/**
 * Luvus UHP event stream.
 *
 * One long-lived `luvus uhp events` child per process that watches children.
 * The module parses its NDJSON stdout, classifies frames, and keeps a pane
 * snapshot from `luvus agent list`. It starts lazily on the first watched
 * child, restarts with a bounded delay after a failure, and kills the child on
 * shutdown.
 *
 * Transport only: completion decisions stay in `luvus.ts`.
 */
import { spawn } from "node:child_process";

/**
 * Event names that trigger a completion check for a watched pane. Every other
 * event (including the high-volume output events) is ignored.
 */
export const UHP_TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  "pane.agent_status_changed",
  "terminal.exited",
  "terminal.closed",
  "pane.closed",
]);

/** The frame that means the server dropped events; the code resyncs. */
export const UHP_RESYNC_EVENT = "events.resync_required";

/** Bounded restart delays in ms; the last value repeats. */
export const UHP_RESTART_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

/** One parsed event frame. */
export interface UhpEventFrame {
  event: string;
  sequence: number;
  data: Record<string, unknown>;
}

/** What a parsed frame asks the stream to do. */
export type UhpFrameKind = "trigger" | "resync" | "ignore";

/**
 * Parse one NDJSON line. Returns null for a malformed line or for a JSON object
 * that is not an event frame (for example the `subscription_started` envelope,
 * which carries no `event` field).
 */
export function parseUhpEventLine(line: string): UhpEventFrame | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const frame = value as { event?: unknown; sequence?: unknown; data?: unknown };
  if (typeof frame.event !== "string" || frame.event === "") return null;
  if (typeof frame.sequence !== "number" || !Number.isFinite(frame.sequence)) return null;
  if (typeof frame.data !== "object" || frame.data === null) return null;
  return {
    event: frame.event,
    sequence: frame.sequence,
    data: frame.data as Record<string, unknown>,
  };
}

/** Classify a parsed frame: a trigger, a resync request, or noise. */
export function classifyUhpFrame(frame: UhpEventFrame): UhpFrameKind {
  if (frame.event === UHP_RESYNC_EVENT) return "resync";
  return UHP_TRIGGER_EVENTS.has(frame.event) ? "trigger" : "ignore";
}

/**
 * The pane a frame refers to: `data.pane` for pane events, `data.pane_id` for
 * terminal events.
 */
export function framePane(frame: UhpEventFrame): string | undefined {
  const pane = frame.data.pane;
  if (typeof pane === "string" && pane !== "") return pane;
  const paneId = frame.data.pane_id;
  if (typeof paneId === "string" && paneId !== "") return paneId;
  return undefined;
}

/** Bounded restart delay for `attempt` consecutive stream failures. */
export function restartDelayMs(
  attempt: number,
  delays: readonly number[] = UHP_RESTART_DELAYS_MS,
): number {
  const list = delays.length > 0 ? delays : UHP_RESTART_DELAYS_MS;
  const index = Math.min(Math.max(attempt, 0), list.length - 1);
  return list[index];
}

/** The stdout and kill handle the module needs from a spawned `luvus` child. */
export interface UhpStreamChild {
  stdout: AsyncIterable<string | Buffer>;
  kill(): void;
}

/** Test seam: spawns a `luvus` child for an argv. */
export type UhpSpawn = (args: string[]) => UhpStreamChild;

let spawnOverride: UhpSpawn | null = null;

/**
 * Test seam: replaces the real `spawn` with an in-process function, so the
 * suite needs no Luvus binary. `null` restores the real process.
 */
export function __setUhpSpawnForTests__(fn: UhpSpawn | null): void {
  spawnOverride = fn;
}

function luvusBinPath(): string {
  const bin = process.env.LUVUS_BIN_PATH;
  if (!bin) throw new Error("LUVUS_BIN_PATH is not set. Start pi inside a Luvus pane.");
  return bin;
}

