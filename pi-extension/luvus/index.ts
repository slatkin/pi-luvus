import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  pollForExit,
  closeSurface,
  sendEscape,
  readScreen,
  runInPane,
  agentPrompt,
  parseSurfacePlacement,
  type SurfacePlacement,
} from "./luvus.ts";
import { UhpEventStream } from "./uhp-events.ts";
import {
  buildSubagentToolAllowlist,
  getAgentConfigDir,
  getBundledAgentsDir,
  loadAgentDefaults,
  parseAgentDefinition,
  type AgentDefaults,
  type AgentDefinition,
  type SubagentSessionMode,
} from "./agent-defs.ts";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  writeLaunchSpec,
  type LaunchSpec,
} from "./launch.ts";

import {
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import { slugifyName } from "./slug.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  loadSurfaceConfig,
  writeSurfaceConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { createLuvusStatusReporter } from "./luvus-status.ts";
import { createTurnNotifier } from "./turn-notify.ts";
import { createLiveTitleController } from "./live-title.ts";
import { capSummary, SCREEN_SUMMARY_CHARS } from "./report-cap.ts";
import {
  IDLE_NUDGE_TEXT,
  decideGoneAction,
  decideIdleAction,
  type IdleWatchState,
} from "./idle-watchdog.ts";

/** Absolute path to `pi-extension/luvus`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Pane-side entry point every pi-parent launch spec runs through. */
const SUBAGENTS_CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
//
// Keys are namespaced per module URL: multiple copies of this extension can coexist
// in one process (e.g. a global install plus the project copy), and a shared key
// would let one copy abort the other's poll watchers. Same-URL /reload still resolves
// to the same key, so cleanup across reloads keeps working.
const INSTANCE_KEY = `#${import.meta.url}`;
const WIDGET_INTERVAL_KEY = Symbol.for(`pi-luvus/widget-interval${INSTANCE_KEY}`);
const STATUS_INTERVAL_KEY = Symbol.for(`pi-luvus/status-interval${INSTANCE_KEY}`);
const POLL_ABORT_KEY = Symbol.for(`pi-luvus/poll-abort-controller${INSTANCE_KEY}`);
const UHP_STREAM_KEY = Symbol.for(`pi-luvus/uhp-stream${INSTANCE_KEY}`);

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();

  // The previous module load's event stream child must not outlive the reload.
  const prevStream = (globalThis as any)[UHP_STREAM_KEY] as UhpEventStream | undefined;
  if (prevStream) prevStream.shutdown();
}

/** One UHP event stream per pi process; it starts lazily on the first watcher. */
const uhpEventStream = new UhpEventStream();
(globalThis as any)[UHP_STREAM_KEY] = uhpEventStream;

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name." }),
  task: Type.String({ description: "Task prompt for the subagent." }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent definition that supplies defaults (model, tools, skills). See luvus_list.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Role instructions to append to the system prompt." }),
  ),
  model: Type.Optional(Type.String({ description: "Model. Overrides the agent default." })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills. Overrides the agent default." }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools. Overrides the agent default." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Start directory. The subagent loads the local .pi/ config, CLAUDE.md, skills and extensions.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "true: the subagent gets a copy of this conversation. Overrides the agent session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "true: the user drives the subagent, and stall events do not wake you. Default: the agent `interactive` value, else the inverse of `auto-exit`.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Claude Code subagents only: the session ID to continue (from an earlier result).",
    }),
  ),
  surface: Type.Optional(
    Type.Union([Type.Literal("right"), Type.Literal("down"), Type.Literal("tab"), Type.Literal("pane")], {
      description:
        '"right" (default): split side by side. "down": split below. "tab": new workspace tab. "pane" = "right". Overrides the configured default.',
    }),
  ),
});

type AgentSource = "package" | "global" | "project";

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "luvus_spawn",
  "luvus_interrupt",
  "luvus_list",
  "luvus_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function sessionDirSlugFor(cwd: string): string {
  return cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

function getDefaultSessionDirNameFor(cwd: string): string {
  // The plain slug is not injective: `/a/b-c` and `/a-b/c` both become
  // `--a-b-c--`, so distinct cwds would share one session dir. Append a short
  // hash of the raw path to give each cwd its own directory.
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return `--${sessionDirSlugFor(cwd)}-${hash}--`;
}

