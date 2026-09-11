import { useState } from "react";

import {
  useKit,
  spreadSemitones,
  MIN_SEMITONES,
  MAX_SEMITONES,
  DEFAULT_SPREAD,
  SLOT_COUNT,
} from "../stores/kit";
import { useLibrary } from "../stores/library";
import { formatSemitones, noteName } from "./KitTray";

/**
 * One sample across all sixteen pads, pitched: the piano.
 *
 * Not in SPEC §7 -- it predates seeing a drill library, where the thing you
 * want from a single 808 is a bassline rather than one pad. Sitala has no
 * per-pad tuning, so the only way to play a tuned 808 through it is to hand it
 * sixteen already-tuned files, which is exactly what this makes.
 *
 * Two controls, because they are the two independent things about a range:
 * where it starts, and how far apart the steps are. `root` shifts the whole
 * spread without changing its shape -- the "shift the range" half -- and `step`
 * sets the interval, 1 for chromatic, 12 for octaves, 7 to lay out fifths.
 */
export function Chromatic(): React.JSX.Element | null {
  const rows = useLibrary((s) => s.rows);
  const selectedIndex = useLibrary((s) => s.selectedIndex);
  const spreadChromatic = useKit((s) => s.spreadChromatic);
  const rendering = useKit((s) => s.rendering);

  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState(DEFAULT_SPREAD.root);
  const [step, setStep] = useState(DEFAULT_SPREAD.step);

  const sample = rows[selectedIndex] ?? null;

  const offsets = spreadSemitones({ root, step });
  const first = offsets[0] ?? 0;
  const last = offsets[SLOT_COUNT - 1] ?? 0;
  // A step wide enough to run past two octaves fills the tail with duplicates
  // of the ceiling. Better to say so than to let sixteen pads quietly become
  // eleven distinct notes.
  const clampedCount = offsets.filter(
    (semitones, i) => semitones !== root + i * step,
  ).length;

  return (
    <div className="chromatic">
      <button
        className="chromatic-toggle"
        onClick={() => setOpen((v) => !v)}
        disabled={sample === null}
        title={
          sample === null
            ? "Select a sample first"
            : `Spread ${sample.filename} across all ${SLOT_COUNT} pads, pitched`
        }
      >
        chromatic…
      </button>

      {open && sample !== null && (
        <div className="chromatic-menu">
          <p className="chromatic-source" title={sample.relPath}>
            {sample.filename}
          </p>

          <label>
            <span>root</span>
            <input
              type="range"
              min={MIN_SEMITONES}
              max={MAX_SEMITONES}
              step={1}
              value={root}
              onChange={(e) => setRoot(Number(e.target.value))}
            />
            <span className="chromatic-value">{formatSemitones(root)}</span>
          </label>

          <label>
            <span>step</span>
            <input
              type="range"
              min={1}
              max={12}
              step={1}
              value={step}
              onChange={(e) => setStep(Number(e.target.value))}
            />
            <span className="chromatic-value">{step}</span>
          </label>

          <p className="chromatic-range">
            pad 1 {noteName(first)} → pad {SLOT_COUNT} {noteName(last)}
            <span className="dim">
              {" "}
              ({formatSemitones(first)} to {formatSemitones(last)} st)
            </span>
          </p>

          {clampedCount > 0 && (
            <p className="chromatic-warn">
              {clampedCount} pad{clampedCount === 1 ? "" : "s"} past the two-octave
              limit, held at {noteName(last)}. Lower the step or the root to
              spread them out.
            </p>
          )}

          <p className="dim chromatic-note">
            Varispeed, like a hardware sampler: up is shorter, down is longer.
          </p>

          <button
            className="chromatic-apply"
            onClick={() => {
              setOpen(false);
              spreadChromatic(sample, { root, step });
            }}
          >
            fill all {SLOT_COUNT} pads
          </button>
        </div>
      )}

      {rendering > 0 && (
        <span className="chromatic-rendering" title="Writing the pitched files so the pads can be dragged">
          rendering {rendering}…
        </span>
      )}
    </div>
  );
}
