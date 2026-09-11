/**
 * Drag-out to Sitala (SPEC §7.8).
 *
 * The plugin's JS entry point is called straight from the mouse handler rather
 * than being wrapped in a command of our own, which SPEC §5 sketches. Two
 * reasons, both learned in Phase 0: the drag must originate from a real mouse
 * event, and nothing may be awaited between the event and `startDrag` or the
 * gesture is lost. A Rust passthrough would add an IPC hop inside exactly that
 * window and buy nothing — the plugin already is the thin wrapper.
 *
 * What Rust does contribute is the safety check, which rides along on the row
 * as `dragBlocked` so this function never has to ask.
 */
import { startDrag } from "@crabnebula/tauri-plugin-drag";

import { DRAG_ICON } from "./dragIcon";

export interface DragResult {
  started: boolean;
  error?: string;
}

/**
 * Starts an OS drag carrying `paths`.
 *
 * Synchronous up to the `startDrag` call on purpose. Phase 0 confirmed the
 * mechanism: on Windows the plugin builds a shell IDataObject and serves
 * `CF_HDROP`, which is the same data object Explorer produces, so Sitala cannot
 * tell the difference — and it accepted every format tested, so nothing is
 * converted on the way out.
 */
export function dragOut(
  paths: string[],
  blocked: string | null,
  onFinish?: (dropped: boolean) => void,
): DragResult {
  if (paths.length === 0) return { started: false, error: "nothing to drag" };

  // Phase 0 row 9: an over-MAX_PATH file does not fail the drag, it kills the
  // process. Refusing here is the difference between a message and a crash.
  if (blocked !== null) return { started: false, error: blocked };

  void startDrag({ item: paths, icon: DRAG_ICON, mode: "copy" }, (payload) => {
    onFinish?.(payload.result === "Dropped");
  }).catch(() => {
    onFinish?.(false);
  });

  return { started: true };
}
