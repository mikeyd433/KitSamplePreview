# Phase 0 results — drag-out spike

Fill this in as you work the matrix, then stop. Per SPEC §14 the only deliverable
is an answer; nothing else in the spec gets built until this document is complete
and an outcome branch is chosen.

---

## Environment

Copy these from the banner at the top of the spike window.

| | |
|---|---|
| Date | 2026-09-07 (log timestamps 10:39–10:43) |
| Windows version | |
| WebView2 runtime | |
| Tauri version | |
| REAPER version | |
| Sitala version | |
| Sitala plugin format used (VST3 / VST2 / CLAP) | |

---

## Established before the spike ran

Read out of the `drag-rs` / `tauri-plugin-drag` source, not measured. Recorded
here so it is not mistaken for a test result, and so a surprise in the matrix
can be checked against what the source says *should* happen.

- **The drag is a genuine shell drag.** On Windows `drag-rs` builds its
  `IDataObject` with `SHCreateShellItemArrayFromIDLists` →
  `BindToHandler(BHID_DataObject)` and calls `DoDragDrop` with
  `DROPEFFECT_COPY`, serving `CF_HDROP`. That is the same data object Explorer
  hands out, so a drop target has no way to tell the two apart. This is the
  mechanism SPEC §11.1 hypothesised, now confirmed at the source level — it
  still does not prove Sitala accepts it.
- **Multi-file is supported by the source.** `CF_HDROP` is built by
  concatenating null-terminated wide paths with a final terminator and
  `fWide = 1`. So if test 6 fails, the failure is Sitala's, not the drag's
  (narrows SPEC §11.3).
- **Non-ASCII should hold.** Paths are UTF-16 via `encode_wide`, end to end.
- **Every path is `dunce::canonicalize`d before the shell sees it.** What is
  typed into the box is not necessarily what gets dragged. The pre-flight table
  in each row shows the string that will actually be handed over — check it when
  a row behaves oddly, especially rows 5 and 9.
- **The drag originates from the native window handle**, not the WebView2 child
  window — the plugin passes the Tauri `Window` itself. That removes one of the
  failure modes SPEC §11.1 flagged.
- **A non-existent path fails cleanly** (canonicalize errors before any shell
  call), but `get_file_data_object(...).unwrap()` unwraps an `Option`, so a path
  that canonicalizes yet yields a null shell item id would panic the app rather
  than return an error. Pre-flight every row; if the window vanishes mid-drag,
  this is the first thing to suspect.
- **`dragDropEnabled: false`** is set on the window in `tauri.conf.json`. With
  Tauri's own file-drop handler active the webview never emits `dragstart` on
  Windows, which would make the `dragstart` trigger mode look broken for
  reasons unrelated to Sitala.

---

## Drag matrix

`Badge` is what the spike reported (`Dropped` / `Cancelled` / `Error` / not run).
`Loaded?` is what you saw and heard in Sitala — the badge only says the target
accepted the data object, not that the sample got mapped to the pad.

| # | Test | Trigger mode | Badge | Loaded? | Notes |
|---|---|---|---|---|---|
| 1 | One 16-bit 44.1k WAV → Sitala pad | `dragstart` | **Dropped** | **yes** | **The core question, answered yes.** Sitala took the sample onto the pad and it triggers. Confirmed by ear, not just by badge. 10:43:12. |
| 2 | Repeat onto a different pad | `dragstart` | Dropped | yes | worked |
| 3 | Path with spaces | `dragstart` | Dropped | yes | worked |
| 4 | Path with non-ASCII characters | `dragstart` | Dropped | yes | worked — UTF-16 end to end, as the source predicted |
| 5 | UNC path (`\\NAS\...`) | | | | see notes — confirm whether this was run |
| 6 | Two files at once | | | | see notes — confirm what Sitala did |
| 7 | → REAPER arrange view (not Sitala) | | | | not run — the diagnostic is moot now that row 1 passes |
| 8 | → Explorer / a text editor | `dragstart` | **Dropped** | — | Badge only. The cursor was at (481, 528), possibly still over the spike's own window, and no copied file was separately confirmed — so this row evidences that a drop target accepted, not specifically that Explorer did. Re-run onto an Explorer file list and check for the copy if you want it clean. 10:39:06. |
| 9 | Path over 260 chars *(beyond §14)* | `dragstart` | **crashed** | — | **The app process died and the window closed.** 321-char path. Not a rejection — a panic inside the plugin. Mechanism below. |
| 10 | Standalone Sitala *(only if 1 failed)* | — | — | — | not applicable; row 1 passed |

