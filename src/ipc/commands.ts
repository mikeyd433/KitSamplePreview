/**
 * Typed wrappers over the SPEC §5 command surface.
 *
 * No `any` (SPEC §15): these interfaces are the contract with Rust, and a
 * mistyped boundary is how the UI ends up confidently rendering nothing.
 */
import { invoke } from "@tauri-apps/api/core";

export interface LibraryRoot {
  id: number;
  path: string;
  label: string;
  addedAt: number;
  sampleCount: number;
}

export interface SampleRow {
  id: number;
  rootId: number;
  path: string;
  relPath: string;
  filename: string;
  parentDir: string;
  ext: string;
  sizeBytes: number;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  category: string | null;
  /** Loudest single sample, dBFS. Null until analysed. */
  truePeakDb: number | null;
  /** RMS of the loudest 300 ms window, dBFS. Null until analysed. */
  bodyRmsDb: number | null;
  /** 400 min/max i8 pairs, base64. Null until analysed. */
  peaks: string | null;
  /** Why this file must not be dragged, or null when it is safe. */
  dragBlocked: string | null;
  removed: boolean;
  /** Why the scan could not read this file. Null for healthy rows. */
  probeError: string | null;
}

export interface SampleDetail extends SampleRow {
  tags: string[];
}

export interface SamplePage {
  /** Matches ignoring pagination — §7.3 keeps this visible at all times. */
  total: number;
  rows: SampleRow[];
}

export interface SampleQuery {
  rootId?: number | null;
  subtree?: string | null;
  text?: string | null;
  category?: string | null;
  tags?: string[];
  minDurationMs?: number | null;
  maxDurationMs?: number | null;
  exts?: string[];
  includeRemoved?: boolean;
  limit?: number | null;
  offset?: number | null;
}

export interface FolderNode {
  rootId: number;
  /** Relative to its root; empty string is the root itself. */
  relDir: string;
  sampleCount: number;
}

export interface Playable {
  path: string;
  transcoded: boolean;
}

export interface TagCount {
  name: string;
  sampleCount: number;
}

export interface ScanProgress {
  scanId: number;
  done: number;
  total: number;
  currentPath: string;
}

export interface ScanComplete {
  scanId: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
}

export const listRoots = (): Promise<LibraryRoot[]> => invoke<LibraryRoot[]>("list_roots");

export const addRoot = (path: string): Promise<number> => invoke<number>("add_root", { path });

export const removeRoot = (id: number): Promise<void> => invoke<void>("remove_root", { id });

export const scanRoots = (roots: string[], force: boolean): Promise<number> =>
  invoke<number>("scan_roots", { roots, force });

export const listSamples = (query: SampleQuery): Promise<SamplePage> =>
  invoke<SamplePage>("list_samples", { query });

export const getSample = (id: number): Promise<SampleDetail | null> =>
  invoke<SampleDetail | null>("get_sample", { id });

export const folderTree = (rootId: number | null): Promise<FolderNode[]> =>
  invoke<FolderNode[]>("folder_tree", { rootId });

export const resolvePlayable = (id: number): Promise<Playable> =>
  invoke<Playable>("resolve_playable", { id });

export const setTags = (sampleId: number, tags: string[]): Promise<void> =>
  invoke<void>("set_tags", { sampleId, tags });

export const listTags = (): Promise<TagCount[]> => invoke<TagCount[]>("list_tags");

export interface KitSummary {
  id: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  filled: number;
}

export interface KitSlot {
  slotIndex: number;
  sampleId: number | null;
  gainDbOffset: number;
  notes: string | null;
}

export interface KitSlotDetail extends KitSlot {
  sample: SampleRow | null;
}

export interface KitDetail {
  id: number;
  name: string;
  slots: KitSlotDetail[];
}

export interface ExportOptions {
  sampleRate?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
  applySlotGain?: boolean;
  normalize?: boolean;
  normalizeTargetDb?: number | null;
}

export interface ExportedFile {
  slotIndex: number;
  path: string;
  converted: boolean;
}

export interface SkippedSlot {
  slotIndex: number;
  reason: string;
}

export interface ExportReport {
  destDir: string;
  written: ExportedFile[];
  skipped: SkippedSlot[];
}

export const listKits = (): Promise<KitSummary[]> => invoke<KitSummary[]>("list_kits");

export const saveKit = (name: string, slots: KitSlot[]): Promise<number> =>
  invoke<number>("save_kit", { name, slots });

export const loadKit = (id: number): Promise<KitDetail | null> =>
  invoke<KitDetail | null>("load_kit", { id });

export const deleteKit = (id: number): Promise<void> => invoke<void>("delete_kit", { id });

export const exportKit = (
  kitId: number,
  destDir: string,
  options: ExportOptions,
): Promise<ExportReport> => invoke<ExportReport>("export_kit", { kitId, destDir, options });

export const ffmpegAvailable = (): Promise<boolean> => invoke<boolean>("ffmpeg_available");

export interface AppVersion {
  version: string;
  /** Short commit; a trailing "+" means the tree was dirty at build time. */
  commit: string;
  /** Unix seconds. */
  builtAt: number;
}

export const appVersion = (): Promise<AppVersion> => invoke<AppVersion>("app_version");

export type ViewMode = "list" | "tiles";

export interface Settings {
  scanMaxDurationMs: number;
  viewMode: ViewMode;
  normalizeMode: "off" | "peak" | "body";
  targetPeakDb: number;
  targetRmsDb: number;
}

export const getSettings = (): Promise<Settings> => invoke<Settings>("get_settings");

export const setSetting = (key: string, value: string): Promise<void> =>
  invoke<void>("set_setting", { key, value });

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
