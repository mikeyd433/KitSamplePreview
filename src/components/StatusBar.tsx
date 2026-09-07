import { useLibrary } from "../stores/library";

/** Scan progress, the last scan's report, and anything that went wrong. */
export function StatusBar(): React.JSX.Element {
  const scan = useLibrary((s) => s.scan);
  const error = useLibrary((s) => s.error);
  const rescan = useLibrary((s) => s.rescan);
  const roots = useLibrary((s) => s.roots);

  const selectedError = useLibrary((s) => {
    const row = s.rows[s.selectedIndex];
    if (row === undefined) return null;
    return row.probeError ?? s.rowErrors[row.id] ?? null;
  });

  const pct = scan.total > 0 ? Math.round((scan.done / scan.total) * 100) : 0;

  return (
    <footer className="status">
      <div className="status-left">
        {scan.running ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>
              scanning {scan.done}/{scan.total} ({pct}%)
            </span>
            <span className="path">{scan.currentPath}</span>
          </>
        ) : scan.lastReport !== null ? (
          <span>
            scanned in {(scan.lastReport.elapsedMs / 1000).toFixed(1)}s — {scan.lastReport.added} added,{" "}
            {scan.lastReport.updated} updated, {scan.lastReport.removed} missing,{" "}
            {scan.lastReport.skipped} unchanged
            {scan.lastReport.failed > 0 && (
              <span className="warn"> · {scan.lastReport.failed} unreadable</span>
            )}
          </span>
        ) : (
          <span className="dim">ready</span>
        )}
        {error !== null && <span className="err">{error}</span>}
        {selectedError !== null && <span className="err">{selectedError}</span>}
      </div>

      <div className="status-right">
        <button onClick={() => void rescan(false)} disabled={scan.running || roots.length === 0}>
          rescan
        </button>
        <button
          onClick={() => void rescan(true)}
          disabled={scan.running || roots.length === 0}
          title="Re-probe every file, ignoring the unchanged check"
        >
          full rescan
        </button>
      </div>
    </footer>
  );
}
