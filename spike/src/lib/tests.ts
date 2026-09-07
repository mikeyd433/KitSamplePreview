/**
 * The SPEC §14 test matrix, verbatim, plus two clearly-marked extras.
 *
 * Rows 1–8 are the spec's table. Rows 9–10 are additions:
 *   9  — over-MAX_PATH nesting, because SPEC §3 calls it out as a Windows
 *        hazard and drag-rs canonicalizes with dunce, which strips the `\\?\`
 *        prefix wherever it can. Cheap to run while the rig is already set up.
 *   10 — Sitala standalone rather than hosted. Only worth running if row 1
 *        fails: it isolates "host-owned child window" as the variable.
 * Skip either without affecting the spec's outcome branches.
 */

export interface DragTest {
  readonly id: string;
  readonly title: string;
  /** Where to release the mouse button. */
  readonly target: string;
  /** What the row is evidence for — the spec's "Records" column. */
  readonly records: string;
  readonly pathCount: number;
  readonly placeholders: readonly string[];
  readonly extra?: boolean;
  /** Shown when the row needs setup the developer has to do first. */
  readonly setup?: string;
}

export const DRAG_TESTS: readonly DragTest[] = [
  {
    id: "1",
    title: "Baseline — one 16-bit 44.1k WAV",
    target: "a Sitala pad (Sitala loaded as a plugin inside REAPER)",
    records: "The core question.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\kick.wav`],
  },
  {
    id: "2",
    title: "Repeat onto a different pad",
    target: "a different Sitala pad",
    records: "Whether it is reliable or a fluke.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\snare.wav`],
  },
  {
    id: "3",
    title: "Path containing spaces",
    target: "a Sitala pad",
    records: "Path escaping in the plugin.",
    pathCount: 1,
    placeholders: [String.raw`C:\Sample Packs\Dusty Breaks\kick 01.wav`],
  },
  {
    id: "4",
    title: "Path containing non-ASCII characters",
    target: "a Sitala pad",
    records: "Encoding handling. drag-rs encodes UTF-16 with fWide=1, so this should hold.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\Café_Ünïcode\kick_ñ.wav`],
  },
  {
    id: "5",
    title: "UNC network path",
    target: "a Sitala pad",
    records: "Network path support. Skip if no share is available.",
    pathCount: 1,
    placeholders: [String.raw`\\NAS\samples\kick.wav`],
    setup: "Needs a reachable SMB share. Note it as skipped rather than guessing.",
  },
  {
    id: "6",
    title: "Two files at once",
    target: "a Sitala pad",
    records:
      "Whether multi-drag works at all, and what Sitala does with it (SPEC §11.3). " +
      "The drag source does support it: drag-rs concatenates null-terminated wide paths " +
      "into one CF_HDROP. Any failure here is Sitala's side.",
    pathCount: 2,
    placeholders: [String.raw`C:\Samples\kick.wav`, String.raw`C:\Samples\snare.wav`],
  },
  {
    id: "7",
    title: "Drop on REAPER's arrange view",
    target: "REAPER's arrange view — NOT Sitala",
    records:
      "The important diagnostic. REAPER accepts but Sitala refuses ⇒ Sitala's drop handling " +
      "is the problem and export-to-folder becomes primary. Nothing accepts ⇒ the drag source " +
      "is the problem and may be fixable.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\kick.wav`],
  },
  {
    id: "8",
    title: "Drop on Explorer or a text editor",
    target: "an Explorer window, or Notepad/VS Code",
    records: "Same isolation as row 7, one more data point.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\kick.wav`],
  },
  {
    id: "9",
    title: "Path longer than 260 characters",
    target: "a Sitala pad",
    records:
      "MAX_PATH (SPEC §3). Watch the pre-flight row: if it reports a `\\\\?\\` verbatim path, " +
      "that is the exact string handed to the shell, and some drop targets choke on it.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\aaa...\deeply\nested\pack\kick.wav`],
    extra: true,
    setup:
      "Make one by unzipping a pack inside a pack a few times, or nest folders until the " +
      "pre-flight char count clears 260.",
  },
  {
    id: "10",
    title: "Standalone Sitala rather than hosted",
    target: "a pad in a standalone Sitala build",
    records:
      "Only worth running if row 1 failed. Standalone works but hosted does not ⇒ the " +
      "host-owned child window is the variable.",
    pathCount: 1,
    placeholders: [String.raw`C:\Samples\kick.wav`],
    extra: true,
    setup: "Run only after a row 1 failure.",
  },
];
