import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentConfigDir } from "./agent-defs.ts";
import {
  DEFAULT_SURFACE_PLACEMENT,
  parseSurfacePlacement,
  type SurfacePlacement,
} from "./luvus.ts";
import { parseContextAlertConfig, type ContextAlertConfig } from "./context-alert.ts";
import type {
  ActivityReadResult,
  SubagentActivityPhase,
  SubagentActivityState,
} from "./activity.ts";

export const SNAPSHOT_STALLED_AFTER_MS = 60_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");
// Legacy location: config.json at the package root (e.g. inside pi's git
// clone). Still honored on read so existing installs keep their settings.
const LEGACY_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXTENSION_DIR_NAME = "pi-luvus";

/**
 * Canonical per-install config location: the extension's operating area,
 * e.g. ~/.pi/agent/extensions/pi-luvus/config.json. Unlike the
 * package root, this survives `pi update` of the git clone.
 */
export function getDefaultConfigPath(): string {
  return join(getAgentConfigDir(), "extensions", EXTENSION_DIR_NAME, "config.json");
}

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "running";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
  /** `notify.enabled` — turn-end notifications, default `true`. */
  notifyEnabled: boolean;
  /** `contextAlert` — subagent context alert, default off. */
  contextAlert: ContextAlertConfig;
}

export type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: SubagentActivityPhase;
      active?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

/**
 * Adapt an activity-file read to the observation `observeStatus` consumes.
 * A failed read keeps its reason and error as the snapshot problem.
 */
export function toStatusObservation(read: ActivityReadResult): StatusObservation {
  if (read.ok === false) return { snapshot: read.reason, snapshotError: read.error };

  const activity = read.activity;
  return {
    snapshot: "present",
    updatedAt: activity.updatedAt,
    sequence: activity.sequence,
    phase: activity.phase,
    active: activity.phase === "active",
    activeScope: activity.activeScope,
    activeSince: activity.activeSince,
    waitingSince: activity.waitingSince,
    latestEvent: activity.latestEvent,
    activityLabel: buildActivityLabel(activity),
  };
}

/** Label for a live activity phase; a non-active phase has no label. */
export function buildActivityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeNow: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: SubagentActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(
      source,
      `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`,
    );
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

/** Display label for an active snapshot: explicit label, else its scope. */
export function displayActivityLabel(
  snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">,
): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  // `status` is optional so a config that only sets other keys (e.g. `surface`)
  // still loads; the example default applies.
  const status = config.status === undefined ? {} : requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled =
    status.enabled === undefined ? true : requireBoolean(status.enabled, source, "status.enabled");

  // `notify` is optional too; only `enabled` is defined today.
  const notify = config.notify === undefined ? {} : requireObject(config.notify, source, "notify");
  rejectUnsupportedKeys(notify, ["enabled"], source, "notify");
  const notifyEnabled =
    notify.enabled === undefined ? true : requireBoolean(notify.enabled, source, "notify.enabled");

  const contextAlert = parseContextAlertConfig(config.contextAlert, source);

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
    notifyEnabled,
    contextAlert,
  };
}

/** Read the optional `surface` placement default from parsed config JSON. */
export function parseSurfaceConfig(rawConfig: unknown, source = "config.json"): SurfacePlacement {
  if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    invalidStatusConfig(source, "root must be an object");
  }
  const surface = (rawConfig as Record<string, unknown>).surface;
  return parseSurfacePlacement(surface) ?? DEFAULT_SURFACE_PLACEMENT;
}

/**
 * Load the `surface` placement default from the extension config. Unlike the
 * status config, a missing or unreadable file is not fatal — it just means
 * the default placement.
 */
export function loadSurfaceConfig(
  configPath?: string,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
  legacyPath?: string,
): SurfacePlacement {
  try {
    const { sourcePath, rawConfig } = readStatusConfigFile(
      configPath ?? getDefaultConfigPath(),
      examplePath,
      legacyPath ?? (configPath === undefined ? LEGACY_STATUS_CONFIG_PATH : undefined),
    );
    return parseSurfaceConfig(JSON.parse(rawConfig), sourcePath);
  } catch {
    return DEFAULT_SURFACE_PLACEMENT;
  }
}

