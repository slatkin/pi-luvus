/**
 * Stream state and transport for `/stream` follower panes.
 *
 * Each stream (`thinking` or `tools`) keeps a bounded, in-memory replay ring
 * for the current turn. A unix socket in a private runtime directory carries
 * newline-delimited JSON records to panes. A pane attaches by sending one
 * hello record that names its stream; the server replays the ring, then sends
 * live records only for that stream. Closing the connection detaches.
 *
 * Deltas are coalesced: pending text is written at most once per
 * `flushMs` (default 50 ms) or immediately when it contains a newline. The
 * rings are kept up to date whether or not a client is attached, so a pane
 * opened mid-turn still receives the current turn's earlier content.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STREAM_NAMES = ["thinking", "tools"] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

/** Bounds for one stream's current-turn replay ring. */
export const REPLAY_MAX_LINES = 1000;
export const REPLAY_MAX_CHARS = 64 * 1024;

/** Coalescing window for streamed deltas and tool output. */
export const FLUSH_INTERVAL_MS = 50;

export interface ThinkingRecord {
  stream: "thinking";
  type: "thinking";
  text: string;
}

export interface ToolStartRecord {
  stream: "tools";
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  text: string;
}

export interface ToolUpdateRecord {
  stream: "tools";
  type: "tool_update";
  toolCallId: string;
  text: string;
}

export interface ToolEndRecord {
  stream: "tools";
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
}

export type StreamRecord = ThinkingRecord | ToolStartRecord | ToolUpdateRecord | ToolEndRecord;

export interface StreamStateOptions {
  maxLines?: number;
  maxChars?: number;
}

class ReplayRing {
  private entries: string[] = [];
  private chars = 0;
  private readonly maxLines: number;
  private readonly maxChars: number;

  constructor(maxLines: number, maxChars: number) {
    this.maxLines = maxLines;
    this.maxChars = maxChars;
  }

  push(line: string): void {
    this.entries.push(line);
    this.chars += line.length;
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.maxLines || this.chars > this.maxChars)
    ) {
      const removed = this.entries.shift()!;
      this.chars -= removed.length;
    }
  }

  clear(): void {
    this.entries = [];
    this.chars = 0;
  }

  lines(): string[] {
    return [...this.entries];
  }
}

/** One turn's formatted records, per stream, bounded by lines and characters. */
export class StreamState {
  private readonly rings: Record<StreamName, ReplayRing>;
  private readonly maxChars: number;

  constructor(options: StreamStateOptions = {}) {
    const maxLines = options.maxLines ?? REPLAY_MAX_LINES;
    this.maxChars = options.maxChars ?? REPLAY_MAX_CHARS;
    this.rings = {
      thinking: new ReplayRing(maxLines, this.maxChars),
      tools: new ReplayRing(maxLines, this.maxChars),
    };
  }

  resetTurn(): void {
    for (const stream of STREAM_NAMES) this.rings[stream].clear();
  }

  replay(stream: StreamName): string[] {
    return this.rings[stream].lines();
  }

  appendThinking(text: string): string {
    return this.append({ stream: "thinking", type: "thinking", text: this.capText(text) });
  }

  appendToolStart(toolCallId: string, toolName: string): string {
    return this.append({
      stream: "tools",
      type: "tool_start",
      toolCallId,
      toolName,
      text: `tool ${toolName} started`,
    });
  }

  appendToolUpdate(toolCallId: string, text: string): string {
    return this.append({
      stream: "tools",
      type: "tool_update",
      toolCallId,
      text: this.capText(text),
    });
  }

  appendToolEnd(toolCallId: string, toolName: string, isError: boolean): string {
    return this.append({
      stream: "tools",
      type: "tool_end",
      toolCallId,
      toolName,
      isError,
      text: isError ? `tool ${toolName} failed` : `tool ${toolName} ended`,
    });
  }

  private append(record: StreamRecord): string {
    const line = JSON.stringify(record);
    this.rings[record.stream].push(line);
    return line;
  }

  private capText(text: string): string {
    return text.length > this.maxChars ? text.slice(-this.maxChars) : text;
  }
}

export interface StreamHubOptions extends StreamStateOptions {
  /** Private directory for the socket. Defaults to the runtime directory. */
  socketDir?: string;
  /** Seed for the short hashed socket filename. */
  sessionId?: string;
  /** Explicit filename, used by tests. */
  socketName?: string;
  flushMs?: number;
  /** Called when a stream's client count changes. */
  onClientsChanged?: (stream: StreamName, count: number) => void;
}

export interface StreamHub {
  readonly socketPath: string;
  /** Start listening. Idempotent; returns the socket path. */
  start(): Promise<string>;
  resetTurn(): void;
  recordThinking(delta: string): void;
  recordToolStart(toolCallId: string, toolName: string): void;
  recordToolUpdate(toolCallId: string, toolName: string, text: string): void;
  recordToolEnd(toolCallId: string, toolName: string, isError: boolean): void;
  isAttached(stream: StreamName): boolean;
  clientCount(stream: StreamName): number;
  /** Current-turn replay lines for a stream. */
  replay(stream: StreamName): string[];
  close(): Promise<void>;
}

interface Client {
  socket: Socket;
  stream: StreamName;
}

interface PendingTool {
  toolCallId: string;
  text: string;
}

export function isStreamName(value: unknown): value is StreamName {
  return value === "thinking" || value === "tools";
}

/** The private runtime directory used when no explicit one is supplied. */
export function defaultSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || tmpdir();
  return join(base, "pi-luvus");
}

function hashedSocketName(sessionId: string | undefined): string {
  const seed = sessionId || `${process.pid}`;
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return `stream-${hash}.sock`;
}

