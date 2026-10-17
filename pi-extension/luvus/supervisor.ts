import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  agentPrompt,
  closeSurface,
  createSurface,
  pollForExit,
  readScreen,
  runInPane,
  sendEscape,
  type PollResult,
  type SurfacePlacement,
} from "./luvus.ts";
import { UhpEventStream } from "./uhp-events.ts";
import {
  buildSubagentToolAllowlist,
  getAgentConfigDir,
  loadAgentDefaults,
  type AgentDefaults,
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
  LAUNCH_RECORD_VERSION,
  getLaunchRecordFile,
  readLaunchRecord,
  writeLaunchRecord,
  type LaunchBackendName,
  type LaunchRecord,
} from "./launch-record.ts";
import { findLastAssistantMessage, getNewEntries, seedSubagentSessionFile } from "./session.ts";
import { slugifyName } from "./slug.ts";
import {
  type StatusConfig,
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
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
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

export const SubagentParams = Type.Object({
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
  surface: Type.Optional(
    Type.Union(
      [Type.Literal("right"), Type.Literal("down"), Type.Literal("tab"), Type.Literal("pane")],
      {
        description:
          '"right" (default): split side by side. "down": split below. "tab": new workspace tab. "pane" = "right". Overrides the configured default.',
      },
    ),
  ),
});

/** One steer message delivered to the parent session through `deps.send`. */
export interface SteerMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

/** Delivery options for an injected message: always a steering message today. */
export interface SendOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** How the supervisor injects messages into the parent session (pi.sendMessage). */
export type SendFn = (message: SteerMessage, options: SendOptions) => void;

/** Session context the supervisor needs from the tool call that starts a run. */
export interface SupervisorContext {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

/** Parameters of the `luvus_resume` tool. */
export interface ResumeParams {
  sessionPath: string;
  surface?: string;
  message?: string;
  autoExit?: boolean;
}

/** Tool-result shape `supervisor.resume` returns to the `luvus_resume` handler. */
export interface ResumeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
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
  /** Handoff text when the child ended with a `handoff` sidecar (D5) */
  handoff?: { message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  /** Session entries this run starts after: 0 for a spawn, N for a resume. */
  entryCountBefore: number;
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

export interface SubagentRosterChild {
  id: string;
  name: string;
  pane: string;
  cli: string;
}

export interface SubagentRoster {
  parentPane: string;
  parentName: string;
  children: SubagentRosterChild[];
}

export interface ParentMessage {
  header: string;
  message: string;
}

/** Dependencies injected into `createSupervisor` (design D1). */
export interface SupervisorDeps {
  /** Deliver a steer message to the parent session (pi.sendMessage). */
  send: SendFn;
  /** Latest ExtensionContext for widget updates, or null before session_start. */
  ui: () => ExtensionContext | null;
  /** Luvus surface operations. */
  luvus: {
    createSurface: typeof createSurface;
    runInPane: typeof runInPane;
    closeSurface: typeof closeSurface;
    sendEscape: typeof sendEscape;
    readScreen: typeof readScreen;
    pollForExit: typeof pollForExit;
    agentPrompt: typeof agentPrompt;
  };
  /** Event stream factory; the supervisor owns the instance it returns. */
  events: () => UhpEventStream;
  /** Loaded status configuration (widget labels and transition messages). */
  statusConfig: StatusConfig;
}

/** Everything the supervisor exposes to the extension and its tests. */
export interface Supervisor {
  /** Launch a child and start its watcher, widget and status refresh. */
  spawn(
    params: Static<typeof SubagentParams>,
    ctx: SupervisorContext,
    options?: { surface?: string; placement?: SurfacePlacement },
  ): Promise<RunningSubagent>;
  /** Resume a session (today's inline `luvus_resume` launch path). */
  resume(
    params: ResumeParams,
    ctx: SupervisorContext,
    options?: { placement?: SurfacePlacement },
  ): Promise<ResumeToolResult>;
  /** Send Escape to a running child's current turn. */
  interrupt(
    params: { id?: string; name?: string },
    sendEscapeKey?: (surface: string) => void,
  ): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
  /** The running children, for the widget and `luvus_message`. */
  running(): readonly RunningSubagent[];
  /** Stop every watcher, both refresh intervals and the event stream. Final. */
  shutdown(): void;
  readonly isShutdown: boolean;
  /** The poll signal shared by this supervisor's watchers (tests prove it is live). */
  getAbortController(): AbortController;
  renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[];
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["luvus_spawn", "luvus_interrupt", "luvus_list", "luvus_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
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

export function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd ? (isAbsolute(rawCwd) ? rawCwd : join(cwdBase, rawCwd)) : null;
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

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const sessionsRoot = join(agentDir, "sessions");
  const sessionDir = join(sessionsRoot, getDefaultSessionDirNameFor(cwd));
  if (!existsSync(sessionDir)) {
    migrateLegacySessionDir(sessionsRoot, cwd, sessionDir);
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

/** The launch modes resolved once for a spawn or resume. */
export interface LaunchBehavior {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
}

export function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): LaunchBehavior {
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
export function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

export function formatElapsed(seconds: number): string {
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
export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_LUVUS_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Where this process publishes its roster: `<artifactDir>/luvus-roster.json`. */
export function getRosterFile(artifactDir: string): string {
  return join(artifactDir, "luvus-roster.json");
}

/** The file a child appends parent-bound messages to. */
export function getParentMessageFile(sessionFile: string): string {
  return `${sessionFile}.msg`;
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

/** The launch-prompt line naming the peers a fresh subagent can message. */
export function buildLaunchMessagingHint(siblingNames: string[]): string {
  const names = [...new Set(["parent", ...siblingNames])];
  const list = names.map((name) => `\`${name}\``).join(", ");
  return `You can message ${list} with luvus_message; it does not end your session.`;
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
export function buildPiPromptArgs(params: {
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

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
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

/** Inject any newly written parent-bound messages into this session. */
export function deliverParentMessages(running: RunningSubagent, send: SendFn): void {
  const { messages, offset } = readParentMessages(
    getParentMessageFile(running.sessionFile),
    running.messageOffset ?? 0,
  );
  running.messageOffset = offset;
  for (const message of messages) {
    send(
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
export function drainAndRemoveParentMessages(running: RunningSubagent, send: SendFn): void {
  deliverParentMessages(running, send);
  try {
    rmSync(getParentMessageFile(running.sessionFile), { force: true });
  } catch {
    // Best effort — a stale file only delays the next child's messages.
  }
}

/** Pure mirror of a running map as published for children. */
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
export function borderLine(left: string, right: string, width: number): string {
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
export function borderTop(title: string, info: string, width: number): string {
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
export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
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

export function resolveResultPresentation(
  result: Pick<SubagentResult, "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage">,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: luvus_resume ${result.sessionFile}`
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

export function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  // A backend without an activity snapshot has nothing to observe.
  if (!backendFor(running).observes) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead =
    read.ok === true ? { ok: true } : { ok: false, reason: read.reason, error: read.error };

  if (read.ok === true) {
    running.activity = read.activity;
    running.statusState = observeStatus(
      running.statusState,
      {
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
      },
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: read.reason,
      snapshotError: read.error,
    },
    observedAt,
  );
}

/** Resolved per call so a test can point HOME at a temporary directory. */
function getClaudeSessionsDir(): string {
  return join(homedir(), ".pi", "agent", "sessions", "claude-code");
}

/**
 * Copy the Claude Code transcript beside the other Claude sessions and return
 * its session id: the transcript file name without the `.jsonl` extension,
 * which is what `claude --resume` takes.
 */
function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const sessionsDir = getClaudeSessionsDir();
    mkdirSync(sessionsDir, { recursive: true });
    const filename = basename(transcriptPath);
    copyFileSync(transcriptPath, join(sessionsDir, filename));
    return filename.replace(/\.jsonl$/, "");
  } catch {
    return null;
  }
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
function runIdleWatchdog(
  running: RunningSubagent,
  promptPane: (surface: string, text: string) => unknown,
  now = Date.now(),
): void {
  // Without activity snapshots the watchdog cannot tell a quiet child from a
  // gone one, so it only runs for an observing backend.
  if (!backendFor(running).observes) return;
  const state = (running.idleWatch ??= { nudges: 0 });

  const goneAction = decideGoneAction({
    interactive: running.interactive,
    readOk: running.activityRead?.ok === true,
    activity: running.activity ? { updatedAt: running.activity.updatedAt } : undefined,
    now,
    state,
  });
  if (goneAction === "gone") {
    const detail =
      running.activity != null && running.activityRead?.ok === true
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
      promptPane(running.surface, IDLE_NUDGE_TEXT);
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

export function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void,
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

/** One spawn resolution plus its per-run binding, so a backend builds one run. */
export interface BackendLaunchRequest {
  /** Role values the spawn resolved once (design D3). */
  record: LaunchRecord;
  /** The spawning task, which the record does not keep. */
  task: string;
  /** Skill prompts for this spawn, which the record does not keep. */
  skills?: string;
  /** Spawn-only: how the task reaches the child. */
  launchBehavior?: LaunchBehavior;
  /** The target cwd's `.pi/agent` directory, when it has one. */
  localAgentDir: string | null;
  artifactDir: string;
  /** Names the child can reach with `luvus_message` at spawn time. */
  siblingNames: string[];
  parentRosterFile?: string;
  /** Set when the run continues an existing session (design D5). */
  resume?: {
    /** The follow-up message; the session keeps the spawn task and role. */
    message?: string;
  };
  /** Values that change for every run; the record does not keep them (design D3). */
  run: {
    id: string;
    surface: string;
    startTime: number;
    /** Child session file (pi), or the record-adjacent path (Claude Code). */
    sessionFile: string;
    launchScriptFile: string;
    activityFile: string;
    /** Session entries the run starts after: 0 for a spawn, N for a resume. */
    entryCountBefore: number;
  };
}

/** What a backend builds for one run: its launch spec and its running entry. */
export interface BackendLaunch {
  spec: LaunchSpec;
  running: RunningSubagent;
}

/** A backend's refusal of an interrupt: the tool result to return instead. */
interface BackendInterruptRefusal {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The parts of a run's result that the backend's exit path decides. */
interface BackendExtractedResult {
  summary: string;
  /** Pi's session file; a Claude Code run has none. */
  sessionFile?: string;
  ping?: PollResult["ping"];
  handoff?: PollResult["handoff"];
  errorMessage?: string;
}

/** What a backend does before its pane closes; pi has nothing to do. */
type BackendAfterExit = (running: RunningSubagent) => Pick<SubagentResult, "claudeSessionId">;

/** One backend's behavior. The supervisor reads this table, not the backend name. */
interface SubagentBackend {
  /** The record backend name this entry builds (design D3). */
  name: LaunchBackendName;
  /** True when the backend publishes an activity snapshot that status reads. */
  observes: boolean;
  /** Role-prompt precedence; the spawn resolves it once into the record. */
  resolveRolePrompt(
    params: Static<typeof SubagentParams>,
    agentDefs: AgentDefaults | null,
  ): string | undefined;
  buildLaunch(request: BackendLaunchRequest): BackendLaunch;
  /** Null when Escape interrupts this backend; otherwise the refusal result. */
  interrupt(running: RunningSubagent): BackendInterruptRefusal | null;
  extractResult(
    running: RunningSubagent,
    poll: Pick<PollResult, "exitCode" | "errorMessage" | "ping" | "handoff">,
    readScreen: (surface: string, lines: number) => string,
  ): BackendExtractedResult;
  afterExit: BackendAfterExit;
}

function buildPiLaunch(request: BackendLaunchRequest): BackendLaunch {
  const { record, run } = request;
  const resume = request.resume;

  const identity = record.rolePrompt ?? null;
  const systemPromptMode = record.systemPromptMode;

  // Build pi argv (no shell: every value stays exactly one argument).
  const piArgs: string[] = ["--session", run.sessionFile];

  const subagentDonePath = join(SUBAGENTS_DIR, "luvus-done.ts");
  piArgs.push("-e", subagentDonePath);

  if (record.model) {
    const model = record.thinking ? `${record.model}:${record.thinking}` : record.model;
    piArgs.push("--model", model);
  }

  // Pass the role prompt as a system prompt via file to avoid shell escaping
  // issues with multiline content. Pi's --append-system-prompt and
  // --system-prompt auto-detect file paths and read their contents. A pi
  // session does not store these flags, so a resume writes the file again.
  if (systemPromptMode && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = slugifyName(record.name, { hyphenate: false });
    const syspromptPath = join(
      request.artifactDir,
      `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`,
    );
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    piArgs.push(flag, syspromptPath);
  }

  const toolAllowlist = buildSubagentToolAllowlist(record.tools);
  if (toolAllowlist) {
    piArgs.push("--tools", toolAllowlist);
  }

  // Env: denied tools + subagent identity + config dir propagation.
  // If the target cwd has its own .pi/agent/, that wins; else propagate the
  // current/global agent dir.
  const codingAgentDir =
    request.localAgentDir && existsSync(request.localAgentDir)
      ? request.localAgentDir
      : process.env.PI_CODING_AGENT_DIR;
  const spawnEnv = buildSpawnEnvParts({
    name: record.name,
    agent: record.agent,
    autoExit: record.autoExit,
    subagentSessionFile: run.sessionFile,
    id: run.id,
    activityFile: run.activityFile,
    surface: run.surface,
    codingAgentDir,
    denySet: new Set(record.denyTools),
    parentRosterFile: request.parentRosterFile,
  });

  if (resume) {
    // The session keeps the spawn task and role. A resume adds only the follow-up
    // message, behind the peers the child can reach at resume time.
    if (resume.message) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = slugifyName(record.name, { hyphenate: false });
      const promptPath = join(
        request.artifactDir,
        "luvus-resume",
        `${safeName || "resume"}-${timestamp}.md`,
      );
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(
        promptPath,
        `${buildLaunchMessagingHint(request.siblingNames)}\n\n${resume.message}`,
        "utf8",
      );
      piArgs.push(`@${promptPath}`);
    }
  } else {
    const launchBehavior = request.launchBehavior;
    if (!launchBehavior) throw new Error("A spawn launch needs a launch behavior");

    // Only full-context fork mode inherits prior conversation state.
    // Blank-session modes need the wrapper instructions and artifact-backed handoff.
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = buildSubagentTaskPrompt({
      task: request.task,
      roleBlock,
      modeHint: resolveModeHint(record.autoExit),
      summaryInstruction: record.autoExit
        ? "Your FINAL assistant message should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one."
        : "Your FINAL assistant message (before calling luvus_done or before the user exits) should summarize what you accomplished. Put the verdict or outcome first. Keep it short: results and findings, not your process. Follow your role's report format if it sets one.",
      messagingHint: buildLaunchMessagingHint(request.siblingNames),
      inheritsConversationContext: launchBehavior.inheritsConversationContext,
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
      const safeName = slugifyName(record.name, { hyphenate: false });
      const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
      const artifactPath = join(request.artifactDir, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      taskArg = `@${artifactPath}`;
    }

    for (const promptArg of buildPiPromptArgs({
      effectiveSkills: request.skills,
      taskDelivery: launchBehavior.taskDelivery,
      taskArg,
    })) {
      piArgs.push(promptArg);
    }
  }

  return {
    spec: {
      version: LAUNCH_SPEC_VERSION,
      name: record.name,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      env: spawnEnv,
      command: "pi",
      args: piArgs,
      sessionFile: run.sessionFile,
      title: buildPaneTitle(record.name, resume?.message ?? request.task),
    },
    running: {
      id: run.id,
      name: record.name,
      task: request.task,
      agent: record.agent,
      surface: run.surface,
      startTime: run.startTime,
      sessionFile: run.sessionFile,
      launchScriptFile: run.launchScriptFile,
      activityFile: run.activityFile,
      entryCountBefore: run.entryCountBefore,
      interactive: record.interactive,
      statusState: createStatusState({
        source: "pi",
        startTimeMs: run.startTime,
      }),
    },
  };
}

function buildClaudeLaunch(request: BackendLaunchRequest): BackendLaunch {
  const { record, run } = request;
  const sentinelFile = join(tmpdir(), `pi-claude-${run.id}-done`);
  const pluginDir = join(SUBAGENTS_DIR, "plugin");

  const claudeArgs: string[] = ["--dangerously-skip-permissions"];

  if (existsSync(pluginDir)) {
    claudeArgs.push("--plugin-dir", pluginDir);
  }

  if (record.model) {
    claudeArgs.push("--model", record.model);
  }

  if (record.rolePrompt) {
    claudeArgs.push("--append-system-prompt", record.rolePrompt);
  }

  if (request.resume) {
    // `claude --resume` takes the stored session id, then the follow-up prompt.
    if (!record.claudeSessionId) {
      throw new Error("A Claude Code resume needs a stored session id");
    }
    claudeArgs.push("--resume", record.claudeSessionId);
    if (request.resume.message) claudeArgs.push(request.resume.message);
  } else {
    // A spawn passes the task as the prompt.
    claudeArgs.push(request.task);
  }

  return {
    spec: {
      version: LAUNCH_SPEC_VERSION,
      name: record.name,
      ...(record.cwd ? { cwd: record.cwd } : {}),
      env: { PI_CLAUDE_SENTINEL: sentinelFile },
      command: "claude",
      args: claudeArgs,
      sessionFile: run.sessionFile,
      title: buildPaneTitle(record.name, request.resume?.message ?? request.task),
    },
    running: {
      id: run.id,
      name: record.name,
      task: request.task,
      agent: record.agent,
      surface: run.surface,
      startTime: run.startTime,
      sessionFile: run.sessionFile,
      launchScriptFile: run.launchScriptFile,
      cli: "claude",
      sentinelFile,
      entryCountBefore: run.entryCountBefore,
      interactive: record.interactive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: run.startTime,
      }),
    },
  };
}

function extractPiResult(
  running: RunningSubagent,
  poll: Pick<PollResult, "exitCode" | "errorMessage" | "ping" | "handoff">,
): BackendExtractedResult {
  const fallback = poll.errorMessage
    ? `Subagent error: ${poll.errorMessage}`
    : poll.exitCode !== 0
      ? `Sub-agent exited with code ${poll.exitCode}`
      : "Sub-agent exited without output";
  const summary = existsSync(running.sessionFile)
    ? (findLastAssistantMessage(getNewEntries(running.sessionFile, running.entryCountBefore)) ??
      fallback)
    : fallback;
  return {
    summary,
    sessionFile: running.sessionFile,
    ping: poll.ping,
    handoff: poll.handoff,
    ...(poll.errorMessage ? { errorMessage: poll.errorMessage } : {}),
  };
}

function extractClaudeResult(
  running: RunningSubagent,
  poll: Pick<PollResult, "exitCode" | "errorMessage">,
  readScreen: (surface: string, lines: number) => string,
): BackendExtractedResult {
  let summary = "";

  if (running.sentinelFile) {
    try {
      summary = readFileSync(running.sentinelFile, "utf-8").trim();
    } catch {
      // Fall through to the screen read below.
    }
  }

  if (!summary) {
    summary = readScreen(running.surface, 200)
      .replace(/__SUBAGENT_DONE_\d+__/, "")
      .trimEnd()
      .slice(-SCREEN_SUMMARY_CHARS);
  }

  if (!summary) {
    summary =
      poll.exitCode !== 0
        ? `Claude Code exited with code ${poll.exitCode}`
        : "Claude Code exited without output";
  }

  // The child has no pi-style session file; the record sits beside the path a
  // later `luvus_resume` uses, so that path is the session reference.
  return { summary, sessionFile: running.sessionFile };
}

function copyClaudeTranscript(running: RunningSubagent): Pick<SubagentResult, "claudeSessionId"> {
  if (!running.sentinelFile) return {};
  const sessionId = copyClaudeSession(running.sentinelFile);
  try {
    unlinkSync(running.sentinelFile);
  } catch {
    // Best effort: the sentinel may already be gone.
  }
  try {
    unlinkSync(running.sentinelFile + ".transcript");
  } catch {
    // Best effort: the transcript may already be gone.
  }
  if (!sessionId) return {};

  // Store the id beside the role values, keeping every other record field so a
  // later `luvus_resume` finds the same role configuration.
  const recordFile = getLaunchRecordFile(running.sessionFile);
  const record = readLaunchRecord(recordFile);
  if (record) writeLaunchRecord(recordFile, { ...record, claudeSessionId: sessionId });
  return { claudeSessionId: sessionId };
}

function refuseClaudeInterrupt(running: RunningSubagent): BackendInterruptRefusal {
  return {
    content: [
      {
        type: "text",
        text: "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      },
    ],
    details: { error: "claude interrupt unsupported", id: running.id, name: running.name },
  };
}

/** The backend table (design D4): one place decides each backend's differences. */
const BACKENDS: Record<LaunchBackendName, SubagentBackend> = {
  pi: {
    name: "pi",
    observes: true,
    // The agent body is the role; an explicit parameter only fills a gap.
    resolveRolePrompt: (params, agentDefs) => agentDefs?.body ?? params.systemPrompt,
    buildLaunch: buildPiLaunch,
    interrupt: () => null,
    extractResult: extractPiResult,
    afterExit: () => ({}),
  },
  claude: {
    name: "claude",
    observes: false,
    // An explicit parameter wins over the agent body, as Claude Code did before.
    resolveRolePrompt: (params, agentDefs) => params.systemPrompt ?? agentDefs?.body,
    buildLaunch: buildClaudeLaunch,
    interrupt: refuseClaudeInterrupt,
    extractResult: extractClaudeResult,
    afterExit: copyClaudeTranscript,
  },
};

/** The table lookup every backend check in the supervisor goes through. */
function backendFor(owner: { cli?: string } | null | undefined): SubagentBackend {
  return owner?.cli === "claude" ? BACKENDS.claude : BACKENDS.pi;
}

/**
 * Create the parent-side subagent supervisor (design D1). It owns the running
 * map, the roster, the widget and status intervals, its own poll abort
 * controller and its UHP event stream. `send`, `ui`, the Luvus operations and
 * the event stream factory are injected, so tests can run without a real pi
 * or Luvus.
 */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let shutdownDone = false;

  /** All currently running subagents, keyed by id. */
  const runningSubagents = new Map<string, RunningSubagent>();

  /** Where this process publishes its roster, set on the first spawn or resume. */
  let rosterContext: { file: string; parentPane: string; parentName: string } | null = null;

  /** Interval timer for widget re-renders. */
  let widgetInterval: ReturnType<typeof setInterval> | null = null;

  /** Interval timer for status transition checks. */
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Abort signal shared by every poll watcher this supervisor starts. Session
   * teardown aborts it; a fresh supervisor (session start, reload) starts a
   * new one. A watcher must never inherit an already-aborted signal:
   * `pollForExit` would fail it instantly with an empty result while the
   * child it just launched is still starting.
   */
  const abortController = new AbortController();

  /** One UHP event stream per supervisor; it starts lazily on the first watcher. */
  let eventStream: UhpEventStream | null = null;

  function events(): UhpEventStream {
    return (eventStream ??= deps.events());
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

  function updateWidget(): void {
    const ctx = deps.ui();
    if (!ctx?.hasUI) return;

    if (runningSubagents.size === 0) {
      ctx.ui.setWidget("luvus-status", undefined);
      if (widgetInterval) {
        clearInterval(widgetInterval);
        widgetInterval = null;
      }
      return;
    }

    ctx.ui.setWidget(
      "luvus-status",
      (_tui, _theme) => {
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
      // A backend without a status feed has no starting phase to report.
      const right = deps.statusConfig.enabled
        ? formatWidgetRightLabel(snapshot)
        : backendFor(agent).observes
          ? " starting… "
          : " running… ";

      lines.push(borderLine(left, right, width));
    }

    lines.push(borderBottom(width));
    return lines;
  }

  function startWidgetRefresh(): void {
    if (widgetInterval) return;
    updateWidget(); // immediate first render
    widgetInterval = setInterval(() => {
      updateWidget();
    }, 1000);
  }

  function startStatusRefresh(): void {
    if (!deps.statusConfig.enabled || statusInterval) return;

    statusInterval = setInterval(() => {
      if (runningSubagents.size === 0) {
        if (statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
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
        const capped = capStatusLines(transitionLines, deps.statusConfig.lineLimit);
        deps.send(
          {
            customType: "luvus_status",
            content: formatStatusAggregate(transitionLines, deps.statusConfig.lineLimit),
            display: true,
            details: { lines: capped.visibleLines, overflow: capped.overflow },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }, 1000);
  }

  function resolveInterruptTarget(params: {
    id?: string;
    name?: string;
  }): { running: RunningSubagent } | { error: string } {
    const requestedId = params.id?.trim();
    if (requestedId) {
      const running = runningSubagents.get(requestedId);
      return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
    }

    const requestedName = params.name?.trim();
    if (!requestedName) {
      return { error: "Provide a running subagent id or exact display name." };
    }

    const matches = Array.from(runningSubagents.values()).filter(
      (running) => running.name === requestedName,
    );
    if (matches.length === 1) return { running: matches[0] };
    if (matches.length === 0) {
      return { error: `No running subagent named "${requestedName}".` };
    }

    const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
  }

  function handleSubagentInterrupt(
    params: { id?: string; name?: string },
    sendEscapeKey?: (surface: string) => void,
  ) {
    const resolved = resolveInterruptTarget(params);
    if ("error" in resolved) {
      return {
        content: [{ type: "text" as const, text: resolved.error }],
        details: { error: resolved.error },
      };
    }

    const running = resolved.running;
    const refusal = backendFor(running).interrupt(running);
    if (refusal) return refusal;

    const now = Date.now();
    observeRunningSubagent(running, now);

    const interruption = requestSubagentInterrupt(running, sendEscapeKey ?? deps.luvus.sendEscape);
    if ("error" in interruption) {
      return {
        content: [{ type: "text" as const, text: interruption.error }],
        details: { error: interruption.error, id: running.id, name: running.name },
      };
    }

    running.statusState = forceStatusAfterInterrupt(running.statusState, now);
    updateWidget();

    return {
      content: [
        { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
      ],
      details: { id: running.id, name: running.name, status: "interrupt_requested" },
    };
  }

  /**
   * Launch a subagent: creates the multiplexer pane, builds the command, and
   * sends it. Returns a RunningSubagent — does NOT poll.
   *
   * Call watchSubagent() on the returned object to observe completion.
   */
  async function launchSubagent(
    params: Static<typeof SubagentParams>,
    ctx: SupervisorContext,
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

    const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
      params,
      agentDefs,
    );

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

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);
    const denySet = resolveDenyTools(agentDefs);
    const backend = backendFor(agentDefs);
    const rolePrompt = backend.resolveRolePrompt(params, agentDefs);

    // Resolve the agent defaults once and keep them in the launch record, so a
    // later resume starts the same role without reading the agent file again.
    const record: LaunchRecord = {
      version: LAUNCH_RECORD_VERSION,
      backend: backend.name,
      name: params.name,
      ...(params.agent ? { agent: params.agent } : {}),
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
      ...(effectiveTools ? { tools: effectiveTools } : {}),
      ...(rolePrompt ? { rolePrompt } : {}),
      ...(agentDefs?.systemPromptMode ? { systemPromptMode: agentDefs.systemPromptMode } : {}),
      denyTools: [...denySet],
      autoExit: agentDefs?.autoExit ?? false,
      interactive: effectiveInteractive,
    };
    writeLaunchRecord(getLaunchRecordFile(subagentSessionFile), record);

    // Use pre-created surface (parallel mode) or create a new one.
    // For new surfaces, pause briefly so the shell is ready before sending the command.
    const surfacePreCreated = !!options?.surface;
    const surface = options?.surface ?? deps.luvus.createSurface(params.name, options?.placement);
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

    // A Claude Code child has no pi-style session file; seeding one would make
    // a resume path that no backend reads. The record still sits beside it.
    if (launchBehavior.seededSessionMode && backend.name === "pi") {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
      });
    }

    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    const { spec, running } = backend.buildLaunch({
      record,
      task: params.task,
      skills: effectiveSkills,
      launchBehavior,
      localAgentDir,
      artifactDir,
      siblingNames: Array.from(runningSubagents.values(), (agent) => agent.name),
      parentRosterFile: rosterContext?.file,
      run: {
        id,
        surface,
        startTime,
        sessionFile: subagentSessionFile,
        launchScriptFile,
        activityFile,
        entryCountBefore: 0,
      },
    });

    writeLaunchSpec(launchScriptFile, spec);
    deps.luvus.runInPane(surface, paneLine);

    runningSubagents.set(id, running);
    writeRoster();
    return running;
  }

  /**
   * Watch a launched subagent until it exits. Polls for completion, extracts
   * the summary from the session file, cleans up the surface,
   * and removes the entry from runningSubagents.
   */
  async function watchSubagent(
    running: RunningSubagent,
    signal: AbortSignal,
    send: SendFn,
  ): Promise<SubagentResult> {
    const { name, task, surface, startTime, sessionFile } = running;
    // Either the per-agent watcher or the supervisor's teardown (reload,
    // session shutdown) can end the wait. Keep the combined signal so the
    // catch below reports a cancellation instead of a bogus subagent failure.
    const pollSignal = AbortSignal.any([signal, abortController.signal]);

    try {
      // Watch the pane on the UHP event stream: it starts lazily on the first
      // watcher and stops once the last one releases.
      const releaseEventWatch = events().watch(surface);
      let result: Awaited<ReturnType<typeof pollForExit>>;
      try {
        result = await deps.luvus.pollForExit(surface, pollSignal, {
          interval: 1000,
          sessionFile,
          sentinelFile: running.sentinelFile,
          eventStream: events(),
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
            deliverParentMessages(running, send);
            runIdleWatchdog(running, deps.luvus.agentPrompt);
          },
        });
      } finally {
        releaseEventWatch();
      }

      // A child can write its last message just before exiting; deliver it before
      // the completion result so ordering matches what the child observed.
      drainAndRemoveParentMessages(running, send);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      const backend = backendFor(running);
      const extracted = backend.extractResult(running, result, deps.luvus.readScreen);
      const afterExit = backend.afterExit(running);

      try {
        deps.luvus.closeSurface(surface);
      } catch {
        // The pane may already be gone (closed by hand); the sidecar result stands.
      }
      runningSubagents.delete(running.id);
      writeRoster();

      return {
        name,
        task,
        exitCode: result.exitCode,
        elapsed,
        ...extracted,
        ...(afterExit.claudeSessionId ? { claudeSessionId: afterExit.claudeSessionId } : {}),
      };
    } catch (err: any) {
      try {
        deps.luvus.closeSurface(surface);
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

      if (pollSignal.aborted) {
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
   * for help, otherwise the result. Shared by spawned and resumed children.
   */
  function deliverSubagentCompletion(
    running: RunningSubagent,
    result: SubagentResult,
    send: SendFn,
  ): void {
    updateWidget(); // reflect removal from the Map immediately

    const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: luvus_resume ${result.sessionFile}`;
    if (result.ping) {
      send(
        {
          customType: "luvus_ping",
          content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            message: result.ping.message,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    if (result.handoff) {
      // No `sessionRef` here: its `Resume: luvus_resume` line tells the parent
      // to do the opposite of what a handoff needs. The session file still goes
      // in the content, and the instruction line says to start a new subagent.
      send(
        {
          customType: "luvus_handoff",
          content:
            `Sub-agent "${running.name}" handed off at the context alert (${formatElapsed(result.elapsed)}). The task is not complete.\n\n` +
            `${result.handoff.message}\n\n` +
            `Start a new subagent with this handoff in its task. Do not resume this session.\n\n` +
            `Session: ${result.sessionFile}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            message: result.handoff.message,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    send(
      {
        customType: "luvus_result",
        content: resolveResultPresentation(result, running.name),
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          sessionFile: result.sessionFile,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Report a watcher failure to the parent; see deliverSubagentCompletion. */
  function deliverSubagentError(running: RunningSubagent, err: unknown, send: SendFn): void {
    const message = (err as { message?: string } | undefined)?.message;
    updateWidget();
    send(
      {
        customType: "luvus_result",
        content: `Sub-agent "${running.name}" error: ${message ?? String(err)}`,
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          error: message,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Start a launched child's watcher and deliver its outcome to the parent. */
  function startWatcher(running: RunningSubagent): void {
    // Create a separate AbortController for the watcher
    // (the tool's signal completes when we return)
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;

    // Start widget refresh and status supervision when the first agent launches
    startWidgetRefresh();
    startStatusRefresh();

    // Fire-and-forget: start watching in background
    watchSubagent(running, watcherAbort.signal, deps.send)
      .then((result) => {
        deliverSubagentCompletion(running, result, deps.send);
      })
      .catch((err) => {
        deliverSubagentError(running, err, deps.send);
      });
  }

  return {
    get isShutdown() {
      return shutdownDone;
    },
    async spawn(params, ctx, options) {
      const running = await launchSubagent(params, ctx, options);
      startWatcher(running);
      return running;
    },

    async resume(params, ctx, options) {
      const startTime = Date.now();
      const id = Math.random().toString(16).slice(2, 10);

      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
      const activityFile = getSubagentActivityFile(artifactDir, id);
      mkdirSync(dirname(activityFile), { recursive: true });
      ensureRosterContext(ctx);

      // Read the record before the session file: a Claude Code record resumes
      // without a pi-style session file, and the record sits beside that path.
      const storedRecord = readLaunchRecord(getLaunchRecordFile(params.sessionPath));
      if (!storedRecord && !existsSync(params.sessionPath)) {
        return {
          content: [{ type: "text", text: `Error: session file not found: ${params.sessionPath}` }],
          details: { error: "session not found" },
        };
      }
      if (storedRecord?.backend === "claude" && !storedRecord.claudeSessionId) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: the launch record for ${params.sessionPath} has no Claude Code ` +
                "session id. The run did not store its transcript; start a new subagent instead.",
            },
          ],
          details: { error: "claude session id missing", sessionPath: params.sessionPath },
        };
      }

      const autoExit = params.autoExit ?? storedRecord?.autoExit ?? true;
      // An explicit autoExit makes the run interactive exactly when it is false.
      let interactive = storedRecord?.interactive ?? !autoExit;
      if (params.autoExit !== undefined) interactive = !params.autoExit;
      const effectiveRecord: LaunchRecord = storedRecord
        ? { ...storedRecord, autoExit, interactive }
        : {
            version: LAUNCH_RECORD_VERSION,
            backend: "pi",
            name: "Resume",
            denyTools: [],
            autoExit,
            interactive,
          };
      const name = effectiveRecord.name;
      const backend = BACKENDS[effectiveRecord.backend];

      // Record the entry count before the resume so its delivery only reads the
      // entries the resumed run writes. A Claude Code run has no pi-style
      // session file, so its summary comes from the sentinel and the screen.
      const entryCountBefore =
        effectiveRecord.backend === "claude" || !existsSync(params.sessionPath)
          ? 0
          : getNewEntries(params.sessionPath, 0).length;

      // Compute the launch-spec path and its pane line before any pane
      // exists, so an unsafe path fails without leaving an empty pane behind.
      const launchScriptFile = join(
        artifactDir,
        "luvus-scripts",
        `${slugifyName(name, { fallback: "resume", hyphenate: false })}-resume-${Date.now()}.json`,
      );
      const paneLine = paneCommandLine(SUBAGENTS_CLI_PATH, launchScriptFile);

      const surface = deps.luvus.createSurface(name, options?.placement);
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

      // Mirror the spawn's cwd lookup: only a record that names a cwd can have
      // its own `.pi/agent` configuration.
      const localAgentDir = effectiveRecord.cwd ? join(effectiveRecord.cwd, ".pi", "agent") : null;
      const { spec, running } = backend.buildLaunch({
        record: effectiveRecord,
        task: params.message ?? "resumed session",
        localAgentDir,
        artifactDir,
        siblingNames: Array.from(runningSubagents.values(), (agent) => agent.name),
        parentRosterFile: rosterContext?.file,
        resume: { message: params.message },
        run: {
          id,
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          entryCountBefore,
        },
      });
      writeLaunchSpec(launchScriptFile, spec);
      deps.luvus.runInPane(surface, paneLine);

      runningSubagents.set(id, running);
      writeRoster();

      startWatcher(running);

      return {
        content: [
          {
            type: "text",
            text: storedRecord
              ? `Session "${name}" resumed.`
              : `Session "${name}" resumed. No launch record was found, so the role configuration was not restored.`,
          },
        ],
        details: {
          id,
          name,
          sessionPath: params.sessionPath,
          launchScriptFile,
          status: "started",
        },
      };
    },

    interrupt: handleSubagentInterrupt,

    running(): readonly RunningSubagent[] {
      return Array.from(runningSubagents.values());
    },

    shutdown(): void {
      if (shutdownDone) return;
      shutdownDone = true;
      if (widgetInterval) {
        clearInterval(widgetInterval);
        widgetInterval = null;
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      abortController.abort();
      for (const [_id, agent] of runningSubagents) {
        agent.abortController?.abort();
      }
      runningSubagents.clear();
      rosterContext = null;
      // The stream child must not outlive the session; do not rely on it exiting.
      eventStream?.shutdown();
    },

    getAbortController(): AbortController {
      return abortController;
    },
    renderSubagentWidgetLines,
  };
}
