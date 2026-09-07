import { useState } from "react";

import { useLibrary } from "../stores/library";

const CATEGORIES = ["kick", "snare", "hat", "clap", "tom", "perc", "cymbal", "808", "vox", "fx"];

/**
 * Refile everything currently listed.
 *
 * Inference gets folder names wrong -- SPEC §7.1 says so plainly -- and with
 * packs that each name the same drum differently, correcting samples one at a
 * time is not a real option. Filtering to a folder and refiling all of it in
 * one go is: 44 files, one click.
 *
 * Only appears when the view is narrowed, because "apply to everything" with no
 * filter set is never what anyone means.
 */
export function Recategorize(): React.JSX.Element | null {
  const total = useLibrary((s) => s.total);
  const rows = useLibrary((s) => s.rows);
  const subtree = useLibrary((s) => s.subtree);
  const text = useLibrary((s) => s.text);
  const category = useLibrary((s) => s.category);
  const recategorizeVisible = useLibrary((s) => s.recategorizeVisible);

  const [open, setOpen] = useState(false);

  const narrowed = subtree !== null || text.trim() !== "" || category !== null;
  if (!narrowed || rows.length === 0) return null;

  const apply = (value: string | null, clear = false): void => {
    setOpen(false);
    void recategorizeVisible(value, clear);
  };

  return (
    <div className="recat">
      <button onClick={() => setOpen((v) => !v)} title="Set the type for every sample listed">
        file {total} as…
      </button>

      {open && (
        <div className="recat-menu">
          {CATEGORIES.map((name) => (
            <button key={name} onClick={() => apply(name)}>
              {name}
            </button>
          ))}
          <button onClick={() => apply(null)}>uncategorised</button>
          <button
            className="recat-reset"
            onClick={() => apply(null, true)}
            title="Forget the correction and let the filename guess apply again"
          >
            reset to guess
          </button>
        </div>
      )}
    </div>
  );
}
