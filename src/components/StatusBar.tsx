import { useEffect, useState } from "react";

import { useLibrary } from "../stores/library";
import * as ipc from "../ipc/commands";

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
        <VersionBadge />
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


/**
 * Which build is running.
 *
 * The app is updated by rebuilding from a branch, so "am I on the latest?" has
 * no other answer — and a stale build that looks current is expensive to
 * suspect. The commit is the part that actually distinguishes two builds; the
 * version number rarely moves.
 */
function VersionBadge(): React.JSX.Element | null {
  const [info, setInfo] = useState<ipc.AppVersion | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ipc.appVersion().then(setInfo).catch(() => undefined);
  }, []);

  if (info === null) return null;

  const built = new Date(info.builtAt * 1000);
  const dirty = info.commit.endsWith("+");
  const label = `v${info.version} · ${info.commit}`;

  const copy = (): void => {
    void navigator.clipboard
      .writeText(`${label} (built ${built.toISOString()})`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <button
      className={`version${dirty ? " dirty" : ""}`}
      onClick={copy}
      title={
        `Built ${built.toLocaleString()}` +
        (dirty ? "\nfrom a working tree with uncommitted changes" : "") +
        "\nClick to copy"
      }
    >
      {copied ? "copied" : label}
    </button>
  );
}
