import { useCallback, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { errorText, readFileBytes, scanDecodeDir, type AudioFile } from "../lib/ipc";
import { loadJSON, saveJSON } from "../lib/persist";
import { log } from "../lib/log";

/**
 * SPEC §14's second test: which formats does WebView2's `decodeAudioData`
 * actually refuse?
 *
 * Each file is decoded twice, from two different byte sources:
 *
 *   asset — convertFileSrc → fetch → arrayBuffer → decodeAudioData. This is
 *           the real Phase 1 path (SPEC §8), so it also exercises the asset
 *           protocol scope that SPEC §3 warns about.
 *   ipc   — bytes read by Rust and returned over IPC → decodeAudioData.
 *
 * The pair is what makes a failure attributable. asset fails and ipc succeeds
 * ⇒ the asset protocol or its scope is at fault, not the decoder. Both fail
 * ⇒ WebView2 genuinely will not decode that format and the ffmpeg fallback
 * has to cover it.
 */

interface DecodeOk {
  ok: true;
  /** Frames ÷ the buffer's own rate. */
  durationMs: number;
  channels: number;
  /**
   * decodeAudioData resamples to the AudioContext rate, so this is the
   * context's rate — NOT the file's. The sniffed column carries the file's.
   */
  bufferSampleRate: number;
  /** Largest absolute sample. Distinguishes "decoded" from "decoded to silence". */
  peak: number;
}
type DecodeResult = DecodeOk | { ok: false; error: string } | null;

interface Row {
  file: AudioFile;
  assetUrl: string;
  assetFetchError: string | null;
  assetDecode: DecodeResult;
  ipcReadError: string | null;
  ipcDecode: DecodeResult;
  running: boolean;
}

function blankRow(file: AudioFile): Row {
  return {
    file,
    assetUrl: convertFileSrc(file.path),
    assetFetchError: null,
    assetDecode: null,
    ipcReadError: null,
    ipcDecode: null,
    running: false,
  };
}

/**
 * Rejects if `p` has not settled in `ms`.
 *
 * Not defensive padding: a zero-byte file in the corpus made `decodeAudioData`
 * return a promise that never settled at all, which stalled the whole run and
 * left every later row showing "—" — indistinguishable from a run that had
 * finished. A bench that can quietly stop early is worse than no bench, since
 * the missing rows look like results.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} did not settle within ${ms} ms — treating as a failure`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

const DECODE_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;

async function decode(ctx: AudioContext, bytes: ArrayBuffer): Promise<DecodeResult> {
  if (bytes.byteLength === 0) {
    return { ok: false, error: "empty file — nothing to decode" };
  }
  try {
    // decodeAudioData detaches the buffer it is given, so each attempt needs
    // its own copy or the second one fails for the wrong reason.
    const buffer = await withTimeout(
      ctx.decodeAudioData(bytes.slice(0)),
      DECODE_TIMEOUT_MS,
      "decodeAudioData",
    );
    let peak = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] ?? 0);
        if (v > peak) peak = v;
      }
    }
    return {
      ok: true,
      durationMs: Math.round(buffer.duration * 1000),
      channels: buffer.numberOfChannels,
      bufferSampleRate: buffer.sampleRate,
      peak,
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export function DecodeBench(): React.JSX.Element {
  const [dir, setDir] = useState<string>(() => loadJSON<string>("decodeDir", ""));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);

  const audioCtx = (): AudioContext => {
    ctxRef.current ??= new AudioContext();
    return ctxRef.current;
  };

  const scan = useCallback(async (): Promise<void> => {
    const target = dir.trim();
    if (target.length === 0) return;
    saveJSON("decodeDir", target);
    setBusy(true);
    try {
      const files = await scanDecodeDir(target);
      setRows(files.map(blankRow));
      log.ok(
        "decode",
        `scanned ${target} — ${files.length} audio file(s); asset protocol scope extended to that folder`,
      );
      if (files.length === 0) {
        log.warn("decode", "no audio files matched — check the folder path and extensions");
      }
    } catch (e) {
      log.error("decode", "scan_decode_dir failed", errorText(e));
    } finally {
      setBusy(false);
    }
  }, [dir]);

  // Takes the row rather than reading it back out of state: `file`, `path` and
  // `assetUrl` are fixed at scan time, so the caller already holds everything
  // this needs, and peeking at state from inside an updater misbehaves under
  // StrictMode's double-invoke.
  const runRow = useCallback(async (index: number, row: Row): Promise<void> => {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, running: true } : r)));
    const ctx = audioCtx();

    let assetFetchError: string | null = null;
    let assetDecode: DecodeResult = null;
    try {
      const res = await withTimeout(fetch(row.assetUrl), READ_TIMEOUT_MS, "asset fetch");
      if (!res.ok) {
        assetFetchError = `HTTP ${res.status} ${res.statusText}`;
      } else {
        const bytes = await withTimeout(res.arrayBuffer(), READ_TIMEOUT_MS, "asset arrayBuffer");
        assetDecode = await decode(ctx, bytes);
      }
    } catch (e) {
      // The SPEC §3 trap: a scope miss surfaces here as a bare network error
      // and reads exactly like a decode bug.
      assetFetchError = `${errorText(e)} (asset protocol scope? see SPEC §3)`;
    }

    let ipcReadError: string | null = null;
    let ipcDecode: DecodeResult = null;
    try {
      const bytes = await withTimeout(
        readFileBytes(row.file.path),
        READ_TIMEOUT_MS,
        "read_file_bytes",
      );
      ipcDecode = await decode(ctx, bytes);
    } catch (e) {
      ipcReadError = errorText(e);
    }

    const verdict =
      assetDecode?.ok === true && ipcDecode?.ok === true
        ? "ok"
        : assetDecode?.ok !== true && ipcDecode?.ok === true
          ? "asset-protocol-only failure"
          : "decoder refuses this format";
    log[verdict === "ok" ? "ok" : "warn"](
      "decode",
      `${row.file.name} — ${verdict}`,
      { format: row.file.format, assetFetchError, assetDecode, ipcReadError, ipcDecode },
    );

    setRows((rs) =>
      rs.map((r, i) =>
        i === index
          ? { ...r, assetFetchError, assetDecode, ipcReadError, ipcDecode, running: false }
          : r,
      ),
    );
  }, []);

  const runAll = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      for (const [i, row] of rows.entries()) {
        // One pathological file must not end the run; the rows after it would
        // read as "not reached" and be mistaken for results.
        try {
          await runRow(i, row);
        } catch (e) {
          log.error("decode", `${row.file.name} — row aborted`, errorText(e));
          setRows((rs) => rs.map((r, j) => (j === i ? { ...r, running: false } : r)));
        }
      }
    } finally {
      setBusy(false);
    }
  }, [rows, runRow]);

  const copyMarkdown = useCallback(async (): Promise<void> => {
    const header =
      "| file | sniffed format | asset fetch | asset decode | ipc decode | peak |\n" +
      "|---|---|---|---|---|---|\n";
    const body = rows
      .map((r) => {
        const f = r.file.format;
        const fmt = [
          f.container,
          f.codec,
          f.bitDepth === null ? null : `${f.bitDepth}-bit`,
          f.sampleRate === null ? null : `${f.sampleRate} Hz`,
          f.channels === null ? null : `${f.channels}ch`,
        ]
          .filter((x): x is string => x !== null && x !== "")
          .join(" · ");
        const d = (x: DecodeResult): string =>
          x === null ? "—" : x.ok ? "ok" : `FAIL: ${x.error}`;
        const peak =
          r.ipcDecode?.ok === true
            ? r.ipcDecode.peak.toFixed(3)
            : r.assetDecode?.ok === true
              ? r.assetDecode.peak.toFixed(3)
              : "—";
        return `| ${r.file.name} | ${fmt} | ${r.assetFetchError ?? "ok"} | ${d(r.assetDecode)} | ${d(r.ipcDecode)} | ${peak} |`;
      })
      .join("\n");
    const md = header + body + "\n";
    try {
      await navigator.clipboard.writeText(md);
      log.ok("decode", "results table copied to the clipboard — paste into RESULTS.md");
    } catch (e) {
      log.warn("decode", `clipboard unavailable (${errorText(e)}) — table is in this entry`, md);
    }
  }, [rows]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>2 · decodeAudioData bench</h2>
        <div className="controls">
          <button onClick={() => void runAll()} disabled={busy || rows.length === 0}>
            run all
          </button>
          <button onClick={() => void copyMarkdown()} disabled={rows.length === 0}>
            copy results as markdown
          </button>
        </div>
      </header>

      <p className="note">
        Point this at one folder holding the awkward cases: 8-, 16-, 24-bit and 32-bit float WAV,
        mono and stereo, 96 kHz, AIFF, MP3, FLAC, OGG. Two decode attempts per file, from two byte
        sources — if <code>asset</code> fails where <code>ipc</code> succeeds, the fault is the
        asset protocol scope, not the decoder.
      </p>

      <div className="dir-row">
        <input
          type="text"
          spellCheck={false}
          value={dir}
          placeholder={String.raw`C:\Samples\_decode_test`}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void scan();
          }}
        />
        <button onClick={() => void scan()} disabled={busy || dir.trim().length === 0}>
          scan folder
        </button>
      </div>

      {rows.length > 0 && (
        <table className="decode">
          <thead>
            <tr>
              <th>file</th>
              <th>sniffed format (from the file's own header)</th>
              <th>asset</th>
              <th>ipc</th>
              <th>decoded</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.file.path}>
                <td className="mono">{r.file.name}</td>
                <td>
                  <FormatCell row={r} />
                </td>
                <td>
                  <ResultCell error={r.assetFetchError} result={r.assetDecode} />
                </td>
                <td>
                  <ResultCell error={r.ipcReadError} result={r.ipcDecode} />
                </td>
                <td className="mono small">
                  <DecodedSummary row={r} />
                </td>
                <td>
                  <button onClick={() => void runRow(i, r)} disabled={r.running || busy}>
                    {r.running ? "…" : "run"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function FormatCell({ row }: { row: Row }): React.JSX.Element {
  const f = row.file.format;
  const bits = [
    f.container,
    f.codec,
    f.bitDepth === null ? null : `${f.bitDepth}-bit`,
    f.sampleRate === null ? null : `${f.sampleRate} Hz`,
    f.channels === null ? null : f.channels === 1 ? "mono" : f.channels === 2 ? "stereo" : `${f.channels}ch`,
    f.durationMs === null ? null : `${f.durationMs} ms`,
  ].filter((x): x is string => x !== null && x !== "");
  return (
    <span className="small">
      {bits.join(" · ")}
      {f.note !== null && <span className="tag">{f.note}</span>}
    </span>
  );
}

function ResultCell({
  error,
  result,
}: {
  error: string | null;
  result: DecodeResult;
}): React.JSX.Element {
  if (error !== null) return <span className="badge badge-err" title={error}>read fail</span>;
  if (result === null) return <span className="badge badge-idle">—</span>;
  if (result.ok) return <span className="badge badge-ok">ok</span>;
  return <span className="badge badge-err" title={result.error}>refused</span>;
}

function DecodedSummary({ row }: { row: Row }): React.JSX.Element {
  const r = row.ipcDecode?.ok === true ? row.ipcDecode : row.assetDecode?.ok === true ? row.assetDecode : null;
  if (r === null) return <>—</>;
  return (
    <>
      {r.durationMs} ms · {r.channels}ch · peak {r.peak.toFixed(3)}
      {r.peak === 0 && <span className="tag warn">decoded to silence</span>}
      <span className="tag" title="decodeAudioData resamples to the AudioContext rate, so this is the context's rate, not the file's">
        ctx {Math.round(r.bufferSampleRate)} Hz
      </span>
    </>
  );
}
