import { useLibrary } from "../stores/library";
import { UNCATEGORISED } from "../ipc/commands";
import { orderCategories } from "../categories";

/**
 * Quick-filter chips over the inferred category (SPEC §7.3).
 *
 * Built from what the library actually holds, not from a fixed list. A drill
 * pack has no toms and no cymbals, and two chips that always return nothing
 * teach you to stop trusting the row. What is here is what you have.
 *
 * Counts come from the same query as the list, minus the category filter, so
 * they say how many are in view rather than how many exist somewhere.
 *
 * uncategorised is a chip like any other, and it is the important one: it is
 * where every failed guess lands, and the only place to start fixing them. It
 * sits last and muted -- a destination, not a filter you reach for.
 *
 * The categories are filename-guessed and sometimes wrong (§7.1) — these exist
 * to cut 2,000 files down to a workable handful, not to be a taxonomy.
 */
export function CategoryChips(): React.JSX.Element | null {
  const categories = useLibrary((s) => s.categories);
  const category = useLibrary((s) => s.category);
  const setCategory = useLibrary((s) => s.setCategory);

  const counts = new Map<string, number>();
  for (const entry of categories) {
    if (entry.sampleCount > 0) {
      counts.set(entry.category ?? UNCATEGORISED, entry.sampleCount);
    }
  }

  // A chip for the current filter even at zero: refiling the last sample out of
  // a category must not delete the control that is holding the view.
  if (category !== null && !counts.has(category)) counts.set(category, 0);

  const named = orderCategories([...counts.keys()].filter((n) => n !== UNCATEGORISED));
  const shown = counts.has(UNCATEGORISED) ? [...named, UNCATEGORISED] : named;

  if (shown.length === 0) return null;

  return (
    <div className="chips" role="group" aria-label="Category filter">
      {shown.map((name) => (
        <button
          key={name}
          className={
            `chip${category === name ? " active" : ""}` +
            (name === UNCATEGORISED ? " muted" : "")
          }
          onClick={() => setCategory(category === name ? null : name)}
          title={
            name === UNCATEGORISED
              ? "Samples the filename guess could not place. Filter here, then refile them in one go."
              : undefined
          }
        >
          {name === UNCATEGORISED ? "uncategorised" : name}
          <span className="chip-count">{counts.get(name)}</span>
        </button>
      ))}
    </div>
  );
}
