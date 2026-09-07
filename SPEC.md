# Kitbench — Drum Sample Auditioner

**Status:** spec, pre-implementation — no code exists yet
**Target platform:** Windows only. macOS and Linux are explicitly out of scope; do not add cross-platform abstractions for them.
**Working name:** "Kitbench" is provisional. Rename freely — it appears in `tauri.conf.json`, `Cargo.toml`, and `package.json`.

---

## 0. How to use this document

This is a complete, standalone implementation spec. It assumes no prior conversation and no existing code.

### Start here

**Read §14 and do only that.** §14 is a half-day throwaway spike that answers the one question the whole project depends on: can a file be dragged out of a Tauri window onto a Sitala pad on Windows? Everything from §1–§13 describes the app to build *after* that question is answered yes.

Do not scaffold the real project before §14 reports back. The spec is detailed enough to be tempting; resist it.

### The environment this runs in

- **Windows.** The developer's machine, with REAPER installed.
- **REAPER** is the DAW. **Sitala** is a free drum-sampler plugin that runs inside it: a 4×4 grid of pads, each holding one drum sample loaded by dragging a WAV file onto it. Sitala is the *target* of this tool, not something being modified or integrated with via any API — the only interface between Kitbench and Sitala is a file drag.
- The developer is comfortable with React/TypeScript and has shipped Tauri v2 apps before. Explanations of basic Tauri or React concepts are unnecessary; explanations of audio-specific decisions are welcome.

### How decisions are marked

- **Bold "Recommended" / "default"** — a decision already made. Implement it; don't relitigate it.
- **"Deferred" / "later" / "Phase 5"** — deliberately out of scope. Do not build it, even if it seems easy while you're in the neighborhood. §11.5 explains why this matters here specifically.
- **"Unverified" / "unknown"** — genuinely open. Find out empirically, don't guess, and report what you found.
- §12 lists what's resolved. Don't ask about those.

### When something isn't covered

Prefer the simplest thing that satisfies §2 (non-goals), §10 (performance targets), and §13 (the growth rules). If a choice would be hard to reverse later — schema shape, the scan pipeline's structure, how paths are stored — check §13 before picking; if it's a threshold, a cache size, or an index, pick something reasonable and move on.

Ask the developer when: Phase 0 fails or gets ambiguous results, a phase's scope seems wrong once you're inside it, or a decision would change §2.

### Conventions

See §15.

---

## 1. Problem

Mapping a drum kit in Sitala (or any pad sampler) means dragging WAVs from a file browser onto pads. The file browser gives you filenames and nothing else. You either commit a sample to a pad to hear it, or you preview it somewhere else and lose your place. With a 2,000-file sample library that round trip is the entire cost of building a kit.

Kitbench is a standalone desktop app that sits beside the DAW and makes auditioning fast: point it at a folder, arrow-key through samples with instant playback, hear candidates over a groove, collect the winners into a 16-slot tray, and drag them out onto Sitala's pads.

### Success criterion

Building a 16-pad kit from an unfamiliar sample library is faster and produces a kit you like more than doing it directly in Sitala. If drag-out to Sitala doesn't work, the app fails this test regardless of how good everything else is — see §11.1.

---

## 2. Non-goals

- **Not a sampler.** No MIDI-triggered kit playback for production, no plugin format, no VST/AU/CLAP build. Sitala remains the instrument.
- **Not a sample library manager.** No moving, renaming, or reorganizing the user's files on disk. Kitbench reads; it writes only to its own cache and to explicit export destinations.
- **Not a DAW.** The context loop (§7.5) is a monitoring aid, not a sequencer.
- **Not multi-user, not networked, not cloud.** Local files only.
- **No sample editing.** No trimming, no pitch shifting, no processing baked into exports beyond format conversion and optional gain normalization.

---

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri v2 | Windows target only |
| Frontend | React + Vite + TypeScript | Developer's existing stack; strict mode on |
| Audio playback | Web Audio API (in the webview) | See §8 for the rationale |
| Audio decode/analysis (scan-time) | `symphonia` (Rust) | WAV, FLAC, MP3, OGG, AIFF |
| Directory walk | `walkdir` + `rayon` | Parallel scan |
| Index | SQLite via `tauri-plugin-sql` | `LIKE` search in v1, FTS5 later — see §4 |
| Drag-out | `tauri-plugin-drag` (wraps `drag-rs`) | **Highest-risk dependency — see §11.1** |
| Format conversion | `ffmpeg.exe` as a Tauri sidecar binary | Bundled, not assumed present on PATH |
| File watching | `notify` (optional, phase 4) | |
| State | Zustand or equivalent | Keep it small; most state is derived from the index |

### Windows specifics

