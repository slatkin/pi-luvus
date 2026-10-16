/**
 * Luvus module: publish titles for resumable pi sessions.
 *
 * Luvus does not parse pi's session store. This module lists the resumable
 * `pi` sessions over the Luvus CLI, finds each session's JSONL file under
 * `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`), reads the
 * last `session_info` name or the first user message, and pushes the titles
 * back with one `ui agent-title push`.
 *
 * The module is one-shot: Luvus runs it from `[[startup]]` and the
 * `pane.agent_status_changed` / `pane.closed` events. It caches each file's
 * title by modification time in `$LUVUS_MODULE_STATE_DIR`, so an event reads
 * only the session files that changed.
 *
 * The prompt-cut rule (first non-empty line, controls stripped, 48 chars) is
 * the shared helper in `../pi-extension/luvus/live-title.ts`, imported by
 * relative path: the module ships inside this package and resolves the helper
 * from the same checkout, so no copy is needed.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cutPromptTitle,
  firstUserPromptText,
  type SessionEntryLike,
} from "../pi-extension/luvus/live-title.ts";
import { LUVUS_CALL_TIMEOUT_MS } from "../pi-extension/luvus/luvus.ts";

/** Most recent sessions pushed in one run. */
export const MAX_SESSIONS = 256;

/** UTF-8 byte cap for one title, because Luvus bounds module titles. */
export const MAX_TITLE_BYTES = 256;

/** The module state file, relative to `$LUVUS_MODULE_STATE_DIR`. */
export const CACHE_FILE = "titles-cache.json";

/** One resumable session as `luvus agent sessions` reports it. */
export interface AgentSession {
  agent: string;
  session_id: string;
  cwd?: string;
}

/** One title row for `ui agent-title push`. */
export interface TitleRow {
  agent: string;
  session_id: string;
  title: string;
}

/** A session entry that may carry a `session_info` name. */
interface SessionInfoLike extends SessionEntryLike {
  name?: unknown;
}

/** Modification time and size of one session file. */
export interface SessionFileInfo {
  path: string;
  mtimeMs: number;
  size: number;
}

/** One cached title, keyed by session file path. */
export interface TitleCacheEntry {
  mtimeMs: number;
  size: number;
  title: string;
}

/** The on-disk cache written to the module state directory. */
export interface TitleCache {
  version: 1;
  files: Record<string, TitleCacheEntry>;
}

/** An empty cache. */
export function emptyCache(): TitleCache {
  return { version: 1, files: {} };
}

/** Resolve the sessions root, respecting `PI_CODING_AGENT_DIR`. */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

/** True when a value has the `agent` + `session_id` shape. */
function isAgentSession(value: unknown): value is AgentSession {
  if (value === null || typeof value !== "object") return false;
  const row = value as { agent?: unknown; session_id?: unknown };
  return typeof row.agent === "string" && typeof row.session_id === "string";
}

