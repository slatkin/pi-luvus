/**
 * Pi → Luvus live-status bridge.
 *
 * Luvus detects pi panes via the process tree but has no screen rules for
 * pi's TUI, so every pi pane reads `idle` (`no_positive_state_evidence`)
 * even mid-turn. This module publishes a leased status instead, the same
 * `agent report` API the Claude hook uses: `working` while a turn runs,
 * `idle` while the session waits for input, released on shutdown so a
 * clean exit never leaves a stale lease behind. Reports carry a short TTL
 * as a backstop for unclean kills, and repeat statuses are skipped so
 * high-frequency events cost nothing.
 *
 * Sub-agents also publish a terminal `done` / `blocked` report at their
 * exit points (see luvus-done.ts). A terminal report latches: later
 * `working`/`idle` reports and the shutdown release are skipped, so the
 * terminal value stays observable until the lease TTL expires or the pane
 * closes (luvus 0.14.3 keeps it for the full TTL after pi exits).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execLuvusCli, execLuvusCliAsync } from "./luvus.ts";

/** Lease source id for `agent report` / `agent release`. */
export const LUVUS_STATUS_SOURCE = "pi-luvus-status";
/** Lease TTL in seconds — re-reported on every transition, so a short
 *  backstop is safe even for long turns (worst case after kill -9). */
export const LUVUS_STATUS_TTL_S = 300;

/** Module-level, so it dies with the extension runtime on /reload — a
 *  globalThis flag would survive the runtime replacement and leave the
 *  reloaded extension with no listeners at all.
 *
 *  Ownership: a subagent child loads two extension entries (the installed
 *  index.ts and the launch-spec -e luvus-done.ts), and pi evaluates this
 *  module once per entry, so module-level state is NOT shared between them.
 *  index.ts therefore skips reporter registration in a child (isSubagentChild);
 *  luvus-done.ts owns the pane status there, and this latch is authoritative
 *  for it. A plain pane has the single index.ts reporter and never publishes a
 *  terminal status. */
let registeredInRuntime = false;

/** Module-level for the same reason as `registeredInRuntime`. In a subagent
 *  child the index.ts reporter never registers (isSubagentChild), so the
 *  registered reporter and the terminal publisher are the same instance and
 *  see the same latch. */
let terminalPublished = false;

/** Test hook: reset the per-runtime registration guard and terminal latch. */
export function __resetRegistrationForTests__(): void {
  registeredInRuntime = false;
  terminalPublished = false;
}

export type LuvusAgentStatus = "working" | "idle" | "done" | "blocked";

/**
 * True for the terminal statuses `done` and `blocked`, and once one has been
 * published: later reports and the shutdown release are suppressed, and an
 * in-flight call is re-sent afterwards so the terminal value lands last.
 */
function isTerminal(status?: LuvusAgentStatus): boolean {
  return terminalPublished || status === "done" || status === "blocked";
}

export function buildReportArgs(
  pane: string,
  status: LuvusAgentStatus,
  message?: string,
): string[] {
  const args = [
    "agent",
    "report",
    pane,
    "--source",
    LUVUS_STATUS_SOURCE,
    "--kind",
    "pi",
    "--status",
    status,
  ];
  // `--message` is accepted but undocumented (`agent report --help` omits it),
  // verified on luvus 0.14.3. `blocked` carries the ping question; `working`
  // carries the running tool name.
  if ((status === "blocked" || status === "working") && message) args.push("--message", message);
  args.push("--ttl", String(LUVUS_STATUS_TTL_S));
  return args;
}

/** Dedupe key is status plus message, so a tool change re-reports `working`. */
function reportKey(status: LuvusAgentStatus, message?: string): string {
  return message ? `${status}\u0000${message}` : status;
}

export function buildReleaseArgs(pane: string): string[] {
  return ["agent", "release", pane, "--source", LUVUS_STATUS_SOURCE];
}

