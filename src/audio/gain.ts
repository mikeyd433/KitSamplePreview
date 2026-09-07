/**
 * Preview gain matching (SPEC §7.6).
 *
 * "Comparing a −18 dB hat against a −3 dB kick tells you which is louder, not
 * which is better." This is what makes A/B-ing two samples a judgement about
 * the sample rather than about its level.
 *
 * Preview only. Exported files are untouched unless normalization is explicitly
 * enabled in the export options (Phase 3).
 */
import type { SampleRow } from "../ipc/commands";

export type NormalizeMode = "off" | "peak" | "body";

/**
 * How far the applied gain may stray, in dB either way.
 *
 * SPEC §7.6: "Clamp the applied gain to ±12 dB so a near-silent file doesn't
 * blast." Without it, a file measured near the silence floor would ask for a
 * hundred dB of boost.
 */
export const GAIN_CLAMP_DB = 12;

/** Target levels. Peak sits near the ceiling; body sits where mixes live. */
export const DEFAULT_TARGET_PEAK_DB = -1;
export const DEFAULT_TARGET_RMS_DB = -18;

export interface NormalizeSettings {
  mode: NormalizeMode;
  targetPeakDb: number;
  targetRmsDb: number;
}

export const DEFAULT_NORMALIZE: NormalizeSettings = {
  // Body match is the default (SPEC §7.6): peak match is simple and
  // predictable, but a sample with one stray transient plays back quiet.
  mode: "body",
  targetPeakDb: DEFAULT_TARGET_PEAK_DB,
  targetRmsDb: DEFAULT_TARGET_RMS_DB,
};

/**
 * The gain to apply when previewing `row`, in dB.
 *
 * Returns 0 when normalization is off, and when the file has no measurement to
 * normalise against — a row that was never analysed plays at its recorded
 * level rather than at a guess.
 */
export function previewGainDb(row: SampleRow, settings: NormalizeSettings): number {
  if (settings.mode === "off") return 0;

  const measured = settings.mode === "peak" ? row.truePeakDb : row.bodyRmsDb;
  if (measured === null) return 0;

  const target = settings.mode === "peak" ? settings.targetPeakDb : settings.targetRmsDb;
  const gain = target - measured;
  return Math.max(-GAIN_CLAMP_DB, Math.min(GAIN_CLAMP_DB, gain));
}
