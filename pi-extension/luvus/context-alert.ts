/**
 * Context alert configuration (pure parsing). See
 * openspec/changes/context-alert-handoff (D1): `parseStatusConfig` calls
 * `parseContextAlertConfig` and stores the result on `StatusConfig`.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDefaultConfigPath } from "./status.ts";

export const DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS = 200_000;

export type ContextAlertThreshold =
  { kind: "tokens"; value: number } | { kind: "percent"; value: number };

export interface ContextAlertConfig {
  enabled: boolean;
  threshold: ContextAlertThreshold;
}

/** Structural copy of pi's `ContextUsage`; `tokens`/`percent` are null when unknown. */
export interface ContextUsageLike {
  tokens: number | null;
  percent: number | null;
}

/**
 * True only when the needed field of the usage (`tokens` for a token
 * threshold, `percent` for a percentage threshold) is a number at or above
 * the threshold. Unknown usage and unknown fields never alert.
 */
export function shouldAlert(
  usage: ContextUsageLike | undefined,
  threshold: ContextAlertThreshold,
): boolean {
  if (!usage) return false;
  if (threshold.kind === "tokens") {
    return typeof usage.tokens === "number" && usage.tokens >= threshold.value;
  }
  return typeof usage.percent === "number" && usage.percent >= threshold.value;
}

/** Human-readable threshold, as used in the alert text (D3). */
export function formatAlertThreshold(threshold: ContextAlertThreshold): string {
  return threshold.kind === "tokens"
    ? `${threshold.value} tokens`
    : `${threshold.value}% of the context window`;
}

/**
 * The steer message fired at `turn_end` when the usage crosses the threshold
 * (D3). Names the token count and the threshold, and tells the child to stop,
 * commit or list uncommitted work, and finish with `luvus_done` + `handoff`.
 */
export function alertText(tokens: number, threshold: ContextAlertThreshold): string {
  return [
    `[Context alert] This session has used ${tokens} context tokens (threshold: ${formatAlertThreshold(threshold)}).`,
    "Stop the task after this turn. Commit the finished work, or list the uncommitted changes.",
    "Write a handoff that a fresh agent can continue from: the goal, what is done, what is left, and the current state.",
    "Send it to the parent the way your instructions say.",
    "Then end the session with the luvus_done tool, passing that handoff text in its `handoff` parameter.",
  ].join("\n");
}

/**
 * The completion nudge sent when the alert has fired (D3). Asks for
 * `luvus_done` with `handoff`; unlike the generic nudge it does not claim that
 * the last message was already delivered as the report.
 */
export function handoffNudgeText(): string {
  return [
    "[Automated reminder] Your last turn ended but this session is still open, and your context crossed the alert threshold earlier.",
    "Call the luvus_done tool now, with your handoff text in its `handoff` parameter, to end the session and hand the task to a fresh agent.",
    "If you are blocked and need input from the caller, call caller_ping with your question.",
    "Otherwise, continue working.",
  ].join("\n");
}

function invalidContextAlertConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

/**
 * The configured threshold in its configured form: a token count as a number,
 * or a percentage as the string the config used, e.g. `"80%"` (D6).
 */
export function formatThresholdValue(threshold: ContextAlertThreshold): number | string {
  return threshold.kind === "tokens" ? threshold.value : `${threshold.value}%`;
}

/** Path of the handoff log: `handoffs.jsonl` in the config.json directory (D6). */
export function handoffLogPath(): string {
  return join(dirname(getDefaultConfigPath()), "handoffs.jsonl");
}

/** One `handoffs.jsonl` line (D6). */
export interface HandoffLogRow {
  at: string;
  event: "alert" | "handoff";
  /** Server session name, the socket path when it cannot be resolved, or null outside Luvus. */
  luvusSession: string | null;
  child: string;
  session: string;
  tokens: number | null;
  /** Only on `alert` rows: the threshold as configured. */
  threshold?: number | string;
}

/**
 * From a parsed `luvus session list --json` payload, return the name whose
 * `socket_path` equals `socketPath`. When nothing matches — or the list is
 * missing or malformed — return the socket path itself. With no socket path
 * (outside Luvus) return null.
 */
export function matchLuvusSession(list: unknown, socketPath: string | undefined): string | null {
  if (!socketPath) return null;
  const sessions = (list as { sessions?: unknown } | null | undefined)?.sessions;
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (
        session != null &&
        typeof session === "object" &&
        (session as { socket_path?: unknown }).socket_path === socketPath
      ) {
        const name = (session as { name?: unknown }).name;
        if (typeof name === "string" && name !== "") return name;
      }
    }
  }
  return socketPath;
}

/**
 * Append one JSON line. Best effort: every error is caught, so a failed log
 * write never delays or prevents the alert, the sidecar write, or shutdown.
 */
export function appendHandoffLog(row: HandoffLogRow, path: string): void {
  try {
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    // Best effort — the log is diagnostic only.
  }
}

/** Same key check as `rejectUnsupportedKeys` in status.ts, kept local so this module stays dependency-free. */
function rejectUnsupportedContextAlertKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidContextAlertConfig(
      source,
      `contextAlert has unsupported key(s): ${unsupportedKeys.join(", ")}`,
    );
  }
}

/**
 * Parse the optional `contextAlert` block. `raw` is the value of the
 * `contextAlert` key (possibly undefined). The threshold is either a positive
 * integer token count or a percentage string like `"80"` + `%` in (0, 100].
 */
export function parseContextAlertConfig(raw: unknown, source = "config.json"): ContextAlertConfig {
  if (raw === undefined) {
    return {
      enabled: false,
      threshold: { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS },
    };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    invalidContextAlertConfig(source, "contextAlert must be an object");
  }
  const block = raw as Record<string, unknown>;
  rejectUnsupportedContextAlertKeys(block, ["enabled", "threshold"], source);

  const enabled =
    block.enabled === undefined ? false : requireContextAlertBoolean(block.enabled, source);
  const threshold =
    block.threshold === undefined
      ? { kind: "tokens" as const, value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS }
      : parseThreshold(block.threshold, source);

  return { enabled, threshold };
}

function requireContextAlertBoolean(value: unknown, source: string): boolean {
  if (typeof value !== "boolean") {
    invalidContextAlertConfig(source, "contextAlert.enabled must be a boolean");
  }
  return value;
}

const PERCENT_THRESHOLD_PATTERN = /^\d+(\.\d+)?%$/;

function parseThreshold(value: unknown, source: string): ContextAlertThreshold {
  if (typeof value === "string" && PERCENT_THRESHOLD_PATTERN.test(value)) {
    const percent = Number(value.slice(0, -1));
    if (percent > 0 && percent <= 100) return { kind: "percent", value: percent };
    invalidContextAlertConfig(
      source,
      `contextAlert.threshold percentage must be greater than 0 and at most 100 (got ${value})`,
    );
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { kind: "tokens", value };
  }
  invalidContextAlertConfig(
    source,
    'contextAlert.threshold must be a positive integer token count or a percentage string like "80%"',
  );
}
