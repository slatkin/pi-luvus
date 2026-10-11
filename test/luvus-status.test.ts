import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildReleaseArgs,
  buildReportArgs,
  buildSessionBindArgs,
  createLuvusStatusReporter,
  LUVUS_STATUS_SOURCE,
  LUVUS_STATUS_TTL_S,
  piSessionId,
  __resetRegistrationForTests__,
} from "../pi-extension/luvus/luvus-status.ts";
import { execLuvusCliAsync, __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";

const ENV = { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7", PI_SESSION_FILE: "/tmp/2026-10-02T15-25-11-301Z_abc.jsonl" };
const CTX = { sessionManager: { getSessionId: () => "sess-1" } };
/** Renewal fires at TTL / 2. */
const RENEWAL_MS = (LUVUS_STATUS_TTL_S / 2) * 1000;

/** Let the async report chain settle (microtasks after the stubbed call). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makePi() {
  const handlers = new Map<string, Array<(a?: unknown, b?: unknown) => void>>();
  return {
    handlers,
    pi: { on: (event: string, fn: (a?: unknown, b?: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    } },
    fire(event: string, ctx?: unknown, eventData?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(eventData, ctx);
    },
  };
}

/**
 * Sync and async Luvus exec stubs. Both record the args synchronously; the
 * async stub returns an immediately resolved promise, so the reporter's
 * in-flight bookkeeping advances on the next microtask.
 */
function makeExec() {
  const calls: string[][] = [];
  return {
    calls,
    exec: (_bin: string, args: string[]) => {
      calls.push(args);
    },
    execAsync: async (_bin: string, args: string[]) => {
      calls.push(args);
    },
  };
}

beforeEach(() => {
  __resetRegistrationForTests__();
});

describe("luvus-status reporter", () => {
  it("builds report args; --message rides on blocked and working statuses", () => {
    assert.deepEqual(buildReportArgs("7", "idle"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "idle",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "done"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "done",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "blocked", "need input"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "blocked",
      "--message",
      "need input",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "blocked"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "blocked",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "working", "bash"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "working",
      "--message",
      "bash",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "working"), [
      "agent",
      "report",
      "7",
      "--source",
      LUVUS_STATUS_SOURCE,
      "--kind",
      "pi",
      "--status",
      "working",
      "--ttl",
      String(LUVUS_STATUS_TTL_S),
    ]);
    assert.deepEqual(buildReportArgs("7", "done", "ignored"), buildReportArgs("7", "done"));
    assert.deepEqual(buildReportArgs("7", "idle", "ignored"), buildReportArgs("7", "idle"));
  });

  it("dedupes on status plus message, so a new tool message re-reports working", async () => {
    const { calls, exec, execAsync } = makeExec();
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("working", "bash");
    await flush();
    // Same status and message — deduped.
    reporter.report("working", "bash");
    await flush();
    // A different tool message is a new report.
    reporter.report("working", "read");
    await flush();
    // The tool ended: status is the same, message differs.
    reporter.report("working");
    await flush();
    reporter.release();
    assert.deepEqual(calls, [
      buildReportArgs("7", "working", "bash"),
      buildReportArgs("7", "working", "read"),
      buildReportArgs("7", "working"),
      buildReleaseArgs("7"),
    ]);
  });

  it("reports the tool name on tool_execution_start and clears it on tool_execution_end", async () => {
    const { calls, exec, execAsync } = makeExec();
    const target = makePi();
    createLuvusStatusReporter(exec, { ...ENV }, execAsync).register(target.pi as never);
    target.fire("session_start", CTX);
    await flush();
    target.fire("tool_execution_start", undefined, { toolName: "bash" });
    await flush();
    target.fire("tool_execution_end", undefined, { toolName: "bash" });
    await flush();
    assert.deepEqual(calls, [
      buildSessionBindArgs("7", "sess-1"),
      buildReportArgs("7", "idle"),
      buildReportArgs("7", "working", "bash"),
      buildReportArgs("7", "working"),
    ]);
  });

  it("publishes a blocked report with the ping question as the message", () => {
    const { calls, exec, execAsync } = makeExec();
    createLuvusStatusReporter(exec, { ...ENV }, execAsync).report("blocked", "which target?");
    assert.deepEqual(calls, [buildReportArgs("7", "blocked", "which target?")]);
  });

  it("latches after a terminal report and skips later working/idle reports", async () => {
    const { calls, exec, execAsync } = makeExec();
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("working");
    await flush();
    reporter.report("done");
    reporter.report("working");
    reporter.report("idle");
    await flush();
    assert.deepEqual(calls, [buildReportArgs("7", "working"), buildReportArgs("7", "done")]);
  });

  it("does not latch when the terminal report fails", async () => {
    const { calls, execAsync } = makeExec();
    let failures = 1;
    const exec = (_bin: string, args: string[]) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("luvus unreachable");
      }
      calls.push(args);
    };
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("blocked", "question");
    reporter.report("idle");
    await flush();
    assert.deepEqual(calls, [buildReportArgs("7", "idle")]);
  });

  it("releases the lease on release() when no terminal status was published", async () => {
    const { calls, exec, execAsync } = makeExec();
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("idle");
    await flush();
    reporter.release();
    assert.deepEqual(calls, [buildReportArgs("7", "idle"), buildReleaseArgs("7")]);
  });

  it("skips the shutdown release after a terminal report", async () => {
    const { calls, exec, execAsync } = makeExec();
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("working");
    await flush();
    reporter.report("done");
    reporter.release();
    assert.deepEqual(calls, [buildReportArgs("7", "working"), buildReportArgs("7", "done")]);
  });

  it("skips the registered shutdown release when another instance published terminal", async () => {
    const { calls, exec, execAsync } = makeExec();
    const target = makePi();
    createLuvusStatusReporter(exec, { ...ENV }, execAsync).register(target.pi as never);
    target.fire("session_start", CTX);
    await flush();
    target.fire("agent_start");
    await flush();
    // A manual -e luvus-done.ts load in a non-child pane builds a second
    // reporter instance (module-level state is not shared across extension
    // entries); its terminal report must still stop the registered instance's
    // session_shutdown release.
    createLuvusStatusReporter(exec, { ...ENV }, execAsync).report("blocked", "need input");
    target.fire("session_shutdown");
    assert.deepEqual(calls, [
      buildSessionBindArgs("7", "sess-1"),
      buildReportArgs("7", "idle"),
      buildReportArgs("7", "working"),
      buildReportArgs("7", "blocked", "need input"),
    ]);
  });

  it("reports idle → working → idle and releases on shutdown, skipping repeats", async () => {
    const { calls, exec, execAsync } = makeExec();
    const target = makePi();
    createLuvusStatusReporter(exec, { ...ENV }, execAsync).register(target.pi as never);
    target.fire("session_start", CTX);
    await flush();
    target.fire("turn_start");
    await flush();
    target.fire("turn_start");
    target.fire("agent_end");
    await flush();
    target.fire("session_shutdown");
    assert.deepEqual(calls, [
      buildSessionBindArgs("7", "sess-1"),
      buildReportArgs("7", "idle"),
      buildReportArgs("7", "working"),
      buildReportArgs("7", "idle"),
      buildReleaseArgs("7"),
    ]);
  });

  it("binds the pi session id from PI_SESSION_FILE", () => {
    assert.equal(
      piSessionId({ PI_SESSION_FILE: "/home/x/.pi/agent/sessions/--home--/2026-10-02T15-25-11-301Z_01a0fd38-2905-7368-b9f5-a30c7bd41580.jsonl" }),
      "01a0fd38-2905-7368-b9f5-a30c7bd41580",
    );
    assert.equal(piSessionId({}), null);
  });

  it("sends nothing outside a Luvus pane", () => {
    const { calls, exec, execAsync } = makeExec();
    const target = makePi();
    createLuvusStatusReporter(exec, {}, execAsync).register(target.pi as never);
    target.fire("session_start");
    target.fire("turn_start");
    target.fire("session_shutdown");
    assert.deepEqual(calls, []);
  });

  it("retries a failed report on the next transition and releases once", async () => {
    const { calls, exec } = makeExec();
    let failures = 1;
    const execAsync = async (_bin: string, args: string[]) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("luvus unreachable");
      }
      calls.push(args);
    };
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("working");
    await flush();
    reporter.report("idle");
    await flush();
    reporter.release();
    reporter.release();
    assert.deepEqual(calls, [buildReportArgs("7", "idle"), buildReleaseArgs("7")]);
  });

  it("registers listeners only once when both entries load", () => {
    const { exec } = makeExec();
    const target = makePi();
    createLuvusStatusReporter(exec, { ...ENV }).register(target.pi as never);
    createLuvusStatusReporter(exec, { ...ENV }).register(target.pi as never);
    assert.equal(target.handlers.get("turn_start")?.length, 1);
  });

  it("uses the pi-luvus-status source with a short TTL", () => {
    assert.equal(LUVUS_STATUS_SOURCE, "pi-luvus-status");
    assert.ok(LUVUS_STATUS_TTL_S <= 300);
  });

  it("keeps one async call in flight and sends only the latest status", async () => {
    const calls: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execAsync = async (_bin: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 1) await firstGate;
    };
    const reporter = createLuvusStatusReporter(() => {}, { ...ENV }, execAsync);
    reporter.report("working");
    // A call is in flight; both later statuses replace each other, so only the
    // latest survives.
    reporter.report("idle");
    reporter.report("working");
    releaseFirst();
    await flush();
    assert.deepEqual(calls, [buildReportArgs("7", "working"), buildReportArgs("7", "working")]);
  });

  it("re-publishes a terminal status that an in-flight call would overwrite", async () => {
    const calls: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const exec = (_bin: string, args: string[]) => {
      calls.push(args);
    };
    const execAsync = async (_bin: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 1) await firstGate;
    };
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("idle");
    // The sync terminal report lands while the idle call is still in flight,
    // so the idle could overwrite it; the terminal status is sent again.
    reporter.report("done");
    releaseFirst();
    await flush();
    assert.deepEqual(calls, [
      buildReportArgs("7", "idle"),
      buildReportArgs("7", "done"),
      buildReportArgs("7", "done"),
    ]);
  });

  it("releases again when an in-flight call would resurrect the lease", async () => {
    const calls: string[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const exec = (_bin: string, args: string[]) => {
      calls.push(args);
    };
    const execAsync = async (_bin: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 1) await firstGate;
    };
    const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
    reporter.report("idle");
    // The release lands while the idle call is still in flight, so the idle
    // could resurrect the lease; the release is sent again.
    reporter.release();
    releaseFirst();
    await flush();
    assert.deepEqual(calls, [
      buildReportArgs("7", "idle"),
      buildReleaseArgs("7"),
      buildReleaseArgs("7"),
    ]);
  });

  it("renews the last non-terminal status at TTL/2, bypassing dedupe", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { calls, exec, execAsync } = makeExec();
      const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
      reporter.report("idle");
      await flush();
      // A repeated idle is deduped immediately...
      reporter.report("idle");
      await flush();
      assert.deepEqual(calls, [buildReportArgs("7", "idle")]);
      // ...but the renewal re-sends it anyway.
      mock.timers.tick(RENEWAL_MS);
      await flush();
      assert.deepEqual(calls, [buildReportArgs("7", "idle"), buildReportArgs("7", "idle")]);
      reporter.release();
    } finally {
      mock.timers.reset();
    }
  });

  it("renews the last non-terminal message at TTL/2", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { calls, exec, execAsync } = makeExec();
      const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
      reporter.report("working", "bash");
      await flush();
      mock.timers.tick(RENEWAL_MS);
      await flush();
      assert.deepEqual(calls, [
        buildReportArgs("7", "working", "bash"),
        buildReportArgs("7", "working", "bash"),
      ]);
      reporter.release();
    } finally {
      mock.timers.reset();
    }
  });

  it("stops renewal after a terminal report", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { calls, exec, execAsync } = makeExec();
      const reporter = createLuvusStatusReporter(exec, { ...ENV }, execAsync);
      reporter.report("idle");
      await flush();
      reporter.report("done");
      mock.timers.tick(RENEWAL_MS * 2);
      await flush();
      assert.deepEqual(calls, [buildReportArgs("7", "idle"), buildReportArgs("7", "done")]);
      reporter.release();
    } finally {
      mock.timers.reset();
    }
  });

  it("stops renewal after session_shutdown", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      const { calls, exec, execAsync } = makeExec();
      const target = makePi();
      createLuvusStatusReporter(exec, { ...ENV }, execAsync).register(target.pi as never);
      target.fire("session_start", CTX);
      await flush();
      target.fire("session_shutdown");
      mock.timers.tick(RENEWAL_MS * 2);
      await flush();
      assert.deepEqual(calls, [
        buildSessionBindArgs("7", "sess-1"),
        buildReportArgs("7", "idle"),
        buildReleaseArgs("7"),
      ]);
    } finally {
      mock.timers.reset();
    }
  });

  it("never throws on a failed or timed-out async call", async () => {
    // A rejecting test seam stands in for a failed or timed-out call.
    __setLuvusExecForTests__(async () => {
      throw new Error("boom");
    });
    try {
      await assert.doesNotReject(execLuvusCliAsync("/bin/luvus", ["agent", "list"]));
    } finally {
      __setLuvusExecForTests__(null);
    }
    // A seam that throws synchronously must be swallowed too.
    __setLuvusExecForTests__(() => {
      throw new Error("boom");
    });
    try {
      await assert.doesNotReject(execLuvusCliAsync("/bin/luvus", ["agent", "list"]));
    } finally {
      __setLuvusExecForTests__(null);
    }
  });
});
