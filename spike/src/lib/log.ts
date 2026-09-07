/**
 * The spike's log pane (SPEC §14: "a visible log pane showing what was called
 * with what arguments, and any error returned").
 *
 * Deliberately an external store rather than React state: entries are appended
 * from drag callbacks that fire while the main thread is blocked inside
 * DoDragDrop, and from promise chains that outlive the component. It also
 * doubles as the report -- `toMarkdown` produces something pasteable straight
 * into RESULTS.md.
 */

export type LogLevel = "info" | "call" | "ok" | "warn" | "error";

export interface LogEntry {
  readonly id: number;
  readonly at: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly detail?: string;
}

const MAX_ENTRIES = 500;

let entries: readonly LogEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function push(level: LogLevel, source: string, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    id: nextId++,
    at: stamp(),
    level,
    source,
    message,
    ...(detail === undefined ? {} : { detail: format(detail) }),
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  emit();
}

function format(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export const log = {
  info: (source: string, message: string, detail?: unknown) => push("info", source, message, detail),
  call: (source: string, message: string, detail?: unknown) => push("call", source, message, detail),
  ok: (source: string, message: string, detail?: unknown) => push("ok", source, message, detail),
  warn: (source: string, message: string, detail?: unknown) => push("warn", source, message, detail),
  error: (source: string, message: string, detail?: unknown) => push("error", source, message, detail),
  clear: () => {
    entries = [];
    emit();
  },
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  snapshot: (): readonly LogEntry[] => entries,
  toMarkdown: (): string => {
    if (entries.length === 0) return "_(log empty)_\n";
    const lines = entries.map((e) => {
      const head = `${e.at}  [${e.level.toUpperCase()}] ${e.source} — ${e.message}`;
      return e.detail ? `${head}\n${e.detail.replace(/^/gm, "    ")}` : head;
    });
    return "```\n" + lines.join("\n") + "\n```\n";
  },
};
