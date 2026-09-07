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
import type {
  CategoryCount, FolderNode, LibraryRoot, SampleDetail, SampleRow, TagCount, ViewMode,
} from "../ipc/commands";
import { DEFAULT_NORMALIZE, previewGainDb, type NormalizeMode, type NormalizeSettings } from "../audio/gain";
import { prefetch } from "../audio/bufferCache";
import { previewSample } from "../audio/preview";

/** How far either side of the selection to warm the decode cache (SPEC §8). */
const PREFETCH_RADIUS = 3;

/** Settle time before fetching the selected sample's detail. */
const DETAIL_DEBOUNCE_MS = 120;

let detailTimer: ReturnType<typeof setTimeout> | null = null;

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
  /**
   * What the same search would return across the whole library, when the view
   * is scoped to a root or folder. Null when nothing is scoped.
   *
   * This is what turns "12 results" from a dead end into a signpost: the
   * matches you cannot see are the reason a scoped search feels like the tool
   * is missing things.
   */
  globalTotal: number | null;
  loading: boolean;

  rootId: number | null;
  subtree: string | null;
  text: string;
  category: string | null;
  tagFilter: string[];

  tags: TagCount[];
  categories: CategoryCount[];
  /** Browse the sidebar by disk folder, or by what kind of drum it is. */
  groupBy: "folder" | "type";
  normalize: NormalizeSettings;
  /** Tags and anything else the list row does not carry, for the inspector. */
  detail: SampleDetail | null;

  viewMode: ViewMode;
  /**
   * Tiles per row, reported by the grid as it resizes.
   *
   * The keyboard layer needs it: in tile view an up/down press moves a whole
   * row, and only the grid knows how wide a row currently is.
   */
  columns: number;

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

  loadSettings: () => Promise<void>;
  setViewMode: (mode: ViewMode) => void;
  setColumns: (columns: number) => void;

  setCategory: (category: string | null) => void;
  setGroupBy: (groupBy: "folder" | "type") => void;
  refreshCategories: () => Promise<void>;
  /** Correct the guess for every sample currently listed. */
  recategorizeVisible: (category: string | null, clear?: boolean) => Promise<void>;
  toggleTagFilter: (tag: string) => void;
  setNormalizeMode: (mode: NormalizeMode) => void;
  setNormalizeTarget: (mode: "peak" | "body", db: number) => void;
  toggleFavorite: () => Promise<void>;
  setTagsForSelected: (tags: string[]) => Promise<void>;
  refreshTags: () => Promise<void>;

  setText: (text: string) => void;
  setRoot: (rootId: number | null) => void;
  setSubtree: (subtree: string | null) => void;
  clearScope: () => void;
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
  globalTotal: null,
  loading: false,

  rootId: null,
  subtree: null,
  text: "",
  category: null,
  tagFilter: [],

  tags: [],
  categories: [],
  groupBy: "folder",
  normalize: DEFAULT_NORMALIZE,
  detail: null,

  viewMode: "list",
  columns: 1,

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

  loadSettings: async () => {
    try {
      const settings = await ipc.getSettings();
      set({
        viewMode: settings.viewMode === "tiles" ? "tiles" : "list",
        normalize: {
          mode: settings.normalizeMode,
          targetPeakDb: settings.targetPeakDb,
          targetRmsDb: settings.targetRmsDb,
        },
      });
    } catch {
      // A settings read that fails is not worth blocking startup over; the
      // defaults are perfectly usable.
    }
  },

  setViewMode: (viewMode) => {
    set({ viewMode });
    void ipc.setSetting("view.mode", viewMode).catch(() => undefined);
  },

  setColumns: (columns) => {
    if (columns > 0 && columns !== get().columns) set({ columns });
  },

  setCategory: (category) => {
    set({ category });
    void get().runQuery();
  },

  toggleTagFilter: (tag) => {
    const current = get().tagFilter;
    // AND semantics (SPEC §7.3): every selected tag must be present.
    set({ tagFilter: current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag] });
    void get().runQuery();
  },

  setNormalizeMode: (mode) => {
    set((s) => ({ normalize: { ...s.normalize, mode } }));
    void ipc.setSetting("preview.normalizeMode", mode).catch(() => undefined);
    // Re-fire so the change is audible immediately rather than on the next
    // selection — the point of the control is A/B-ing it.
    get().replay();
  },

  setNormalizeTarget: (mode, db) => {
    set((s) => ({
      normalize: {
        ...s.normalize,
        ...(mode === "peak" ? { targetPeakDb: db } : { targetRmsDb: db }),
      },
    }));
    const key = mode === "peak" ? "preview.targetPeakDb" : "preview.targetRmsDb";
    void ipc.setSetting(key, String(db)).catch(() => undefined);
  },

  setGroupBy: (groupBy) => {
    // Switching how you browse should not leave the other axis filtering
    // invisibly: by type, a folder filter is exactly the thing you cannot see.
    set({ groupBy, subtree: null, category: null });
    void get().refreshCategories();
    void get().runQuery();
  },

  refreshCategories: async () => {
    try {
      set({ categories: await ipc.categoryCounts() });
    } catch {
      /* the sidebar counts are not worth an error banner */
    }
  },

  recategorizeVisible: async (category, clear = false) => {
    const ids = get().rows.map((row) => row.id);
    if (ids.length === 0) return;
    try {
      await ipc.setCategory(ids, category, clear);
      await get().refreshCategories();
      await get().runQuery();
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
  },

  refreshTags: async () => {
    try {
      set({ tags: await ipc.listTags() });
    } catch {
      /* the tag panel is not worth an error banner */
    }
  },

  toggleFavorite: async () => {
    const { detail } = get();
    if (detail === null) return;
    // SPEC §6 shows favourites in the tag list; a favourite is just a tag, so
    // there is no second mechanism to keep in step with the first.
    const next = detail.tags.includes("favorite")
      ? detail.tags.filter((t) => t !== "favorite")
      : [...detail.tags, "favorite"];
    await get().setTagsForSelected(next);
  },

  setTagsForSelected: async (tags) => {
    const { detail } = get();
    if (detail === null) return;
    try {
      await ipc.setTags(detail.id, tags);
      set({ detail: { ...detail, tags } });
      await get().refreshTags();
      // A tag filter that no longer matches must drop the row from the list.
      if (get().tagFilter.length > 0) await get().runQuery();
    } catch (e) {
      set({ error: ipc.errorText(e) });
    }
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

  clearScope: () => {
    set({ rootId: null, subtree: null });
    void get().refreshRoots();
    void get().runQuery();
  },

  runQuery: async () => {
    const { rootId, subtree, text } = get();
    set({ loading: true });
    try {
      const { category, tagFilter } = get();
      const filters = {
        text: text.trim() === "" ? null : text,
        category,
        tags: tagFilter,
      };
      const page = await ipc.listSamples({ rootId, subtree, ...filters });

      // When scoped, ask what the same filters would match everywhere. Cheap
      // enough to do on every query — `limit: 0` returns the count without the
      // rows — and it is the difference between "there are 12" and "there are
      // 12 here, and 47 you are not being shown".
      const scoped = rootId !== null || subtree !== null;
      const globalTotal = scoped
        ? (await ipc.listSamples({ ...filters, limit: 0 })).total
        : null;
      // Keep the selection where it is if the row is still present, so typing
      // a search term that narrows the list does not throw away the user's place.
      const previous = get().rows[get().selectedIndex]?.id;
      const nextIndex = previous === undefined ? -1 : page.rows.findIndex((r) => r.id === previous);
      set({
        rows: page.rows,
        total: page.total,
        globalTotal,
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

    void previewSample(row.id, previewGainDb(row, get().normalize)).then((result) => {
      set((s) => {
        const errors = { ...s.rowErrors };
        if (result.error === undefined) delete errors[row.id];
        else errors[row.id] = result.error;
        return { rowErrors: errors };
      });
    });

    // The inspector needs tags, which the list row does not carry. Debounced:
    // holding the arrow key would otherwise fire one IPC round trip per row,
    // competing with the decodes that actually have to be fast.
    if (detailTimer !== null) clearTimeout(detailTimer);
    detailTimer = setTimeout(() => {
      void ipc
        .getSample(row.id)
        .then((detail) => {
          // Discard if the selection moved on while this was in flight.
          if (get().rows[get().selectedIndex]?.id === row.id) set({ detail });
        })
        .catch(() => undefined);
    }, DETAIL_DEBOUNCE_MS);

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
