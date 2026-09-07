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
import { useKit } from "../stores/kit";
import { SLOT_KEYS } from "../components/KitTray";
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
        // Widens one step at a time, so Escape always undoes the most recent
        // narrowing rather than throwing away both at once.
        if (store.text !== "") store.setText("");
        else if (store.rootId !== null || store.subtree !== null) store.clearScope();
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

      // Horizontal keys always move one sample; vertical keys move one row,
      // which is one sample in the list and a full row of them in the grid.
      //
      // SPEC §7.2 reserved left/right for folder-tree collapse/expand. Dropped
      // at the developer's request: the tree keeps its click twisties, and
      // freeing the keys makes one keymap work in both views instead of two
      // that diverge.
      const step = store.viewMode === "tiles" ? Math.max(1, store.columns) : 1;

      // The 4x4 slot block (SPEC §7.2). These deliberately shadow letter keys,
      // which is safe only because the `typing` guard above has already
      // returned for anything focused on an input — the spec is explicit that
      // slot assignment is live only when the list has focus.
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const slot = SLOT_KEYS.indexOf(e.key.toLowerCase());
        if (slot !== -1) {
          const row = store.rows[store.selectedIndex];
          if (row !== undefined) useKit.getState().assign(slot, row);
          e.preventDefault();
          return;
        }
      }

      switch (e.key) {
        case "Enter": {
          // §7.2: add the selection to the next empty slot.
          const row = store.rows[store.selectedIndex];
          if (row !== undefined) useKit.getState().assignToNextEmpty(row);
          e.preventDefault();
          break;
        }
        case "ArrowLeft":
          void unlock();
          store.moveSelection(-1);
          e.preventDefault();
          break;
        case "ArrowRight":
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
        case "*":
          // SPEC §7.2. A favourite is a tag, so this rides on the same
          // mechanism as everything else in the tag panel.
          void store.toggleFavorite();
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
