import { useCallback, useEffect, useState } from "react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { CallbackPayload } from "@crabnebula/tauri-plugin-drag";

import { DRAG_TESTS, type DragTest } from "../lib/tests";
import { DRAG_ICON_PNG_DATA_URI } from "../lib/dragIcon";
import { checkPaths, errorText, type PathCheck } from "../lib/ipc";
import { loadJSON, saveJSON } from "../lib/persist";
import { log } from "../lib/log";

/**
 * Which DOM event starts the drag.
 *
 * Which of these works is itself an open question, so it is a switch rather
 * than a decision. `dragstart` is the pattern drag-rs documents: let the
 * webview begin an HTML5 drag, cancel it with preventDefault, and start the
 * OLE drag in its place. `mousedown` skips HTML5 entirely.
 *
 * Note `dragDropEnabled: false` in tauri.conf.json — with Tauri's own file-drop
 * handler active, the webview never emits dragstart on Windows and this switch
 * would appear broken for reasons that have nothing to do with Sitala.
 */
type TriggerMode = "dragstart" | "mousedown";

type Outcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "dropped"; cursor: unknown }
  | { kind: "cancelled"; cursor: unknown }
  | { kind: "error"; message: string }
  | { kind: "blocked"; message: string };

type PathMap = Record<string, string[]>;

function initialPaths(): PathMap {
  const stored = loadJSON<PathMap>("dragPaths", {});
  const out: PathMap = {};
  for (const t of DRAG_TESTS) {
    const saved = stored[t.id];
    out[t.id] = Array.from({ length: t.pathCount }, (_, i) => saved?.[i] ?? "");
  }
  return out;
}

