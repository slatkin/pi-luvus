/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `luvus_done` tool for autonomous agents to self-terminate
 * - Nudges any agent that forgets to call luvus_done after generating
 * - Publishes a terminal Luvus status (`done`, or `blocked` with the ping
 *   question / error text) before each sidecar write, so an external
 *   orchestrator can wait on the pane instead of scraping the screen
 * - Respects PI_DENY_TOOLS for its own tools: a denied tool is not registered,
 *   `caller_ping` included; `luvus_done` is never denied.
 *
 * Auto-exit: with PI_LUVUS_AUTO_EXIT=1, a normal `agent_end` (no user takeover,
 * not aborted) writes the `done` `.exit` sidecar and shuts the session down.
 * Otherwise the only success-path exits are the explicit `luvus_done` /
 * `caller_ping` tools, and an agent that finishes without calling either is
 * nudged. Provider-error turns write the error `.exit` sidecar so the parent
 * learns about failures promptly.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { createLuvusStatusReporter } from "./luvus-status.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

const ASSISTANT_ROLE = "assistant";
const NORMAL_STOP_REASON = "stop";

/** Return true only when the latest assistant message ended by the model stopping normally. */
export function shouldScheduleAgentEndNudge(
  messages: readonly { role?: string; stopReason?: string }[] | undefined,
): boolean {
  if (!messages) return false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === ASSISTANT_ROLE) {
      return message.stopReason === NORMAL_STOP_REASON;
    }
  }

  return false;
}

export function shouldAutoExitOnAgentEnd(messages: any[] | undefined): boolean {
  // If the latest agent turn completed normally, close the session. Escape/abort
  // still leaves it open for inspection or another prompt. User takeover is the
  // caller's concern.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_LUVUS_NAME ?? "";
  const subagentAgent = process.env.PI_LUVUS_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  // Parsed for the restored auto-exit path below (2026-10-02-restore-auto-exit):
  // an auto-exit agent whose turn ends normally exits itself.
  const autoExit = process.env.PI_LUVUS_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_LUVUS_ID,
    activityFile: process.env.PI_LUVUS_ACTIVITY_FILE,
  });

  // Live sidebar status for this pane. In a subagent child this is the ONLY
  // reporter: index.ts skips its own registration here (isSubagentChild), so
  // this instance's listeners and this module's terminal latch are the single
  // source of truth for the pane's status lease.
  const statusReporter = createLuvusStatusReporter();
  statusReporter.register(pi);

  // ── Agent completion nudge configuration ──
  /** Delay (ms) before sending a nudge after agent_end. Configurable via env var. */
  const NUDGE_DELAY_MS = Math.max(
    1000,
    parseInt(process.env.PI_LUVUS_NUDGE_DELAY_MS ?? "5000", 10) || 5000,
  );
  /** Set to "1" to disable the nudge entirely. */
  const NUDGE_DISABLED = process.env.PI_LUVUS_NUDGE_DISABLE === "1";
  const NUDGE_TEXT =
    "[Automated reminder] Your last turn ended but this session is still open.\n" +
    "If your task is complete, call the luvus_done tool now, with no other text. " +
    "Your last message was already delivered as your report — do not repeat or summarise it.\n" +
    "If you are blocked and need input from the caller, call caller_ping with your question.\n" +
    "Otherwise, continue working.";

  let doneCalled = false;
  let userInputAfterAgentEnd = false;
  let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cancel and forget the pending completion reminder, if any. */
  function clearNudgeTimer(): void {
    if (nudgeTimer !== null) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
  }

  /**
   * After a subagent stops normally, schedule a nudge reminding it to call
   * luvus_done if it hasn't already. Error and aborted runs are excluded.
   *
   * Each call replaces any pending nudge, so repeated agent_end events
   * automatically reset the timer. The nudge only fires if no new agent
   * activity or user input arrives within NUDGE_DELAY_MS.
   */
  function scheduleAgentEndNudge(pi: ExtensionAPI): void {
    clearNudgeTimer();
    if (NUDGE_DISABLED || doneCalled) return;

    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      if (doneCalled || userInputAfterAgentEnd) return;

      pi.sendUserMessage(NUDGE_TEXT, { deliverAs: "followUp" });
    }, NUDGE_DELAY_MS);
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "luvus-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    doneCalled = false;
    userInputAfterAgentEnd = false;
    userTookOver = false;
    clearNudgeTimer();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // User typed something — they are in control, cancel any pending nudge.
    userInputAfterAgentEnd = true;
    clearNudgeTimer();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover,
    // which keeps an auto-exit session open instead of exiting it.
    if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
    // Agent is about to generate — clear any pending nudge; the AI is active.
    clearNudgeTimer();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
    // Agent has started a new generation cycle — clear any pending nudge.
    userInputAfterAgentEnd = false;
    clearNudgeTimer();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;

    // Error turns still exit so the parent learns about the failure promptly
    // (auto-retry exhausted, provider overload, etc.) — deviation from
    // maplezzk's port, which leans on the stalled watchdog for errors.
    // Without this the parent would only see exit code 0 and a stale
    // assistant message, mistaking the crash for a successful completion.
    const errorInfo = findLatestAssistantError(messages);
    const sessionFile = process.env.PI_LUVUS_SESSION;
    if (errorInfo && sessionFile) {
      statusReporter.report("blocked", errorInfo.errorMessage);
      try {
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }),
        );
      } catch {
        // Best effort — even without the sidecar, watcher's session-file
        // fallback can still recover the errorMessage.
      }
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    // Only input arriving after this point counts as a takeover; input that
    // landed mid-run (e.g. luvus_message) must not silence the nudge.
    userInputAfterAgentEnd = false;

    // Restored auto-exit: an auto-exit agent whose turn ended normally exits
    // itself instead of waiting on the nudge. A taken-over session stays open
    // (falls through to the nudge path); aborted stops stay open; the error
    // branch above already handled provider failures.
    if (autoExit && !userTookOver && shouldAutoExitOnAgentEnd(messages)) {
      recorder.agentEndDone();
      statusReporter.report("done");
      if (sessionFile) {
        try {
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
        } catch {
          // Best effort — without the sidecar the watcher falls back to the
          // session file / screen sentinel.
        }
      }
      ctx.shutdown();
      return;
    }

    // A normal stop leaves the session open and nudges the agent to call
    // luvus_done if it forgot.
    if (shouldScheduleAgentEndNudge(messages)) {
      scheduleAgentEndNudge(pi);
    } else {
      clearNudgeTimer();
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    clearNudgeTimer();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Ask the parent for help, then END your session. The parent gets your message and can resume you with a reply. " +
      "Use it when you are blocked or need a decision. To keep working, use luvus_message.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_LUVUS_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_LUVUS_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      doneCalled = true;
      clearNudgeTimer();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_LUVUS_NAME ?? "subagent",
        message: params.message,
      };
      statusReporter.report("blocked", params.message);
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "luvus_done",
    label: "Subagent Done",
    description:
      "Call this when your task is complete. It ENDS your session. " +
      "Your last assistant message before this call is the summary that goes to the caller. " +
      "To send a message and keep working, use luvus_message.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_LUVUS_SESSION;
      recorder.subagentDone();
      doneCalled = true;
      clearNudgeTimer();
      statusReporter.report("done");
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