function sessionsFrom(value: unknown): AgentSession[] {
  if (Array.isArray(value)) return value.filter(isAgentSession);
  if (value !== null && typeof value === "object") {
    const result = (value as { result?: unknown }).result ?? value;
    const sessions = (result as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions.filter(isAgentSession);
  }
  return [];
}

/**
 * Parse the JSON from `luvus agent sessions`, which wraps the list in
 * `{"id":…,"result":{"sessions":[…]}}`. A bare list or `{"sessions":[…]}` is
 * accepted too. Malformed input yields an empty list, never a throw.
 */
export function parseAgentSessions(raw: string): AgentSession[] {
  try {
    return sessionsFrom(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** The `pi` sessions, newest first, capped at `limit`. */
export function piSessions(
  sessions: readonly AgentSession[],
  limit = MAX_SESSIONS,
): AgentSession[] {
  return sessions.filter((session) => session.agent === "pi").slice(0, limit);
}

/** The session id carried by a pi session file name (`<stamp>_<id>.jsonl`). */
export function sessionIdFromFileName(name: string): string | null {
  if (!name.endsWith(".jsonl")) return null;
  const stem = name.slice(0, -".jsonl".length);
  const parts = stem.split("_");
  const id = parts[parts.length - 1];
  return id.length > 0 ? id : null;
}

/**
 * Index every `.jsonl` session file under `root` by session id, walking the
 * tree once. Missing or unreadable directories are skipped.
 */
export function indexSessionFiles(root: string): Map<string, SessionFileInfo> {
  const index = new Map<string, SessionFileInfo>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const id = sessionIdFromFileName(entry.name);
      if (id === null || index.has(id)) continue;
      try {
        const stat = statSync(path);
        index.set(id, { path, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // A file removed mid-walk is not a session we can title.
      }
    }
  }
  return index;
}

/**
 * Cut a title to `max` UTF-8 bytes without splitting a code point. A trailing
 * replacement character from a split sequence is dropped.
 */
export function capTitleBytes(title: string, max = MAX_TITLE_BYTES): string {
  const bytes = Buffer.from(title, "utf8");
  if (bytes.length <= max) return title;
  let cut = bytes.subarray(0, max).toString("utf8");
  while (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Title for one session: the last `session_info` name when the session has
 * one, else the first user message. Both run through the shared prompt-cut
 * helper. Returns "" when neither exists.
 */
export function titleFromEntries(entries: readonly SessionInfoLike[]): string {
  let name = "";
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    if (entry.type !== "session_info") continue;
    if (typeof entry.name === "string") name = entry.name;
  }
  if (name.trim().length > 0) return cutPromptTitle(name);
  return cutPromptTitle(firstUserPromptText(entries));
}

/** Parse one JSONL session file's text into a title. */
export function parseSessionTitle(text: string): string {
  const entries: SessionInfoLike[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as SessionInfoLike);
    } catch {
      // One malformed line must not lose the rest of the session.
    }
  }
  return titleFromEntries(entries);
}

/** Args for one `ui agent-title push` with every row. */
export function buildTitlePushArgs(rows: readonly TitleRow[]): string[] {
  return ["ui", "agent-title", "push", "--titles", JSON.stringify(rows)];
}

/** Read a cache file's text, accepting only the current version. */
export function readTitleCache(text: string | null): TitleCache {
  if (text === null) return emptyCache();
  try {
    const parsed = JSON.parse(text) as Partial<TitleCache>;
    if (parsed.version === 1 && parsed.files !== null && typeof parsed.files === "object") {
      return { version: 1, files: parsed.files as Record<string, TitleCacheEntry> };
    }
  } catch {
    // A bad cache is rebuilt from session files.
  }
  return emptyCache();
}

/**
 * Resolve titles for the pi sessions, reading only files whose modification
 * time or size changed since the cache was written. A file that disappears or
 * becomes unreadable between the index and the read is skipped for this run,
 * so one bad session never loses the rest. The returned cache holds the current
 * run's files only, so it stays bounded.
 */
export function collectTitles(
  sessions: readonly AgentSession[],
  cache: TitleCache,
  index: ReadonlyMap<string, SessionFileInfo>,
  readFile: (path: string) => string,
  limit = MAX_SESSIONS,
): { rows: TitleRow[]; cache: TitleCache; reads: number } {
  const rows: TitleRow[] = [];
  const files: Record<string, TitleCacheEntry> = {};
  let reads = 0;
  for (const session of piSessions(sessions, limit)) {
    const info = index.get(session.session_id);
    if (info === undefined) continue;
    const cached = cache.files[info.path];
    let title: string;
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      title = cached.title;
    } else {
      try {
        title = parseSessionTitle(readFile(info.path));
      } catch {
        // The file vanished or became unreadable after the index: skip it.
        continue;
      }
      reads++;
    }
    files[info.path] = { mtimeMs: info.mtimeMs, size: info.size, title };
    const capped = capTitleBytes(title);
    if (capped.length > 0) {
      rows.push({ agent: session.agent, session_id: session.session_id, title: capped });
    }
  }
  return { rows, cache: { version: 1, files }, reads };
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run the Luvus CLI once, capturing stdout/stderr and never throwing.
 *
 * The module keeps its own capture-style spawn rather than the
 * fire-and-forget `execLuvusCli` in `luvus.ts`: one module run needs the raw
 * `agent sessions` listing and must degrade to an error exit, not a throw.
 * It invokes the exact `$LUVUS_BIN_PATH` and shares the call timeout.
 */
export function runLuvus(bin: string, args: readonly string[]): CliResult {
  try {
    const result = spawnSync(bin, [...args], { encoding: "utf8", timeout: LUVUS_CALL_TIMEOUT_MS });
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function readCacheFile(path: string): TitleCache {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  return readTitleCache(text);
}

function writeCacheFile(path: string, cache: TitleCache): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (error) {
    console.error(`pi pane titles: cannot write cache: ${String(error)}`);
  }
}

/**
 * One module run. Returns the process exit code: 0 even when there is nothing
 * to push, 1 only when the session listing or the title push failed.
 */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  // Invoke the exact `$LUVUS_BIN_PATH`; never resolve `luvus` from PATH.
  // Without it the module cannot make a Luvus call.
  const bin = env.LUVUS_BIN_PATH;
  if (!bin) {
    console.error("pi pane titles: LUVUS_BIN_PATH is not set; skipping.");
    return 1;
  }
  const listing = runLuvus(bin, ["agent", "sessions"]);
  if (!listing.ok) {
    console.error(`pi pane titles: luvus agent sessions failed: ${listing.stderr.trim()}`);
    return 1;
  }
  const sessions = parseAgentSessions(listing.stdout);
  const index = indexSessionFiles(sessionsRoot(env));
  const stateDir = env.LUVUS_MODULE_STATE_DIR;
  const cachePath = stateDir ? join(stateDir, CACHE_FILE) : null;
  const cache = cachePath ? readCacheFile(cachePath) : emptyCache();
  const { rows, cache: next } = collectTitles(sessions, cache, index, (path) =>
    readFileSync(path, "utf8"),
  );
  if (cachePath) writeCacheFile(cachePath, next);
  if (rows.length === 0) return 0;
  const pushed = runLuvus(bin, buildTitlePushArgs(rows));
  if (!pushed.ok) {
    console.error(`pi pane titles: ui agent-title push failed: ${pushed.stderr.trim()}`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
