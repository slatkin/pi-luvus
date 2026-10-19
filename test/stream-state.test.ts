import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StreamState,
  createStreamHub,
  defaultSocketDir,
  type StreamHub,
  type StreamName,
} from "../pi-extension/luvus/stream-state.ts";
import { registerStreamEventHandlers } from "../pi-extension/luvus/index.ts";

function lineReader(socket: Socket) {
  let buffer = "";
  const lines: string[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });

  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  return {
    lines,
    async next(): Promise<string> {
      for (let i = 0; i < 400; i += 1) {
        if (lines.length > 0) return lines.shift()!;
        await tick();
      }
      throw new Error("no record received");
    },
    async silent(): Promise<boolean> {
      for (let i = 0; i < 100; i += 1) {
        if (lines.length > 0) return false;
        await tick();
      }
      return true;
    },
  };
}

async function connectClient(path: string, stream?: StreamName) {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const reader = lineReader(socket);
  if (stream) socket.write(`${JSON.stringify({ hello: stream })}\n`);
  return { socket, reader };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-stream-"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met");
}

describe("StreamState", () => {
  test("caps replay by line count and keeps the most recent lines", () => {
    const state = new StreamState({ maxLines: 3, maxChars: 10_000 });
    for (let i = 0; i < 6; i += 1) state.appendThinking(`line ${i}`);

    const records = state.replay("thinking").map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.text),
      ["line 3", "line 4", "line 5"],
    );
  });

  test("caps replay by characters", () => {
    const state = new StreamState({ maxLines: 100, maxChars: 500 });
    for (let i = 0; i < 20; i += 1) state.appendThinking("x".repeat(100));

    const lines = state.replay("thinking");
    assert.ok(lines.length > 0);
    assert.ok(lines.length < 20);
    assert.ok(lines.reduce((total, line) => total + line.length, 0) <= 500);
  });

  test("turn reset clears both streams", () => {
    const state = new StreamState();
    state.appendThinking("thought");
    state.appendToolStart("t1", "bash");
    state.resetTurn();

    assert.deepEqual(state.replay("thinking"), []);
    assert.deepEqual(state.replay("tools"), []);
  });

  test("a failed tool end is a failed line", () => {
    const state = new StreamState();
    const record = JSON.parse(state.appendToolEnd("t1", "bash", true));

    assert.deepEqual(record, {
      stream: "tools",
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: true,
      text: "tool bash failed",
    });
  });
});

describe("StreamHub socket", () => {
  let dir: string;
  let socketDir: string;
  let hub: StreamHub;
  let sockets: Socket[];

  beforeEach(() => {
    dir = tempDir();
    socketDir = join(dir, "run");
    sockets = [];
    hub = createStreamHub({ socketDir, sessionId: "session-1" });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
    mock.timers.reset();
  });

  test("creates a private runtime directory and a short hashed path", async () => {
    const path = await hub.start();

    assert.match(path, /stream-[0-9a-f]{16}\.sock$/);
    assert.equal(statSync(socketDir).mode & 0o777, 0o700);
  });

  test("unlinks a stale path before listening", async () => {
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    writeFileSync(hub.socketPath, "stale");
    await hub.start();

    const { socket, reader } = await connectClient(hub.socketPath, "thinking");
    sockets.push(socket);
    assert.equal(statSync(hub.socketPath).isSocket(), true);
    await reader.silent();
  });

  test("replays the current turn on hello, then continues live", async () => {
    hub.recordThinking("before\n");
    hub.recordToolStart("t1", "bash");
    await hub.start();

    const { socket, reader } = await connectClient(hub.socketPath, "thinking");
    sockets.push(socket);
    assert.deepEqual(JSON.parse(await reader.next()), {
      stream: "thinking",
      type: "thinking",
      text: "before\n",
    });

    hub.recordThinking("after\n");
    assert.equal(JSON.parse(await reader.next()).text, "after\n");
  });

  test("fans out only to clients of the same stream", async () => {
    await hub.start();
    const thinking = await connectClient(hub.socketPath, "thinking");
    const tools = await connectClient(hub.socketPath, "tools");
    sockets.push(thinking.socket, tools.socket);
    await waitFor(() => hub.clientCount("thinking") === 1 && hub.clientCount("tools") === 1);

    hub.recordThinking("text\n");
    assert.equal(JSON.parse(await thinking.reader.next()).text, "text\n");
    assert.equal(await tools.reader.silent(), true);
  });

  test("detaches when a connection closes", async () => {
    await hub.start();
    const { socket } = await connectClient(hub.socketPath, "tools");
    await waitFor(() => hub.isAttached("tools"));

    socket.destroy();
    await waitFor(() => !hub.isAttached("tools"));
    assert.equal(hub.clientCount("tools"), 0);
  });

  test("uses XDG_RUNTIME_DIR and falls back to the temp directory", () => {
    assert.equal(defaultSocketDir({ XDG_RUNTIME_DIR: "/run/user/1" }), "/run/user/1/pi-luvus");
    assert.equal(defaultSocketDir({}), join(tmpdir(), "pi-luvus"));
  });
});