/**
 * Persist the `surface` placement default to the extension config.json,
 * keeping any other keys. Seeds from the legacy package-root config when the
 * new file does not exist yet (migration), else from the shipped example.
 * Throws on invalid JSON so callers can report it instead of silently
 * truncating the user's config.
 */
export function writeSurfaceConfig(
  placement: SurfacePlacement,
  configPath?: string,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
  legacyPath?: string,
): void {
  const resolved = configPath ?? getDefaultConfigPath();
  const legacy = legacyPath ?? (configPath === undefined ? LEGACY_STATUS_CONFIG_PATH : undefined);
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") {
      // Existing but unreadable/invalid — refuse to overwrite it.
      throw error;
    }
    for (const seed of [legacy, examplePath]) {
      if (!seed || seed === resolved) continue;
      try {
        base = JSON.parse(readFileSync(seed, "utf8")) as Record<string, unknown>;
        break;
      } catch {
        // Not valid JSON: try the next seed.
      }
    }
  }
  base.surface = placement;
  mkdirSync(dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  writeFileSync(tmp, JSON.stringify(base, null, 2) + "\n");
  renameSync(tmp, resolved);
}

function readStatusConfigFile(
  configPath: string,
  examplePath: string,
  legacyPath?: string,
): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  if (legacyPath && legacyPath !== configPath) {
    try {
      return { sourcePath: legacyPath, rawConfig: readFileSync(legacyPath, "utf8") };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== "ENOENT") throw error;
    }
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath}${legacyPath ? `, ${legacyPath},` : ""} or ${examplePath}.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath?: string,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
  legacyPath?: string,
): StatusConfig {
  const resolved = configPath ?? getDefaultConfigPath();
  const { sourcePath, rawConfig } = readStatusConfigFile(
    resolved,
    examplePath,
    legacyPath ?? (configPath === undefined ? LEGACY_STATUS_CONFIG_PATH : undefined),
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`, { cause: error });
  }

  return parseStatusConfig(parsed, sourcePath);
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === "claude" ? "unseen" : "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity =
    lastActivityAtMs != null &&
    (updatedAt < lastActivityAtMs ||
      (updatedAt === lastActivityAtMs &&
        lastActivitySequence != null &&
        sequence < lastActivitySequence));
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride =
    state.localOverrideAtMs != null &&
    (updatedAt < state.localOverrideAtMs ||
      (updatedAt === state.localOverrideAtMs &&
        state.localOverrideSequence != null &&
        sequence <= state.localOverrideSequence));
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? (observation.activeSince ?? state.activeSinceMs ?? updatedAt)
    : null;
  const waitingSinceMs =
    phase === "waiting" ? (observation.waitingSince ?? state.waitingSinceMs ?? updatedAt) : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? (observation.activeScope ?? null) : null,
    waitingSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

export function forceStatusAfterInterrupt(
  state: SubagentStatusState,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    phase: "waiting",
    latestEvent: "interrupt_requested",
    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: "waiting",
  };
}

function classifyProblemState(
  state: SubagentStatusState,
  now: number,
): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) return { kind: "stalled", statusLabel: problemLabel };

  const lastHealthyKind = state.activeNow
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      kind = "active";
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind = elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS ? "stalled" : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText =
    state.activeSinceMs == null ? null : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText =
    state.waitingSinceMs == null ? null : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText =
    state.snapshotProblemSinceMs == null
      ? null
      : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" &&
          (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = displayActivityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`,
    );
  }

  if (snapshot.kind === "waiting") {
    const problem =
      snapshot.statusLabel && snapshot.statusLabel !== "done"
        ? ` (${snapshot.statusLabel})`
        : snapshot.statusLabel === "done"
          ? " (done)"
          : "";
    return boundStatusLine(
      `${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`,
    );
  }

  return boundStatusLine(
    `${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`,
  );
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail =
      snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