**Did `dragstart` and `mousedown` behave differently?**

> `dragstart` works — both recorded rows used it. `mousedown` has not been
> exercised, so no comparison yet. Since `dragstart` works there is no pressing
> reason to need the alternative.

**What did Sitala do with the two-file drop (test 6)?** Fill consecutive pads,
take the first, take the last, or reject?

> 

---

## decodeAudioData results

Paste the table from the bench's *copy results as markdown* button.

> 

Formats WebView2 refused (this is what the ffmpeg transcode fallback in SPEC §8
has to cover):

> 

Any file that decoded but came back **peak 0.000** — decoded to silence, which is
a subtler failure than a refusal and worth calling out separately:

> 

Did anything fail on the `asset` arm but succeed on `ipc`? That is an asset
protocol scope problem (SPEC §3), not a decoder problem, and it is Phase 1 work
rather than a §14 finding:

> 

---

## Report back (SPEC §14)

**Which tests passed:**

> 

**If drag-out failed, at which layer** — tests 7 and 8 tell you. Sitala refuses
but REAPER accepts ⇒ Sitala's drop handling. Nothing accepts ⇒ the drag source:

> 

**Which audio formats `decodeAudioData` refused:**

> 

**Did the spike take materially longer than half a day, and why?** SPEC §14: if
it ran long, that is itself a finding.

> 

---

## Outcome

Tick one. SPEC §14 defines what each one means for the phases that follow.

- [ ] **All green** → proceed to Phase 1 as specced. Delete the spike.
- [ ] **Drag works to REAPER but not Sitala** → export-kit-to-folder (SPEC §7.8)
      becomes the primary delivery path and moves from Phase 3 into Phase 1. The
      kit tray gains priority over the inspector. The rest of the spec is
      unchanged.
- [ ] **Drag works but multi-file does not** → expected; note it and move on.
      Single-file drag plus batch export covers everything.
- [ ] **Drag does not work at all** → stop and reassess before writing more code.
      Options include a different drag crate, a small native shim, or accepting
      export-to-folder permanently. Pick from what the spike showed, not from
      the spec.

**Anything the spike turned up that the spec did not anticipate:**

> 1. **`startDrag`'s `icon` is not optional**, and is not raw bytes. SPEC §5
>    sketches `start_drag(paths, icon: Option<Vec<u8>>)`; the plugin requires a
>    `data:image/png;base64,…` string (or a `{File|Raw}` object). Phase 3's
>    `drag.rs` wrapper needs to account for that.
> 2. **`dragDropEnabled: false` is required on the window.** With Tauri's own
>    file-drop handler active the webview never emits `dragstart`, so the
>    `dragstart` trigger would look broken for reasons unrelated to Sitala.
>    Carry this into the Phase 1 window config.
> 3. **The window freezes for the duration of a drag.** `DoDragDrop` blocks the
>    main thread, so the app stops repainting and queued log entries all land
>    afterwards. Harmless here, but worth knowing before it reads as a hang in
>    the real app.
> 5. **A path over MAX_PATH crashes the whole application.** This is the most
>    consequential find, and it is a crash rather than a refusal.
>
>    `drag-rs` canonicalizes every path with `dunce`, which returns a `\\?\`
>    verbatim path for anything it cannot express in normal form. The shell
>    namespace parser does not accept that prefix, so `ILCreateFromPathW`
>    returns a null `ITEMIDLIST`, `SHCreateShellItemArrayFromIDLists` fails,
>    and `get_shell_item_array(paths).unwrap()` — an `unwrap` on an `Option` —
>    panics on the main thread and takes the process with it. No error reaches
>    the callback, because the callback never runs.
>
>    **Phase 3's `drag.rs` must refuse these paths before calling the plugin**
>    and surface a normal error. SPEC §3 treats MAX_PATH as a scanner concern;
>    it is also a crash vector in the drag path, and a sample pack unzipped
>    inside a sample pack is exactly how a real library acquires one. Either
>    guard on the canonicalized form being verbatim, or upstream the fix.
>
>    Corroborating: Windows PowerShell 5.1 could not traverse to the file
>    either, failing at 7 levels deep — so Win32 long-path support is not
>    enabled on this machine. The file itself exists; Node created it using a
>    `\\?\` path.
>
>    The spike now blocks such a drag rather than reproducing the crash.
>
> 4. **A drag with no path silently does nothing** — which reads as "drag is
>    broken" rather than "no file selected". The real app's rows always carry a
>    path so this cannot arise, but it cost time here.
