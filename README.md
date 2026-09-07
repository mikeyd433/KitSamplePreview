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
spike/          Phase 0 throwaway — see below
```

## The spike

[`spike/`](spike/) answered the one question the whole design rested on: can a
file be dragged from a Tauri window onto a Sitala pad and be accepted?
[`spike/RESULTS.md`](spike/RESULTS.md) records that it can, along with several
findings that changed the plan — most importantly that Sitala accepts every
audio format tested, so nothing is converted on the way out, and that a path
over MAX_PATH crashes the drag plugin outright and has to be refused.

It is kept for now because two of its questions are still open: what Sitala
does with a two-file drop, and whether MP3/FLAC/OGG survive both decoders. It
can be deleted once those close.

## Tests

```
npm run typecheck
cd src-tauri && cargo test
```

The Rust tests cover the three things SPEC §15 names as worth testing, because
each is easy to get subtly wrong and hard to notice: path canonicalization,
peak/RMS analysis against generated signals with known values, and `search_text`
normalization.
