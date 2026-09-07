import { useSyncExternalStore, useState, useMemo } from "react";
import { log, type LogEntry, type LogLevel } from "../lib/log";
import { errorText } from "../lib/ipc";

const LEVELS: readonly LogLevel[] = ["info", "call", "ok", "warn", "error"];

export function LogPane(): React.JSX.Element {
  const entries = useSyncExternalStore(log.subscribe, log.snapshot);
  const [hidden, setHidden] = useState<ReadonlySet<LogLevel>>(new Set());

  const shown = useMemo(
    () => entries.filter((e) => !hidden.has(e.level)),
    [entries, hidden],
  );

  const toggle = (level: LogLevel): void =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(log.toMarkdown());
      log.ok("log", "log copied to the clipboard");
    } catch (e) {
      log.warn("log", `clipboard unavailable: ${errorText(e)} — select the pane text instead`);
    }
  };

  return (
    <section className="panel log-panel">
      <header className="panel-head">
        <h2>3 · Log</h2>
        <div className="controls">
          {LEVELS.map((l) => (
            <label key={l} className={`radio${hidden.has(l) ? " off" : ""}`}>
              <input type="checkbox" checked={!hidden.has(l)} onChange={() => toggle(l)} />
              {l}
            </label>
          ))}
          <button onClick={() => void copy()} disabled={entries.length === 0}>
            copy as markdown
          </button>
          <button onClick={() => log.clear()} disabled={entries.length === 0}>
            clear
          </button>
        </div>
      </header>

      <div className="log">
        {shown.length === 0 ? (
          <p className="empty">Nothing logged yet. Every startDrag call, its arguments, its
            callback and any error lands here.</p>
        ) : (
          // Newest first: during a drag the main thread is blocked, so a burst
          // of entries arrives at once and the interesting one is the last.
          [...shown].reverse().map((e) => <LogRow key={e.id} entry={e} />)
        )}
      </div>
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }): React.JSX.Element {
  return (
    <div className={`log-row log-${entry.level}`}>
      <span className="log-at">{entry.at}</span>
      <span className="log-src">{entry.source}</span>
      <span className="log-msg">
        {entry.message}
        {entry.detail !== undefined && <pre>{entry.detail}</pre>}
      </span>
    </div>
  );
}