/** Text from a tool's partial result, for the tools stream. */
export function toolOutputText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

export function createStreamHub(options: StreamHubOptions = {}): StreamHub {
  const dir = options.socketDir ?? defaultSocketDir();
  const name = options.socketName ?? hashedSocketName(options.sessionId);
  const socketPath = join(dir, name);
  const flushMs = options.flushMs ?? FLUSH_INTERVAL_MS;
  const state = new StreamState(options);
  const clients = new Set<Client>();

  let server: Server | undefined;
  let listening = false;
  let startPromise: Promise<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let thinkingPending = "";
  const toolPending: PendingTool[] = [];

  const emitChanged = (stream: StreamName) => {
    try {
      options.onClientsChanged?.(stream, countFor(stream));
    } catch {
      // A display callback must never break transport.
    }
  };

  const countFor = (stream: StreamName): number => {
    let count = 0;
    for (const client of clients) if (client.stream === stream) count += 1;
    return count;
  };

  const writeLines = (stream: StreamName, lines: string[]): void => {
    if (lines.length === 0) return;
    const payload = lines.map((line) => `${line}\n`).join("");
    for (const client of clients) {
      if (client.stream !== stream) continue;
      try {
        client.socket.write(payload);
      } catch {
        // The close handler removes a broken client.
      }
    }
  };

  const flushThinking = (): void => {
    if (!thinkingPending) return;
    const text = thinkingPending;
    thinkingPending = "";
    writeLines("thinking", [state.appendThinking(text)]);
  };

  const flushTools = (): void => {
    if (toolPending.length === 0) return;
    const pending = toolPending.splice(0, toolPending.length);
    const lines: string[] = [];
    let merged: PendingTool | undefined;
    for (const chunk of pending) {
      if (merged && merged.toolCallId === chunk.toolCallId) {
        merged.text += chunk.text;
      } else {
        if (merged) lines.push(state.appendToolUpdate(merged.toolCallId, merged.text));
        merged = { ...chunk };
      }
    }
    if (merged) lines.push(state.appendToolUpdate(merged.toolCallId, merged.text));
    writeLines("tools", lines);
  };

  const flushAll = (): void => {
    flushThinking();
    flushTools();
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flushAll();
    }, flushMs);
    const handle = timer as { unref?: () => void };
    handle.unref?.();
  };

  const clearTimer = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const handleConnection = (socket: Socket): void => {
    let client: Client | undefined;
    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (client || !line.trim()) continue;
        let hello: unknown;
        try {
          hello = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        const stream = (hello as { hello?: unknown } | null)?.hello;
        if (!isStreamName(stream)) {
          socket.destroy();
          return;
        }
        client = { socket, stream };
        // Include any pending delta in replay, but before this client joins
        // the fan-out set so it does not receive the record twice.
        if (stream === "thinking") flushThinking();
        else flushTools();
        clients.add(client);
        const replay = state.replay(stream);
        if (replay.length > 0) socket.write(replay.map((entry) => `${entry}\n`).join(""));
        emitChanged(stream);
      }
    });

    socket.on("close", () => {
      if (!client) return;
      clients.delete(client);
      emitChanged(client.stream);
      client = undefined;
    });

    socket.on("error", () => {
      socket.destroy();
    });
  };

  const listen = async (): Promise<string> => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(socketPath, { force: true });

    const nextServer = createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        nextServer.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        nextServer.removeListener("error", onError);
        resolve();
      };
      nextServer.once("error", onError);
      nextServer.once("listening", onListening);
      nextServer.listen(socketPath);
    });
    nextServer.on("error", () => {
      // Runtime socket errors surface through client handlers; keep the
      // server itself from raising an unhandled error.
    });
    server = nextServer;
    listening = true;
    return socketPath;
  };

  return {
    socketPath,

    async start(): Promise<string> {
      if (listening) return socketPath;
      startPromise ??= listen().catch((error) => {
        startPromise = undefined;
        rmSync(socketPath, { force: true });
        throw error;
      });
      return startPromise;
    },

    resetTurn(): void {
      clearTimer();
      thinkingPending = "";
      toolPending.length = 0;
      state.resetTurn();
    },

    recordThinking(delta: string): void {
      if (!delta) return;
      thinkingPending += delta;
      if (delta.includes("\n")) {
        flushThinking();
      } else {
        schedule();
      }
    },

    recordToolStart(toolCallId: string, toolName: string): void {
      flushTools();
      writeLines("tools", [state.appendToolStart(toolCallId, toolName)]);
    },

    recordToolUpdate(toolCallId: string, _toolName: string, text: string): void {
      if (!text) return;
      toolPending.push({ toolCallId, text });
      if (text.includes("\n")) {
        flushTools();
      } else {
        schedule();
      }
    },

    recordToolEnd(toolCallId: string, toolName: string, isError: boolean): void {
      flushTools();
      writeLines("tools", [state.appendToolEnd(toolCallId, toolName, isError)]);
    },

    isAttached(stream: StreamName): boolean {
      return countFor(stream) > 0;
    },

    clientCount(stream: StreamName): number {
      return countFor(stream);
    },

    replay(stream: StreamName): string[] {
      return state.replay(stream);
    },

    async close(): Promise<void> {
      clearTimer();
      for (const client of clients) client.socket.destroy();
      clients.clear();
      const current = server;
      server = undefined;
      listening = false;
      startPromise = undefined;
      if (current) {
        await new Promise<void>((resolve) => current.close(() => resolve()));
      }
      rmSync(socketPath, { force: true });
    },
  };
}