/** Bind the pane to pi's native session id so Mission Control usage and
 *  resume work. pi publishes its session file via PI_SESSION_FILE; the id is
 *  the uuid after the timestamp prefix in the basename. */
export function piSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.PI_SESSION_FILE;
  if (!file) return null;
  const base = file.split("/").pop() ?? "";
  const id =
    base
      .replace(/\.jsonl$/, "")
      .split("_")
      .pop() ?? "";
  return id || null;
}

export function buildSessionBindArgs(pane: string, sessionId: string): string[] {
  return ["pane", "report", pane, "--agent", "pi", "--session", sessionId];
}

/** The caller's pane when pi runs inside Luvus, else null (same env check
 *  as isMuxAvailable in luvus.ts, plus the pane id self-reports target). */
export function luvusStatusPane(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.LUVUS_ENV || !env.LUVUS_BIN_PATH || !env.LUVUS_PANE_ID) return null;
  return env.LUVUS_PANE_ID;
}

export interface LuvusStatusReporter {
  report(status: LuvusAgentStatus, message?: string): void;
  release(): void;
  register(pi: ExtensionAPI): void;
}

/** Renewal interval — half the TTL, so the lease never expires while pi runs. */
const LUVUS_STATUS_RENEWAL_MS = (LUVUS_STATUS_TTL_S / 2) * 1000;

