# Kitbench

A drum-sample auditioner that sits beside REAPER: point it at a folder,
arrow-key through samples with instant playback, hear candidates over a groove,
collect the winners into a 16-slot tray, and drag them onto Sitala's pads.

Windows only. Working name — see [`SPEC.md`](SPEC.md) §0.

## Status: Phase 0, awaiting results

The whole design rests on one unvalidated assumption: that a file can be dragged
out of a Tauri window onto a Sitala pad and be accepted (SPEC §11.1). SPEC §14
makes answering that a half-day throwaway spike that gates everything else.

That spike is built and lives in [`spike/`](spike/). It has not been run — it
needs Windows with REAPER and Sitala. **Nothing else in the spec gets built
until [`spike/RESULTS.md`](spike/RESULTS.md) is filled in and an outcome branch
is chosen.**

Start at [`spike/README.md`](spike/README.md).
