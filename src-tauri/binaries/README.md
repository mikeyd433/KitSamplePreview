# ffmpeg sidecar

SPEC §3 ships ffmpeg as a Tauri sidecar rather than assuming it on `PATH`. The
binary is deliberately **not committed** — it is ~80 MB and not ours to
redistribute.

## When you actually need it

Not often, and that is a Phase 0 finding rather than an assumption. SPEC §7.8
expected a conversion before every hand-off to Sitala, because §11.2 thought
Sitala might reject 32-bit float or non-44.1k rates. It rejects neither: it
took every format tested, including AIFF. So:

- **Drag-out never converts.** The original file goes across untouched.
- **Export converts only when asked.** Leave sample rate, bit depth and
  channels as-is and skip the gain options, and export is a byte-for-byte copy
  that never invokes ffmpeg.

You need the sidecar when you want an export at a specific rate, depth or
channel count, or with slot gain or normalization baked in.

## Adding it

1. Get a static Windows build (gyan.dev or BtbN both publish one).
2. Rename it `ffmpeg-x86_64-pc-windows-msvc.exe` — Tauri requires the target
   triple suffix — and put it in this folder.
3. Add it to `tauri.conf.json` so it ships with the installer:

   ```json
   "bundle": {
     "externalBin": ["binaries/ffmpeg"]
   }
   ```

In development the app also accepts a plain `ffmpeg.exe` beside the executable,
and an explicit path in settings (`export.ffmpegPath`) overrides both.

The export dialog checks for it up front, so a missing sidecar shows as a
disabled option rather than a failure after you press go.
