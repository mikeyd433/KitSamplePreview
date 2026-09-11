import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLibrary } from "../stores/library";
import type { SampleRow } from "../ipc/commands";
import { formatDuration, formatRate, rowFault } from "./format";
import { Waveform } from "./Waveform";
import { dragOut } from "../ipc/drag";

/**
 * Virtualized from day one (SPEC §13): retrofitting virtualization into a
 * working list is a rewrite of the list component, and it costs little now.
 *
 * Hand-rolled rather than pulling in a windowing library — SPEC §3 is the
 * dependency list and §15 asks that additions be a decision rather than a
 * detail. Fixed row height makes the arithmetic trivial, and fixed row height
 * is what the design wants anyway.
 */
const ROW_HEIGHT = 26;
const OVERSCAN = 8;

export function SampleList(): React.JSX.Element {
  const rows = useLibrary((s) => s.rows);
  const total = useLibrary((s) => s.total);
  const selectedIndex = useLibrary((s) => s.selectedIndex);
  const rowErrors = useLibrary((s) => s.rowErrors);
  const select = useLibrary((s) => s.select);
  const loading = useLibrary((s) => s.loading);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the selection on screen when the keyboard moves it. Layout effect, so
  // the scroll happens in the same frame as the highlight and holding the arrow
  // key does not visibly lag behind the sound.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el === null || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [selectedIndex]);

  const firstVisible = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = rows.slice(firstVisible, firstVisible + visibleCount);

  return (
    <section className="list-panel">
      <header className="list-head">
        <span className="col-name">NAME</span>
        <span className="col-dur">DUR</span>
        <span className="col-wave" />
        <span className="col-rate">SR</span>
        <span className="col-ch">CH</span>
        <span className="col-count">
          {loading ? "…" : `${total} ${total === 1 ? "sample" : "samples"}`}
        </span>
      </header>

      <div
        className="list-viewport"
        ref={viewportRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
      >
        {rows.length === 0 ? (
          <p className="empty">
            {loading ? "Loading…" : "No samples. Add a library root and scan."}
          </p>
        ) : (
          <div className="list-sizer" style={{ height: rows.length * ROW_HEIGHT }}>
            <div className="list-window" style={{ transform: `translateY(${firstVisible * ROW_HEIGHT}px)` }}>
              {slice.map((row, i) => (
                <Row
                  key={row.id}
                  row={row}
                  selected={firstVisible + i === selectedIndex}
                  error={rowErrors[row.id]}
                  onSelect={() => select(firstVisible + i)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface RowProps {
  row: SampleRow;
  selected: boolean;
  error: string | undefined;
  onSelect: () => void;
}

function Row({ row, selected, error, onSelect }: RowProps): React.JSX.Element {
  // A file the scan could not read, or one the decoder refused, is shown as a
  // visibly broken row rather than a silent one (SPEC §15).
  const fault = rowFault(row, error);
  const broken = fault !== null;
  const title = fault ?? row.path;

  return (
    <div
      className={`row${selected ? " row-selected" : ""}${broken ? " row-broken" : ""}${row.removed ? " row-removed" : ""}`}
      style={{ height: ROW_HEIGHT }}
      draggable={!row.removed && row.dragBlocked === null}
      onDragStart={(e) => {
        // Hand the file to the OS rather than letting the webview drag it
        // (SPEC §7.8). Nothing is awaited here — the gesture would be lost.
        e.preventDefault();
        dragOut([row.path], row.dragBlocked);
      }}
      onMouseDown={onSelect}
      title={title}
    >
      <span className="col-name">
        {row.filename}
        {row.removed && <span className="tag">missing</span>}
        {broken && <span className="tag tag-err">{row.probeError !== null ? "unreadable" : "no preview"}</span>}
      </span>
      <span className="col-dur">{formatDuration(row.durationMs)}</span>
      <span className="col-wave">
        {/* Drawn from the blob the scan computed — no decode happens here
            (SPEC §7.4). */}
        <Waveform
          sampleId={row.id}
          peaks={row.peaks}
          width={72}
          height={16}
          color={selected ? "#e8a84a" : "#6f6f80"}
        />
      </span>
      <span className="col-rate">{formatRate(row.sampleRate)}</span>
      <span className="col-ch">{row.channels ?? "—"}</span>
      <span className="col-count" />
    </div>
  );
}
