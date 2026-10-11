/**
 * Luvus module: publish Bar totals for the live pi panes.
 *
 * One widget shows three totals over every live `pi` pane: the pane count, the
 * sum of the session costs, and the largest context token count. A pane's cost
 * is the sum of `usage.cost.total` over its assistant messages; its context
 * count is `usage.totalTokens` of the last assistant message. Luvus does not
 * parse pi's session store, so the module lists the live agents with
 * `luvus agent list`, finds each session's JSONL file under
 * `$PI_CODING_AGENT_DIR/sessions`, and pushes one `luvus bar push`.
 *
 * The module is one-shot: Luvus runs it from `[[startup]]` and the
 * `pane.agent_status_changed` / `pane.closed` events. It caches each file's
 * totals by modification time and size in `$LUVUS_MODULE_STATE_DIR`, so an
 * event reads only the session files that changed.
 *
 * Session-file listing and the CLI runner are shared with `titles.ts` by
 * relative import: both scripts ship in this package and resolve from the same
 * checkout, so no copy is needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  indexSessionFiles,
  runLuvus,
  sessionsRoot,
  type SessionFileInfo,
} from "./titles.ts";

/** The declared Bar widget id, from `luvus-module.toml`. */
export const BAR_ID = "pi-usage";

/** The module state file, relative to `$LUVUS_MODULE_STATE_DIR`. */
export const CACHE_FILE = "usage-cache.json";

/** Cost and context of one session file. */
export interface SessionUsage {
  cost: number;
  contextTokens: number;
}

/** The three totals the widget shows. */
export interface UsageTotals {
  panes: number;
  cost: number;
  contextTokens: number;
}

/** One agent row as `luvus agent list` reports it. */
export interface AgentEntry {
  agent?: unknown;
  session?: unknown;
}

/** One cached session total, keyed by session file path. */
export interface UsageCacheEntry {
  mtimeMs: number;
  size: number;
  cost: number;
  contextTokens: number;
}

/** The on-disk cache written to the module state directory. */
export interface UsageCache {
  version: 1;
  files: Record<string, UsageCacheEntry>;
}

/** An empty cache. */
export function emptyUsageCache(): UsageCache {
  return { version: 1, files: {} };
}

function agentsFrom(value: unknown): AgentEntry[] {
  if (Array.isArray(value)) return value as AgentEntry[];
  if (value !== null && typeof value === "object") {
    const result = (value as { result?: unknown }).result ?? value;
    const agents = (result as { agents?: unknown }).agents;
    if (Array.isArray(agents)) return agents as AgentEntry[];
  }
  return [];
}

/**
 * Parse the JSON from `luvus agent list`, which wraps the list in
 * `{"id":…,"result":{"agents":[…]}}`. A bare list or `{"agents":[…]}` is
 * accepted too. Malformed input yields an empty list, never a throw.
 */
