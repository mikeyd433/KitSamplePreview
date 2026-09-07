import { useEffect, useState } from "react";

import { useKit, SLOT_COUNT, type Slot } from "../stores/kit";
import { useLibrary } from "../stores/library";
import { dragOut } from "../ipc/drag";
import { Waveform } from "./Waveform";
import { ExportDialog } from "./ExportDialog";

/**
 * The 16-slot tray (SPEC §7.7), mirroring Sitala's 4x4 so pad positions
 * translate directly.
 *
 * Each pad supports two different drags, which need separate grips because
 * they are different mechanisms:
 *
 *   the pad body — an OS drag carrying the file, for dropping onto Sitala
 *                  (SPEC §7.8). This is the primary action and the reason
 *                  Phase 0 existed.
 *   the corner grip — an ordinary in-page drag, for reordering and swapping
 *                  pads within the tray.
 *
 * Trying to serve both from one gesture would mean guessing which the user
 * meant, and guessing wrong on the one that reaches another application.
 */
export function KitTray(): React.JSX.Element {
  const name = useKit((s) => s.name);
  const slots = useKit((s) => s.slots);
  const dirty = useKit((s) => s.dirty);
  const kits = useKit((s) => s.kits);
  const kitId = useKit((s) => s.kitId);
  const error = useKit((s) => s.error);
  const setName = useKit((s) => s.setName);
  const save = useKit((s) => s.save);
  const load = useKit((s) => s.load);
  const clearAll = useKit((s) => s.clearAll);
  const refreshKits = useKit((s) => s.refreshKits);

  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void refreshKits();
  }, [refreshKits]);

  const filled = slots.filter((slot) => slot.sample !== null).length;

  return (
    <section className="kit">
      <header className="kit-head">
        <span className="kit-label">KIT</span>
        <input
          className="kit-name"
          type="text"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="kit-count">
          {filled}/{SLOT_COUNT}
          {dirty && <span className="dot" title="Unsaved changes" />}
        </span>

        <button onClick={() => void save()} disabled={name.trim() === ""}>
          save
        </button>
        <select
          value={kitId ?? ""}
          onChange={(e) => {
            const id = Number(e.target.value);
            if (!Number.isNaN(id) && e.target.value !== "") void load(id);
          }}
        >
          <option value="">load…</option>
          {kits.map((kit) => (
            <option key={kit.id} value={kit.id}>
              {kit.name} ({kit.filled}/{SLOT_COUNT})
            </option>
          ))}
        </select>
        <button onClick={() => clearAll()}>new</button>
        <button
          onClick={() => setExporting(true)}
          disabled={filled === 0}
          title="Write every filled pad to a folder, named so alphabetical order matches pad order"
        >
          export kit…
        </button>
        <span className="kit-hint">drag a pad → Sitala</span>
      </header>

      {error !== null && <p className="kit-error">{error}</p>}

      <div className="pads">
        {slots.map((slot, index) => (
          <Pad key={index} index={index} slot={slot} />
        ))}
      </div>

      {exporting && kitId !== null && (
        <ExportDialog kitId={kitId} onClose={() => setExporting(false)} />
      )}
      {exporting && kitId === null && (
        <div className="dialog-backdrop" onClick={() => setExporting(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Save the kit first</h3>
            <p className="note">
              Export reads the saved kit, so give this one a name and press save.
            </p>
            <div className="dialog-actions">
              <button onClick={() => setExporting(false)}>ok</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** The 4x4 key block, in the physical arrangement of the pads (SPEC §7.2). */
export const SLOT_KEYS = ["1", "2", "3", "4", "q", "w", "e", "r", "a", "s", "d", "f", "z", "x", "c", "v"];

function Pad({ index, slot }: { index: number; slot: Slot }): React.JSX.Element {
  const selectedSlot = useKit((s) => s.selectedSlot);
  const selectSlot = useKit((s) => s.selectSlot);
  const clearSlot = useKit((s) => s.clearSlot);
  const swap = useKit((s) => s.swap);
  const setSlotGain = useKit((s) => s.setSlotGain);
  const [dragOverFrom, setDragOverFrom] = useState(false);

  const sample = slot.sample;
  const selected = selectedSlot === index;
  const missing = sample !== null && sample.removed;
  const blocked = sample?.dragBlocked ?? null;

  return (
    <div
      className={`pad${selected ? " pad-selected" : ""}${sample === null ? " pad-empty" : ""}${missing ? " pad-missing" : ""}${dragOverFrom ? " pad-target" : ""}`}
      onDragOver={(e) => {
        // Only in-tray moves are droppable here; a file drag from outside is
        // not something the tray accepts.
        if (e.dataTransfer.types.includes("application/x-kitbench-slot")) {
          e.preventDefault();
          setDragOverFrom(true);
        }
      }}
      onDragLeave={() => setDragOverFrom(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverFrom(false);
        const from = Number(e.dataTransfer.getData("application/x-kitbench-slot"));
        if (!Number.isNaN(from)) swap(from, index);
      }}
    >
      <div className="pad-top">
        <span className="pad-index">{index + 1}</span>
        <span className="pad-key">{SLOT_KEYS[index]}</span>
        {sample !== null && (
          <>
            <span
              className="pad-grip"
              draggable
              title="Drag to move or swap pads"
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-kitbench-slot", String(index));
                e.dataTransfer.effectAllowed = "move";
              }}
            >
              ⠿
            </span>
            <button className="pad-clear" title="Clear pad" onClick={() => clearSlot(index)}>
              ×
            </button>
          </>
        )}
      </div>

      <div
        className="pad-body"
        draggable={sample !== null && blocked === null}
        onMouseDown={() => selectSlot(index)}
        onDragStart={(e) => {
          // Cancel the webview's own drag and hand the file to the OS instead.
          e.preventDefault();
          if (sample === null) return;
          const result = dragOut([sample.path], blocked);
          if (!result.started && result.error !== undefined) {
            useKit.setState({ error: result.error });
          }
        }}
        title={
          sample === null
            ? `Empty — press ${SLOT_KEYS[index]} with a sample selected`
            : (blocked ?? sample.relPath)
        }
      >
        {sample === null ? (
          <span className="pad-placeholder">—</span>
        ) : (
          <>
            <Waveform
              sampleId={sample.id}
              peaks={sample.peaks}
              width={104}
              height={26}
              color={selected ? "#e8a84a" : "#6f6f80"}
            />
            <span className="pad-name">{sample.filename}</span>
          </>
        )}
      </div>

      {sample !== null && (
        <div className="pad-foot">
          {missing && <span className="bad">missing</span>}
          {!missing && blocked !== null && <span className="bad" title={blocked}>can't drag</span>}
          {!missing && blocked === null && (
            <label className="pad-gain" title="Per-slot gain offset — metadata until export">
              <input
                type="range"
                min={-12}
                max={12}
                step={0.5}
                value={slot.gainDbOffset}
                onChange={(e) => setSlotGain(index, Number(e.target.value))}
              />
              <span>
                {slot.gainDbOffset > 0 ? "+" : ""}
                {slot.gainDbOffset.toFixed(1)}
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

/** Adds the library's current selection to a slot. Used by the keyboard layer. */
export function assignSelectionToSlot(slotIndex: number): void {
  const { rows, selectedIndex } = useLibrary.getState();
  const row = rows[selectedIndex];
  if (row === undefined) return;
  useKit.getState().assign(slotIndex, row);
}
