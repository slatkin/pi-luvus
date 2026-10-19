import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createStreamHub,
  isStreamName,
  toolOutputText,
  type StreamHub,
  type StreamName,
} from "./stream-state.ts";
import { StreamProjection, type AttachState } from "./stream-projection.ts";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  pollForExit,
  closeSurface,
  sendEscape,
  readScreen,
  runInPane,
  splitPane,
  namePane,
  agentPrompt,
  parseSurfacePlacement,
  type SurfacePlacement,
} from "./luvus.ts";
import { streamTailScriptPath, tailerCommandLine } from "./launch.ts";
import { UhpEventStream } from "./uhp-events.ts";
import {
  createSupervisor,
  SubagentParams,
  borderLine,
  buildLaunchMessagingHint,
  buildPiPromptArgs,
  buildSpawnEnvParts,
  buildSubagentTaskPrompt,
  drainAndRemoveParentMessages,
  formatElapsed,
  getDefaultSessionDirFor,
  getParentMessageFile,
  getShellReadyDelayMs,
  readParentMessages,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveResultPresentation,
  type ParentMessage,
  type RunningSubagent,
  type SubagentRoster,
  type Supervisor,
} from "./supervisor.ts";

// Re-exported for the module's test surface (see __test__ below).
export { resolveModeHint } from "./supervisor.ts";
import {
  buildSubagentToolAllowlist,
  getAgentConfigDir,
  getBundledAgentsDir,
  loadAgentDefaults,
  parseAgentDefinition,
  type AgentDefinition,
} from "./agent-defs.ts";

import { decodeChildEnv, isSubagentChild } from "./child-env.ts";
import { loadStatusConfig, loadSurfaceConfig, writeSurfaceConfig } from "./status.ts";
import { createLuvusStatusReporter } from "./luvus-status.ts";
import { createTurnNotifier } from "./turn-notify.ts";
import { createLiveTitleController } from "./live-title.ts";

// Survive /reload: the supervisor owns every timer, poll watcher and event
// stream this module load started. /reload re-imports this file, so shutting
// down the supervisor stored under one per-URL key stops the previous load's
// closures. See https://github.com/HazAT/pi-interactive-subagents/issues/5
//
// The key is namespaced per module URL: multiple copies of this extension can
// coexist in one process (e.g. a global install plus the project copy), and a
// shared key would let one copy shut down the other's supervisor.
const INSTANCE_KEY = `#${import.meta.url}`;
const SUPERVISOR_KEY = Symbol.for(`pi-luvus/supervisor${INSTANCE_KEY}`);

/** The pi that registration bound last; the supervisor's deps.send targets it. */
let activePi: ExtensionAPI | null = null;

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/**
 * Per-session stream transport. The hub starts recording at session start so
 * a pane opened mid-turn can replay that turn; its socket starts listening on
 * the first attach (unit 3).
 */
let streamHub: StreamHub | undefined;

/**
 * Follower panes this session opened, per stream. `/stream close` closes them
 * and clears the record; a stream whose client count drops to zero (its pane
 * closed) also forgets the record, so a later request can open a fresh pane.
 */
const streamPanes = new Map<StreamName, string>();

/**
 * The session's stream hub, created on first use. `onClientsChanged` is the
 * detach signal: when a stream's last client disappears (its pane closed),
 * forget the pane recorded for it so a repeat request opens a new pane.
 */
function ensureStreamHub(sessionId: string | undefined): StreamHub {
  streamHub ??= createStreamHub({
    sessionId,
    onClientsChanged: (stream, count) => {
      if (count === 0) streamPanes.delete(stream);
      syncStreamProjection();
    },
  });
  return streamHub;
}

/** Whether a stream is attached: a pane this session opened, or a live client. */
function streamAttached(stream: StreamName): boolean {
  return streamPanes.has(stream) || (streamHub?.isAttached(stream) ?? false);
}

/** The transcript projection, created on the first attach-state sync. */
let streamProjection: StreamProjection | undefined;

/** The live TUI captured by the zero-height widget factory. */
let streamTui: unknown;

/** The projection's attach state, derived from the existing stream state. */
function streamAttachState(): AttachState {
  const thinking = streamAttached("thinking");
  const tools = streamAttached("tools");
  if (thinking && tools) return "both";
  if (thinking) return "thinking";
  if (tools) return "tools";
  return "none";
}