- **Webview is WebView2 (Chromium).** One engine, one set of audio-decode behaviors, no Safari/WebKit divergence to design around. This meaningfully de-risks §8.
- **Sidecar naming.** Tauri expects the target triple suffix: `ffmpeg-x86_64-pc-windows-msvc.exe`, declared in `tauri.conf.json` under `bundle.externalBin`.
- **Paths.** Backslash separators, drive letters, and UNC paths (`\\NAS\samples`) for network shares. Normalize to a canonical form on the Rust side before storing in `sample.path`, and store canonical — comparing `C:\Samples\kick.wav` against `c:/samples/kick.wav` on rescan will otherwise produce phantom adds.
- **MAX_PATH.** Deeply nested sample libraries can exceed 260 characters. Use `\\?\`-prefixed paths in Rust file operations, or enable long-path support in the app manifest. Sample packs unzipped inside sample packs hit this more often than you'd think.
- **Distribution.** Personal use, so no code signing. An unsigned MSI/NSIS installer will trip SmartScreen once; that's acceptable. Revisit only if this is ever shared.
- **Capabilities.** Tauri v2 gates the asset protocol behind a capability file, not `tauri.conf.json` alone. The webview cannot `fetch` a local audio file until the asset protocol is enabled *and* its scope includes the library roots (§8). Because roots are chosen by the user at runtime, the scope has to be extended dynamically via the asset scope API rather than declared statically. Get this working early in Phase 1 — a silent fetch failure here looks exactly like a decode bug and wastes an afternoon.

---

## 4. Data model

### `sample`

The core record. One row per audio file found during scan.

```
id              INTEGER PRIMARY KEY
path            TEXT UNIQUE        -- absolute
filename        TEXT               -- basename, for display
parent_dir      TEXT               -- for the folder tree
ext             TEXT               -- wav / flac / mp3 / ogg / aiff
size_bytes      INTEGER
mtime           INTEGER            -- for incremental rescan
duration_ms     INTEGER
sample_rate     INTEGER
channels        INTEGER
bit_depth       INTEGER NULL       -- null for compressed formats
true_peak_db    REAL               -- for gain matching
body_rms_db     REAL               -- RMS over the loudest 300ms window; see §7.6
peaks           BLOB               -- downsampled waveform, see §7.4
category        TEXT NULL          -- inferred: kick/snare/hat/clap/tom/perc/cymbal/fx/unknown
scanned_at      INTEGER
```

### Search

**v1: no FTS5.** Add a `search_text` column to `sample` — the filename and parent path lowercased, with underscores, hyphens, and camelCase boundaries normalized to spaces, so `Vinyl_808s/KICK_808_deep-02.wav` becomes `vinyl 808s kick 808 deep 02 wav`. Query it with `AND`-ed `LIKE '%term%'` clauses, one per whitespace-separated search term. At the library sizes in play now this is instant, and it removes a dependency risk entirely.

FTS5 is a compile-time SQLite option and is not guaranteed present in whatever build `tauri-plugin-sql` links. Deferring it means not discovering that in Phase 3.

**Later, when the library grows:** add a `sample_fts` FTS5 virtual table over the same `search_text` column. Because the normalization already happened at scan time, this is an additive migration — no re-scan, no re-analysis, and the query layer is the only thing that changes. Check availability first with `SELECT * FROM pragma_compile_options()` (look for `ENABLE_FTS5`) and enable the appropriate `rusqlite` bundled feature if it's missing. Trigger point: when `LIKE` search on the full library stops meeting the 50 ms target in §10, likely somewhere in the tens of thousands of rows.

### `tag` / `sample_tag`

Free-form user tags, many-to-many. Distinct from `category` (which is inferred and overwritable).

### `kit`

A saved 16-slot tray.

```
id, name, created_at, updated_at
```

### `kit_slot`

```
kit_id, slot_index (0-15), sample_id, gain_db_offset, notes
```

Slots reference samples by id; nothing is copied until export. A kit whose underlying file has moved shows the slot as broken rather than silently empty.

### `library_root`

Folders the user has added. Multiple roots supported; the folder tree shows them as top-level nodes.

---

## 5. Architecture

### Rust side (commands)

```
scan_roots(roots: Vec<String>, force: bool) -> ScanId
  Emits progress events: scan:progress { done, total, current_path }
                          scan:complete { added, updated, removed }

list_samples(query: SampleQuery) -> Vec<SampleRow>
  Filter by root, subtree, text (LIKE over search_text — see §4), category,
  tags, duration range, ext. Paginated; the UI virtualizes.

get_sample(id) -> SampleDetail            -- includes full peaks blob

resolve_playable(id) -> String
  Returns an asset-protocol URL the webview can fetch. For formats Web Audio
  cannot decode natively, transcodes to a cached temp WAV first and returns that.

convert_for_export(ids, opts) -> Vec<String>
  ffmpeg sidecar. opts: target sample rate, bit depth, channels, normalization.
  Writes to a session temp dir. Returns absolute paths.

start_drag(paths: Vec<String>, icon: Option<Vec<u8>>)
  Thin wrapper over tauri-plugin-drag.

