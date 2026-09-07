import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import { RootsPanel } from "./components/RootsPanel";
import { SampleList } from "./components/SampleList";
import { SampleTiles } from "./components/SampleTiles";
import { StatusBar } from "./components/StatusBar";
import { useGlobalKeyboard } from "./keyboard/useGlobalKeyboard";
import { useLibrary } from "./stores/library";
import { unlock } from "./audio/engine";
import type { ScanComplete, ScanProgress } from "./ipc/commands";

export function App(): React.JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  const text = useLibrary((s) => s.text);
  const setText = useLibrary((s) => s.setText);
  const refreshRoots = useLibrary((s) => s.refreshRoots);
  const runQuery = useLibrary((s) => s.runQuery);
  const viewMode = useLibrary((s) => s.viewMode);
  const setViewMode = useLibrary((s) => s.setViewMode);
  const loadSettings = useLibrary((s) => s.loadSettings);

  useGlobalKeyboard(searchRef);

  useEffect(() => {
    void loadSettings();
    void refreshRoots();
    void runQuery();
  }, [loadSettings, refreshRoots, runQuery]);

  // Scan progress is streamed rather than polled, so a large library keeps the
  // window responsive throughout (SPEC §7.1).
  useEffect(() => {
    const store = useLibrary.getState();
    const unlisteners = [
      listen<ScanProgress>("scan:progress", (e) => store.onScanProgress(e.payload)),
      listen<ScanComplete>("scan:complete", (e) => store.onScanComplete(e.payload)),
    ];
    return () => {
      for (const pending of unlisteners) void pending.then((off) => off());
    };
  }, []);

  return (
    <div className="app" onPointerDown={() => void unlock()}>
      <header className="topbar">
        <input
          ref={searchRef}
          className="search"
          type="text"
          spellCheck={false}
          value={text}
          placeholder="search — try “808 kick”  ( / to focus, Esc to clear )"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="view-toggle" role="group" aria-label="View">
          {(["list", "tiles"] as const).map((mode) => (
            <button
              key={mode}
              className={viewMode === mode ? "active" : ""}
              onClick={() => setViewMode(mode)}
              title={
                mode === "list"
                  ? "List — more rows on screen, and ←/→ stay with the folder tree"
                  : "Tiles — bigger targets; ←/→ move across the grid"
              }
            >
              {mode}
            </button>
          ))}
        </div>
        <span className="hint">
          {viewMode === "tiles" ? "↑↓←→ audition" : "↑↓ audition"} · Space replay
        </span>
      </header>

      <div className="main">
        <RootsPanel />
        {viewMode === "tiles" ? <SampleTiles /> : <SampleList />}
      </div>

      <StatusBar />
    </div>
  );
}