/**
 * Surface a projection warning through the session's UI. It runs from render
 * paths, so it must never throw.
 */
function warnStreamProjection(message: string): void {
  try {
    latestCtx?.ui.notify(message, "warning");
  } catch {
    // Without a UI the transcript rendering unchanged is the only feedback.
  }
}

/**
 * Apply the derived attach state to the projection. A no-op until the widget
 * factory has handed over a `tui`; the projection itself fails open on a
 * layout mismatch, warns once, and leaves the transcript untouched.
 */
function syncStreamProjection(): void {
  if (!streamTui) return;
  streamProjection ??= new StreamProjection({ warn: warnStreamProjection });
  streamProjection.apply(streamAttachState(), streamTui);
}

/**
 * Capture the live TUI through the zero-height "luvus-streams" widget: the
 * widget renders nothing, and its factory is the public seam that hands the
 * projection the `tui` it needs to find and swap the chat container.
 */
function captureStreamTui(ctx: ExtensionContext): void {
  try {
    ctx.ui.setWidget("luvus-streams", (tui) => {
      streamTui = tui;
      return {
        render: () => [],
        invalidate() {},
      };
    });
  } catch {
    // Without a widget surface the projection stays dormant; a later session
    // start can still capture the tui.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Dependencies of the `/stream` command handler, resolved per call. */
export interface StreamCommandDeps {
  notify: (text: string, level: "info" | "warning" | "error") => void;
  /** The Luvus pane this pi process runs in, when known. */
  paneId: string | undefined;
  /** Session id seeding the stream socket name, when a session exists. */
  sessionId: string | undefined;
}

/**
 * The `/stream` command: open the `thinking` and/or `tools` follower panes,
 * report the attached state, or close the panes this session opened. An
 * unrecognised argument reports the accepted arguments and changes nothing;
 * a repeat request reports that the stream is already attached.
 */
export async function handleStreamCommand(args: string, deps: StreamCommandDeps): Promise<void> {
  const arg = args.trim().toLowerCase();

  if (arg === "") {
    deps.notify(
      `Streams — thinking: ${streamAttached("thinking") ? "attached" : "not attached"}, ` +
        `tools: ${streamAttached("tools") ? "attached" : "not attached"}`,
      "info",
    );
    return;
  }

  if (arg === "close") {
    closeStreamPanes(deps.notify);
    syncStreamProjection();
    return;
  }

  let requested: StreamName[];
  if (arg === "both") {
    requested = ["thinking", "tools"];
  } else if (isStreamName(arg)) {
    requested = [arg];
  } else {
    requested = [];
  }
  if (requested.length === 0) {
    deps.notify(
      `Unknown stream argument "${args.trim()}". Accepted: thinking, tools, both, close.`,
      "warning",
    );
    return;
  }

  const pending = requested.filter((stream) => !streamPanes.has(stream));
  for (const stream of requested) {
    if (!pending.includes(stream)) {
      deps.notify(`The ${stream} stream is already attached.`, "info");
    }
  }
  if (pending.length === 0) return;

  const paneId = deps.paneId;
  if (!paneId) {
    deps.notify("Opening a stream requires a Luvus pane. Start pi inside a Luvus pane.", "warning");
    return;
  }

  await openStreamPanes(pending, paneId, deps);
}

/**
 * One in-flight gate for the pane-opening section of `/stream`. The section is
 * a check-then-act across `await hub.start()`: two invocations that both pass
 * the record pre-check would each split a pane for the same stream. Gating
 * the section behind one promise serializes concurrent invocations, and the
 * section re-checks the records after the start await, so a stream the
 * in-flight invocation already opened is not split a second time.
 */
let streamOpenGate: Promise<void> = Promise.resolve();

/**
 * Open the requested stream panes, serialized against other in-flight opens.
 * Every stream still recorded when the section runs is skipped with the
 * already-attached notice instead of a second split.
 */
async function openStreamPanes(
  pending: StreamName[],
  paneId: string,
  deps: StreamCommandDeps,
): Promise<void> {
  const section = streamOpenGate.then(async () => {
    const hub = ensureStreamHub(deps.sessionId);
    try {
      await hub.start();
    } catch (error) {
      deps.notify(`Cannot start the stream socket: ${errorText(error)}`, "error");
      return;
    }

    const commandLine = (stream: StreamName) =>
      tailerCommandLine(hub.socketPath, stream, streamTailScriptPath());

    for (const stream of pending) {
      // Re-check after the start await: a concurrent invocation may have
      // opened this stream while this section waited at the gate.
      if (streamPanes.has(stream)) {
        deps.notify(`The ${stream} stream is already attached.`, "info");
        continue;
      }
      // The tools pane splits below the thinking pane when one exists (recorded
      // earlier or just created); otherwise to the right of the pi pane.
      const thinkingPane = streamPanes.get("thinking");
      const fromThinking = stream === "tools" && thinkingPane !== undefined;
      const base = fromThinking ? thinkingPane : paneId;
      const direction = fromThinking ? "down" : "right";
      try {
        const pane = splitPane(base, direction);
        try {
          namePane(pane, stream);
        } catch {
          // Naming is cosmetic; the pane works unnamed.
        }
        try {
          runInPane(pane, commandLine(stream));
        } catch (error) {
          try {
            closeSurface(pane);
          } catch {
            // The split already failed to hold the pane; nothing to add.
          }
          throw error;
        }
        streamPanes.set(stream, pane);
        deps.notify(`The ${stream} stream is attached (pane ${pane}).`, "info");
      } catch (error) {
        deps.notify(`Cannot open the ${stream} stream: ${errorText(error)}`, "error");
      }
    }
    syncStreamProjection();
  });
  // A rejected section must not poison the gate for later invocations.
  streamOpenGate = section.then(
    () => undefined,
    () => undefined,
  );
  await section;
}

/**
 * Close the follower panes this session opened and forget them. Detach itself
 * is inferred from the socket: a closed pane's tailer drops its connection.
 */
function closeStreamPanes(notify: StreamCommandDeps["notify"]): void {
  const entries = [...streamPanes.entries()];
  if (entries.length === 0) {
    notify("No stream panes are open.", "info");
    return;
  }
  let closed = 0;
  for (const [stream, pane] of entries) {
    try {
      closeSurface(pane);
      closed += 1;
    } catch (error) {
      notify(`Cannot close the ${stream} pane (${pane}): ${errorText(error)}`, "warning");
    }
    streamPanes.delete(stream);
  }
  notify(`Closed ${closed} stream pane${closed === 1 ? "" : "s"}.`, "info");
}

/** Wire pi turn and tool events to one stream hub. */
export function registerStreamEventHandlers(
  pi: Pick<ExtensionAPI, "on">,
  getHub: () => StreamHub | undefined,
): void {
  pi.on("turn_start", () => {
    getHub()?.resetTurn();
  });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (update.type !== "thinking_delta") return;
    getHub()?.recordThinking(update.delta);
  });
  pi.on("tool_execution_start", (event) => {
    getHub()?.recordToolStart(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_update", (event) => {
    getHub()?.recordToolUpdate(
      event.toolCallId,
      event.toolName,
      toolOutputText(event.partialResult),
    );
  });
  pi.on("tool_execution_end", (event) => {
    getHub()?.recordToolEnd(event.toolCallId, event.toolName, event.isError);
  });
}

function getSupervisor(): Supervisor | undefined {
  return (globalThis as any)[SUPERVISOR_KEY] as Supervisor | undefined;
}

function createSupervisorInstance(): Supervisor {
  const supervisor = createSupervisor({
    send: (message, options) => {
      activePi?.sendMessage(message, options);
    },
    ui: () => latestCtx,
    luvus: {
      createSurface,
      runInPane,
      closeSurface,
      sendEscape,
      readScreen,
      pollForExit,
      agentPrompt,
    },
    events: () => new UhpEventStream(),
    statusConfig,
  });
  (globalThis as any)[SUPERVISOR_KEY] = supervisor;
  return supervisor;
}

/** The live supervisor for this module load, created on first use. */
function currentSupervisor(): Supervisor {
  return getSupervisor() ?? createSupervisorInstance();
}

// The previous module load's supervisor must not outlive the reload.
getSupervisor()?.shutdown();

type AgentSource = "package" | "global" | "project";

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
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

// ── Parent/child messaging (design Decisions 4, 5, 8) ──
//
// Children and siblings are addressed through Luvus `agent prompt` (luvus.ts).
// `parent` is not: a child appends JSON lines to `<session>.msg`, and the
// parent's existing poll loop injects them as steering messages.

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
  const reachable = () => reachableTargetNames({ ...params, ownChildren }).join(", ") || "(none)";

  if (!to) {
    return {
      error: `Provide a target: \`parent\`, a child, or a sibling. Reachable: ${reachable()}.`,
    };
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

/** Append one parent-bound message to a child's `<session>.msg` file. */
export function appendParentMessage(file: string, payload: ParentMessage): void {
  appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

/** Read this process's parent roster (path passed to children at spawn). */
function readParentRoster(file: string | undefined): SubagentRoster | null {
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
    description: "`parent`, or the exact id or display name of a running child or sibling.",
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
    header: formatMessageHeader({
      senderName: context.senderName,
      targetRelation: target.relation,
    }),
    message: input.message,
  };

  if (target.relation === "parent") {
    if (!context.parentMessageFile) return { error: "This agent has no parent." };
    try {
      deps.append(context.parentMessageFile, payload);
    } catch (error: any) {
      return {
        error: `Failed to write the parent message file: ${error?.message ?? String(error)}`,
      };
    }
    return {
      ok: true,
      target,
      text: "Message sent to parent. It arrives as a steering message; a reply will come back as a separate message.",
    };
  }

  try {
    deps.prompt(target.pane!, `${payload.header}\n${payload.message}`);
  } catch (error: any) {
    return {
      error: `Failed to send to "${target.name}" via Luvus: ${error?.message ?? String(error)}`,
    };
  }
  return {
    ok: true,
    target,
    text:
      `Message sent to "${target.name}" (pane ${target.pane}). Delivery is asynchronous; ` +
      "a reply will arrive as a separate message.",
  };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
    return currentSupervisor().renderSubagentWidgetLines(agents, width);
  },
  loadAgentDefaults,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveDenyTools,
  resolveResultPresentation,
  buildSpawnEnvParts,
  resolveMessageTarget,
  formatMessageHeader,
  buildLaunchMessagingHint,
  buildSubagentTaskPrompt,
  sendSubagentMessage,
  readParentMessages,
  drainAndRemoveParentMessages(
    running: RunningSubagent,
    pi: { sendMessage: (m: any, o: any) => unknown },
  ) {
    drainAndRemoveParentMessages(running, (message, options) => pi.sendMessage(message, options));
  },
  getCurrentSupervisor(): Supervisor {
    return currentSupervisor();
  },
  getDefaultSessionDirFor,
  /** Copy of the follower pane records, for tests. */
  streamPaneEntries(): Array<[StreamName, string]> {
    return [...streamPanes];
  },
  /** The derived projection attach state, for tests. */
  streamAttachState(): AttachState {
    return streamAttachState();
  },
  /** One projection sync, for tests that drive attach state directly. */
  syncStreamProjection(): void {
    syncStreamProjection();
  },
  /** The hub socket path, for tests that attach a client directly. */
  streamSocketPath(): string | undefined {
    return streamHub?.socketPath;
  },
  /** Reset stream command state between tests: records and the hub. */
  async resetStreamState(): Promise<void> {
    streamPanes.clear();
    const hub = streamHub;
    streamHub = undefined;
    await hub?.close();
    streamProjection?.uninstall();
    streamProjection = undefined;
    streamTui = undefined;
  },
};

/**
 * True when this pi process is a subagent child: it carries a sidecar session
 * path, and its launch args load `luvus-done.ts`. That extension owns the
 * child's status reporter. A second reporter would keep its own terminal latch,
 * so this registration is skipped here to keep one reporter per child. A plain
 * pane (no child env) registers as before.
 */
export { isSubagentChild };

export default function subagentsExtension(pi: ExtensionAPI) {
  // Decode the child env once: a pi process does not change its own
  // PI_LUVUS_* values. Every reader below uses this value.
  const childEnv = decodeChildEnv(process.env);

  // A fresh supervisor for this registration: stop the supervisor that a
  // previous load or registration left behind, then store the new one. Tool
  // handlers resolve the supervisor per call through currentSupervisor(), so
  // they always operate on the one the key holds — including the replacement
  // that session_start installs after a shutdown.
  getSupervisor()?.shutdown();
  createSupervisorInstance();
  activePi = pi;

  // Live sidebar status for this pane. A subagent child does NOT register it:
  // luvus-done.ts owns the child's reporter (the child marker is decoded in
  // child-env.ts).
  if (childEnv.sessionFile === undefined) createLuvusStatusReporter().register(pi);

  // One Luvus notification when a turn ends in an unfocused parent pane.
  createTurnNotifier(process.env, statusConfig.notifyEnabled).register(pi);

  // First-prompt OSC title for unnamed non-subagent panes. A subagent child
  // sets PI_LUVUS_NAME, so it keeps its `<name> — <task>` title.
  createLiveTitleController().register(pi);

  // Capture the UI context for widget updates
  registerStreamEventHandlers(pi, () => streamHub);

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // A previous session's shutdown made that supervisor final. Replace it
    // with a fresh one so a spawn in this session is not born with an
    // aborted poll signal or a stopped event stream.
    if (getSupervisor()?.isShutdown) createSupervisorInstance();
    captureStreamTui(ctx);
    ensureStreamHub(ctx.sessionManager.getSessionId());
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    getSupervisor()?.shutdown();
    // The transcript is torn down with the session; drop the projection and
    // its tui without touching the dying tree. A new session start captures
    // a fresh tui through the widget.
    streamProjection = undefined;
    streamTui = undefined;
    const hub = streamHub;
    streamHub = undefined;
    void hub?.close();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(childEnv.denyTools);

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
        const currentAgent = childEnv.agent;
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

        // Launch the subagent (creates pane or tab, sends command) and start
        // watching it in the background; the supervisor delivers the result.
        const running = await currentSupervisor().spawn(params, ctx, {
          placement: resolveSurfacePlacement(params.surface),
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
        const name =
          typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

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
        return currentSupervisor().interrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
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
      promptSnippet: "Message `parent`, a child, or a sibling without ending your session.",
      parameters: SubagentMessageParams,

      async execute(
        _toolCallId,
        params,
      ): Promise<
        AgentToolResult<{ error?: string; name?: string; pane?: string; relation?: string }>
      > {
        if (!isMuxAvailable()) return muxUnavailableResult();

        const sessionFile = childEnv.sessionFile ?? null;
        const result = sendSubagentMessage(
          { to: params.to, message: params.message },
          {
            hasParent: !!sessionFile,
            ownChildren: currentSupervisor().running(),
            parentRoster: readParentRoster(childEnv.parentRosterFile),
            selfId: childEnv.id ?? "",
            senderName: childEnv.name ?? "parent",
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
      promptSnippet: "List agent definitions for subagent.",
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
        message: Type.Optional(
          Type.String({
            description: "Message to send after the resume, for example follow-up instructions.",
          }),
        ),
        surface: Type.Optional(
          Type.Union(
            [
              Type.Literal("right"),
              Type.Literal("down"),
              Type.Literal("tab"),
              Type.Literal("pane"),
            ],
            {
              description: 'Same values as subagent surface: "right" (default), "down", "tab".',
            },
          ),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Exit after the response. Default: the launch record value, or true without a record. Set false for an interactive session.",
          }),
        ),
      }),

      renderCall(_args, theme) {
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold("Resume")) +
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
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        // The supervisor owns the resume launch and its watcher. It reads the
        // launch record first, because a Claude Code record resumes without a
        // pi-style session file; without a record, a missing session file is
        // still an error result.
        return currentSupervisor().resume(params, ctx, {
          placement: resolveSurfacePlacement(params.surface),
        });
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
        ctx.ui.notify(
          `Subagent surface: ${getSurfaceDefault()} (accepted: right, down, tab)`,
          "warning",
        );
      }
    },
  });

  // /stream command — attach or detach stream follower panes
  pi.registerCommand("stream", {
    description: "Attach thinking/tools follower panes: /stream [thinking|tools|both|close]",
    handler: async (args, ctx) => {
      await handleStreamCommand(args, {
        notify: (text, level) => ctx.ui.notify(text, level),
        paneId: process.env.LUVUS_PANE_ID,
        sessionId: ctx?.sessionManager?.getSessionId?.(),
      });
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
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
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
            contentLines.push(theme.fg("dim", `Resume:  luvus_resume ${details.sessionFile}`));
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

  // ── luvus_handoff message renderer ──
  pi.registerMessageRenderer("luvus_handoff", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "→");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— handed off")}`;

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
