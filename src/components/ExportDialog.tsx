import { useEffect, useState } from "react";

import * as ipc from "../ipc/commands";
import type { ExportReport } from "../ipc/commands";

/**
 * Export kit to a folder (SPEC §7.8).
 *
 * Every option defaults to leaving the audio alone, which after Phase 0 is not
 * just a safe default but the right one: Sitala accepted every format tested,
 * so a plain copy is what usually wants to happen. That also means the common
 * export needs no ffmpeg at all — the sidecar only matters once an option here
 * is changed, and the dialog says so rather than failing after the fact.
 */
export function ExportDialog({
  kitId,
  onClose,
}: {
  kitId: number;
  onClose: () => void;
}): React.JSX.Element {
  const [dest, setDest] = useState("");
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  const [bitDepth, setBitDepth] = useState<number | null>(null);
  const [channels, setChannels] = useState<number | null>(null);
  const [applySlotGain, setApplySlotGain] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasFfmpeg, setHasFfmpeg] = useState<boolean | null>(null);

  useEffect(() => {
    ipc.ffmpegAvailable().then(setHasFfmpeg).catch(() => setHasFfmpeg(false));
  }, []);

  const converting =
    sampleRate !== null || bitDepth !== null || channels !== null || applySlotGain || normalize;
  const blockedOnFfmpeg = converting && hasFfmpeg === false;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setReport(
        await ipc.exportKit(kitId, dest.trim(), {
          sampleRate,
          bitDepth,
          channels,
          applySlotGain,
          normalize,
        }),
      );
    } catch (e) {
      setError(ipc.errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h3>Export kit</h3>
        <p className="note">
          Writes every filled pad as <code>01_name.wav</code> … <code>16_name.wav</code>, so
          alphabetical order in Explorer matches pad order. Always copies; never touches your
          source files.
        </p>

        <label className="field">
          <span>destination folder</span>
          <input
            type="text"
            spellCheck={false}
            value={dest}
            placeholder={String.raw`C:\Kits\Dusty Break`}
            onChange={(e) => setDest(e.target.value)}
          />
        </label>

        <div className="opts">
          <label className="field">
            <span>sample rate</span>
            <select
              value={sampleRate ?? ""}
              onChange={(e) => setSampleRate(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">leave as-is</option>
              <option value="44100">44.1 kHz</option>
              <option value="48000">48 kHz</option>
            </select>
          </label>

          <label className="field">
            <span>bit depth</span>
            <select
              value={bitDepth ?? ""}
              onChange={(e) => setBitDepth(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">leave as-is</option>
              <option value="16">16-bit</option>
              <option value="24">24-bit</option>
              <option value="32">32-bit float</option>
            </select>
          </label>

          <label className="field">
            <span>channels</span>
            <select
              value={channels ?? ""}
              onChange={(e) => setChannels(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">leave as-is</option>
              <option value="1">mono</option>
              <option value="2">stereo</option>
            </select>
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={applySlotGain}
            onChange={(e) => setApplySlotGain(e.target.checked)}
          />
          bake in per-pad gain offsets
        </label>
        <label className="check">
          <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          normalize levels on the way out
        </label>

        {blockedOnFfmpeg && (
          <p className="warn-box">
            Those options re-encode, which needs the ffmpeg sidecar — and it is not installed.
            See <code>src-tauri/binaries/README.md</code>. Leave every option as-is and the export
            is a straight copy that works without it.
          </p>
        )}

        {error !== null && <p className="warn-box err">{error}</p>}

        {report !== null && (
          <div className="report">
            <p>
              Wrote {report.written.length} file{report.written.length === 1 ? "" : "s"} to{" "}
              <code>{report.destDir}</code>.
            </p>
            {report.skipped.length > 0 && (
              <ul className="skipped">
                {report.skipped.map((skip) => (
                  <li key={skip.slotIndex}>
                    pad {skip.slotIndex + 1}: {skip.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={onClose}>{report === null ? "cancel" : "close"}</button>
          <button
            onClick={() => void run()}
            disabled={busy || dest.trim() === "" || blockedOnFfmpeg}
          >
            {busy ? "exporting…" : "export"}
          </button>
        </div>
      </div>
    </div>
  );
}
