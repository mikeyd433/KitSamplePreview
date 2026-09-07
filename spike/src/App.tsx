import { DragBench } from "./components/DragBench";
import { DecodeBench } from "./components/DecodeBench";
import { LogPane } from "./components/LogPane";
import { EnvBanner } from "./components/EnvBanner";

export function App(): React.JSX.Element {
  return (
    <div className="app">
      <header className="app-head">
        <div>
          <h1>Kitbench — Phase 0 drag-out spike</h1>
          <p>
            Throwaway. One question: can a file be dragged from a Tauri v2 window onto a Sitala pad
            inside REAPER on Windows and be accepted? Work the matrix, then fill in{" "}
            <code>spike/RESULTS.md</code> and stop.
          </p>
        </div>
        <EnvBanner />
      </header>

      <DragBench />
      <DecodeBench />
      <LogPane />
    </div>
  );
}
