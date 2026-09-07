/**
 * The audio engine's one AudioContext and its node graph (SPEC §8).
 *
 * Deliberately outside React. It owns mutable, timing-sensitive state that must
 * not be subject to re-render cycles; components read from it and send it
 * commands, but never own it (SPEC §15).
 *
 * The graph, with the context loop's half arriving in Phase 4:
 *
 *   preview voice ──▶ preview gain (normalization) ──┐
 *                                                     ├──▶ master ──▶ destination
 *   context loop  ──▶ loop gain ────────────────────┘
 */

interface Graph {
  ctx: AudioContext;
  /** Everything preview-related hangs off this; Phase 2's gain matching lands here. */
  previewBus: GainNode;
  master: GainNode;
}

let graph: Graph | null = null;

export function engine(): Graph {
  if (graph === null) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const previewBus = ctx.createGain();
    previewBus.connect(master);
    master.connect(ctx.destination);
    graph = { ctx, previewBus, master };
  }
  return graph;
}

/**
 * Resumes the context if the browser suspended it pending a user gesture.
 *
 * Worth calling on any interaction rather than once at startup: a context
 * created before the first gesture starts suspended, and a suspended context
 * makes every preview silently do nothing — which reads as "preview is broken"
 * rather than "click something first".
 */
export async function unlock(): Promise<void> {
  const { ctx } = engine();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* a resume that fails will be retried on the next interaction */
    }
  }
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function setMasterGainDb(db: number): void {
  const { ctx, master } = engine();
  master.gain.setTargetAtTime(dbToGain(db), ctx.currentTime, 0.01);
}
