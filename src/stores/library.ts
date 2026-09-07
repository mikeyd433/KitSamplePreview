/**
 * Library state (SPEC §5): the current query, its result page, and the
 * selection index. Selection changes drive preview.
 *
 * Most state here is derived from the index rather than owned, so the store
 * stays small — it holds what the user has chosen, and a cache of what the
 * last query returned.
 */
import { create } from "zustand";

import * as ipc from "../ipc/commands";
import type { FolderNode, LibraryRoot, SampleRow } from "../ipc/commands";
import { prefetch } from "../audio/bufferCache";
import { previewSample } from "../audio/preview";

/** How far either side of the selection to warm the decode cache (SPEC §8). */
const PREFETCH_RADIUS = 3;

interface ScanState {
  running: boolean;
  done: number;
  total: number;
  currentPath: string;
  lastReport: ipc.ScanComplete | null;
}

interface LibraryState {
  roots: LibraryRoot[];
  folders: FolderNode[];
  rows: SampleRow[];
  total: number;
  loading: boolean;

  rootId: number | null;
  subtree: string | null;
  text: string;

  selectedIndex: number;
  /** Decode failures, keyed by sample id, so a bad row shows why (SPEC §15). */
  rowErrors: Record<number, string>;
  error: string | null;
  scan: ScanState;

  refreshRoots: () => Promise<void>;
  addRoot: (path: string) => Promise<void>;
  removeRoot: (id: number) => Promise<void>;
  rescan: (force: boolean) => Promise<void>;
  onScanProgress: (p: ipc.ScanProgress) => void;
  onScanComplete: (c: ipc.ScanComplete) => void;

  setText: (text: string) => void;
  setRoot: (rootId: number | null) => void;
  setSubtree: (subtree: string | null) => void;
  runQuery: () => Promise<void>;

  select: (index: number, options?: { preview?: boolean }) => void;
  moveSelection: (delta: number) => void;
  replay: () => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  roots: [],
  folders: [],
  rows: [],
  total: 0,
  loading: false,

  rootId: null,
  subtree: null,
  text: "",

  selectedIndex: -1,
  rowErrors: {},
  error: null,
  scan: { running: false, done: 0, total: 0, currentPath: "", lastReport: null },

  refreshRoots: async () => {
    try {
      const [roots, folders] = await Promise.all([
        ipc.listRoots(),
        ipc.folderTree(get().rootId),
      ]);
      set({ roots, folders, error: null });
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  addRoot: async (path) => {
    try {
      await ipc.addRoot(path);
      await get().refreshRoots();
      // A freshly added root holds nothing until it is walked, so scanning
      // here is the difference between "added a folder" and "added a library".
      await get().rescan(false);
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  removeRoot: async (id) => {
    try {
      await ipc.removeRoot(id);
      if (get().rootId === id) set({ rootId: null, subtree: null });
      await get().refreshRoots();
      await get().runQuery();
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  rescan: async (force) => {
    try {
      set((s) => ({ scan: { ...s.scan, running: true, done: 0, total: 0 }, error: null }));
      await ipc.scanRoots([], force);
    } catch (e) {
      set((s) => ({ scan: { ...s.scan, running: false }, error: ipc.errorText(e) }));
    }
  },

  onScanProgress: (p) =>
    set((s) => ({
      scan: { ...s.scan, running: true, done: p.done, total: p.total, currentPath: p.currentPath },
    })),

  onScanComplete: (c) => {
    set((s) => ({ scan: { ...s.scan, running: false, lastReport: c } }));
    void get().refreshRoots();
    void get().runQuery();
  },

  setText: (text) => {
    set({ text });
    void get().runQuery();
  },

  setRoot: (rootId) => {
    set({ rootId, subtree: null });
    void get().refreshRoots();
    void get().runQuery();
  },

  setSubtree: (subtree) => {
    set({ subtree });
    void get().runQuery();
  },

  runQuery: async () => {
    const { rootId, subtree, text } = get();
    set({ loading: true });
    try {
      const page = await ipc.listSamples({
        rootId,
        subtree,
        text: text.trim() === "" ? null : text,
      });
      // Keep the selection where it is if the row is still present, so typing
      // a search term that narrows the list does not throw away the user's place.
      const previous = get().rows[get().selectedIndex]?.id;
      const nextIndex = previous === undefined ? -1 : page.rows.findIndex((r) => r.id === previous);
      set({
        rows: page.rows,
        total: page.total,
        loading: false,
        error: null,
        selectedIndex: nextIndex,
      });
    } catch (e) {
      set({ loading: false, error: ipc.errorText(e) });
    }
  },

  select: (index, options) => {
    const { rows } = get();
    if (index < 0 || index >= rows.length) return;
    const row = rows[index];
    if (row === undefined) return;
    set({ selectedIndex: index });

    if (options?.preview === false) return;

    void previewSample(row.id).then((result) => {
      set((s) => {
        const errors = { ...s.rowErrors };
        if (result.error === undefined) delete errors[row.id];
        else errors[row.id] = result.error;
        return { rowErrors: errors };
      });
    });

    // Warm the neighbours so arrow-key scrubbing never waits on a decode.
    const ids: number[] = [];
    for (let d = -PREFETCH_RADIUS; d <= PREFETCH_RADIUS; d++) {
      const neighbour = rows[index + d];
      if (d !== 0 && neighbour !== undefined) ids.push(neighbour.id);
    }
    prefetch(ids);
  },

  moveSelection: (delta) => {
    const { selectedIndex, rows } = get();
    if (rows.length === 0) return;
    // From nothing, the first move lands on the first row rather than nowhere.
    const from = selectedIndex < 0 ? (delta > 0 ? -1 : 0) : selectedIndex;
    const next = Math.max(0, Math.min(rows.length - 1, from + delta));
    if (next !== selectedIndex || selectedIndex < 0) get().select(next);
  },

  replay: () => {
    const { selectedIndex } = get();
    if (selectedIndex >= 0) get().select(selectedIndex);
  },
}));
