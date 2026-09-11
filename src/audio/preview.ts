/**
 * The preview voice (SPEC §7.2, §8).
 *
 * Auto-preview-on-selection is the single most important behaviour in the app:
 * holding the down arrow should machine-gun through 30 kicks with each one
 * audibly starting. Everything here exists to make retriggering under that load
 * clean.
 */
import { dbToGain, engine, unlock } from "./engine";
import { load, peek } from "./bufferCache";

/**
 * Release ramp applied to a voice being replaced (SPEC §8: 3–5 ms).
 *
 * A linear ramp, not `setTargetAtTime`: the latter is exponential and never
 * actually reaches zero, so the `stop()` still truncates mid-waveform — which
 * is exactly the click that makes a preview tool feel cheap.
 */
const RELEASE_S = 0.004;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

let current: Voice | null = null;
/** Guards against a slow decode landing after a newer selection has moved on. */
let generation = 0;

interface PlayingVoice {
  sampleId: number;
  /** Context time at which the voice started. */
  startedAt: number;
  durationS: number;
}
let playing: PlayingVoice | null = null;

/**
 * How far through the current preview, 0–1, or null when nothing is sounding.
 *
 * Derived from `AudioContext.currentTime` rather than tracked by a timer: the
 * context clock is the one the audio is actually running on, so the playhead
 * cannot drift away from the sound (SPEC §7.4).
 */
export function playheadFraction(sampleId: number): number | null {
  if (playing === null || playing.sampleId !== sampleId) return null;
  const { ctx } = engine();
  const elapsed = ctx.currentTime - playing.startedAt;
  if (elapsed < 0 || elapsed > playing.durationS) return null;
  return elapsed / playing.durationS;
}

function releaseCurrent(at: number): void {
  if (current === null) return;
  const { source, gain } = current;
  const param = gain.gain;
  param.cancelScheduledValues(at);
  // Anchor at the value it actually holds now, or the ramp starts from
  // whatever was last scheduled rather than from the audible level.
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(0, at + RELEASE_S);
  // Stop just after the ramp completes, never bare: a bare stop() truncates
  // mid-waveform.
  source.stop(at + RELEASE_S + 0.001);
  current = null;
}

export function stop(): void {
  const { ctx } = engine();
  releaseCurrent(ctx.currentTime);
}

/**
 * Playback-rate multiplier for a semitone offset.
 *
 * Must match `pitch::rate_for` on the Rust side exactly, because the preview is
 * the audition and the render is what gets dragged: if they disagreed, a pad
 * would export at a different pitch than the one you approved.
 */
export function rateForSemitones(semitones: number): number {
  return 2 ** (semitones / 12);
}

/**
 * Starts `buffer` immediately, ramping out whatever is already sounding.
 *
 * `semitones` is varispeed, the same as the render: up is faster and shorter.
 * Nothing is pre-rendered to preview a pitch -- `playbackRate` on the source
 * node is exact and free, so auditioning a chromatic spread stays as immediate
 * as auditioning anything else.
 */
export function playBuffer(
  buffer: AudioBuffer,
  gainDb = 0,
  sampleId = -1,
  semitones = 0,
): void {
  const { ctx, previewBus } = engine();
  const now = ctx.currentTime;

  releaseCurrent(now);

  const gain = ctx.createGain();
  gain.gain.value = dbToGain(gainDb);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const rate = rateForSemitones(semitones);
  source.playbackRate.value = rate;
  source.connect(gain);
  gain.connect(previewBus);

  const voice: Voice = { source, gain };
  source.onended = () => {
    gain.disconnect();
    if (current === voice) current = null;
    if (playing !== null && playing.sampleId === sampleId) playing = null;
  };

  // SPEC §7.2: preview always plays from the file's true start. No fade-in.
  source.start(now);
  current = voice;
  // The sounding duration, not the buffer's: at double rate the playhead has to
  // cross the waveform in half the time or it trails the sound it is drawing.
  playing = { sampleId, startedAt: now, durationS: buffer.duration / rate };
}

export interface PreviewResult {
  played: boolean;
  /** Set when the sample could not be decoded, for the row to display. */
  error?: string;
}

/**
 * Previews a sample by id, decoding if necessary.
 *
 * A cached buffer plays synchronously — no await before `start()` — which is
 * what keeps SPEC §10's "under 30 ms cached" target reachable. Only a cold
 * sample goes through the async path.
 */
export async function previewSample(
  sampleId: number,
  gainDb = 0,
  semitones = 0,
): Promise<PreviewResult> {
  void unlock();

  const cached = peek(sampleId);
  if (cached !== undefined) {
    playBuffer(cached, gainDb, sampleId, semitones);
    return { played: true };
  }

  const mine = ++generation;
  try {
    const buffer = await load(sampleId);
    // The selection moved while this was decoding. Playing now would fire a
    // sample the user has already scrolled past — the "dropped preview" that
    // §10 rules out is a missing sound, but a late one is worse.
    if (mine !== generation) return { played: false };
    playBuffer(buffer, gainDb, sampleId, semitones);
    return { played: true };
  } catch (e) {
    if (mine !== generation) return { played: false };
    return { played: false, error: e instanceof Error ? e.message : String(e) };
  }
}
