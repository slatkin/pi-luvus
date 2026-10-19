import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamHub } from "../pi-extension/luvus/stream-state.ts";
import { streamTailScriptPath } from "../pi-extension/luvus/launch.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-stream-tail-"));
}

interface Tailer {
  stdout: string;
  stderr: string;
  code: number | null;
  done: Promise<void>;
}

function spawnTailer(socketPath: string, stream: string): Tailer {
  const tailer: Tailer = {
    stdout: "",
    stderr: "",
    code: null,
    done: undefined as unknown as Promise<void>,
  };
  const child = spawn(
    process.execPath,
    [streamTailScriptPath(), "--socket", socketPath, "--stream", stream],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  tailer.done = new Promise<void>((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      tailer.stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tailer.stderr += chunk;
    });
    child.on("close", (code) => {
      tailer.code = code;
      resolve();
    });
  });
  return tailer;
}

// A spawned child needs real time to boot before it connects, so polling uses
// wall-clock sleeps rather than setImmediate ticks.
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met");
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("stream-tail.mjs", () => {
  test("prints a header, copies records, and exits 0 when the socket closes", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const hub = createStreamHub({ socketDir: dir, socketName: "t.sock" });
    await hub.start();

    const tailer = spawnTailer(hub.socketPath, "thinking");
    await waitFor(() => hub.clientCount("thinking") === 1);
    hub.recordThinking("mid-turn thought");
    await waitFor(() => tailer.stdout.includes("mid-turn thought"));

    await hub.close();
    await tailer.done;
    assert.equal(tailer.code, 0);
    assert.match(tailer.stdout, /pi-luvus thinking stream/);
    assert.match(tailer.stdout, /"type":"thinking"/);
    assert.match(tailer.stdout, /"text":"mid-turn thought"/);
    assert.equal(tailer.stderr, "");
  });

  test("replays the ring and continues live", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const hub = createStreamHub({ socketDir: dir, socketName: "t.sock" });
    await hub.start();
    hub.recordToolStart("call-1", "read_file");
    await waitFor(() => hub.replay("tools").length > 0);

    const tailer = spawnTailer(hub.socketPath, "tools");
    await waitFor(() => tailer.stdout.includes("tool read_file started"));
    hub.recordToolEnd("call-1", "read_file", true);
    await waitFor(() => tailer.stdout.includes("tool read_file failed"));

    await hub.close();
    await tailer.done;
    assert.equal(tailer.code, 0);
    assert.match(tailer.stdout, /pi-luvus tools stream/);
    assert.match(tailer.stdout, /"type":"tool_start"/);
    assert.match(tailer.stdout, /"type":"tool_end"/);
  });

  test("exits non-zero when the connection fails", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const missing = join(dir, "absent.sock");

    const tailer = spawnTailer(missing, "thinking");
    await tailer.done;
    assert.notEqual(tailer.code, 0);
    assert.match(tailer.stderr, /cannot connect/);
  });
});
