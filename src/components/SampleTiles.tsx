import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useLibrary } from "../stores/library";
import type { SampleRow } from "../ipc/commands";
import { formatChannels, formatDuration, formatRate, rowFault } from "./format";

/**
 * Tile view: the same rows, laid out as a grid.
 *
 * Virtualized on the same terms as the list (SPEC §13) — the window is a range
 * of grid rows rather than list rows, but the arithmetic is the same and the
 * measurement stays in one place.
 *
 * Each tile reserves space for a waveform thumbnail. It is empty until Phase 2
 * computes peaks at scan time (SPEC §7.4); reserving it now means the layout
 * does not shift when the pictures arrive, and it is the thing that will make
 * this view worth choosing.
 */
const TILE_WIDTH = 168;
const TILE_HEIGHT = 104;
const GAP = 10;
const ROW_HEIGHT = TILE_HEIGHT + GAP;
const OVERSCAN = 2;

export function SampleTiles(): React.JSX.Element {
  const rows = useLibrary((s) => s.rows);
  const total = useLibrary((s) => s.total);
  const selectedIndex = useLibrary((s) => s.selectedIndex);
  const rowErrors = useLibrary((s) => s.rowErrors);
  const select = useLibrary((s) => s.select);
  const loading = useLibrary((s) => s.loading);
  const setColumns = useLibrary((s) => s.setColumns);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 900, height: 600 });

  useEffect(() => {
    const el = viewportRef.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((size.width - GAP) / (TILE_WIDTH + GAP)));

  // The keyboard layer needs the column count to move a whole row per press,
  // and only this component knows how wide a row currently is.
  useEffect(() => setColumns(columns), [columns, setColumns]);

  const gridRows = Math.ceil(rows.length / columns);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (el === null || selectedIndex < 0) return;
    const row = Math.floor(selectedIndex / columns);
    const top = row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [selectedIndex, columns]);

  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleRows = Math.ceil(size.height / ROW_HEIGHT) + OVERSCAN * 2;
  const start = firstRow * columns;
  const slice = rows.slice(start, start + visibleRows * columns);

  return (
    <section className="list-panel">
      <header className="list-head tiles-head">
        <span>NAME</span>
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
          <div className="list-sizer" style={{ height: gridRows * ROW_HEIGHT }}>
            <div
              className="tile-grid"
              style={{
                transform: `translateY(${firstRow * ROW_HEIGHT}px)`,
                gridTemplateColumns: `repeat(${columns}, ${TILE_WIDTH}px)`,
                gap: GAP,
              }}
            >
              {slice.map((row, i) => (
                <Tile
                  key={row.id}
                  row={row}
                  selected={start + i === selectedIndex}
                  fault={rowFault(row, rowErrors[row.id])}
                  onSelect={() => select(start + i)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

interface TileProps {
  row: SampleRow;
  selected: boolean;
  fault: string | null;
  onSelect: () => void;
}

function Tile({ row, selected, fault, onSelect }: TileProps): React.JSX.Element {
  return (
    <div
      className={`tile${selected ? " tile-selected" : ""}${fault !== null ? " tile-broken" : ""}${row.removed ? " tile-removed" : ""}`}
      style={{ height: TILE_HEIGHT }}
      onMouseDown={onSelect}
      title={fault ?? row.relPath}
    >
      {/* Phase 2 (SPEC §7.4) renders the cached peaks blob here. */}
      <div className="tile-wave" aria-hidden="true" />
      <div className="tile-name">{row.filename}</div>
      <div className="tile-meta">
        {fault !== null ? (
          <span className="bad">{row.probeError !== null ? "unreadable" : "no preview"}</span>
        ) : (
          <>
            {formatDuration(row.durationMs)} · {formatRate(row.sampleRate)}k ·{" "}
            {formatChannels(row.channels)}
          </>
        )}
      </div>
    </div>
  );
}