function migrateLegacySessionDir(sessionsRoot: string, cwd: string, sessionDir: string): void {
  if (existsSync(sessionDir)) return;
  // Before the hashed name, session dirs were `--<slug>--`. That slug is not
  // injective, so the first cwd to launch claims the legacy dir; later cwds
  // just create fresh dirs. Best-effort: ENOENT/EEXIST/ENOTEMPTY races and a
  // failed rename all leave the old dir in place rather than losing data.
  try {
    renameSync(join(sessionsRoot, `--${sessionDirSlugFor(cwd)}--`), sessionDir);
  } catch {
    // Nothing to migrate, or another process got there first.
  }
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const sessionsRoot = join(agentDir, "sessions");
  const sessionDir = join(sessionsRoot, getDefaultSessionDirNameFor(cwd));
  if (!existsSync(sessionDir)) {
    migrateLegacySessionDir(sessionsRoot, cwd, sessionDir);
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (a forked child) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `luvus_spawn({ name, task })` call,
 * typical for a bare forked spawn), `autoExit` is undefined and the
 * subagent is treated as interactive.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_LUVUS_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require Luvus. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

// Subagent surface placement default: "right" (side-by-side split), "down"
// (stacked split) or "tab" (own workspace tab). Loaded from the extension config
// (~/.pi/agent/extensions/pi-luvus/config.json), changeable at
// runtime via /luvus-surface, overridable per call via the tool's `surface` param.
let surfaceDefault: SurfacePlacement = loadSurfaceConfig();

export function getSurfaceDefault(): SurfacePlacement {
  return surfaceDefault;
}

export function setSurfaceDefault(value: SurfacePlacement): void {
  surfaceDefault = value;
}

/** Resolve placement for one spawn: explicit tool param > configured default. */
export function resolveSurfacePlacement(param: unknown): SurfacePlacement {
  return parseSurfacePlacement(param) ?? surfaceDefault;
}

// Test hook: redirect config.json writes away from the extension config dir.
let surfaceConfigPath: string | undefined;
export const __surfaceTest__ = {
  setConfigPath(path: string | undefined) {
    surfaceConfigPath = path;
  },
};

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";
  const summary = capSummary(result.summary, result.sessionFile);

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with luvus_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** Launch-spec path written under `<artifactDir>/luvus-scripts/`. */
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /** Byte offset of the parent's next unread line in this child's `.msg` file. */
  messageOffset?: number;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. an interactive child).
   */
  interactive: boolean;
  /** Parent-side idle watchdog progress (see idle-watchdog.ts). */
  idleWatch?: IdleWatchState;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Parent/child messaging (design Decisions 4, 5, 8) ──
//
// Children and siblings are addressed through Luvus `agent prompt` (luvus.ts).
// `parent` is not: typing into the parent's pane merges with and submits
// whatever draft the user is composing there (task 1.1, case d), so a child
// appends JSON lines to `<session>.msg` and the parent's existing poll loop
// injects them as steering messages.

interface SubagentRosterChild {
  id: string;
  name: string;
  pane: string;
  cli: string;
}

interface SubagentRoster {
  parentPane: string;
  parentName: string;
  children: SubagentRosterChild[];
}

interface ParentMessage {
  header: string;
  message: string;
}

/** Where this process publishes its roster, set on the first spawn or resume. */
let rosterContext: { file: string; parentPane: string; parentName: string } | null = null;

function getRosterFile(artifactDir: string): string {
  return join(artifactDir, "luvus-roster.json");
}

/** The file a child appends parent-bound messages to. */
function getParentMessageFile(sessionFile: string): string {
  return `${sessionFile}.msg`;
}

/** Pure mirror of `runningSubagents` as published for children. */
export function buildRosterPayload(params: {
  parentPane: string;
  parentName: string;
  children: Iterable<Pick<RunningSubagent, "id" | "name" | "surface" | "cli">>;
}): SubagentRoster {
  return {
    parentPane: params.parentPane,
    parentName: params.parentName,
    children: Array.from(params.children, (child) => ({
      id: child.id,
      name: child.name,
      pane: child.surface,
      cli: child.cli ?? "pi",
    })),
  };
}

/** Record where this process's roster lives (idempotent). */
function ensureRosterContext(ctx: {
  sessionManager: { getSessionDir(): string; getSessionId(): string };
}): void {
  if (rosterContext) return;
  rosterContext = {
    file: getRosterFile(
      getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
    ),
    parentPane: process.env.LUVUS_PANE_ID ?? "",
    parentName: process.env.PI_LUVUS_NAME ?? "parent",
  };
}

/**
 * Rewrite the roster file to mirror `runningSubagents`, atomically. Called on
 * every spawn, resume and exit so children can resolve siblings. Best effort:
 * without it the sender just loses the sibling lookup.
 */
