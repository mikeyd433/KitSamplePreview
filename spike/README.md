# Phase 0 spike — drag-out

Throwaway. It answers one question and then gets deleted:

> Can a file be dragged from a Tauri v2 window onto a Sitala pad inside REAPER
> on Windows and be accepted?

Per SPEC §14, nothing else in the spec gets built until this reports back.
Budget is half a day; if it runs long, that is itself a finding worth writing
down rather than pushing through.

## What is deliberately absent

No SQLite, no scan pipeline, no audio engine, no list, no kit tray. This is not
Kitbench and none of it should be carried forward — Phase 1 starts from a clean
scaffold.

## Prerequisites

- Windows, with **REAPER** and **Sitala** installed (Sitala as a plugin, not the
  standalone build — the drop target being a host-owned child window is exactly
  the configuration under test).
- Node 20.19+ and a Rust toolchain with the MSVC target.
- The WebView2 runtime (present on Windows 11 and current Windows 10).

## Run it

```
cd spike
npm install
npm run spike        # tauri dev
```

`npm run typecheck` type-checks the frontend; `cargo test` in `src-tauri/` runs
the header-sniffer tests.

## What to do

1. **Fill in the paths.** SPEC §14 says hardcode them, but rows 3, 4, 5 and 9
   need paths with spaces, non-ASCII characters, a UNC share and over-260-char
   nesting — those are specific to your machine and cannot be usefully baked in.
   The fields are editable and persist to `localStorage`, so the matrix survives
   a reload.

   `npm run corpus` makes most of what you need — see below. Row 5 (UNC) still
   needs a reachable share, and rows 1, 2, 6, 7 and 8 want real samples you
   recognise by ear. Note a row as skipped rather than guessing at it.

2. **Watch the pre-flight table** under each row. It shows what
   `dunce::canonicalize` makes of the path, which is the string the shell
   actually receives — not necessarily what you typed. This is where UNC and
   MAX_PATH surprises show up before a drag is even attempted.

3. **Work the matrix.** Drag each row's handle onto the target named in the row.
   Try both trigger modes (`dragstart` and `mousedown`) at least once; which one
   works is itself unknown.

4. **Read the badge, but trust your ears.** `Dropped` is Windows'
   `DRAGDROP_S_DROP` — the target accepted the data object. It does not prove
   Sitala mapped the sample to the pad. Confirm that separately.

5. **Run the decode bench** against `test-corpus/decode`. Each file is decoded
   twice, once through the asset protocol and once from bytes handed over IPC,
   so a failure is attributable: asset fails where ipc succeeds ⇒ asset protocol
   scope (SPEC §3), both fail ⇒ WebView2 genuinely refuses the format.

   Watch the peak column as well as the badges. Every generated file peaks at
   0.500, so a row that decodes but comes back 0.000 decoded to silence, and
   anything else decoded wrong. Both are quieter failures than a refusal. Files
   above 44.1 kHz land slightly under 0.500 because `decodeAudioData` resamples
   to the AudioContext rate — that is the resampler, not a fault.

6. **Fill in `RESULTS.md`** and stop. The log pane and the decode table both
   have *copy as markdown* buttons that paste straight into it.

## Test corpus

```
npm run corpus                 # → spike/test-corpus/
npm run corpus -- D:\somewhere  # or wherever you like
```

Generates the files that are tedious to assemble by hand, and prints the exact
paths to paste into rows 3, 4 and 9:

- `decode/` — every bit depth and container combination worth testing: 8-bit
  unsigned, 16/24/32-bit integer, 32-bit float both as tag 3 and as
  `WAVE_FORMAT_EXTENSIBLE`, 8 kHz through 96 kHz, mono and stereo, AIFF, AIFC
  `sowt`, a WAV with JUNK/LIST/bext chunks ahead of `fmt `, and three broken
  files (truncated, header-only, zero-byte) that must fail cleanly.
- `paths/` — a path with spaces, a path with accented and CJK characters, and a
  nesting deep enough to clear MAX_PATH.

MP3, FLAC and OGG need an encoder, so they appear only if `ffmpeg` is on your
PATH; otherwise copy a few real ones in, because SPEC §8 expects all three to
work. (Unrelated to the bundled ffmpeg sidecar §3 specifies for the real app.)

This is format torture for the decode bench, not a sample library. SPEC §15's
"never fake data" still governs every phase after this one — Phase 1 gets
pointed at a real sample pack.

## Notes on the rig

- Drag mode is pinned to `copy`. The plugin also offers `move`, which permits a
  drop target to relocate the source file; aiming that at a real sample library
  is not worth the finding.
- `dragDropEnabled: false` is set on the window. With Tauri's own file-drop
  handler active the webview never emits `dragstart` on Windows, which would
  make that trigger mode look broken for reasons unrelated to Sitala.
- The window freezes while a drag is in flight. `DoDragDrop` blocks the main
  thread until the drop completes; log entries queued during a drag appear all
  at once afterwards. Expected, not a bug.
- Two rows (9 and 10) go beyond SPEC §14's eight. Row 9 covers the MAX_PATH
  hazard SPEC §3 raises; row 10 only matters if row 1 fails. Skip either without
  affecting the spec's outcome branches.