export function createLuvusStatusReporter(
  exec: (bin: string, args: string[]) => void = execLuvusCli,
  env: NodeJS.ProcessEnv = process.env,
  execAsync: (bin: string, args: string[]) => Promise<void> = execLuvusCliAsync,
): LuvusStatusReporter {
  let lastReportedKey: string | null = null;
  /** Last non-terminal status and message — what a renewal re-sends. */
  let lastNonTerminal: { status: LuvusAgentStatus; message?: string } | null = null;
  /** The newest report waiting for the in-flight call to end. */
  let pendingAsync: { status: LuvusAgentStatus; message?: string } | null = null;
  /** A terminal status that a call already in flight could overwrite; re-sent once that call settles. */
  let terminalAfterAsync: { status: LuvusAgentStatus; message?: string } | null = null;
  /** True when a release was sent while a call was in flight; re-sent once it settles. */
  let releaseAfterAsync = false;
  let inFlight = false;
  let renewalTimer: NodeJS.Timeout | null = null;

  function stopRenewal(): void {
    if (renewalTimer === null) return;
    clearInterval(renewalTimer);
    renewalTimer = null;
  }

  function startRenewal(pane: string): void {
    if (renewalTimer !== null || !pane) return;
    renewalTimer = setInterval(() => {
      // Renewal skips the dedupe — the status has not changed, but the lease
      // must stay alive. A terminal report or a release stops the timer.
      if (isTerminal() || !lastNonTerminal) return;
      enqueueAsync(pane, lastNonTerminal.status, lastNonTerminal.message);
    }, LUVUS_STATUS_RENEWAL_MS);
    renewalTimer.unref?.();
  }

  function pumpAsync(pane: string): void {
    // One call in flight; the latest pending status replaces any older one.
    if (inFlight || isTerminal() || !pendingAsync) return;
    const next = pendingAsync;
    pendingAsync = null;
    inFlight = true;
    // A failed or timed-out call must neither throw nor wedge the queue; the
    // next report retries. `then(ok, err)` keeps the rejection handled.
    void execAsync(
      env.LUVUS_BIN_PATH as string,
      buildReportArgs(pane, next.status, next.message),
    ).then(
      () => finishAsync(pane),
      () => finishAsync(pane),
    );
  }

  function finishAsync(pane: string): void {
    inFlight = false;
    // A call that was already dispatched when a terminal report or a release
    // arrived can land after it and overwrite the final state. Re-publish the
    // terminal status (once, synchronously, so it lands last), or release the
    // lease again, before doing anything else.
    let resend: string[] | null = null;
    if (isTerminal() && terminalAfterAsync) {
      resend = buildReportArgs(pane, terminalAfterAsync.status, terminalAfterAsync.message);
      terminalAfterAsync = null;
      releaseAfterAsync = false;
    } else if (releaseAfterAsync) {
      resend = buildReleaseArgs(pane);
      releaseAfterAsync = false;
    }
    if (resend) {
      try {
        exec(env.LUVUS_BIN_PATH as string, resend);
      } catch {
        // Best effort — a stale or overwritten lease still expires with its TTL.
      }
      return;
    }
    pumpAsync(pane);
  }

  function enqueueAsync(pane: string, status: LuvusAgentStatus, message?: string): void {
    pendingAsync = { status, message };
    pumpAsync(pane);
  }

  function report(status: LuvusAgentStatus, message?: string): void {
    const pane = luvusStatusPane(env);
    if (!pane || isTerminal()) return;
    // Terminal statuses are final and stay synchronous: luvus-completion
    // requires the report to land before the sidecar write and shutdown.
    if (isTerminal(status)) {
      const key = reportKey(status, message);
      if (lastReportedKey === key) return;
      try {
        exec(env.LUVUS_BIN_PATH as string, buildReportArgs(pane, status, message));
        lastReportedKey = key;
        terminalPublished = true;
        lastNonTerminal = null;
        pendingAsync = null;
        stopRenewal();
        // An async call already in flight may land after this sync report and
        // overwrite it; finishAsync re-publishes the terminal status.
        if (inFlight) terminalAfterAsync = { status, message };
      } catch {
        // Best effort — a failed report retries on the next transition.
      }
      return;
    }
    // Non-terminal reports run async so they never delay a turn.
    const key = reportKey(status, message);
    if (lastReportedKey === key) return;
    lastReportedKey = key;
    lastNonTerminal = { status, message };
    startRenewal(pane);
    enqueueAsync(pane, status, message);
  }

  function release(): void {
    const pane = luvusStatusPane(env);
    stopRenewal();
    lastNonTerminal = null;
    pendingAsync = null;
    // A published terminal status outlives the process: leaving the lease lets
    // an external orchestrator observe `done` / `blocked` for the TTL.
    if (!pane || isTerminal() || lastReportedKey === null) return;
    // An async call already in flight may land after this release and
    // resurrect the lease; finishAsync releases it again.
    if (inFlight) releaseAfterAsync = true;
    try {
      exec(env.LUVUS_BIN_PATH as string, buildReleaseArgs(pane));
    } catch {
      // Releasing a missing/expired lease errors — the lease is gone either way.
    } finally {
      lastReportedKey = null;
    }
  }

  function bindSession(sessionId: string | null): void {
    const pane = luvusStatusPane(env);
    if (!pane || !sessionId) return;
    try {
      exec(env.LUVUS_BIN_PATH as string, buildSessionBindArgs(pane, sessionId));
    } catch {
      // Best effort — Mission Control usage stays unbound until next start.
    }
  }

  function register(pi: ExtensionAPI): void {
    if (registeredInRuntime) return;
    registeredInRuntime = true;
    pi.on("session_start", (_event, ctx) => {
      // pi injects PI_SESSION_FILE only into spawned children, not into its own
      // process env — read the live id from the session manager.
      const id =
        (
          ctx as { sessionManager?: { getSessionId?: () => string | null } } | undefined
        )?.sessionManager?.getSessionId?.() ?? piSessionId(env);
      bindSession(id || null);
      report("idle");
    });
    pi.on("agent_start", () => report("working"));
    pi.on("turn_start", () => report("working"));
    pi.on("tool_execution_start", (event) => {
      const toolName = (event as { toolName?: unknown } | undefined)?.toolName;
      report("working", typeof toolName === "string" ? toolName : undefined);
    });
    pi.on("tool_execution_end", () => report("working"));
    pi.on("agent_end", () => report("idle"));
    pi.on("session_shutdown", () => release());
  }

  return { report, release, register };
}
