/**
 * The category vocabulary, in the order it is shown (SPEC §7.1, §7.3).
 *
 * One list, imported by both the chip row and the refile menu, because the two
 * drifting apart means offering a category the filter cannot show.
 *
 * Roughly kit order -- kick, snare, hat -- rather than alphabetical, because
 * that is the order a drummer names them in and the chips are read by position
 * once you have used them twice.
 */
export const CANONICAL_CATEGORIES = [
  "kick",
  "snare",
  "hat",
  "clap",
  "tom",
  "perc",
  "cymbal",
  "fill",
  "808",
  "vox",
  "fx",
] as const;

/**
 * Orders a set of category names for display.
 *
 * Anything not in `CANONICAL_CATEGORIES` sorts after it, alphabetically. That
 * is not a hypothetical: refiling a folder writes whatever the user picked, and
 * a category this build has never heard of still has to appear somewhere
 * predictable rather than vanish.
 */
export function orderCategories(names: readonly string[]): string[] {
  const rank = (name: string): number => {
    const index = (CANONICAL_CATEGORIES as readonly string[]).indexOf(name);
    return index === -1 ? CANONICAL_CATEGORIES.length : index;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
