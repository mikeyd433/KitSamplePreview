/** Row formatting shared by the list and tile views. */
import type { SampleRow } from "../ipc/commands";

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatRate(hz: number | null): string {
  if (hz === null) return "—";
  return (hz / 1000).toFixed(1);
}

export function formatChannels(channels: number | null): string {
  if (channels === null) return "—";
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return `${channels}ch`;
}

/**
 * Why a row cannot be auditioned, or null when it is fine.
 *
 * A scan failure and a decode failure are different problems with the same
 * consequence, and both have to be visible (SPEC §15) — a broken file the user
 * cannot see is one they cannot fix.
 */
export function rowFault(row: SampleRow, decodeError: string | undefined): string | null {
  return row.probeError ?? decodeError ?? null;
}
