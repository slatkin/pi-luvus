/**
 * Luvus backend for subagent panes — the only supported terminal host.
 *
 * Every CLI call executes the binary at `$LUVUS_BIN_PATH` directly (no shell,
 * no PATH lookup) and parses the JSON envelope: `.result` on success, `.error`
 * thrown as an Error otherwise. Availability is an env check: pi must run
 * inside a Luvus pane (`LUVUS_ENV`, `LUVUS_BIN_PATH`, `LUVUS_PANE_ID`).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { slugifyName } from "./slug.ts";
import type { UhpEventSource } from "./uhp-events.ts";

const execFileAsync = promisify(execFile);

/**
 * Hard deadline for every Luvus CLI call. A wedged daemon must fail the call
 * (naming it) rather than block a pane operation forever — the synchronous
 * path would otherwise freeze the parent pi event loop.
 */
export const LUVUS_CALL_TIMEOUT_MS = 5000;

/**
 * Test seam: replaces the `execFileSync`/`execFile` call behind every Luvus
 * command with an in-process function, so the suite needs no Luvus binary and
 * no shell. Returns the raw stdout; `null` restores the real process.
 */
export type LuvusExec = (args: string[]) => string | Promise<string>;

let execOverride: LuvusExec | null = null;

export function __setLuvusExecForTests__(fn: LuvusExec | null): void {
  execOverride = fn;
}

/**
 * Run a Luvus command for its effect only, honouring the test seam. Used by
 * `luvus-status.ts`, which needs its own bin path and quiet stdio rather than
 * the envelope-parsing `luvus()` below.
 */
export function execLuvusCli(bin: string, args: string[]): void {
  if (execOverride) {
    const output = execOverride(args);
    if (output instanceof Promise) void output.catch(() => {});
    return;
  }
  execFileSync(bin, args, { encoding: "utf8", timeout: LUVUS_CALL_TIMEOUT_MS, stdio: ["ignore", "ignore", "ignore"] });
}

/**
 * Async, fire-and-forget variant of `execLuvusCli` for callers that must not
 * block the event loop (live status reports). It shares the test seam and the
 * call timeout. The returned promise always resolves, so a failed or timed-out
 * call can never surface as an unhandled rejection.
 */
export async function execLuvusCliAsync(bin: string, args: string[]): Promise<void> {
  if (execOverride) {
    try {
      await execOverride(args);
    } catch {
      // Best effort — the caller has no way to act on a failed report.
    }
    return;
  }
  try {
    await execFileAsync(bin, args, { encoding: "utf8", timeout: LUVUS_CALL_TIMEOUT_MS });
  } catch {
    // Timed out or failed — nothing to do; the next report retries.
  }
}

/**
 * execFileSync and promisified execFile report a timeout differently (an
 * ETIMEDOUT code vs. a killed SIGTERM with a null code); both mean the call
 * hit `LUVUS_CALL_TIMEOUT_MS`.
 */
function isLuvusTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; killed?: unknown } | null;
  return e?.code === "ETIMEDOUT" || (e?.killed === true && e?.code === null);
}

function luvusTimeoutError(args: string[]): Error {
  return new Error(`Luvus command timed out after ${LUVUS_CALL_TIMEOUT_MS}ms: luvus ${args.join(" ")}`);
}

function luvusBinPath(): string {
  const bin = process.env.LUVUS_BIN_PATH;
  if (!bin) throw new Error("LUVUS_BIN_PATH is not set. Start pi inside a Luvus pane.");
  return bin;
}