export_kit(kit_id, dest_dir, opts) -> ExportReport

set_tags(sample_id, tags)
add_root(path) / remove_root(id)
```

### Frontend

- **Library store** — current query, result page, selection index. Selection changes drive preview.
- **Audio engine** (§8) — a singleton module, not React state. Owns the `AudioContext`, the decoded-buffer LRU, the context-loop node graph, and the preview voice.
- **Kit store** — the 16 slots, dirty state, save/load.
- **Keyboard layer** — a single global handler, because the whole app is keyboard-driven and scattered `onKeyDown` handlers will fight each other.

---

## 6. UI layout

```
┌────────────────────────────────────────────────────────────────────────┐
│  [ search: "808 kick"                    ]  [kick][snare][hat][…]  ⚙   │
├──────────────┬─────────────────────────────────────┬───────────────────┤
│              │                                     │                   │
│  ROOTS       │  NAME            DUR   ▁▃▇▅▂  SR    │   INSPECTOR       │
│  ▾ Samples   │  KICK_808_01    0.84s  ▁▇▅▂   44.1  │                   │
│    ▾ 808s    │  KICK_808_02    1.10s  ▁█▆▃   44.1  │  ▁▃▇█▆▄▂▁         │
│      Vinyl   │ ▸KICK_808_deep  1.42s  ▂█▇▄   48.0  │  big waveform     │
│    ▾ Acoustic│  KICK_sub_A     0.66s  ▁▆▃▁   44.1  │                   │
│      Kicks   │  …                                  │  KICK_808_deep    │
│      Snares  │                                     │  48k · 24b · mono │
│              │  (virtualized, arrow keys move,     │  peak −1.2 dB     │
│  TAGS        │   selection auto-previews)          │                   │
│  ★ favorites │                                     │  [▶] [loop] [↻]   │
│  # punchy    │                                     │  gain ──●──       │
│  # lofi      │                                     │  [+ add to kit]   │
├──────────────┴─────────────────────────────────────┴───────────────────┤
│ KIT: "Dusty Break"        ┌──┬──┬──┬──┐   CONTEXT LOOP                 │
│                           │ 1│ 2│ 3│ 4│   [ break_92bpm.wav      ]  ✕  │
│                           ├──┼──┼──┼──┤   ▶ 92 BPM  ──●──── −8 dB      │
│                           │ 5│ 6│ 7│ 8│   trigger: ○ manual ● 1/4      │
│                           ├──┼──┼──┼──┤                                │
│                           │ 9│10│11│12│   [ export kit… ]              │
│                           ├──┼──┼──┼──┤                                │
│                           │13│14│15│16│   drag any pad → Sitala        │
│                           └──┴──┴──┴──┘                                │
└────────────────────────────────────────────────────────────────────────┘
```

Dark by default. The list is the focus; everything else is support.

---

## 7. Features

### 7.1 Library scanning

Add one or more root folders. Scan walks recursively, in parallel, decoding each file's header for format info and its full body for peak/RMS analysis (§7.4, §7.6). Progress is streamed to the UI — a 5,000-file library should not present a frozen window.

Incremental by default: a file whose `(path, size, mtime)` matches the existing row is skipped. `force: true` re-analyzes everything. Files that disappeared are marked removed, not deleted, so kit slots referencing them can report "missing" rather than vanishing.

Skips: hidden files, files under `__MACOSX`, zero-byte files, anything over a configurable duration ceiling (default 30s — a sample library full of 4-minute loops isn't what this tool is for, but the ceiling is a setting, not a hard rule).

**Category inference** is filename-pattern based and deliberately dumb: match `kick|bd|bass ?drum` → kick, `snare|sd|rim` → snare, `hat|hh|hihat` → hat, and so on, case-insensitive, checked against both filename and parent directory name. It will be wrong sometimes. It exists to power the quick-filter chips, and the user can override it. Do not attempt audio-content classification in v1.

### 7.2 Browse and preview

The list is virtualized and keyboard-first:

| Key | Action |
|---|---|
| `↑` / `↓` | Move selection — **plays the newly selected sample immediately** |
| `Space` | Replay current selection |
| `←` / `→` | Collapse / expand folder tree node |
| `Enter` | Add selection to the next empty kit slot |
| `1234` / `QWER` / `ASDF` / `ZXCV` | Assign selection to kit slot 1–16 — the key block is physically a 4×4 grid, matching the tray |
| `/` | Focus search |
| `Esc` | Clear search / return focus to list |
| `\` | Toggle context loop playback |
| `*` | Toggle favorite |

The slot keys deliberately shadow the letter keys, so typing must be unambiguous: slot assignment is only live when the list has focus, and `/` or clicking the search box takes focus away from it.

Auto-preview-on-selection is the single most important behavior in the app. Holding `↓` should machine-gun through 30 kicks with each one audibly starting. If retriggering while a previous preview is still ringing causes clicks, apply a 3–5 ms release ramp to the outgoing voice rather than cutting it (§8).

Preview always plays from the file's true start. No fade-in.

### 7.3 Search and filtering

- Text search over the normalized `search_text` column (§4), AND-ing one `LIKE` clause per whitespace-separated term, so `808 kick` matches `Vinyl_808s/KICK_808_deep_02.wav` in any term order
- Quick-filter chips for inferred categories (kick / snare / hat / clap / tom / perc / cymbal / fx)
- Tag filter (user tags, multi-select, AND semantics)
- Duration range slider — useful for separating one-shots from loops that snuck in
- Format filter (ext, sample rate, mono/stereo) — matters when the target sampler is picky

Filters compose. The result count is always visible; going from 2,000 files to 12 is the point.

### 7.4 Waveform display

Peaks are computed **once, at scan time, in Rust** and stored as a blob. Decoding thousands of files in the webview to draw thumbnails would make the list unusable.

Format: min/max pairs at a fixed resolution — 400 buckets per file regardless of duration, `i8` normalized, so 800 bytes per sample. A 5,000-file library costs 4 MB of blobs. The list thumbnail renders a downsampled subset of those buckets; the inspector renders all 400 on a canvas.

The inspector waveform shows a playhead during preview. Clicking it does **not** seek — preview always plays from the start (a drum one-shot auditioned from the middle is meaningless), but a click-to-seek option can be revisited if loops end up in the library.

### 7.5 Context auditioning

The differentiating feature. Sitala makes you commit a sample to a pad before you hear it in a kit; Kitbench lets you hear it over a groove first.

**Loop slot.** Drag any audio file in (or pick one from the library). It loops continuously through its own gain node, independent of preview gain. Typical use: a two-bar break, or a rough sketch bounced out of REAPER.

**Bounce-folder watch.** A single configured folder — the user's REAPER render destination — is watched, and the newest audio file in it is offered as a one-click "load latest bounce." The intended loop is: render a sketch in REAPER, alt-tab to Kitbench, the new bounce is already there.

Implementation notes: this is a *narrow* watch (one folder, non-recursive, newest-by-mtime), not the general library watching deferred in §13 — it's a `notify` watcher on one path, or even just an mtime poll every few seconds, which avoids the dependency entirely. Debounce it: REAPER writes the file progressively, so a watcher firing on first-write will grab a truncated or locked file. Wait for the size to stop changing across two consecutive checks before offering it, and handle the "file is locked by another process" error by retrying rather than surfacing it. Never auto-load without user action — a new bounce appearing mid-audition should light up a button, not swap the audio out from under them.

**BPM.** User-entered. Optionally derived: user types the loop's bar count, app computes BPM from `(bars × 4 × 60000) / duration_ms`. Do not attempt beat detection in v1 — it's a rabbit hole and typing "92" takes two seconds.

**Trigger modes:**
- `manual` — candidate plays only when selection changes or `Space` is pressed
- `1/4`, `1/8`, `1/2`, `1 bar` — candidate retriggers on a repeating pulse locked to the loop's start, so a kick auditions on every downbeat against the break

The pulse is scheduled with `AudioContext.currentTime` lookahead (schedule ~100 ms ahead on a 25 ms interval timer), not `setInterval` firing `.start()` directly — the latter drifts audibly within seconds.

**Kit context (stretch, phase 4).** Instead of an external loop, play the pads already assigned in a simple hardcoded pattern (kick on 1/3, snare on 2/4, hat on 8ths) so a candidate hi-hat is heard against the actual kick and snare chosen. Worth building only if the loop slot proves it earns its place.

### 7.6 Gain matching

Comparing a −18 dB hat against a −3 dB kick tells you which is louder, not which is better. Preview offers a normalization toggle:

- **Off** — files play at their recorded level
- **Peak match** — apply `target_peak_db − true_peak_db`; simple, predictable, but a sample with one stray transient will be quiet
- **Body match (default)** — apply `target_rms_db − body_rms_db`, where `body_rms_db` is the RMS of the loudest 300 ms window in the file

**Why not LUFS:** gated integrated loudness (BS.1770) needs 400 ms blocks and a gating window that a 200 ms hi-hat one-shot simply doesn't fill. It returns garbage or nothing for short one-shots. The loudest-300ms-window RMS is a pragmatic stand-in that behaves sensibly across the 50 ms – 3 s range that drum one-shots actually occupy. Clamp the applied gain to ±12 dB so a near-silent file doesn't blast.

Normalization affects **preview only**. Exported files are untouched unless the user explicitly enables normalization in export options (§7.8).

### 7.7 Kit tray

Sixteen slots in a 4×4 grid, mirroring Sitala's layout so slot positions translate directly.

- Assign by keyboard (§7.2), by drag from the list, or by the inspector's `+ add to kit` button
- Click a slot to preview it; the slot shows the sample name and its waveform thumbnail
- Drag a slot to reorder; drag a slot onto another to swap
- Per-slot gain offset (metadata only — see export options for whether it's applied)
- Save / load / duplicate kits by name
- A slot whose file has gone missing renders in an error state with the last-known path

The tray is the shortlist. The workflow it's built for: audition 40 kicks, put the best 3 in slots, A/B them against the loop, keep one.

### 7.8 Drag-out and export

Two ways to get samples into Sitala.

**Drag-out (primary).** Drag a list row, an inspector, or a kit slot directly onto a Sitala pad. Implemented via `tauri-plugin-drag`'s `startDrag`, invoked from a real mouse event handler.

If the file is not in a format the target accepts (§11.2), it is converted to a temp WAV *before* the drag begins and the temp path is dragged instead. This means a conversion may need to complete inside a mouse-down handler — for a 1-second one-shot with ffmpeg that's a few milliseconds, but the implementation should pre-convert on selection rather than on drag start, so the file is already sitting in the temp dir by the time the user reaches for it.

**Export kit (fallback and batch).** Writes all 16 slots to a chosen folder, named `01_KICK_808_deep.wav` … `16_….wav` so alphabetical order in a file browser matches pad order. Options:

- Target sample rate (default: leave as-is / 44.1 / 48)
- Bit depth (default 24-bit PCM)
- Mono/stereo (default: leave as-is)
- Apply per-slot gain offsets (default off)
- Apply normalization (default off)

Export always writes copies. It never modifies source files.

**Sitala preset format** — Sitala saves its own kit preset files. Writing one directly would let Kitbench hand over a complete mapped kit in one step, skipping the 16 drags entirely. The format is not documented and has not been investigated. Treat this as a possible phase 5 experiment, not a plan; do not build anything that depends on it.

### 7.9 Settings

Library roots, preview normalization mode and target level, duration ceiling for scan, default export options, theme, ffmpeg sidecar path override. Persisted in the SQLite DB, not localStorage.

---

## 8. Audio engine

**Playback lives in the webview, via Web Audio.** Rationale:

- Mixing a looping context track against a retriggering preview voice is three nodes and a gain — in Rust it's a mixer you have to write
- `AudioBufferSourceNode.start(when)` gives sample-accurate scheduling for free, which §7.5's pulse needs
- Decoded buffers are directly usable for the playhead and any future waveform interaction
- Latency (~10–20 ms) is irrelevant for auditioning; this is not a playable instrument

The cost is getting bytes into the webview and decoding there. Use Tauri's asset protocol (`convertFileSrc`) with the library roots added to the asset scope, then `fetch` → `arrayBuffer` → `decodeAudioData`.

**Buffer cache.** An LRU of decoded `AudioBuffer`s, capped by total sample frames rather than count (a 30 s loop is not equivalent to a 200 ms hat). Start at ~500 MB of decoded audio, make it a setting. Prefetch the next 3 and previous 3 rows relative to the selection, so arrow-key scrubbing never waits on a decode.

**Node graph:**

```
preview voice  ──▶ preview gain (normalization) ──┐
                                                   ├──▶ master gain ──▶ destination
