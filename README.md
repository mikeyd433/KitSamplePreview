# Kitbench

A drum-sample auditioner that sits beside REAPER: point it at a folder,
arrow-key through samples with instant playback, collect the winners into a
16-slot tray, and drag them onto Sitala's pads.

Windows only. Working name — see [`SPEC.md`](SPEC.md) §0.

## Status: usable

Phases 0–3 of [`SPEC.md`](SPEC.md) §9 are built. Phase 4 (context auditioning)
was dropped as unnecessary; Phase 5 was always deferred.

```
npm install
npm start
```

That is the development loop — it needs a terminal and rebuilds as you edit.

### A desktop icon

```powershell
cd C:\Users\micha\KitSamplePreview
git pull
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
.\scripts\update-kitbench.ps1
```

Pulls, builds a release binary, and puts a **Kitbench** shortcut on your
Desktop pointing at it. Launching from the icon after that is instant.

Updating is deliberately a separate step from launching: a release build takes
minutes, and an icon that rebuilt on every double-click would be unusable. Run
the script again whenever you want the latest.

The status bar shows the version and the commit the running binary was built
from, so "am I on the latest?" is answerable by looking. A trailing `+` means it
was built from a working tree with uncommitted changes, and an amber badge says
the same thing more loudly.

Add a library root, and it scans. Then:

| key | |
|---|---|
| `↑` `↓` `←` `→` | move the selection — **the newly selected sample plays immediately** |
| `Space` | replay |
| `1234` `QWER` `ASDF` `ZXCV` | assign the selection to that pad, in the tray's 4×4 layout |
| `Enter` | assign to the next empty pad |
| `/` | focus search · `Esc` clears it |
| `*` | toggle favourite |

Drag a list row, a tile, or a kit pad straight onto a Sitala pad. Or use
**export kit…** to write the tray to a folder as `01_…` through `16_…`, so
alphabetical order in Explorer matches pad order.

## What it does not do

Deliberately, per SPEC §2. It is not a sampler, not a library manager, not a
DAW. It never modifies your sample files — it reads them, and writes only its
own index and whatever you explicitly export. It does not talk to REAPER or to
Sitala through any API; the only interface is a file drag.

## Layout

```
src/            React frontend
  audio/          engine, preview voice, decoded-buffer LRU, peaks, gain (no React)
  components/     list, tiles, inspector, kit tray, export
  stores/         library and kit state
  keyboard/       the single global key handler
  ipc/            typed wrappers over the Rust commands
src-tauri/src/  scan (walk, probe, analyse), db, convert, commands
scripts/        test-corpus generator
docs/           Phase 0 results
```

## Why the design is what it is

Before any of this was built, a throwaway spike answered the one question the
whole thing rested on: can a file be dragged from a Tauri window onto a Sitala
pad and be accepted? It can.
[`docs/phase-0-results.md`](docs/phase-0-results.md) is that report, and it is
worth reading before changing anything near the drag or the export paths — it
records several findings that changed the plan:

- **Sitala accepts every audio format tested**, including AIFF and 32-bit float
  at 96 kHz. So nothing is converted on the way out, and SPEC §7.8's
  pre-conversion machinery was never built.
- **WebView2 refuses AIFF**, and nothing else. Conversion is needed for
  *preview*, not for the drag — the opposite of what the spec assumed.
- **A path over MAX_PATH crashes the drag plugin outright**, taking the process
  with it. It has to be refused before the plugin is called; that guard lives
  in `paths.rs`.

Two of its questions are still open and neither blocks anything: what Sitala
does with a two-file drop, and whether MP3/FLAC/OGG survive both decoders.

The spike app itself is gone, as SPEC §14 directs.

## Test corpus

```
npm run corpus
```

Generates files in awkward formats and paths — every bit depth, integer and
float, 8 kHz to 96 kHz, AIFF and AIFC, PCM behind metadata chunks, three broken
files, and paths with spaces, non-ASCII and over-MAX_PATH nesting. Point a
library root at it to exercise the scanner at its edges.

Not a stand-in for real samples: SPEC §15 is explicit that the app is built and
judged against a real sample pack. These files are format torture, and their
value is that their headers are known.

## Tests

```
npm run typecheck
cd src-tauri && cargo test
```

The Rust tests cover the three things SPEC §15 names as worth testing, because
each is easy to get subtly wrong and hard to notice: path canonicalization,
peak/RMS analysis against generated signals with known values, and `search_text`
normalization.