export function DragBench(): React.JSX.Element {
  const [paths, setPaths] = useState<PathMap>(initialPaths);
  const [checks, setChecks] = useState<Record<string, PathCheck[]>>({});
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [triggerMode, setTriggerMode] = useState<TriggerMode>(() =>
    loadJSON<TriggerMode>("triggerMode", "dragstart"),
  );

  useEffect(() => saveJSON("dragPaths", paths), [paths]);
  useEffect(() => saveJSON("triggerMode", triggerMode), [triggerMode]);

  const preflight = useCallback(async (test: DragTest, rowPaths: string[]): Promise<void> => {
    const clean = rowPaths.map((p) => p.trim()).filter((p) => p.length > 0);
    if (clean.length === 0) {
      setChecks((c) => ({ ...c, [test.id]: [] }));
      return;
    }
    try {
      const result = await checkPaths(clean);
      setChecks((c) => ({ ...c, [test.id]: result }));
      for (const r of result) {
        if (r.error !== null) {
          log.warn(`test ${test.id}`, `pre-flight: ${r.input} — ${r.error}`);
        } else if (r.verbatim) {
          log.warn(
            `test ${test.id}`,
            `pre-flight: canonicalized to a \\\\?\\ verbatim path (${r.charLen} chars) — this is the string the shell receives`,
            r.canonical,
          );
        }
      }
    } catch (e) {
      log.error(`test ${test.id}`, "check_paths failed", errorText(e));
    }
  }, []);

  // Pre-flight on mount and whenever a field loses focus — never inside the
  // drag handler. SPEC §7.8 makes the same call for format conversion: an
  // await between mousedown and startDrag risks losing the drag gesture, so
  // everything that can be known ahead of time is known ahead of time.
  useEffect(() => {
    for (const t of DRAG_TESTS) {
      const rowPaths = paths[t.id];
      if (rowPaths && rowPaths.some((p) => p.trim().length > 0)) void preflight(t, rowPaths);
    }
    // Intentionally mount-only: `paths` is read once to restore what was saved
    // from the last run, and blur drives every check after that.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fire = useCallback(
    (test: DragTest): void => {
      const clean = (paths[test.id] ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
      if (clean.length === 0) {
        log.warn(`test ${test.id}`, "no path entered — nothing to drag");
        return;
      }

      const rowChecks = checks[test.id];

      // Row 9 established that this crashes the process, so the spike refuses
      // it rather than reproducing a known result.
      //
      // drag-rs canonicalizes with dunce, which yields a `\\?\` verbatim path
      // for anything over MAX_PATH. The shell namespace parser rejects that
      // prefix, so ILCreateFromPathW returns a null ITEMIDLIST,
      // SHCreateShellItemArrayFromIDLists fails, and
      // `get_shell_item_array(paths).unwrap()` panics on the main thread —
      // taking the whole app with it, with no error to report.
      const unsafePaths = rowChecks?.filter((c) => c.verbatim || c.charLen > 259) ?? [];
      if (unsafePaths.length > 0) {
        const message =
          "blocked: over MAX_PATH. drag-rs would panic on this and kill the app — " +
          "see RESULTS.md row 9. Phase 3's drag wrapper needs this same guard.";
        log.error(`test ${test.id}`, message, unsafePaths.map((c) => ({
          chars: c.charLen,
          verbatim: c.verbatim,
          canonical: c.canonical,
        })));
        setOutcomes((o) => ({ ...o, [test.id]: { kind: "blocked", message } }));
        return;
      }

      const missing = rowChecks?.filter((c) => !c.exists) ?? [];
      if (missing.length > 0) {
        log.warn(
          `test ${test.id}`,
          `${missing.length} path(s) do not exist — dragging anyway; drag-rs canonicalizes first, so expect a clean error rather than a drop`,
          missing.map((m) => m.input),
        );
      }

      // Exactly what crosses the IPC boundary, minus the icon blob.
      log.call(`test ${test.id}`, `startDrag via ${triggerMode}`, {
        item: clean,
        icon: `<data:image/png;base64 — ${DRAG_ICON_PNG_DATA_URI.length} chars, elided>`,
        mode: "copy",
        shellWillReceive: rowChecks?.map((c) => c.canonical ?? `(canonicalize failed: ${c.error})`),
      });
      setOutcomes((o) => ({ ...o, [test.id]: { kind: "pending" } }));

      const onEvent = (payload: CallbackPayload): void => {
        const dropped = payload.result === "Dropped";
        // "Dropped" is DRAGDROP_S_DROP: the target accepted the data object.
        // It does NOT prove Sitala mapped the sample to the pad — that still
        // has to be confirmed by eye and ear.
        log[dropped ? "ok" : "warn"](
          `test ${test.id}`,
          `drag callback: ${payload.result}`,
          payload,
        );
        setOutcomes((o) => ({
          ...o,
          [test.id]: dropped
            ? { kind: "dropped", cursor: payload.cursorPos }
            : { kind: "cancelled", cursor: payload.cursorPos },
        }));
      };

      startDrag({ item: clean, icon: DRAG_ICON_PNG_DATA_URI, mode: "copy" }, onEvent)
        .then(() => {
          log.info(`test ${test.id}`, "startDrag resolved — the OLE drag loop has finished");
        })
        .catch((e: unknown) => {
          const message = errorText(e);
          log.error(`test ${test.id}`, "startDrag rejected", message);
          setOutcomes((o) => ({ ...o, [test.id]: { kind: "error", message } }));
        });
    },
    [paths, checks, triggerMode],
  );

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>1 · Drag-out matrix</h2>
        <div className="controls">
          <span className="label">start drag on</span>
          {(["dragstart", "mousedown"] as const).map((m) => (
            <label key={m} className="radio">
              <input
                type="radio"
                name="trigger"
                checked={triggerMode === m}
                onChange={() => setTriggerMode(m)}
              />
              {m}
            </label>
          ))}
        </div>
      </header>

      <p className="note">
        <strong>Reading the result badge.</strong> <code>Dropped</code> is Windows'{" "}
        <code>DRAGDROP_S_DROP</code> — the target accepted the data object. It is not proof Sitala
        mapped the sample; confirm that by eye and ear. <code>Cancelled</code> means the target
        refused the drop or you released over nothing. <code>Error</code> means the drag never
        started, and the log says why. Drag mode is pinned to <code>copy</code>: the plugin also
        offers <code>move</code>, which would let a target relocate the source file, and pointing
        that at a real sample library is not worth the finding.
      </p>

      <div className="rows">
        {DRAG_TESTS.map((test) => (
          <DragRow
            key={test.id}
            test={test}
            paths={paths[test.id] ?? []}
            checks={checks[test.id]}
            outcome={outcomes[test.id] ?? { kind: "idle" }}
            triggerMode={triggerMode}
            onChange={(i, v) =>
              setPaths((p) => {
                const row = [...(p[test.id] ?? [])];
                row[i] = v;
                return { ...p, [test.id]: row };
              })
            }
            onBlur={() => void preflight(test, paths[test.id] ?? [])}
            onFire={() => fire(test)}
          />
        ))}
      </div>
    </section>
  );
}

interface DragRowProps {
  test: DragTest;
  paths: string[];
  checks: PathCheck[] | undefined;
  outcome: Outcome;
  triggerMode: TriggerMode;
  onChange: (index: number, value: string) => void;
  onBlur: () => void;
  onFire: () => void;
}

function DragRow(props: DragRowProps): React.JSX.Element {
  const { test, paths, checks, outcome, triggerMode, onChange, onBlur, onFire } = props;

  const handleProps =
    triggerMode === "dragstart"
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
            // Cancel the webview's own HTML5 drag; the OLE drag replaces it.
            e.preventDefault();
            onFire();
          },
        }
      : {
          onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
            if (e.button !== 0) return;
            e.preventDefault();
            onFire();
          },
        };

  const anyMissing =
    (checks?.some((c) => !c.exists) ?? false) ||
    (checks?.some((c) => c.verbatim || c.charLen > 259) ?? false);
  const hasPath = paths.some((p) => p.trim().length > 0);

  return (
    <article className={`row${test.extra === true ? " row-extra" : ""}`}>
      <div className="row-head">
        <span className="test-id">{test.id}</span>
        <div className="row-title">
          <h3>
            {test.title}
            {test.extra === true && <span className="tag">beyond §14</span>}
          </h3>
          <p className="target">
            drop on <strong>{test.target}</strong>
          </p>
        </div>
        <OutcomeBadge outcome={outcome} />
      </div>

      <p className="records">{test.records}</p>
      {test.setup !== undefined && <p className="setup">Setup: {test.setup}</p>}

      <div className="row-body">
        <div className="inputs">
          {paths.map((value, i) => (
            <input
              // Row length is fixed by pathCount, so the index is a stable key.
              key={i}
              type="text"
              spellCheck={false}
              value={value}
              placeholder={test.placeholders[i] ?? ""}
              onChange={(e) => onChange(i, e.target.value)}
              onBlur={onBlur}
            />
          ))}
        </div>

        <div
          className={`handle${anyMissing ? " handle-warn" : ""}${hasPath ? "" : " handle-empty"}`}
          title={
            triggerMode === "dragstart"
              ? "Drag me onto the target"
              : "Press and hold, then move onto the target"
          }
          {...handleProps}
        >
          <span className="handle-grip" aria-hidden="true" />
          drag
        </div>
      </div>

      {checks !== undefined && checks.length > 0 && <PreflightTable checks={checks} />}
    </article>
  );
}

