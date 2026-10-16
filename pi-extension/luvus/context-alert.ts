/**
 * Context alert configuration (pure parsing). See
 * openspec/changes/context-alert-handoff (D1): `parseStatusConfig` calls
 * `parseContextAlertConfig` and stores the result on `StatusConfig`.
 */

export const DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS = 200_000;

export type ContextAlertThreshold =
  | { kind: "tokens"; value: number }
  | { kind: "percent"; value: number };

export interface ContextAlertConfig {
  enabled: boolean;
  threshold: ContextAlertThreshold;
}

function invalidContextAlertConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

/** Same key check as `rejectUnsupportedKeys` in status.ts, kept local so this module stays dependency-free. */
function rejectUnsupportedContextAlertKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidContextAlertConfig(source, `contextAlert has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

/**
 * Parse the optional `contextAlert` block. `raw` is the value of the
 * `contextAlert` key (possibly undefined). The threshold is either a positive
 * integer token count or a percentage string like `"80"` + `%` in (0, 100].
 */
export function parseContextAlertConfig(raw: unknown, source = "config.json"): ContextAlertConfig {
  if (raw === undefined) {
    return { enabled: false, threshold: { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS } };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    invalidContextAlertConfig(source, "contextAlert must be an object");
  }
  const block = raw as Record<string, unknown>;
  rejectUnsupportedContextAlertKeys(block, ["enabled", "threshold"], source);

  const enabled = block.enabled === undefined ? false : requireContextAlertBoolean(block.enabled, source);
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