function writeRoster(): void {
  if (!rosterContext) return;
  try {
    const payload = buildRosterPayload({
      parentPane: rosterContext.parentPane,
      parentName: rosterContext.parentName,
      children: runningSubagents.values(),
    });
    mkdirSync(dirname(rosterContext.file), { recursive: true });
    const tmp = `${rosterContext.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmp, rosterContext.file);
  } catch {
    // Best effort — see the doc comment.
  }
}

/** Env for a freshly spawned pi subagent, in launch-spec form. */
export function buildSpawnEnvParts(params: {
  name: string;
  agent?: string;
  autoExit?: boolean;
  subagentSessionFile: string;
  id: string;
  activityFile: string;
  surface: string;
  codingAgentDir?: string;
  denySet: Set<string>;
  parentRosterFile?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (params.codingAgentDir) env.PI_CODING_AGENT_DIR = params.codingAgentDir;
  if (params.denySet.size > 0) env.PI_DENY_TOOLS = [...params.denySet].join(",");
  env.PI_LUVUS_NAME = params.name;
  if (params.agent) env.PI_LUVUS_AGENT = params.agent;
  if (params.autoExit) env.PI_LUVUS_AUTO_EXIT = "1";
  env.PI_LUVUS_SESSION = params.subagentSessionFile;
  env.PI_LUVUS_ID = params.id;
  env.PI_LUVUS_ACTIVITY_FILE = params.activityFile;
  env.PI_LUVUS_SURFACE = params.surface;
  if (params.parentRosterFile) env.PI_LUVUS_PARENT_ROSTER = params.parentRosterFile;
  return env;
}

/** Env for a resumed pi subagent, in launch-spec form. */
export function buildResumeEnvParts(params: {
  name: string;
  sessionPath: string;
  id: string;
  activityFile: string;
  autoExit: boolean;
  codingAgentDir?: string;
  parentRosterFile?: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (params.codingAgentDir) env.PI_CODING_AGENT_DIR = params.codingAgentDir;
  env.PI_LUVUS_NAME = params.name;
  env.PI_LUVUS_SESSION = params.sessionPath;
  env.PI_LUVUS_ID = params.id;
  env.PI_LUVUS_ACTIVITY_FILE = params.activityFile;
  if (params.autoExit) env.PI_LUVUS_AUTO_EXIT = "1";
  if (params.parentRosterFile) env.PI_LUVUS_PARENT_ROSTER = params.parentRosterFile;
  return env;
}

export type SubagentRelation = "parent" | "child" | "sibling";

export interface MessageTarget {
  relation: SubagentRelation;
  name: string;
  /** Pane id for child and sibling targets; absent for `parent`. */
  id?: string;
  pane?: string;
}

/** Names the sender can reach right now, for the "no such target" error. */
function reachableTargetNames(params: {
  hasParent: boolean;
  ownChildren: Array<Pick<RunningSubagent, "name">>;
  parentRoster: SubagentRoster | null;
  selfId: string;
}): string[] {
  const names: string[] = [];
  if (params.hasParent) names.push("parent");
  for (const child of params.ownChildren) names.push(child.name);
  for (const sibling of params.parentRoster?.children ?? []) {
    if (sibling.id !== params.selfId) names.push(sibling.name);
  }
  return [...new Set(names)];
}

/**
 * Resolve a `to` target (design Decision 4): `parent`, one of the sender's own
 * running children, or a running sibling (the parent's other children minus
 * the sender). Exact ids win over names; an ambiguous name reports its matches.
 */
export function resolveMessageTarget(params: {
  hasParent: boolean;
  ownChildren: Iterable<Pick<RunningSubagent, "id" | "name" | "surface">>;
  parentRoster: SubagentRoster | null;
  selfId: string;
  to: string;
}): { target: MessageTarget } | { error: string } {
  const to = params.to?.trim();
  // Materialize once: `ownChildren` is often a live Map iterator, and both the
  // candidate search and the reachable-names error would otherwise consume it.
  const ownChildren = Array.from(params.ownChildren);
  const reachable = () =>
    reachableTargetNames({ ...params, ownChildren }).join(", ") || "(none)";

  if (!to) {
    return { error: `Provide a target: \`parent\`, a child, or a sibling. Reachable: ${reachable()}.` };
  }
  if (to === "parent") {
    if (!params.hasParent) return { error: "This agent has no parent." };
    return { target: { relation: "parent", name: "parent" } };
  }

  const candidates: MessageTarget[] = [
    ...ownChildren.map((child): MessageTarget => ({
      relation: "child",
      id: child.id,
      name: child.name,
      pane: child.surface,
    })),
    ...(params.parentRoster?.children ?? [])
      .filter((sibling) => sibling.id !== params.selfId)
      .map((sibling): MessageTarget => ({
        relation: "sibling",
        id: sibling.id,
        name: sibling.name,
        pane: sibling.pane,
      })),
  ];

  const byId = candidates.find((candidate) => candidate.id === to);
  if (byId) return { target: byId };

  const byName = candidates.filter((candidate) => candidate.name === to);
  if (byName.length === 1) return { target: byName[0] };
  if (byName.length > 1) {
    const matches = byName.map((candidate) => `${candidate.name} [${candidate.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${to}". Matches: ${matches}` };
  }

  return { error: `No reachable agent named "${to}". Reachable: ${reachable()}.` };
}

/**
 * Header line prepended to every delivered message (design Decision 5). The
 * sender's relation is named for children and siblings, and omitted when the
 * sender is the receiver's parent.
 */
export function formatMessageHeader(params: {
  senderName: string;
  targetRelation: SubagentRelation;
}): string {
  if (params.targetRelation === "parent") {
    return `[subagent message from ${params.senderName} (child)]`;
  }
  if (params.targetRelation === "sibling") {
    return `[subagent message from ${params.senderName} (sibling)]`;
  }
  return `[subagent message from ${params.senderName}]`;
}

/** The launch-prompt line naming the peers a fresh subagent can message. */
export function buildLaunchMessagingHint(siblingNames: string[]): string {
  const names = [...new Set(["parent", ...siblingNames])];
  const list = names.map((name) => `\`${name}\``).join(", ");
  return `You can message ${list} with luvus_message; it does not end your session.`;
}

