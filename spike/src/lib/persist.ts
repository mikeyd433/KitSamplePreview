/**
 * localStorage-backed field persistence.
 *
 * The matrix in SPEC §14 needs paths with spaces, non-ASCII characters, a UNC
 * share and an over-MAX_PATH nesting. Those cannot be hardcoded usefully — they
 * are specific to the machine under test — and retyping them between runs is
 * how a test row quietly gets skipped.
 */
const PREFIX = "kitbench-spike:";

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* a full or disabled localStorage must not break the bench */
  }
}
