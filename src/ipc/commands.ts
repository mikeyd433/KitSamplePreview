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

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
