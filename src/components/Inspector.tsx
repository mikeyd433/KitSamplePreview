import { useEffect, useRef, useState } from "react";

import { useLibrary } from "../stores/library";
import { playheadFraction } from "../audio/preview";
import { previewGainDb, type NormalizeMode } from "../audio/gain";
import { formatChannels, formatDuration } from "./format";
import { Waveform } from "./Waveform";

const WAVE_WIDTH = 264;

/** The right-hand pane (SPEC §6): the selected sample, in detail. */
export function Inspector(): React.JSX.Element {
  const rows = useLibrary((s) => s.rows);
  const selectedIndex = useLibrary((s) => s.selectedIndex);
  const detail = useLibrary((s) => s.detail);
  const normalize = useLibrary((s) => s.normalize);
  const setNormalizeMode = useLibrary((s) => s.setNormalizeMode);
  const setNormalizeTarget = useLibrary((s) => s.setNormalizeTarget);
  const replay = useLibrary((s) => s.replay);
  const toggleFavorite = useLibrary((s) => s.toggleFavorite);
  const setTagsForSelected = useLibrary((s) => s.setTagsForSelected);
  const rowErrors = useLibrary((s) => s.rowErrors);

  const row = rows[selectedIndex];
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const frame = useRef<number | null>(null);

  // Poll the audio clock rather than run a timer of our own: the context time
  // is what the sound is actually playing against, so the playhead cannot
  // drift away from it.
  useEffect(() => {
    if (row === undefined) return;
    const tick = (): void => {
      setPlayhead(playheadFraction(row.id));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [row]);

  if (row === undefined) {
    return (
      <aside className="inspector">
        <p className="empty">Nothing selected.</p>
      </aside>
    );
  }

  const fault = row.probeError ?? rowErrors[row.id] ?? null;
  const gain = previewGainDb(row, normalize);
  const tags = detail !== null && detail.id === row.id ? detail.tags : [];
  const isFavorite = tags.includes("favorite");

  return (
    <aside className="inspector">
      <div className="inspector-wave">
        {/* Clicking does not seek: a drum one-shot auditioned from the middle
            is meaningless, and preview always plays from the true start
            (SPEC §7.4, §7.2). */}
        <Waveform
          sampleId={row.id}
          peaks={row.peaks}
          width={WAVE_WIDTH}
          height={84}
          playhead={playhead}
          color="#8b8b9c"
        />
      </div>

      <h3 className="inspector-name" title={row.relPath}>
        {row.filename}
      </h3>

      <dl className="facts">
        <div>
          <dt>format</dt>
          <dd>
            {row.sampleRate === null ? "—" : `${(row.sampleRate / 1000).toFixed(1)}k`}
            {row.bitDepth !== null && ` · ${row.bitDepth}b`}
            {` · ${formatChannels(row.channels)}`}
          </dd>
        </div>
        <div>
          <dt>length</dt>
          <dd>{formatDuration(row.durationMs)}</dd>
        </div>
        <div>
          <dt>peak</dt>
          <dd>{row.truePeakDb === null ? "—" : `${row.truePeakDb.toFixed(1)} dB`}</dd>
        </div>
        <div>
          <dt>body</dt>
          <dd>{row.bodyRmsDb === null ? "—" : `${row.bodyRmsDb.toFixed(1)} dB`}</dd>
        </div>
      </dl>

      {fault !== null && <p className="inspector-fault">{fault}</p>}

      <div className="inspector-actions">
        <button onClick={() => replay()}>▶ replay</button>
        <button
          className={isFavorite ? "fav on" : "fav"}
          onClick={() => void toggleFavorite()}
          title="Toggle favourite (*)"
        >
          {isFavorite ? "★" : "☆"}
        </button>
      </div>

      <section className="normalize">
        <h4>preview level</h4>
        <div className="seg">
          {(["off", "peak", "body"] as const).map((mode) => (
            <button
              key={mode}
              className={normalize.mode === mode ? "active" : ""}
              onClick={() => setNormalizeMode(mode)}
              title={titleFor(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        {normalize.mode !== "off" && (
          <>
            <label className="target">
              <span>
                target {normalize.mode === "peak" ? "peak" : "RMS"}
              </span>
              <input
                type="range"
                min={-36}
                max={0}
                step={1}
                value={normalize.mode === "peak" ? normalize.targetPeakDb : normalize.targetRmsDb}
                onChange={(e) =>
                  setNormalizeTarget(
                    normalize.mode === "peak" ? "peak" : "body",
                    Number(e.target.value),
                  )
                }
              />
              <span className="num">
                {normalize.mode === "peak" ? normalize.targetPeakDb : normalize.targetRmsDb} dB
              </span>
            </label>
            <p className="applied">
              applying {gain >= 0 ? "+" : ""}
              {gain.toFixed(1)} dB
              {Math.abs(gain) >= 12 && <span className="warn"> · clamped</span>}
            </p>
          </>
        )}
      </section>

      <section className="tags">
        <h4>tags</h4>
        <div className="tag-row">
          {tags.length === 0 && <span className="dim">none</span>}
          {tags.map((tag) => (
            <button
              key={tag}
              className="chip"
              title="Remove"
              onClick={() => void setTagsForSelected(tags.filter((t) => t !== tag))}
            >
              {tag} ×
            </button>
          ))}
        </div>
        <input
          type="text"
          className="tag-input"
          placeholder="add a tag…"
          value={tagDraft}
          spellCheck={false}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const tag = tagDraft.trim().toLowerCase();
            setTagDraft("");
            if (tag !== "" && !tags.includes(tag)) void setTagsForSelected([...tags, tag]);
          }}
        />
      </section>
    </aside>
  );
}

function titleFor(mode: NormalizeMode): string {
  switch (mode) {
    case "off":
      return "Files play at their recorded level";
    case "peak":
      return "Match true peak — simple and predictable, but one stray transient makes a sample quiet";
    case "body":
      return "Match the RMS of the loudest 300 ms — behaves sensibly across the range one-shots occupy";
  }
}