context loop   ──▶ loop gain ─────────────────────┘
```

**Retrigger handling.** On a new preview while one is playing: give each voice its own gain node, `linearRampToValueAtTime(0, now + 0.004)` on the outgoing one, schedule its `stop()` just after the ramp completes, and start the new voice immediately. Use a linear ramp, not `setTargetAtTime` — the latter is exponential and never actually reaches zero, so the `stop()` still truncates. Do not call `stop()` bare: mid-waveform truncation is exactly the click that makes a preview tool feel cheap.

**Decode fallbacks.** Because Windows means WebView2 means Chromium, there's exactly one decoder to reason about: `decodeAudioData` handles WAV (PCM and IEEE float), MP3, FLAC, and OGG/Vorbis. AIFF and exotic WAV chunk layouts are the likely gaps.

Don't guess at the boundary — during Phase 0, throw a folder of odd files at it (AIFF, 32-bit float WAV, 24-bit WAV, 8-bit, mono and stereo, 96 kHz) and record what actually fails. That's a 20-minute test that settles a design question.

`resolve_playable` (§5) is the escape hatch regardless: if the frontend reports a decode failure for a path, ask Rust to transcode it to a cached 16-bit WAV via the ffmpeg sidecar and retry once. Cache the transcode keyed on `(path, mtime)` so it happens once per file, ever. Keep this path even if the Phase 0 test finds nothing — sample libraries contain strange files.

---

## 9. Build phases

Each phase should end with something usable.

**Phase 0 — Drag-out spike. Half a day. Gate for everything else.**
Throwaway code, full brief in **§14**. Do not write another line of Kitbench until it reports back. If drag-out can't be made to work, the design changes — see §11.1.

*Done when:* every test in §14's matrix has a recorded result and the outcome branch is chosen.

**Phase 1 — Browse and preview.**
Scaffold, multi-root selection, scan with progress, SQLite index, virtualized list, folder tree, `LIKE` text search, keyboard navigation, auto-preview-on-selection with clean retriggering.

*Done when:* you can point it at a folder, hold `↓`, and hear every sample fire cleanly with no clicks and no dropped previews. At that point the app is already useful, even with nothing else built.

**Phase 2 — Inspector and analysis.**
Peaks at scan time, list thumbnails, inspector waveform with playhead, format metadata display, gain matching, category inference and quick-filter chips, tags and favorites.

*Done when:* a quiet hat and a loud kick preview at comparable perceived level with body-match on, and every row shows a waveform thumbnail without a decode happening in the webview.

**Phase 3 — Kit tray and getting files out.**
16-slot grid, keyboard assignment, save/load kits, per-slot gain, drag-out wired to real rows and slots, ffmpeg sidecar, pre-conversion on selection, export kit with options.

*Done when:* a full 16-pad kit can be assembled and landed in Sitala — by drag if Phase 0 said yes, by export-to-folder otherwise.

**Phase 4 — Context auditioning.**
Loop slot, BPM entry, lookahead-scheduled pulse triggering, independent loop gain, bounce-folder watch (§7.5). Kit-context playback if the loop slot proves the concept.

*Done when:* a candidate kick can be auditioned on every downbeat against a looping break, with no audible drift after two minutes of continuous playback.

**Phase 5 — Deferred.**
- **MIDI controller mapping** (Akai MPK Mini MK3, the developer's controller) — its 8 pads trigger kit slots and audition the selection, knobs drive preview gain and loop level. Deliberately out of scope for now, at the developer's explicit request. Web MIDI in the webview is the likely path and would be a small addition once the kit tray exists. Do not build this in Phases 0–4.
- Sitala preset writing (§7.8), if the format turns out to be tractable.
- Audio-content-based category classification.

---

## 10. Performance targets

The interaction targets are the ones that matter now — they're what make the tool feel fast at any library size. The scan targets are stated against a hypothetical 5,000-file library so there's a number to measure against later; don't optimize toward them before the library is anywhere near that.

| Operation | Target | Matters now? |
|---|---|---|
| Selection change → audible sound | Under 30 ms cached, under 120 ms cold | **Yes** |
| Holding `↓` through a list | No dropped previews, no clicks | **Yes** |
| Filter/search re-query | Under 50 ms | **Yes** |
| Incremental rescan, no changes | Under 2 s | Yes |
| Cold scan, 5,000 files | Under 60 s, UI responsive throughout | Later |

---

## 11. Risks

### 11.1 Drag-out to Sitala — **critical, unvalidated**

Everything downstream assumes a file can be dragged from a Tauri window onto a Sitala pad and be accepted. This has not been tested.

**The Windows-only target makes this more likely to work than it looked.** On Windows, a file drag is an OLE drag-and-drop operation carrying a `CF_HDROP` clipboard format — the same mechanism Explorer uses. Sitala accepts drops from Explorer, which means its window registers an OLE drop target and handles `CF_HDROP`. A drag originating from another application is not distinguishable from an Explorer drag at that layer, so if `drag-rs` emits a standard `CF_HDROP` data object, the target has no particular reason to reject it. That's the mechanism, not a guarantee — verify it.

Remaining failure modes worth testing specifically:

- Sitala running as a **plugin inside REAPER** means the drop target is a child window owned by the host, not a standalone app. Test in that configuration, not against a standalone build.
- Drag initiated from a WebView2 child window may need the drag to originate from the native window handle rather than the webview's — this is the plugin's problem to solve, but it's where an obscure failure would live.
- Paths with spaces, non-ASCII characters, and UNC network paths.

Mitigated by making it Phase 0. If it fails, the fallback is **export-kit-to-folder as the primary path**: Kitbench writes the 16 chosen files to a folder with pad-ordered names, and the user drags from Explorer once, in order. Slower, but the auditioning value survives intact. Design the export path well enough that this fallback is genuinely acceptable.

### 11.2 What formats Sitala actually accepts

Unverified. It may reject 32-bit float WAV, non-44.1k rates, compressed formats, or stereo files. Determine this empirically during Phase 0 and set the pre-conversion defaults to match. This is cheap to find out and expensive to guess wrong.

### 11.3 Multi-file drag

Whether `startDrag` with multiple paths works, and whether Sitala does anything sensible with a multi-file drop (fill consecutive pads? take the first? reject?), is unknown on both sides. Assume single-file drag works and multi-file does not until proven otherwise. The kit-export path covers the batch case regardless.

### 11.4 Scan performance at future scale — **not a v1 problem**

Full-body decoding for peaks reads every byte of every file, so a large library on an external drive or network share will scan far slower than §10's targets. At current library size this is invisible; don't build for it yet.

The pressure valve, when needed: a "metadata only, skip analysis" scan mode with peaks computed lazily on first selection. Keep the door open by making peak computation a distinct step in the scan pipeline rather than inlining it into the walk, so it can be made optional later without restructuring.

### 11.5 Scope creep toward being a sampler

The context-auditioning and kit-tray features are one honest step away from "well, if it can play a pattern, why not sequence it — and if it can sequence, why not make it the sampler."

That is a different and much larger project. A real sampler means voice allocation and stealing, choke groups, click-free retriggering under load, sample-accurate MIDI handling within the audio block, velocity layers and round-robins, plugin-format wrappers (VST3/CLAP), preset state serialization, and a GUI built to plugin-host constraints. Kitbench avoids all of it by never being the instrument — Sitala plays the kit, Kitbench only helps choose it.

If a feature request starts with "while I'm in here," check it against §2 before building it.

---

## 12. Open questions

1. **Does Phase 0 succeed?** Everything else waits on the answer. This is now the only open question that blocks anything.

*Resolved:* Windows only (§3). Library small now, growing later (§13). Multi-root with a folder tree in v1 (§7.1). Context loop takes a manual pick plus a watched bounce folder (§7.5). Phase 0 runs as a standalone throwaway spike before any project scaffolding (§14).

---

## 13. Designing for growth

The library is small today and expected to get much bigger. That argues for building the simple version now — but there are a handful of decisions where the cheap choice today makes the expensive migration tomorrow, and those are worth getting right up front.

**Keep these, even though they're overkill at current scale:**

| Decision | Why now |
|---|---|
| SQLite index, not a JSON cache | Migrating a JSON blob to a real schema later means rewriting every query. The schema costs nothing today. |
| Virtualized list from day one | Retrofitting virtualization into a working list is a rewrite of the list component. |
| Peaks computed at scan time, cached as blobs | The alternative (decode in JS on render) works fine at 200 files and falls over at 5,000, and switching means rebuilding the waveform pipeline. |
| Incremental rescan keyed on `(path, size, mtime)` | A dozen lines now; the thing that makes a 20,000-file rescan bearable later. |
| Normalized `search_text` column | Makes the FTS5 upgrade additive rather than a re-scan (§4). |
| Canonical path storage | Path normalization bugs are nearly invisible at 200 files and produce thousands of phantom rows at scale. |
| Paginated `list_samples` | Even if v1 always asks for everything, having the parameter means the call site doesn't change later. |

**Skip these until the library actually grows:**

- FTS5 (§4) — `LIKE` is fine and carries less risk
- The metadata-only scan mode (§11.4)
- **Library-wide** file watching (`notify` across all roots) — manual rescan is fine when a scan takes two seconds. Note this is distinct from the single-folder bounce watch in §7.5, which ships in Phase 4 and can be an mtime poll rather than a real watcher.
- Buffer cache tuning — the §8 LRU can start generous and be revisited
- Any parallelism beyond wrapping the walk in `rayon`, which is one line

The rule of thumb: **schema and pipeline shape are hard to change later, so decide them now; thresholds, indexes, and caches are easy to change later, so don't tune them yet.**

---

## 14. Phase 0 brief — drag-out spike

**This is throwaway code. Do not scaffold Kitbench. Do not create the SQLite schema, the list, the audio engine, or anything else in this spec.** The only deliverable is an answer to one question: can a file be dragged from a Tauri v2 window onto a Sitala pad inside REAPER on Windows and be accepted?

Budget: half a day. If it runs long, that itself is a finding — report it rather than pushing through.

### Build

A minimal Tauri v2 app, Windows target, containing:

- A window with four or five labeled `<div>`s, each hardcoded to an absolute path of a WAV file on disk
- `tauri-plugin-drag` wired up, with `startDrag` invoked from each div's `mousedown`/`dragstart` handler
- A visible log pane in the window showing what was called with what arguments, and any error returned

No styling beyond what makes the divs clickable. No file picker. No state.

### Test matrix

Run each against **Sitala loaded as a plugin inside REAPER**, not a standalone Sitala build — the drop target is a host-owned child window and that's the configuration that matters.

| # | Test | Records |
|---|---|---|
| 1 | Drag one 16-bit 44.1k WAV onto a Sitala pad | The core question |
| 2 | Repeat onto a different pad | Whether it's reliable or a fluke |
| 3 | Drag a file whose path contains spaces | Path escaping in the plugin |
| 4 | Drag a file whose path contains non-ASCII characters | Encoding handling |
| 5 | Drag a file from a UNC path (`\\NAS\...`) if a share is available | Network path support |
| 6 | Drag **two** files at once | Whether multi-drag works at all, and what Sitala does with it (§11.3) |
| 7 | Drag onto REAPER's arrange view instead of Sitala | Isolates "drag is broken" from "Sitala rejects it" |
| 8 | Drag onto Explorer / a text editor | Same isolation, one more data point |

Test 7 is the important diagnostic. If REAPER accepts the drop but Sitala doesn't, the problem is Sitala's drop handling and the export-to-folder fallback becomes primary. If nothing accepts it, the problem is the drag source and may be fixable.

### Second, unrelated test — 20 minutes

While the spike app exists, settle the decode question from §8. Point a plain HTML page (or the spike window) at `decodeAudioData` and feed it: 16-bit WAV, 24-bit WAV, 32-bit float WAV, 8-bit WAV, mono, stereo, 96 kHz, AIFF, MP3, FLAC, OGG. Record which fail. That determines how much the ffmpeg transcode fallback actually has to cover.

### Report back

- Which tests in the matrix passed
- If drag-out failed, at which layer (test 7/8 tell you)
- Which audio formats `decodeAudioData` refused
- Whether the spike took materially longer than half a day, and why

### Outcomes

**All green** → proceed to Phase 1 as specced. Delete the spike.

**Drag works to REAPER but not Sitala** → export-kit-to-folder (§7.8) becomes the primary delivery path and moves from Phase 3 into Phase 1. Kit tray gains priority over the inspector. The rest of the spec is unchanged.

**Drag works but multi-file doesn't** → expected; note it and move on. Single-file drag plus batch export covers everything.

**Drag doesn't work at all** → stop and reassess before writing more code. Options at that point include a different drag crate, a small native shim, or accepting export-to-folder permanently. Don't pick one from the spec — pick it from what the spike actually showed.

---

## 15. Conventions

### Repo layout

```
/
├─ src/                        React frontend
│  ├─ audio/                   Audio engine (§8) — plain TS modules, no React
│  │  ├─ engine.ts             AudioContext owner, node graph, master gain
│  │  ├─ preview.ts            Preview voice, retrigger ramping
│  │  ├─ contextLoop.ts        Loop playback + lookahead pulse scheduler
│  │  └─ bufferCache.ts        Decoded AudioBuffer LRU
│  ├─ components/
│  ├─ stores/                  Zustand stores (library, kit, settings)
│  ├─ keyboard/                Single global key handler (§5)
│  └─ ipc/                     Typed wrappers over Tauri commands
├─ src-tauri/
│  ├─ src/
│  │  ├─ scan/                 walkdir + symphonia; analysis as a separate step (§11.4)
│  │  ├─ db/                   schema, migrations, queries
│  │  ├─ convert/              ffmpeg sidecar invocation
│  │  ├─ drag.rs               tauri-plugin-drag wrapper
│  │  └─ commands.rs           the §5 command surface
│  ├─ binaries/                ffmpeg-x86_64-pc-windows-msvc.exe
│  └─ capabilities/            asset protocol scope (§3)
└─ SPEC.md                     this document
```

The audio engine lives outside React deliberately. It owns mutable, timing-sensitive state that must not be subject to re-render cycles; React reads from it and sends it commands, but never owns it.

### Code

- TypeScript strict mode. No `any` in committed code — if a Tauri return type is awkward, write the interface.
- Rust: `thiserror` for error types, `anyhow` only at the command boundary. Commands return `Result<T, String>` with a message the UI can actually display.
- No `unwrap()` on anything touching the filesystem or user data. A malformed WAV in the library must not panic the scan — log it, mark the row, keep going. Sample libraries are full of broken files.
- Keep the §5 command surface stable. If a new command seems necessary, it probably belongs as a parameter on an existing one.

### Dependencies

§3 is the dependency list. Adding to it is a decision, not a detail — flag it rather than pulling in a crate silently. Particularly resist: an audio playback crate (playback is in the webview by design, §8), an ORM (the queries are simple), a component library (the UI is four panes).

### Testing

Not a TDD project, but three things are worth real tests because they're easy to get subtly wrong and hard to notice:

1. **Path canonicalization** (§3) — round-trip a variety of Windows path spellings and assert they normalize identically. This is the bug that silently produces duplicate rows.
2. **Peak/RMS analysis** (§7.4, §7.6) — against generated WAVs with known content: a full-scale sine, a −20 dB sine, a click, silence. Assert the computed values are what the math says they should be.
3. **`search_text` normalization** (§4) — a table of filenames in, expected token strings out.

Everything else is verified by using it. The audio behaviors in §10 can't be unit-tested meaningfully; they're judged by ear.

### Never fake data

Do not build against generated placeholder sample rows or mock audio. Point it at a real folder of real WAVs from the start. Every interesting bug in this app — decode failures, path weirdness, broken files, clicks on retrigger, a 40-character filename blowing out the list layout — only appears with real files, and a UI that looks right against fabricated rows will look wrong the first time it meets a sample pack.

### Git

Work on a branch per phase. Commit at the end of each meaningful unit rather than in one drop at phase end, so a bad direction can be backed out cleanly.
