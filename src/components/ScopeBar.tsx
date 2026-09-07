import { useLibrary } from "../stores/library";

/**
 * What the search is currently looking at, and how to widen it.
 *
 * Scoping to a root or a folder is useful, but it was previously invisible:
 * the only cue was which sidebar entry looked selected, and the only way out
 * was clicking that same entry again. A search that quietly excludes most of
 * the library reads as a tool that cannot find things.
 *
 * So the scope is stated in words next to the search box, it clears in one
 * click, and when a scoped search is hiding matches it says how many.
 */
export function ScopeBar(): React.JSX.Element {
  const roots = useLibrary((s) => s.roots);
  const rootId = useLibrary((s) => s.rootId);
  const subtree = useLibrary((s) => s.subtree);
  const total = useLibrary((s) => s.total);
  const globalTotal = useLibrary((s) => s.globalTotal);
  const clearScope = useLibrary((s) => s.clearScope);

  const scoped = rootId !== null || subtree !== null;

  const rootLabel = roots.find((root) => root.id === rootId)?.label ?? null;
  const parts = [
    rootLabel,
    ...(subtree === null ? [] : subtree.split("\\").filter((part) => part !== "")),
  ].filter((part): part is string => part !== null);

  const elsewhere = globalTotal === null ? 0 : globalTotal - total;

  return (
    <div className="scope">
      <span className="scope-label">searching</span>
      <button
        className={`scope-chip${scoped ? "" : " all"}`}
        onClick={() => clearScope()}
        disabled={!scoped}
        title={scoped ? "Clear the filter and search every root (Esc)" : "Every sample in every root"}
      >
        {scoped ? parts.join(" › ") : "everything"}
        {scoped && <span className="scope-x">×</span>}
      </button>

      {scoped && elsewhere > 0 && (
        <button
          className="scope-widen"
          onClick={() => clearScope()}
          title="Search the whole library instead"
        >
          {elsewhere} more elsewhere
        </button>
      )}
    </div>
  );
}