describe("StreamHub coalescing", () => {
  let dir: string;
  let hub: StreamHub;
  let sockets: Socket[];

  beforeEach(() => {
    dir = tempDir();
    sockets = [];
    mock.timers.enable({ apis: ["setTimeout"] });
    hub = createStreamHub({ socketDir: join(dir, "run"), sessionId: "coalesce", flushMs: 50 });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
    mock.timers.reset();
  });

  test("writes once per coalescing window", async () => {
    await hub.start();
    const { socket, reader } = await connectClient(hub.socketPath, "thinking");
    sockets.push(socket);
    await waitFor(() => hub.isAttached("thinking"));

    hub.recordThinking("a");
    hub.recordThinking("b");
    mock.timers.tick(49);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(reader.lines, []);

    mock.timers.tick(1);
    assert.equal(JSON.parse(await reader.next()).text, "ab");
    assert.deepEqual(reader.lines, []);
    mock.timers.tick(50);
    await reader.silent();
  });

  test("coalesces tool output in the same window", async () => {
    await hub.start();
    const { socket, reader } = await connectClient(hub.socketPath, "tools");
    sockets.push(socket);
    await waitFor(() => hub.isAttached("tools"));

    hub.recordToolUpdate("t1", "bash", "a");
    hub.recordToolUpdate("t1", "bash", "b");
    mock.timers.tick(50);
    assert.deepEqual(JSON.parse(await reader.next()), {
      stream: "tools",
      type: "tool_update",
      toolCallId: "t1",
      text: "ab",
    });
    assert.deepEqual(reader.lines, []);
  });

  test("writes immediately on a newline", async () => {
    await hub.start();
    const { socket, reader } = await connectClient(hub.socketPath, "thinking");
    sockets.push(socket);
    await waitFor(() => hub.isAttached("thinking"));

    hub.recordThinking("line\n");
    assert.equal(JSON.parse(await reader.next()).text, "line\n");
  });

  test("writes nothing without a client but still records the ring", async () => {
    await hub.start();
    const { socket, reader } = await connectClient(hub.socketPath);
    sockets.push(socket);

    hub.recordThinking("unseen");
    mock.timers.tick(50);
    assert.equal(await reader.silent(), true);
    assert.equal(JSON.parse(hub.replay("thinking")[0]).text, "unseen");
  });
});

describe("stream event wiring", () => {
  let dir: string;
  let hub: StreamHub;
  let sockets: Socket[];

  beforeEach(async () => {
    dir = tempDir();
    sockets = [];
    hub = createStreamHub({ socketDir: join(dir, "run"), sessionId: "events", flushMs: 5 });
    await hub.start();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps turn and tool events to the exact records", async () => {
    type Handler = (...args: any[]) => void;
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () => {};
      },
    };
    registerStreamEventHandlers(pi, () => hub);

    const thinking = await connectClient(hub.socketPath, "thinking");
    const tools = await connectClient(hub.socketPath, "tools");
    sockets.push(thinking.socket, tools.socket);
    await waitFor(() => hub.isAttached("thinking") && hub.isAttached("tools"));

    const fire = (event: string, data: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(data);
    };

    fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    fire("message_update", {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "think\n" },
    });
    fire("message_update", {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "not thinking" },
    });
    fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    fire("tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "out\n" }] },
    });
    fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: {},
      isError: false,
    });
    fire("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "edit",
    });
    fire("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "t2",
      toolName: "edit",
      result: {},
      isError: true,
    });

    assert.deepEqual(JSON.parse(await thinking.reader.next()), {
      stream: "thinking",
      type: "thinking",
      text: "think\n",
    });
    assert.deepEqual(JSON.parse(await tools.reader.next()), {
      stream: "tools",
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      text: "tool bash started",
    });
    assert.deepEqual(JSON.parse(await tools.reader.next()), {
      stream: "tools",
      type: "tool_update",
      toolCallId: "t1",
      text: "out\n",
    });
    assert.deepEqual(JSON.parse(await tools.reader.next()), {
      stream: "tools",
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      text: "tool bash ended",
    });
    assert.deepEqual(JSON.parse(await tools.reader.next()), {
      stream: "tools",
      type: "tool_start",
      toolCallId: "t2",
      toolName: "edit",
      text: "tool edit started",
    });
    assert.deepEqual(JSON.parse(await tools.reader.next()), {
      stream: "tools",
      type: "tool_end",
      toolCallId: "t2",
      toolName: "edit",
      isError: true,
      text: "tool edit failed",
    });
    assert.equal(await thinking.reader.silent(), true);
  });
});