/** Task hint shown to the child: auto-exit agents are now told to exit explicitly too. */
export function resolveModeHint(autoExit?: boolean): string {
  return autoExit
    ? "Complete your task autonomously. Call luvus_done when finished."
    : "Complete your task. When finished, call the luvus_done tool. The user can interact with you at any time.";
}

export function buildSubagentTaskPrompt(params: {
  task: string;
  roleBlock: string;
  modeHint: string;
  summaryInstruction: string;
  messagingHint: string;
  inheritsConversationContext: boolean;
}): string {
  return params.inheritsConversationContext
    ? `${params.task}\n\n${params.messagingHint}`
    : `${params.roleBlock}\n\n${params.modeHint}\n\n${params.messagingHint}\n\n${params.task}\n\n${params.summaryInstruction}`;
}

/** Append one parent-bound message to a child's `<session>.msg` file. */
export function appendParentMessage(file: string, payload: ParentMessage): void {
  appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

/**
 * Read complete JSON lines from a child's message file, starting at byte
 * `offset`. A trailing line without its newline is left for the next call.
 */
export function readParentMessages(
  file: string,
  offset: number,
): { messages: ParentMessage[]; offset: number } {
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return { messages: [], offset };
  }
  const start = offset > raw.length ? 0 : offset;
  const chunk = raw.subarray(start);
  const lastNewline = chunk.lastIndexOf(0x0a);
  if (lastNewline < 0) return { messages: [], offset: start };

  const messages: ParentMessage[] = [];
  for (const line of chunk.subarray(0, lastNewline).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.header === "string" && typeof parsed?.message === "string") {
        messages.push({ header: parsed.header, message: parsed.message });
      }
    } catch {
      // Skip a malformed line rather than stalling the file on it.
    }
  }
  return { messages, offset: start + lastNewline + 1 };
}

/**
 * Remind, then finish, a non-interactive child that ended its turn but never
 * exited. Finishing writes the same `done` sidecar `luvus_done` would, so
 * pollForExit completes the normal way (summary from the session, pane closed).
 *
 * A child that stopped reporting entirely (killed mid-turn, or reloaded — its
 * activity writer disables on reload) never writes a sidecar; the parent
 * would poll its pane once a second for the rest of the session. After
 * `IDLE_GONE_MS` of silence, finish it with an error sidecar instead.
 */