function PreflightTable({ checks }: { checks: PathCheck[] }): React.JSX.Element {
  return (
    <table className="preflight">
      <thead>
        <tr>
          <th>exists</th>
          <th>bytes</th>
          <th>chars</th>
          <th>what the shell receives (dunce-canonicalized)</th>
        </tr>
      </thead>
      <tbody>
        {checks.map((c) => (
          <tr key={c.input} className={c.exists ? "" : "bad"}>
            <td>{c.exists ? (c.isFile ? "file" : "not a file") : "no"}</td>
            <td>{c.sizeBytes ?? "—"}</td>
            <td className={c.charLen > 260 ? "warn" : ""}>{c.charLen}</td>
            <td className="mono">
              {c.canonical ?? <span className="bad">canonicalize failed: {c.error}</span>}
              {c.verbatim && <span className="tag">verbatim \\?\</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OutcomeBadge({ outcome }: { outcome: Outcome }): React.JSX.Element {
  switch (outcome.kind) {
    case "idle":
      return <span className="badge badge-idle">not run</span>;
    case "pending":
      return <span className="badge badge-pending">dragging…</span>;
    case "dropped":
      return <span className="badge badge-ok">Dropped</span>;
    case "cancelled":
      return <span className="badge badge-warn">Cancelled</span>;
    case "error":
      return <span className="badge badge-err" title={outcome.message}>Error</span>;
    case "blocked":
      return <span className="badge badge-err" title={outcome.message}>Blocked — would crash</span>;
  }
}
