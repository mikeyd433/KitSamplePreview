import { useLibrary } from "../stores/library";

/**
 * Quick-filter chips over the inferred category (SPEC §7.3).
 *
 * The categories are filename-guessed and sometimes wrong (§7.1) — these exist
 * to cut 2,000 files down to a workable handful, not to be a taxonomy.
 */
const CATEGORIES = ["kick", "snare", "hat", "clap", "tom", "perc", "cymbal", "fx"] as const;

export function CategoryChips(): React.JSX.Element {
  const category = useLibrary((s) => s.category);
  const setCategory = useLibrary((s) => s.setCategory);

  return (
    <div className="chips" role="group" aria-label="Category filter">
      {CATEGORIES.map((name) => (
        <button
          key={name}
          className={`chip${category === name ? " active" : ""}`}
          onClick={() => setCategory(category === name ? null : name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