function runIdleWatchdog(running: RunningSubagent, now = Date.now()): void {
  if (running.cli === "claude") return;
  const state = (running.idleWatch ??= { nudges: 0 });

  const goneAction = decideGoneAction({
    interactive: running.interactive,
    readOk: running.activityRead?.ok === true,
    activity: running.activity ? { updatedAt: running.activity.updatedAt } : undefined,
    now,
    state,
  });
  if (goneAction === "gone") {
    const detail = running.activity != null && running.activityRead?.ok === true
      ? `last snapshot ${Math.round((now - running.activity.updatedAt) / 1000)}s old ` +
        `(phase ${running.activity.phase}, last event ${running.activity.latestEvent})`
      : `no valid snapshot for ${Math.round((now - (state.failedReadSince ?? now)) / 1000)}s ` +
        `(${running.activityRead?.reason ?? "missing"}${running.activityRead?.error ? ": " + running.activityRead.error : ""})`;
    try {
      writeFileSync(
        `${running.sessionFile}.exit`,
        JSON.stringify({
          type: "error",
          errorMessage: `Subagent child stopped reporting: ${detail}. Finish with an error instead of polling forever.`,
        }),
      );
    } catch {
      // Best effort — a transient failure (ENOSPC/EACCES) must not latch the
      // gone decision, so un-latch and let the next tick retry the write.
      state.gone = false;
    }
    return;
  }

  const action = decideIdleAction({
    interactive: running.interactive,
    phase: running.activity?.phase,
    waitingSince: running.activity?.waitingSince,
    now,
    state,
  });
  if (action === "nudge") {
    state.nudges += 1;
    state.lastNudgeAt = now;
    try {
      agentPrompt(running.surface, IDLE_NUDGE_TEXT);
    } catch {
      // Pane blocked or gone; the nudge still counts so the child is finished.
    }
  } else if (action === "finish") {
    try {
      writeFileSync(`${running.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    } catch {
      // Best effort — the next tick retries.
    }
  }
}

/** Inject any newly written parent-bound messages into this session. */
function deliverParentMessages(running: RunningSubagent, pi: ExtensionAPI): void {
  const { messages, offset } = readParentMessages(
    getParentMessageFile(running.sessionFile),
    running.messageOffset ?? 0,
  );
  running.messageOffset = offset;
  for (const message of messages) {
    pi.sendMessage(
      {
        customType: "luvus_message",
        content: `${message.header}\n${message.message}`,
        display: true,
        details: { from: running.name, id: running.id },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
}

/** Deliver a finished child's last messages, then drop its file. */
function drainAndRemoveParentMessages(running: RunningSubagent, pi: ExtensionAPI): void {
  deliverParentMessages(running, pi);
  try {
    rmSync(getParentMessageFile(running.sessionFile), { force: true });
  } catch {
    // Best effort — a stale file only delays the next child's messages.
  }
}

/** Read this process's parent roster (path passed to children at spawn). */
function readParentRoster(): SubagentRoster | null {
  const file = process.env.PI_LUVUS_PARENT_ROSTER;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.children)) return parsed as SubagentRoster;
  } catch {
    // Missing or half-written roster: sibling lookup is simply unavailable.
  }
  return null;
}

const SubagentMessageParams = Type.Object({
  to: Type.String({
    description:
      "`parent`, or the exact id or display name of a running child or sibling.",
  }),
  message: Type.String({ description: "Message text. Must not be empty." }),
});

/**
 * Validate, resolve and deliver one `luvus_message` call. Exported for unit
 * testing: `deps` lets a test observe whether Luvus was used at all.
 */
export function sendSubagentMessage(
  input: { to: string; message: string },
  context: {
    hasParent: boolean;
    ownChildren: Iterable<Pick<RunningSubagent, "id" | "name" | "surface">>;
    parentRoster: SubagentRoster | null;
    selfId: string;
    senderName: string;
    parentMessageFile: string | null;
  },
  deps: {
    prompt: (pane: string, text: string) => unknown;
    append: (file: string, payload: ParentMessage) => void;
  },
): { ok: true; target: MessageTarget; text: string } | { error: string } {
  if (!input.message?.trim()) {
    return { error: "message must not be empty." };
  }

  const resolved = resolveMessageTarget({
    hasParent: context.hasParent,
    ownChildren: context.ownChildren,
    parentRoster: context.parentRoster,
    selfId: context.selfId,
    to: input.to,
  });
  if ("error" in resolved) return resolved;

  const target = resolved.target;
  const payload: ParentMessage = {
    header: formatMessageHeader({ senderName: context.senderName, targetRelation: target.relation }),
    message: input.message,
  };

  if (target.relation === "parent") {
    if (!context.parentMessageFile) return { error: "This agent has no parent." };
    try {
      deps.append(context.parentMessageFile, payload);
    } catch (error: any) {
      return { error: `Failed to write the parent message file: ${error?.message ?? String(error)}` };
    }
    return {
      ok: true,
      target,
      text:
        "Message sent to parent. It arrives as a steering message; a reply will come back as a separate message.",
    };
  }

  try {
    deps.prompt(target.pane!, `${payload.header}\n${payload.message}`);
  } catch (error: any) {
    return { error: `Failed to send to "${target.name}" via Luvus: ${error?.message ?? String(error)}` };
  }
  return {
    ok: true,
    target,
    text:
      `Message sent to "${target.name}" (pane ${target.pane}). Delivery is asynchronous; ` +
      "a reply will arrive as a separate message.",
  };
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("luvus-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "luvus-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok === true
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok === true) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via Luvus: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      }],
      details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "luvus_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  buildRosterPayload,
  buildSpawnEnvParts,
  buildResumeEnvParts,
  resolveMessageTarget,
  formatMessageHeader,
  buildLaunchMessagingHint,
  buildSubagentTaskPrompt,
  sendSubagentMessage,
  appendParentMessage,
  readParentMessages,
  drainAndRemoveParentMessages,
  writeRoster,
  setRosterContext(ctx: { file: string; parentPane: string; parentName: string } | null) {
    rosterContext = ctx;
  },
  runningSubagents,
  formatElapsed,
  getDefaultSessionDirFor,
  watchSubagent,
  launchSubagent,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string; placement?: SurfacePlacement },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
  ensureRosterContext(ctx);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Compute the launch-spec path and its pane line before any pane exists, so
  // an unsafe path fails without leaving an empty pane behind.
  const launchBase = slugifyName(params.name || "subagent", { hyphenate: false });
  const launchScriptFile = join(artifactDir, "luvus-scripts", `${launchBase}-${id}.json`);
  const paneLine = paneCommandLine(SUBAGENTS_CLI_PATH, launchScriptFile);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name, options?.placement);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = resolveModeHint(agentDefs?.autoExit);
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one."
    : "Your FINAL assistant message (before calling luvus_done or before the user exits) should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const siblingNames = Array.from(runningSubagents.values(), (running) => running.name);
  const fullTask = buildSubagentTaskPrompt({
    task: params.task,
    roleBlock,
    modeHint,
    summaryInstruction,
    messagingHint: buildLaunchMessagingHint(siblingNames),
    inheritsConversationContext,
  });
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = join(tmpdir(), `pi-claude-${id}-done`);
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const claudeArgs: string[] = ["--dangerously-skip-permissions"];

    if (existsSync(pluginDir)) {
      claudeArgs.push("--plugin-dir", pluginDir);
    }

    if (effectiveModel) {
      claudeArgs.push("--model", effectiveModel);
    }

    const sp = params.systemPrompt ?? agentDefs.body;
    if (sp) {
      claudeArgs.push("--append-system-prompt", sp);
    }

    if (params.resumeSessionId) {
      claudeArgs.push("--resume", params.resumeSessionId);
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    claudeArgs.push(params.task);

    const spec: LaunchSpec = {
      version: LAUNCH_SPEC_VERSION,
      name: params.name,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      env: { PI_CLAUDE_SENTINEL: sentinelFile },
      command: "claude",
      args: claudeArgs,
      sessionFile: subagentSessionFile,
      title: buildPaneTitle(params.name, params.task),
    };
    writeLaunchSpec(launchScriptFile, spec);
    runInPane(surface, paneLine);

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    writeRoster();
    return running;
  }

  // ── Pi CLI path ──

  // Build pi argv (no shell: every value stays exactly one argument).
  const piArgs: string[] = ["--session", subagentSessionFile];

  const subagentDonePath = join(SUBAGENTS_DIR, "luvus-done.ts");
  piArgs.push("-e", subagentDonePath);

  if (effectiveModel) {
    const model = effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel;
    piArgs.push("--model", model);
  }

  // Pass agent body as system prompt via file to avoid shell escaping issues
  // with multiline content. Pi's --append-system-prompt and --system-prompt
  // auto-detect file paths and read their contents.
  if (identityInSystemPrompt && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = slugifyName(params.name, { hyphenate: false });
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    piArgs.push(flag, syspromptPath);
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    piArgs.push("--tools", toolAllowlist);
  }

  // Env: denied tools + subagent identity + config dir propagation.
  // If the target cwd has its own .pi/agent/, that wins; else propagate the
  // current/global agent dir.
  const codingAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : process.env.PI_CODING_AGENT_DIR;
  const spawnEnv = buildSpawnEnvParts({
    name: params.name,
    agent: params.agent,
    autoExit: agentDefs?.autoExit,
    subagentSessionFile,
    id,
    activityFile,
    surface,
    codingAgentDir,
    denySet,
    parentRosterFile: rosterContext?.file,
  });

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = slugifyName(params.name, { hyphenate: false });
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    piArgs.push(promptArg);
  }

  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name: params.name,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    env: spawnEnv,
    command: "pi",
    args: piArgs,
    sessionFile: subagentSessionFile,
    title: buildPaneTitle(params.name, params.task),
  };
  writeLaunchSpec(launchScriptFile, spec);
  runInPane(surface, paneLine);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  writeRoster();
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  homedir(),
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = basename(transcriptPath);
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  pi: ExtensionAPI,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    // Watch the pane on the UHP event stream: it starts lazily on the first
    // watcher and stops once the last one releases.
    const releaseEventWatch = uhpEventStream.watch(surface);
    let result: Awaited<ReturnType<typeof pollForExit>>;
    try {
      result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        eventStream: uhpEventStream,
        // The screen read is only the crash fallback; while the child's activity
        // snapshot is demonstrably fresh, skip the per-second process spawn.
        // Claude-backed runs have no snapshots, so they keep scanning.
        maySkipScreenScan: running.activityFile
          ? () => {
              const activity = running.activity;
              return activity != null && Date.now() - activity.updatedAt < 10_000;
            }
          : undefined,
        onTick() {
          observeRunningSubagent(running);
          deliverParentMessages(running, pi);
          runIdleWatchdog(running);
        },
      });
    } finally {
      releaseEventWatch();
    }

    // A child can write its last message just before exiting; deliver it before
    // the completion result so ordering matches what the child observed.
    drainAndRemoveParentMessages(running, pi);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd()
          .slice(-SCREEN_SUMMARY_CHARS);
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      try {
        closeSurface(surface);
      } catch {
        // The pane may already be gone (closed by hand); the sidecar result stands.
      }
      runningSubagents.delete(running.id);
      writeRoster();

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    try {
      closeSurface(surface);
    } catch {
      // The pane may already be gone (closed by hand); the sidecar result stands.
    }
    runningSubagents.delete(running.id);
    writeRoster();

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {
      // The pane may already be gone.
    }
    runningSubagents.delete(running.id);
    writeRoster();
    try {
      rmSync(getParentMessageFile(sessionFile), { force: true });
    } catch {
      // Best effort — we are unwinding, so nothing is injected.
    }

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Steer the parent with a finished subagent run: a ping when the child asked
 * for help, otherwise the result. Shared by the `luvus_spawn` and
 * `luvus_resume` tools, which differ only in the summary and extra details.
 */
function deliverSubagentCompletion(
  running: RunningSubagent,
  result: SubagentResult,
  pi: ExtensionAPI,
  options: {
    /** Built lazily so a ping skips the summary work entirely. */
    present: () => string;
    /** Fields added to the result details (e.g. agent, claudeSessionId). */
    extraDetails?: Record<string, unknown>;
    /** Fields added to the ping details (e.g. the spawning agent). */
    pingExtraDetails?: Record<string, unknown>;
  },
): void {
  updateWidget(); // reflect removal from the Map immediately

  const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
  if (result.ping) {
    pi.sendMessage(
      {
        customType: "luvus_ping",
        content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
        display: true,
        details: {
          name: result.ping.name,
          message: result.ping.message,
          sessionFile: result.sessionFile,
          ...options.pingExtraDetails,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return;
  }

  pi.sendMessage(
    {
      customType: "luvus_result",
      content: options.present(),
      display: true,
      details: {
        name: running.name,
        task: running.task,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...options.extraDetails,
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Report a watcher failure to the parent; see deliverSubagentCompletion. */
function deliverSubagentError(
  running: RunningSubagent,
  err: unknown,
  pi: ExtensionAPI,
  options: { contentPrefix: string; extraDetails?: Record<string, unknown> },
): void {
  const message = (err as { message?: string } | undefined)?.message;
  updateWidget();
  pi.sendMessage(
    {
      customType: "luvus_result",
      content: `${options.contentPrefix}: ${message ?? String(err)}`,
      display: true,
      details: { name: running.name, ...options.extraDetails, error: message },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * True when this pi process is a subagent child: it carries a sidecar session
 * path, and its launch args load `luvus-done.ts`. In a child, that extension
 * owns the pane status end to end — it registers the reporter and publishes the
 * terminal status at its exit points. pi evaluates `luvus-status.ts` once per
 * extension entry, so a child that also registered the `index.ts` reporter
 * would run two reporters with separate terminal latches: the un-latched one
 * reports `idle` on agent_end and releases the lease on shutdown after the
 * other published `done`. Skipping the registration here keeps one reporter
 * per child. A plain pane (no child env) registers as before.
 */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.PI_LUVUS_SESSION);
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Live sidebar status for this pane. A subagent child does NOT register it:
  // the child also loads luvus-done.ts, whose reporter is the single owner
  // of the status lease (see isSubagentChild).
  if (!isSubagentChild()) createLuvusStatusReporter().register(pi);

  // One Luvus notification when a turn ends in an unfocused parent pane.
  createTurnNotifier(process.env, statusConfig.notifyEnabled).register(pi);

  // First-prompt OSC title for unnamed non-subagent panes. A subagent child
  // sets PI_LUVUS_NAME, so it keeps its `<name> — <task>` title.
  createLiveTitleController().register(pi);

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
    rosterContext = null;
    // The stream child must not outlive the session; do not rely on it exiting.
    uhpEventStream.shutdown();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("luvus_spawn"))
    pi.registerTool({
      name: "luvus_spawn",
      label: "Subagent",
      description:
        "Start a subagent in a new Luvus pane. The tool is fire-and-forget: it returns only an acknowledgement. When the subagent finishes, its result arrives automatically as a steer message that starts a new turn. Do not poll, sleep, read logs, or call other tools to check status. Do not fabricate or guess the result. After the call, end your turn or do other independent work, for example start more subagents. Set placement with the surface parameter.",
      promptSnippet:
        "Start an async subagent in a Luvus pane or tab (surface parameter); its result arrives later as a steer message.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. a scout spawning another scout)
        const currentAgent = process.env.PI_LUVUS_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane or tab, sends command)
        const running = await launchSubagent(params, ctx, {
          placement: resolveSurfacePlacement(params.surface),
        });

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal, pi)
          .then((result) => {
            deliverSubagentCompletion(running, result, pi, {
              present: () => resolveResultPresentation(result, running.name),
              extraDetails: {
                agent: running.agent,
                ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
              },
              pingExtraDetails: { agent: running.agent },
            });
          })
          .catch((err) => {
            deliverSubagentError(running, err, pi, {
              contentPrefix: `Sub-agent "${running.name}" error`,
              extraDetails: { task: running.task },
            });
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── luvus_interrupt tool ──
  if (shouldRegister("luvus_interrupt"))
    pi.registerTool({
      name: "luvus_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the current turn of a running pi subagent. The pane and session stay alive. The tool returns an acknowledgement only; it does not cause a subagent result.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id." })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name." })),
      }),

      async execute(
        _toolCallId,
        params,
      ): Promise<AgentToolResult<{ error?: string; id?: string; name?: string; status?: string }>> {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── luvus_message tool ──
  if (shouldRegister("luvus_message"))
    pi.registerTool({
      name: "luvus_message",
      label: "Message Subagent",
      description:
        "Send a short message to `parent`, one of your running children, or a running sibling. Your session continues. A reply, if any, arrives later as a separate message. caller_ping and luvus_done END your session; this tool does not.",
      promptSnippet:
        "Message `parent`, a child, or a sibling without ending your session.",
      parameters: SubagentMessageParams,

      async execute(
        _toolCallId,
        params,
      ): Promise<
        AgentToolResult<{ error?: string; name?: string; pane?: string; relation?: string }>
      > {
        if (!isMuxAvailable()) return muxUnavailableResult();

        const sessionFile = process.env.PI_LUVUS_SESSION ?? null;
        const result = sendSubagentMessage(
          { to: params.to, message: params.message },
          {
            hasParent: !!sessionFile,
            ownChildren: runningSubagents.values(),
            parentRoster: readParentRoster(),
            selfId: process.env.PI_LUVUS_ID ?? "",
            senderName: process.env.PI_LUVUS_NAME ?? "parent",
            parentMessageFile: sessionFile ? getParentMessageFile(sessionFile) : null,
          },
          { prompt: agentPrompt, append: appendParentMessage },
        );

        if ("error" in result) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            details: { error: result.error },
          };
        }
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            name: result.target.name,
            pane: result.target.pane,
            relation: result.target.relation,
          },
        };
      },

      renderCall(args, theme) {
        const target = typeof args.to === "string" && args.to ? args.to : "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.error) {
          return new Text(theme.fg("error", `▸ ${details.error}`), 0, 0);
        }
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details?.name ?? "message")) +
            theme.fg("dim", " — sent"),
          0,
          0,
        );
      },
    });

  // ── luvus_list tool ──
  if (shouldRegister("luvus_list"))
    pi.registerTool({
      name: "luvus_list",
      label: "List Subagents",
      description:
        "List agent definitions for the subagent `agent` parameter. Project .pi/agents/ overrides global ~/.pi/agent/agents/ for the same name.",
      promptSnippet:
        "List agent definitions for subagent.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── luvus_resume tool ──
  if (shouldRegister("luvus_resume"))
    pi.registerTool({
      name: "luvus_resume",
      label: "Resume Subagent",
      description:
        "Resume an earlier subagent session in a new Luvus pane, to continue a cancelled run or give follow-up work. Delivery is the same as subagent: fire-and-forget, the result arrives as a steer message, do not poll or fabricate it. Set placement with the surface parameter.",
      promptSnippet:
        "Resume an earlier subagent session (surface parameter); its result arrives later as a steer message.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file." }),
        name: Type.Optional(
          Type.String({ description: "Display name. Default: 'Resume'." }),
        ),
        surface: Type.Optional(
          Type.Union([Type.Literal("right"), Type.Literal("down"), Type.Literal("tab"), Type.Literal("pane")], {
            description:
              'Same values as subagent surface: "right" (default), "down", "tab".',
          }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Message to send after the resume, for example follow-up instructions.",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Exit after the response. Defaults to true; set false for an interactive session.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });
        ensureRosterContext(ctx);

        // Compute the launch-spec path and its pane line before any pane
        // exists, so an unsafe path fails without leaving an empty pane behind.
        const launchScriptFile = join(
          artifactDir,
          "luvus-scripts",
          `${slugifyName(name, { fallback: "resume", hyphenate: false })}-resume-${Date.now()}.json`,
        );
        const paneLine = paneCommandLine(SUBAGENTS_CLI_PATH, launchScriptFile);

        const surface = createSurface(name, resolveSurfacePlacement(params.surface));
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume argv (no shell: every value stays one argument).
        const resumeArgs: string[] = ["--session", params.sessionPath];

        // Load luvus-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "luvus-done.ts");
        resumeArgs.push("-e", subagentDonePath);

        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const resumeMsgFile = join(
            artifactDir,
            "luvus-resume",
            `${slugifyName(name, { fallback: "resume", hyphenate: false })}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          resumeArgs.push(`@${resumeMsgFile}`);
        }

        // Env — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnv = buildResumeEnvParts({
          name,
          sessionPath: params.sessionPath,
          id,
          activityFile,
          autoExit,
          codingAgentDir: process.env.PI_CODING_AGENT_DIR,
          parentRosterFile: rosterContext?.file,
        });

        const spec: LaunchSpec = {
          version: LAUNCH_SPEC_VERSION,
          name,
          env: resumeEnv,
          command: "pi",
          args: resumeArgs,
          sessionFile: params.sessionPath,
          title: buildPaneTitle(name, params.message),
        };
        writeLaunchSpec(launchScriptFile, spec);
        runInPane(surface, paneLine);

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        writeRoster();
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal, pi)
          .then((result) => {
            deliverSubagentCompletion(running, result, pi, {
              present: () => {
                const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
                const summary = findLastAssistantMessage(allEntries) ??
                  (result.errorMessage
                    ? `Subagent error: ${result.errorMessage}`
                    : result.exitCode !== 0
                      ? `Resumed session exited with code ${result.exitCode}`
                      : "Resumed session exited without new output");
                return resolveResultPresentation(
                  { ...result, summary, sessionFile: params.sessionPath },
                  running.name,
                );
              },
            });
          })
          .catch((err) => {
            deliverSubagentError(running, err, pi, { contentPrefix: "Resume error" });
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /luvus-spawn command — spawn a subagent by name
  pi.registerCommand("luvus-spawn", {
    description: "Spawn a subagent: /luvus-spawn <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /luvus-spawn <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use luvus_spawn with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /luvus-surface command — show or set the default surface placement
  pi.registerCommand("luvus-surface", {
    description: "Show or set the default subagent surface: /luvus-surface [right|down|tab]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const placement = parseSurfacePlacement(arg);
      if (placement) {
        setSurfaceDefault(placement);
        try {
          writeSurfaceConfig(placement, surfaceConfigPath);
          ctx.ui.notify(`Subagent surface set to "${placement}" (saved to config.json).`, "info");
        } catch (error) {
          ctx.ui.notify(
            `Subagent surface set to "${placement}" for this session, but saving to config.json failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
      } else if (arg === "") {
        ctx.ui.notify(`Subagent surface: ${getSurfaceDefault()}`, "info");
      } else {
        ctx.ui.notify(`Subagent surface: ${getSurfaceDefault()} (accepted: right, down, tab)`, "warning");
      }
    },
  });

  // ── luvus_result message renderer ──
  pi.registerMessageRenderer("luvus_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── luvus_status message renderer ──
  pi.registerMessageRenderer("luvus_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── luvus_ping message renderer ──
  pi.registerMessageRenderer("luvus_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
// test
