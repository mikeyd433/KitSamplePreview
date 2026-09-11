/**
 * Decoded AudioBuffer LRU (SPEC §8).
 *
 * Capped by decoded size rather than entry count, because a 30-second loop is
 * not equivalent to a 200 ms hi-hat. Generous by default and left untuned:
 * SPEC §13 lists cache tuning under "easy to change later, so don't tune it
 * yet".
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePlayable } from "../ipc/commands";
import { engine } from "./engine";

/** Roughly 500 MB of decoded float32 audio. */
const DEFAULT_BUDGET_BYTES = 500 * 1024 * 1024;

/** Decoded audio is float32 per channel per frame. */
function sizeOf(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

export class DecodeError extends Error {
  constructor(
    message: string,
    readonly sampleId: number,
  ) {
    super(message);
    this.name = "DecodeError";
  }
}

// A Map iterates in insertion order, so deleting before re-setting on a hit
// gives LRU ordering without a second structure.
const cache = new Map<number, AudioBuffer>();
const inFlight = new Map<number, Promise<AudioBuffer>>();
let bytes = 0;
let budget = DEFAULT_BUDGET_BYTES;

export function setBudgetBytes(n: number): void {
  budget = n;
  evict();
}

function evict(): void {
  while (bytes > budget && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    const victim = cache.get(oldest.value);
    if (victim !== undefined) bytes -= sizeOf(victim);
    cache.delete(oldest.value);
  }
}

export function peek(sampleId: number): AudioBuffer | undefined {
  const hit = cache.get(sampleId);
  if (hit !== undefined) {
    // Re-insert to mark as most recently used.
    cache.delete(sampleId);
    cache.set(sampleId, hit);
  }
  return hit;
}

/**
 * Decodes a sample, or returns the cached buffer.
 *
 * Concurrent calls for the same id share one decode — holding the down arrow
 * fires selection changes faster than a cold decode completes, and without this
 * the same file would be fetched several times over.
 */
export async function load(sampleId: number): Promise<AudioBuffer> {
  const cached = peek(sampleId);
  if (cached !== undefined) return cached;

  const existing = inFlight.get(sampleId);
  if (existing !== undefined) return existing;

  const task = (async (): Promise<AudioBuffer> => {
    const playable = await resolvePlayable(sampleId);
    const url = convertFileSrc(playable.path);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (e) {
      // SPEC §3: a missing asset-protocol scope surfaces exactly here, as a
      // bare network error that reads like a decode bug.
      throw new DecodeError(
        `could not read the file (${e instanceof Error ? e.message : String(e)}) — asset protocol scope?`,
        sampleId,
      );
    }
    if (!response.ok) {
      throw new DecodeError(`could not read the file: HTTP ${response.status}`, sampleId);
    }

    const raw = await response.arrayBuffer();
    const { ctx } = engine();
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(raw);
    } catch {
      // Phase 0 measured the boundary: WebView2 decodes every WAV variant and
      // refuses AIFF/AIFC. Until the ffmpeg fallback lands in Phase 3 this is
      // reported rather than worked around — a row that fails visibly is worth
      // more than one that silently plays nothing.
      throw new DecodeError("this format could not be decoded", sampleId);
    }

    cache.set(sampleId, buffer);
    bytes += sizeOf(buffer);
    evict();
    return buffer;
  })();

  inFlight.set(sampleId, task);
  try {
    return await task;
  } finally {
    inFlight.delete(sampleId);
  }
}

/**
 * Warms the cache around the selection so arrow-key scrubbing never waits on a
 * decode (SPEC §8: "prefetch the next 3 and previous 3 rows").
 */
export function prefetch(sampleIds: readonly number[]): void {
  for (const id of sampleIds) {
    if (cache.has(id) || inFlight.has(id)) continue;
    // Failures here are not surfaced: a prefetch is a guess, and an
    // undecodable neighbour is the selection's problem when it gets there.
    void load(id).catch(() => undefined);
  }
}

export function stats(): { entries: number; bytes: number; budget: number } {
  return { entries: cache.size, bytes, budget };
}

export function clear(): void {
  cache.clear();
  bytes = 0;
}
