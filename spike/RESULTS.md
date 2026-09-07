# Phase 0 results — drag-out spike

Fill this in as you work the matrix, then stop. Per SPEC §14 the only deliverable
is an answer; nothing else in the spec gets built until this document is complete
and an outcome branch is chosen.

---

## Environment

Copy these from the banner at the top of the spike window.

| | |
|---|---|
| Date | |
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
| 1 | One 16-bit 44.1k WAV → Sitala pad | | | | |
| 2 | Repeat onto a different pad | | | | |
| 3 | Path with spaces | | | | |
| 4 | Path with non-ASCII characters | | | | |
| 5 | UNC path (`\\NAS\...`) | | | | |
| 6 | Two files at once | | | | |
| 7 | → REAPER arrange view (not Sitala) | | | | |
| 8 | → Explorer / a text editor | | | | |
| 9 | Path over 260 chars *(beyond §14)* | | | | |
| 10 | Standalone Sitala *(only if 1 failed)* | | | | |

**Did `dragstart` and `mousedown` behave differently?**

> 

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

> 
