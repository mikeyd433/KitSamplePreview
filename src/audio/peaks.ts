/**
 * Decoding the waveform blobs the scan computed (SPEC §7.4).
 *
 * Peaks are computed once, in Rust, at scan time. Nothing here decodes audio —
 * that is the whole point: "decoding thousands of files in the webview to draw
 * thumbnails would make the list unusable".
 */

/** Buckets per file, matching `analyze::BUCKETS` on the Rust side. */
export const BUCKETS = 400;

// Decoding is cheap but not free, and a scrolling list re-renders the same rows
// constantly. Keyed by sample id; the blob for a given id only changes when a
// rescan re-analyses the file, which replaces the row anyway.
const cache = new Map<number, Int8Array>();

export function decodePeaks(sampleId: number, base64: string | null): Int8Array | null {
  if (base64 === null) return null;
  const hit = cache.get(sampleId);
  if (hit !== undefined) return hit;

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // Interpreted as signed: the blob is min/max pairs either side of zero.
    const peaks = new Int8Array(bytes.buffer);
    cache.set(sampleId, peaks);
    return peaks;
  } catch {
    // A corrupt blob should cost a thumbnail, not the row.
    return null;
  }
}

/**
 * Reduces the stored buckets to `target` min/max pairs.
 *
 * The list thumbnail is 40-odd pixels wide and drawing 400 buckets into it
 * would just be 400 overlapping lines (SPEC §7.4: "the list thumbnail renders a
 * downsampled subset"). The inspector asks for all 400 and gets them unchanged.
 */
export function downsample(peaks: Int8Array, target: number): Int8Array {
  const source = Math.floor(peaks.length / 2);
  if (target >= source) return peaks;

  const out = new Int8Array(target * 2);
  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * source) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * source) / target));
    let lo = 127;
    let hi = -128;
    for (let b = start; b < end; b++) {
      lo = Math.min(lo, peaks[b * 2] ?? 0);
      hi = Math.max(hi, peaks[b * 2 + 1] ?? 0);
    }
    out[i * 2] = lo;
    out[i * 2 + 1] = hi;
  }
  return out;
}
