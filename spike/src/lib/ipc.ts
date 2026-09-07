/**
 * Typed wrappers over the spike's four Rust commands.
 *
 * SPEC §15 bans `any` even here; the spike is throwaway but a mistyped IPC
 * boundary is exactly how a spike produces a confidently wrong answer.
 */
import { invoke } from "@tauri-apps/api/core";

export interface PathCheck {
  input: string;
  exists: boolean;
  isFile: boolean;
  sizeBytes: number | null;
  /** The dunce-canonicalized string drag-rs actually hands to the shell. */
  canonical: string | null;
  error: string | null;
  /** Canonicalization produced a `\\?\` verbatim path — the MAX_PATH case. */
  verbatim: boolean;
  charLen: number;
}

export interface FormatSniff {
  container: string;
  codec: string;
  channels: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  durationMs: number | null;
  note: string | null;
}

export interface AudioFile {
  path: string;
  name: string;
  ext: string;
  sizeBytes: number;
  format: FormatSniff;
}

export interface EnvInfo {
  os: string;
  arch: string;
  tauriVersion: string;
  webviewVersion: string;
  dragPluginNote: string;
}

export const checkPaths = (paths: string[]): Promise<PathCheck[]> =>
  invoke<PathCheck[]>("check_paths", { paths });

export const scanDecodeDir = (dir: string): Promise<AudioFile[]> =>
  invoke<AudioFile[]>("scan_decode_dir", { dir });

export const readFileBytes = (path: string): Promise<ArrayBuffer> =>
  invoke<ArrayBuffer>("read_file_bytes", { path });

export const envInfo = (): Promise<EnvInfo> => invoke<EnvInfo>("env_info");

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