async function* emptyStdout(): AsyncGenerator<string> {
  // A failed spawn has no stdout; the caller sees an immediately ended stream.
}

function defaultSpawn(args: string[]): UhpStreamChild {
  const child = spawn(luvusBinPath(), args, { stdio: ["ignore", "pipe", "ignore"] });
  // A missing binary or a failed spawn emits `error`; the ended stdout makes
  // the caller restart. Swallow the event so it is not unhandled.
  child.on("error", () => {});
  return {
    stdout: child.stdout ?? emptyStdout(),
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}

function currentSpawn(): UhpSpawn {
  return spawnOverride ?? defaultSpawn;
}

/** The `luvus agent list` payload the stream keeps for sentinel checks. */
export interface AgentListSnapshot {
  agents?: Array<{ pane?: unknown; status?: unknown; authority?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Unwrap a `luvus` result envelope; a bad envelope or an error yields null. */
function parseAgentListEnvelope(stdout: string): AgentListSnapshot | null {
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; error?: unknown } | null;
    if (parsed === null || typeof parsed !== "object") return null;
    if ("error" in parsed && parsed.error) return null;
    return typeof parsed.result === "object" && parsed.result !== null
      ? (parsed.result as AgentListSnapshot)
      : null;
  } catch {
    return null;
  }
}

/** The event-stream surface `pollForExit` consumes. */
export interface UhpEventSource {
  /** True while the `luvus uhp events` child runs. */
  isRunning(): boolean;
  /** Subscribe to trigger events for one pane. Returns an unsubscribe. */
  onTrigger(pane: string, listener: (pane: string) => void): () => void;
  /** The last `luvus agent list` result, or null before the first snapshot. */
  agentListSnapshot(): AgentListSnapshot | null;
}

export interface UhpEventStreamOptions {
  /** Bounded restart delays in ms; the last value repeats. */
  restartDelaysMs?: readonly number[];
}

/**
 * The stream behind a set of watched panes. Add panes with `watch`; the child
 * starts on the first watcher and stops when the last one releases.
 */
export class UhpEventStream implements UhpEventSource {
  private readonly restartDelays: readonly number[];
  private readonly watchers = new Set<string>();
  private readonly listeners = new Map<string, Set<(pane: string) => void>>();
  private child: UhpStreamChild | null = null;
  private agentListChild: UhpStreamChild | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private agentListTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private agentListAttempt = 0;
  private stopped = false;
  private authoritative = false;
  private agents: AgentListSnapshot | null = null;
  private agentsRequest = 0;
  private lastSeq: number | null = null;

  constructor(options: UhpEventStreamOptions = {}) {
    this.restartDelays = options.restartDelaysMs ?? UHP_RESTART_DELAYS_MS;
  }

  /** Add a watched pane. Returns a release function. */
  watch(pane: string): () => void {
    if (this.stopped) return () => {};
    this.watchers.add(pane);
    if (!this.child) {
      this.cancelRestart();
      this.start();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.watchers.delete(pane);
      if (this.watchers.size === 0) this.stop();
    };
  }

  /**
   * Subscribe to trigger events for one pane. The listener fires only while
   * the pane is watched and the stream is authoritative. Returns an
   * unsubscribe function.
   */
  onTrigger(pane: string, listener: (pane: string) => void): () => void {
    const set = this.listeners.get(pane) ?? new Set<(pane: string) => void>();
    set.add(listener);
    this.listeners.set(pane, set);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(pane);
    };
  }

  /** True while the `luvus uhp events` child runs. */
  isRunning(): boolean {
    return this.child !== null;
  }

  /** The last `luvus agent list` result, or null before the first snapshot. */
  agentListSnapshot(): AgentListSnapshot | null {
    return this.agents;
  }

  /** Highest event sequence seen so far (diagnostics only). */
  lastEventSequence(): number | null {
    return this.lastSeq;
  }

  /** Kill the child and stop watching. Terminal for this instance. */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.watchers.clear();
    this.stop();
  }

  private start(): void {
    if (this.child || this.stopped || this.watchers.size === 0) return;
    let child: UhpStreamChild;
    try {
      child = currentSpawn()(["uhp", "events"]);
    } catch {
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.authoritative = false;
    void this.loadAgentList();
    void this.readStream(child);
  }

  private stop(): void {
    this.cancelRestart();
    this.cancelAgentListRetry();
    const child = this.child;
    this.child = null;
    const listChild = this.agentListChild;
    this.agentListChild = null;
    this.authoritative = false;
    this.restartAttempt = 0;
    this.agentListAttempt = 0;
    // Invalidate a snapshot that is still in flight.
    this.agentsRequest += 1;
    if (child) child.kill();
    if (listChild) listChild.kill();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.watchers.size === 0 || this.restartTimer) return;
    const delay = restartDelayMs(this.restartAttempt, this.restartDelays);
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private cancelAgentListRetry(): void {
    if (this.agentListTimer) {
      clearTimeout(this.agentListTimer);
      this.agentListTimer = null;
    }
  }

  /** Retry a failed `agent list` snapshot with the bounded restart delays. */
  private scheduleAgentListRetry(): void {
    if (this.stopped || this.watchers.size === 0 || this.agentListTimer) return;
    const delay = restartDelayMs(this.agentListAttempt, this.restartDelays);
    this.agentListAttempt += 1;
    this.agentListTimer = setTimeout(() => {
      this.agentListTimer = null;
      if (this.child === null) return;
      void this.loadAgentList();
    }, delay);
  }

  private async readStream(child: UhpStreamChild): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of child.stdout) {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          this.handleChildLine(child, buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim() !== "") this.handleChildLine(child, buffer);
    } catch {
      // A read error means the stream ended; restart below.
    }
    if (this.child === child) {
      this.child = null;
      this.authoritative = false;
      if (!this.stopped && this.watchers.size > 0) this.scheduleRestart();
    }
  }

  /** Handle a line only while `child` is still the current stream child. */
  private handleChildLine(child: UhpStreamChild, line: string): void {
    if (this.child !== child) return;
    this.handleLine(line);
  }

  private handleLine(line: string): void {
    const frame = parseUhpEventLine(line);
    if (!frame) return;
    if (this.lastSeq === null || frame.sequence > this.lastSeq) this.lastSeq = frame.sequence;
    const kind = classifyUhpFrame(frame);
    if (kind === "resync") {
      void this.loadAgentList();
      return;
    }
    // Events are not authoritative until the post-start snapshot is in.
    if (kind !== "trigger" || !this.authoritative) return;
    const pane = framePane(frame);
    if (!pane || !this.watchers.has(pane)) return;
    const listeners = this.listeners.get(pane);
    if (listeners) for (const listener of listeners) listener(pane);
  }

  /**
   * Run `luvus agent list` once and keep its result. A later call supersedes an
   * in-flight one, so only the newest snapshot becomes authoritative. A failed
   * snapshot stays non-authoritative and retries with a bounded delay.
   */
  private async loadAgentList(): Promise<void> {
    this.cancelAgentListRetry();
    const request = ++this.agentsRequest;
    this.authoritative = false;
    const result = await this.runAgentListCommand();
    if (request !== this.agentsRequest) return;
    if (result === null) {
      this.scheduleAgentListRetry();
      return;
    }
    this.agents = result;
    this.agentListAttempt = 0;
    this.authoritative = true;
  }

  private async runAgentListCommand(): Promise<AgentListSnapshot | null> {
    let child: UhpStreamChild | null = null;
    try {
      child = currentSpawn()(["agent", "list"]);
      this.agentListChild = child;
      let output = "";
      for await (const chunk of child.stdout) {
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      }
      return parseAgentListEnvelope(output);
    } catch {
      return null;
    } finally {
      if (this.agentListChild === child) this.agentListChild = null;
    }
  }
}
