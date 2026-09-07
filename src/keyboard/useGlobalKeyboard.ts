/**
 * The single global key handler (SPEC §5).
 *
 * One handler, deliberately: the whole app is keyboard-driven and scattered
 * `onKeyDown` handlers will fight each other. Phase 1 covers navigation and
 * search focus; the 4x4 slot-assignment block arrives with the kit tray in
 * Phase 3.
 */
import { useEffect } from "react";

import { useLibrary } from "../stores/library";
import { unlock } from "../audio/engine";

/** True when the event came from somewhere that legitimately wants the key. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useGlobalKeyboard(searchRef: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const typing = isTyping(e.target);
      const store = useLibrary.getState();

      // Escape works from the search box too: it is how you get back to the
      // list, and §7.2 gives it both jobs — clear the search, then return focus.
      if (e.key === "Escape") {
        if (store.text !== "") store.setText("");
        else searchRef.current?.blur();
        if (typing) searchRef.current?.blur();
        e.preventDefault();
        return;
      }

      // Everything below is list navigation, and must not fire while typing.
      // §7.2: slot assignment is only live when the list has focus, and `/` or
      // clicking the search box takes focus away from it. Same rule, applied
      // early so the later keys inherit it.
      if (typing) return;

      // In tile view a vertical press moves a whole row and the horizontal
      // keys move within one. In list view the horizontal keys stay reserved
      // for the folder tree, exactly as SPEC §7.2 assigns them.
      const tiles = store.viewMode === "tiles";
      const step = tiles ? Math.max(1, store.columns) : 1;

      switch (e.key) {
        case "ArrowLeft":
          if (!tiles) break;
          void unlock();
          store.moveSelection(-1);
          e.preventDefault();
          break;
        case "ArrowRight":
          if (!tiles) break;
          void unlock();
          store.moveSelection(1);
          e.preventDefault();
          break;
        case "/":
          searchRef.current?.focus();
          searchRef.current?.select();
          e.preventDefault();
          break;
        case "ArrowDown":
          void unlock();
          store.moveSelection(step);
          e.preventDefault();
          break;
        case "ArrowUp":
          void unlock();
          store.moveSelection(-step);
          e.preventDefault();
          break;
        case "PageDown":
          store.moveSelection(10 * step);
          e.preventDefault();
          break;
        case "PageUp":
          store.moveSelection(-10 * step);
          e.preventDefault();
          break;
        case "Home":
          store.select(0);
          e.preventDefault();
          break;
        case "End":
          store.select(store.rows.length - 1);
          e.preventDefault();
          break;
        case " ":
          void unlock();
          store.replay();
          e.preventDefault();
          break;
        default:
          break;
      }
    };

    // Capture phase, so the handler sees keys before any focused control can
    // swallow them — the list is the focus of the app, not any one widget.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [searchRef]);
}