/** Shape of `Luvus` CLI `.result` payloads this backend consumes. */
interface LuvusResult {
  /** `pane split` / `pane move` — the pane id */
  pane?: string | number;
  /** `pane read` — the visible screen text */
  text?: string;
  /** `agent list` — every agent across all workspaces/tabs */
  agents?: Array<{ pane?: unknown; tab?: unknown; focused?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

function parseEnvelope(stdout: string): LuvusResult {
  let parsed: { result?: unknown; error?: { message?: unknown } & Record<string, unknown> };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected Luvus output (not JSON): ${stdout.trim().slice(0, 200)}`);
  }
  if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
    const message = parsed.error.message;
    throw new Error(typeof message === "string" && message ? message : JSON.stringify(parsed.error));
  }
  return parsed?.result && typeof parsed.result === "object" ? (parsed.result as LuvusResult) : {};
}

/** Run a Luvus CLI command by exact path, no shell; resolve to `.result`. */
function luvus(args: string[]): LuvusResult {
  if (execOverride) {
    const output = execOverride(args);
    if (output instanceof Promise) {
      throw new Error("__setLuvusExecForTests__ returned a Promise on the synchronous Luvus path");
    }
    return parseEnvelope(output);
  }
  try {
    return parseEnvelope(execFileSync(luvusBinPath(), args, { encoding: "utf8", timeout: LUVUS_CALL_TIMEOUT_MS }));
  } catch (error) {
    if (isLuvusTimeout(error)) throw luvusTimeoutError(args);
    // Non-zero exit: the envelope (with `.error`) is on stdout, but
    // execFileSync only reports "Command failed" — re-parse to surface
    // Luvus's own message, which the error contracts require.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.includes('"error"')) {
      parseEnvelope(stdout); // throws with the Luvus message
    }
    throw error;
  }
}

async function luvusAsync(args: string[]): Promise<LuvusResult> {
  if (execOverride) return parseEnvelope(await execOverride(args));
  try {
    const { stdout } = await execFileAsync(luvusBinPath(), args, { encoding: "utf8", timeout: LUVUS_CALL_TIMEOUT_MS });
    return parseEnvelope(stdout);
  } catch (error) {
    if (isLuvusTimeout(error)) throw luvusTimeoutError(args);
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.includes('"error"')) {
      parseEnvelope(stdout); // throws with the Luvus message
    }
    throw error;
  }
}

export function isMuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.LUVUS_ENV && env.LUVUS_BIN_PATH && env.LUVUS_PANE_ID);
}

export function muxSetupHint(): string {
  return "Start pi inside a Luvus pane.";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

/**
 * Luvus pane names must match [a-z][a-z0-9_-]{0,31} (verified live), while
 * subagent names are free text.
 */
function paneName(name: string): string {
  return slugifyName(name, {
    keepUnderscore: true,
    collapse: false,
    maxLength: 32,
    ensureLeadingLetter: true,
  });
}

function paneReadText(result: LuvusResult): string {
  const { text } = result;
  if (typeof text !== "string") {
    throw new Error(`Unexpected pane read result: ${JSON.stringify(result)}`);
  }
  return text;
}

/**
 * Surface placement for a subagent: a split of the caller's pane to the right
 * (side by side) or down (stacked), or its own tab.
 */
export type SurfacePlacement = "right" | "down" | "tab";

export const DEFAULT_SURFACE_PLACEMENT: SurfacePlacement = "right";

/** Parse a placement value. The legacy "pane" (auto split) means the default split. */
export function parseSurfacePlacement(value: unknown): SurfacePlacement | undefined {
  if (value === "pane") return DEFAULT_SURFACE_PLACEMENT;
  return value === "right" || value === "down" || value === "tab" ? value : undefined;
}

/**
 * Find the tab hosting the caller's pane via `agent list` (entries carry
 * `pane` and `tab` fields). Returns null when the caller cannot be found —
 * callers must then keep pane placement, since a tab move cannot be undone
 * by a focus restore we cannot compute.
 */
function findCallerTab(caller: string): string | null {
  try {
    const { agents } = luvus(["agent", "list"]);
    const mine = agents?.find((agent) => String(agent?.pane) === caller);
    if (mine && mine.tab !== undefined && mine.tab !== null && mine.tab !== "") {
      return String(mine.tab);
    }
  } catch {
    // Discovery failed — fall back to pane placement.
  }
  return null;
}

/**
 * Create a new terminal surface for a subagent. Right/down placement splits
 * the caller's pane (`$LUVUS_PANE_ID`) without taking focus. Tab
 * placement moves the new pane to its own workspace tab, then makes a
 * best-effort attempt to return focus to the caller's tab.
 * Returns the new pane id — valid for pane run/read/close regardless of tab.
 */
export function createSurface(
  name: string,
  placement: SurfacePlacement = DEFAULT_SURFACE_PLACEMENT,
  caller = process.env.LUVUS_PANE_ID,
): string {
  if (!caller) {
    throw new Error("LUVUS_PANE_ID is not set. Start pi inside a Luvus pane.");
  }

  // Look up the caller's tab before the split: tab positions shift as other
  // sessions open and close tabs, so a stale lookup could restore the wrong
  // tab. An unknown caller tab downgrades the spawn to pane placement.
  const callerTab = placement === "tab" ? findCallerTab(caller) : null;

  const result = luvus(["pane", "split", caller, placement === "down" ? "--down" : "--right", "--no-focus"]);
  // Verified live (fixture in test/test.ts): the new pane id is `result.pane`.
  const { pane } = result;
  if (pane === undefined || pane === null || pane === "") {
    throw new Error(`Unexpected pane split result (no pane id): ${JSON.stringify(result)}`);
  }
  const surface = String(pane);

  try {
    luvus(["pane", "name", paneName(name), "--pane", surface]);
  } catch {
    // Optional — naming is cosmetic, the pane works unnamed.
  }

  if (callerTab !== null) {
    try {
      luvus(["pane", "move", surface, "--new-tab"]);
      // ponytail: a focus change the user makes during the move is overridden
      // by the restore. Revisit if that race matters in practice.
      luvus(["tab", "focus", callerTab]);
    } catch {
      // Move failed → the pane is still a correct split of the caller's pane.
      // Restore failed → focus stays on the subagent's tab, still functional.
    }
  }
  return surface;
}

/**
 * Split a pane without taking focus and return the new pane id. The caller
 * pane is passed in rather than read from the environment, because callers
 * may carry it in an injected environment.
 */
export function splitPane(caller: string): string {
  const result = luvus(["pane", "split", caller, "--no-focus"]);
  // Verified live (fixture in test/test.ts): the new pane id is `result.pane`.
  const { pane } = result;
  if (pane === undefined || pane === null || pane === "") {
    throw new Error(`Unexpected pane split result (no pane id): ${JSON.stringify(result)}`);
  }
  return String(pane);
}

/**
 * Name a pane. Callers treat a failure as a cosmetic warning: the pane works
 * unnamed.
 */
export function namePane(surface: string, name: string): void {
  luvus(["pane", "name", name, "--pane", surface]);
}

/**
 * Send one command line to a pane and execute it there.
 */
export function runInPane(surface: string, line: string): void {
  luvus(["pane", "run", surface, line]);
}

/**
 * Read the screen contents of a pane (sync). `pane read` takes no --lines
 * flag (it silently ignores unknown flags, verified live), so tail here.
 */
export function readScreen(surface: string, lines = 50): string {
  return tailLines(paneReadText(luvus(["pane", "read", surface])), lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return tailLines(paneReadText(await luvusAsync(["pane", "read", surface])), lines);
}

/**
 * Whether the pane currently has focus, via `agent list`. A pane that is not
 * listed (closed, unknown) is not focused.
 */
export async function isPaneFocusedAsync(pane: string): Promise<boolean> {
  const { agents } = await luvusAsync(["agent", "list"]);
  const mine = agents?.find((agent) => agent != null && String(agent.pane) === pane);
  return mine?.focused === true;
}

/** Push one notification into Luvus's notification surface. */
export async function pushNotificationAsync(
  text: string,
  level: "info" | "success" | "warning" | "error",
): Promise<void> {
  await luvusAsync(["ui", "notification", "push", "--text", text, "--level", level]);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  luvus(["agent", "keys", surface, "esc"]);
}

/** Shape of the `agent prompt` `.result` payload. */
export interface AgentPromptResult {
  submitted?: boolean;
  evidence?: string;
  pane?: string | number;
  status?: string;
  [key: string]: unknown;
}

/**
 * Deliver `text` to a pane as input and submit it: Luvus `agent prompt` with no
 * `--wait`. Resolves as soon as Luvus reports the text queued, without waiting
 * for the target to act. A blocked target (an approval screen, for example)
 * throws the Luvus `agent_not_ready` error, which callers report rather than
 * retry.
 */
export function agentPrompt(pane: string, text: string): AgentPromptResult {
  return luvus(["agent", "prompt", pane, text]) as AgentPromptResult;
}

/** Send `text` to a named agent pane, waking it (what the child footer asks for). */
export function agentSend(name: string, text: string): void {
  luvus(["agent", "send", name, text]);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  luvus(["pane", "close", surface]);
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by luvus_done / caller_ping /
 * the error path in luvus-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Read the `.exit` sidecar next to a session file. Returns the parsed JSON, or
 * null when the file is missing or is not valid JSON. Never deletes the file —
 * callers that consume a sidecar remove it themselves.
 */
export function readExitSidecar(sessionFile: string): any {
  try {
    return JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Decide whether a matched crash sentinel can belong to a still-running
 * child. `agentList` is the `luvus agent list` payload; a pane entry whose
 * authority is the live process tree, or whose status lease is not terminal,
 * means the pane's agent process is alive — the sentinel pattern on screen is
 * then echo noise (e.g. the child printing the pattern itself), not an exit.
 * A pane with no entry, or one holding only a terminal `done` / `blocked`
 * lease that survives the exited process, accepts the match.
 */
export function sentinelLooksLive(
  agentList: unknown,
  pane: string,
): boolean {
  const list = agentList as { agents?: Array<{ pane?: unknown; status?: unknown; authority?: unknown }> } | null;
  const mine = list?.agents?.find(
    (agent) => agent != null && String((agent as { pane?: unknown }).pane) === pane,
  );
  if (!mine) return false;
  if ((mine as { authority?: unknown }).authority === "process_tree") return true;
  const status = (mine as { status?: unknown }).status;
  const statusText = typeof status === "string" ? status.toLowerCase() : "";
  return statusText !== "done" && statusText !== "blocked";
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by luvus_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /** Return true to skip the per-tick screen read (used while the child's
     * activity snapshot is demonstrably fresh). The sidecar and sentinel-file
     * checks always run. */
    maySkipScreenScan?: () => boolean;
    /** The UHP event stream for this process, when one runs. While it runs,
     * the interval screen read is skipped and a trigger event for `surface`
     * runs an immediate sidecar, sentinel-file, and screen check. */
    eventStream?: UhpEventSource;
  },
): Promise<PollResult> {
  const start = Date.now();
  const eventStream = options.eventStream;

  // A trigger for this pane wakes the loop and asks for one screen read. An
  // event alone never ends the wait: the pass below still needs a result.
  let eventPending = false;
  let wake: (() => void) | null = null;
  const unsubscribe = eventStream?.onTrigger(surface, () => {
    eventPending = true;
    const w = wake;
    wake = null;
    w?.();
  });

  try {
    for (;;) {
      if (signal.aborted) {
        throw new Error("Aborted while waiting for subagent to finish");
      }

      const triggered = eventPending;
      eventPending = false;

      // Fast path: check for .exit sidecar file (written by luvus_done / caller_ping)
      if (options.sessionFile) {
        const data = readExitSidecar(options.sessionFile);
        if (data !== null) {
          rmSync(`${options.sessionFile}.exit`, { force: true });
          return interpretExitSidecar(data);
        }
      }

      // Check Claude sentinel file (written by plugin Stop hook)
      if (options.sentinelFile) {
        try {
          if (existsSync(options.sentinelFile)) {
            return { reason: "sentinel", exitCode: 0 };
          }
        } catch {}
      }

      // Slow path: read terminal screen for sentinel (crash detection). While
      // the event stream runs, only a trigger asks for a read; otherwise a
      // fresh child snapshot can suspend the per-interval read.
      const streamRunning = eventStream?.isRunning() ?? false;
      const shouldReadScreen = streamRunning ? triggered : !options.maySkipScreenScan?.();
      if (shouldReadScreen) {
        try {
          const screen = await readScreenAsync(surface, 5);
          const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
          // Anything else can print this pattern to the pane (the test suite of
          // this very extension asserts on it live); a match only means "the
          // wrapper printed it after its child exited" when no live agent
          // holds the pane any more.
          if (match && !sentinelHostsLiveAgent(surface, eventStream)) {
            return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
          }
        } catch {
          // Surface may have been destroyed — check if .exit file appeared in the meantime
          if (options.sessionFile) {
            const data = readExitSidecar(options.sessionFile);
            if (data !== null) {
              rmSync(`${options.sessionFile}.exit`, { force: true });
              return interpretExitSidecar(data);
            }
          }
        }
      }

      const elapsed = Math.floor((Date.now() - start) / 1000);
      options.onTick?.(elapsed);

      // An event that arrived during the pass re-checks at once.
      if (eventPending) continue;

      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("Aborted"));
        const onWake = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          wake = null;
          resolve();
        };
        function onAbort() {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (wake === onWake) wake = null;
          reject(new Error("Aborted"));
        }
        const timer = setTimeout(onWake, options.interval);
        signal.addEventListener("abort", onAbort, { once: true });
        wake = onWake;
      });
    }
  } finally {
    unsubscribe?.();
  }
}

/** Confirm a screen-sentinel match only when no live agent hosts the pane. */
function sentinelHostsLiveAgent(surface: string, eventStream?: UhpEventSource): boolean {
  // While the stream runs its `luvus agent list` snapshot is the pane state;
  // no per-match `agent list` call is made.
  if (eventStream?.isRunning()) {
    return sentinelLooksLive(eventStream.agentListSnapshot(), surface);
  }
  try {
    return sentinelLooksLive(luvus(["agent", "list"]), surface);
  } catch {
    // Discovery is unavailable — keep the historical behavior instead of
    // suppressing a genuine exit signal while the daemon recovers.
    return false;
  }
}