export function parseAgentList(raw: string): AgentEntry[] {
  try {
    return agentsFrom(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * The session ids of the live pi panes, in listing order. A pane without a
 * `session` is skipped: without one there is no file to read.
 */
export function piSessionIds(panes: readonly AgentEntry[]): string[] {
  const ids: string[] = [];
  for (const pane of panes) {
    if (pane === null || typeof pane !== "object") continue;
    if (pane.agent !== "pi") continue;
    if (typeof pane.session !== "string" || pane.session.length === 0) continue;
    ids.push(pane.session);
  }
  return ids;
}

/**
 * Sum the assistant-message usage of one JSONL session file. Each line with
 * `type: "message"` and `message.role: "assistant"` adds `usage.cost.total` to
 * the cost and keeps `usage.totalTokens` as the context count. A line that does
 * not parse, and a message with no usage, is skipped.
 */
export function parseSessionUsage(text: string): SessionUsage {
  let cost = 0;
  let contextTokens = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as { type?: unknown; message?: unknown };
    if (row.type !== "message") continue;
    const message = row.message;
    if (message === null || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const usage = (message as { usage?: unknown }).usage;
    if (usage === null || typeof usage !== "object") continue;
    const costTotal = (usage as { cost?: unknown }).cost;
    if (costTotal !== null && typeof costTotal === "object") {
      const total = (costTotal as { total?: unknown }).total;
      if (typeof total === "number" && Number.isFinite(total)) cost += total;
    }
    const tokens = (usage as { totalTokens?: unknown }).totalTokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) contextTokens = tokens;
  }
  return { cost, contextTokens };
}

/** `$` and two decimals. */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

/**
 * A token count below 1000 as the number, below 1,000,000 as thousands
 * rounded to a whole number with `k`, and 1,000,000 or more as millions with
 * one decimal and `M`.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Args for one `bar push` with the full and compact content. */
export function buildBarArgs(totals: UsageTotals): string[] {
  const content = [
    { type: "text", text: `π ${totals.panes}` },
    { type: "separator" },
    { type: "text", text: formatCost(totals.cost) },
    { type: "separator" },
    { type: "text", text: `ctx ${formatTokens(totals.contextTokens)}` },
  ];
  const compact = [{ type: "text", text: `π${totals.panes} ${formatCost(totals.cost)}` }];
  return [
    "bar",
    "push",
    "--id",
    BAR_ID,
    "--content",
    JSON.stringify(content),
    "--compact-content",
    JSON.stringify(compact),
  ];
}

/** Args to clear the widget when no pi pane is live. */
export function buildBarRemoveArgs(): string[] {
  return ["bar", "remove", "--id", BAR_ID];
}

/** Read a cache file's text, accepting only the current version. */
export function readUsageCache(text: string | null): UsageCache {
  if (text === null) return emptyUsageCache();
  try {
    const parsed = JSON.parse(text) as Partial<UsageCache>;
    if (parsed.version === 1 && parsed.files !== null && typeof parsed.files === "object") {
      return { version: 1, files: parsed.files as Record<string, UsageCacheEntry> };
    }
  } catch {
    // A bad cache is rebuilt from session files.
  }
  return emptyUsageCache();
}

/**
 * Add the session usage of every live pi pane. A pane whose session file is
 * absent or unreadable still counts in the pane total and adds nothing else,
 * so one bad pane never hides the others. A file with the cached modification
 * time and size is not read again. The returned cache holds the current run's
 * files only, so it stays bounded.
 */
export function collectUsage(
  panes: readonly AgentEntry[],
  cache: UsageCache,
  index: ReadonlyMap<string, SessionFileInfo>,
  readFile: (path: string) => string,
): { totals: UsageTotals; cache: UsageCache; reads: number } {
  const files: Record<string, UsageCacheEntry> = {};
  let panesCount = 0;
  let cost = 0;
  let contextTokens = 0;
  let reads = 0;
  for (const session of piSessionIds(panes)) {
    panesCount++;
    const info = index.get(session);
    if (info === undefined) continue;
    const cached = cache.files[info.path];
    let usage: SessionUsage;
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      usage = { cost: cached.cost, contextTokens: cached.contextTokens };
    } else {
      try {
        usage = parseSessionUsage(readFile(info.path));
      } catch {
        // The file vanished or became unreadable after the index: skip it.
        continue;
      }
      reads++;
    }
    files[info.path] = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      cost: usage.cost,
      contextTokens: usage.contextTokens,
    };
    cost += usage.cost;
    if (usage.contextTokens > contextTokens) contextTokens = usage.contextTokens;
  }
  return { totals: { panes: panesCount, cost, contextTokens }, cache: { version: 1, files }, reads };
}

function readCacheFile(path: string): UsageCache {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  return readUsageCache(text);
}

function writeCacheFile(path: string, cache: UsageCache): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } catch (error) {
    console.error(`pi usage bar: cannot write cache: ${String(error)}`);
  }
}

/**
 * One module run. Returns the process exit code: 0 even when there is nothing
 * to push, 1 only when the agent listing or the bar call failed.
 */
export function main(env: NodeJS.ProcessEnv = process.env): number {
  // Invoke the exact `$LUVUS_BIN_PATH`; never resolve `luvus` from PATH.
  // Without it the module cannot make a Luvus call.
  const bin = env.LUVUS_BIN_PATH;
  if (!bin) {
    console.error("pi usage bar: LUVUS_BIN_PATH is not set; skipping.");
    return 1;
  }
  const listing = runLuvus(bin, ["agent", "list"]);
  if (!listing.ok) {
    console.error(`pi usage bar: luvus agent list failed: ${listing.stderr.trim()}`);
    return 1;
  }
  const panes = parseAgentList(listing.stdout);
  const index = indexSessionFiles(sessionsRoot(env));
  const stateDir = env.LUVUS_MODULE_STATE_DIR;
  const cachePath = stateDir ? join(stateDir, CACHE_FILE) : null;
  const cache = cachePath ? readCacheFile(cachePath) : emptyUsageCache();
  const { totals, cache: next } = collectUsage(panes, cache, index, (path) =>
    readFileSync(path, "utf8"),
  );
  if (cachePath) writeCacheFile(cachePath, next);
  const result =
    totals.panes === 0
      ? runLuvus(bin, buildBarRemoveArgs())
      : runLuvus(bin, buildBarArgs(totals));
  if (!result.ok) {
    console.error(`pi usage bar: luvus bar call failed: ${result.stderr.trim()}`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
