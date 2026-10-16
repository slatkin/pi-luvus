import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  alertText,
  appendHandoffLog,
  handoffLogPath,
  handoffNudgeText,
  matchLuvusSession,
  parseContextAlertConfig,
  shouldAlert,
  DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS,
} from "../pi-extension/luvus/context-alert.ts";
import { listLuvusSessionsAsync, __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";
import { loadStatusConfig, parseStatusConfig } from "../pi-extension/luvus/status.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const DEFAULT_THRESHOLD = { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS };

describe("context-alert config", () => {
  it("with no contextAlert block the alert is off with the default threshold", () => {
    assert.deepEqual(parseContextAlertConfig(undefined), {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
    assert.deepEqual(parseStatusConfig({}).contextAlert, {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
  });

  it("enabled with no threshold means 200000 tokens", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true }), {
      enabled: true,
      threshold: DEFAULT_THRESHOLD,
    });
  });

  it("parses an absolute token threshold", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: 150000 }), {
      enabled: true,
      threshold: { kind: "tokens", value: 150000 },
    });
  });

  it("parses percentage thresholds", () => {
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: "80%" }), {
      enabled: true,
      threshold: { kind: "percent", value: 80 },
    });
    assert.deepEqual(parseContextAlertConfig({ enabled: true, threshold: "80.5%" }), {
      enabled: true,
      threshold: { kind: "percent", value: 80.5 },
    });
  });

  it("rejects an unknown contextAlert key", () => {
    assert.throws(
      () => parseContextAlertConfig({ enabled: true, level: "error" }),
      /contextAlert has unsupported key\(s\): level/,
    );
  });

  it("rejects an invalid contextAlert block and enabled value", () => {
    assert.throws(() => parseContextAlertConfig("yes"), /contextAlert must be an object/);
    assert.throws(
      () => parseContextAlertConfig({ enabled: "yes" }),
      /contextAlert\.enabled must be a boolean/,
    );
  });

  it("rejects invalid thresholds with an error that names contextAlert.threshold", () => {
    for (const threshold of [0, -5, 1.5, "0%", "120%", "80", "abc%", true]) {
      assert.throws(
        () => parseContextAlertConfig({ enabled: true, threshold }),
        /contextAlert\.threshold/,
        `threshold ${JSON.stringify(threshold)} must be rejected`,
      );
    }
  });

  it("parseStatusConfig wires contextAlert through", () => {
    assert.deepEqual(
      parseStatusConfig({ contextAlert: { enabled: true, threshold: "80%" } }).contextAlert,
      { enabled: true, threshold: { kind: "percent", value: 80 } },
    );
  });

  it("loadStatusConfig loads the updated example config", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);
    assert.deepEqual(config.contextAlert, {
      enabled: false,
      threshold: DEFAULT_THRESHOLD,
    });
  });
});

describe("context-alert trigger", () => {
  const usage = (tokens: number | null, percent: number | null = null) => ({ tokens, percent });

  it("token threshold: below, at and above", () => {
    const threshold = { kind: "tokens" as const, value: 200_000 };
    assert.equal(shouldAlert(usage(199_999), threshold), false);
    assert.equal(shouldAlert(usage(200_000), threshold), true);
    assert.equal(shouldAlert(usage(201_000), threshold), true);
  });

  it("percent threshold: below, at and above", () => {
    const threshold = { kind: "percent" as const, value: 80 };
    assert.equal(shouldAlert(usage(null, 79.9), threshold), false);
    assert.equal(shouldAlert(usage(null, 80), threshold), true);
    assert.equal(shouldAlert(usage(null, 99.5), threshold), true);
  });

  it("undefined usage and null fields never alert", () => {
    const tokens = { kind: "tokens" as const, value: 1 };
    const percent = { kind: "percent" as const, value: 1 };
    assert.equal(shouldAlert(undefined, tokens), false);
    assert.equal(shouldAlert(undefined, percent), false);
    assert.equal(shouldAlert(usage(null, null), tokens), false);
    assert.equal(shouldAlert(usage(null, null), percent), false);
    // A token threshold ignores percent, and a percent threshold ignores tokens.
    assert.equal(shouldAlert(usage(null, 100), tokens), false);
    assert.equal(shouldAlert(usage(500_000, null), percent), false);
  });

  it("the alert text holds the token count, the threshold, and luvus_done with handoff", () => {
    const text = alertText(201_000, { kind: "tokens", value: 200_000 });
    assert.match(text, /201000/);
    assert.match(text, /200000/);
    assert.match(text, /luvus_done/);
    assert.match(text, /handoff/);

    const percentText = alertText(160_000, { kind: "percent", value: 80 });
    assert.match(percentText, /160000/);
    assert.match(percentText, /80%/);
    assert.match(percentText, /luvus_done/);
  });

  it("the handoff nudge names handoff and does not say already delivered", () => {
    const text = handoffNudgeText();
    assert.match(text, /luvus_done/);
    assert.match(text, /handoff/);
    assert.doesNotMatch(text, /already delivered/);
  });
});

describe("context-alert handoff log", () => {
  it("listLuvusSessionsAsync returns the parsed sessions object through the exec seam", async () => {
    const calls: string[][] = [];
    __setLuvusExecForTests__((args) => {
      calls.push(args);
      return JSON.stringify({
        result: { sessions: [{ name: "mbv", socket_path: "/tmp/mbv.sock" }] },
      });
    });
    try {
      assert.deepEqual(await listLuvusSessionsAsync(), {
        sessions: [{ name: "mbv", socket_path: "/tmp/mbv.sock" }],
      });
      assert.deepEqual(calls, [["session", "list", "--json"]]);
    } finally {
      __setLuvusExecForTests__(null);
    }
  });

  it("listLuvusSessionsAsync returns null on a failed call or outside Luvus", async () => {
    // A Luvus error envelope, and a thrown call, both resolve to null.
    __setLuvusExecForTests__(() => JSON.stringify({ error: { message: "no such session" } }));
    try {
      assert.equal(await listLuvusSessionsAsync(), null);
    } finally {
      __setLuvusExecForTests__(null);
    }
    __setLuvusExecForTests__(() => {
      throw new Error("boom");
    });
    try {
      assert.equal(await listLuvusSessionsAsync(), null);
    } finally {
      __setLuvusExecForTests__(null);
    }

    // With no seam and no LUVUS_BIN_PATH the real path fails cleanly too.
    const saved = process.env.LUVUS_BIN_PATH;
    delete process.env.LUVUS_BIN_PATH;
    try {
      assert.equal(await listLuvusSessionsAsync(), null);
    } finally {
      if (saved === undefined) delete process.env.LUVUS_BIN_PATH;
      else process.env.LUVUS_BIN_PATH = saved;
    }
  });

  it("matchLuvusSession returns the name whose socket_path matches", () => {
    const list = {
      sessions: [
        { name: "other", socket_path: "/a.sock" },
        { name: "mbv", socket_path: "/b.sock" },
      ],
    };
    assert.equal(matchLuvusSession(list, "/b.sock"), "mbv");
  });

  it("no match and no list both fall back to the socket path", () => {
    const cases: unknown[] = [
      { sessions: [{ name: "x", socket_path: "/a.sock" }] },
      { sessions: [] },
      {},
      null,
      undefined,
      "junk",
    ];
    for (const list of cases) {
      assert.equal(matchLuvusSession(list, "/b.sock"), "/b.sock", `list ${JSON.stringify(list)}`);
    }
  });

  it("no socket path gives null, even with a matching entry", () => {
    const list = { sessions: [{ name: "mbv", socket_path: "/b.sock" }] };
    assert.equal(matchLuvusSession(list, undefined), null);
    assert.equal(matchLuvusSession(list, ""), null);
  });

  it("appendHandoffLog appends one JSON line per row", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-handoff-log-"));
    const path = join(dir, "handoffs.jsonl");
    try {
      const row = {
        at: "2026-10-16T10:00:00.000Z",
        event: "alert" as const,
        luvusSession: "mbv",
        child: "worker",
        session: "/tmp/s.jsonl",
        tokens: 201000,
        threshold: 200000,
      };
      appendHandoffLog(row, path);
      appendHandoffLog(
        { ...row, event: "handoff" as const, tokens: null, threshold: undefined },
        path,
      );
      const lines = readFileSync(path, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), row);
      assert.deepEqual(JSON.parse(lines[1]), {
        at: "2026-10-16T10:00:00.000Z",
        event: "handoff",
        luvusSession: "mbv",
        child: "worker",
        session: "/tmp/s.jsonl",
        tokens: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appendHandoffLog does not throw when the write fails", () => {
    const row = {
      at: "2026-10-16T10:00:00.000Z",
      event: "alert" as const,
      luvusSession: null,
      child: "worker",
      session: "",
      tokens: null,
      threshold: 100,
    };
    // A path inside a directory that does not exist must not throw.
    assert.doesNotThrow(() =>
      appendHandoffLog(row, join(tmpdir(), "pi-handoff-log-missing-dir", "x", "handoffs.jsonl")),
    );
  });

  it("handoffLogPath sits next to the extension config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-handoff-path-"));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      assert.equal(handoffLogPath(), join(dir, "extensions", "pi-luvus", "handoffs.jsonl"));
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context-alert in the child (luvus-done)", () => {
  let freshImports = 0;

  interface ChildHarness {
    handlers: Record<string, Array<(event?: any, ctx?: any) => void>>;
    tools: Array<any>;
    sentMessages: Array<{ message: string; opts?: any }>;
    sessionFile: string;
    configPath: string;
    /** The freshly imported luvus-done module instance (for its test exports). */
    mod: any;
    restore: () => void;
  }

  /**
   * Load a FRESH copy of the child extension so its module-load config read
   * (D2) picks up the given config.json, under a temp PI_CODING_AGENT_DIR.
   * The fake pi's sendUserMessage does NOT fire the input handlers — the
   * late-steer case: the steer can arrive after the agent loop's read.
   */
  async function loadChildExtension(
    env: Record<string, string | undefined>,
    configJson: string,
    options: { sessionFile?: boolean } = {},
  ): Promise<ChildHarness> {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-alert-test-"));
    const sessionFile = join(dir, "child.jsonl");
    const fullEnv = {
      ...env,
      PI_CODING_AGENT_DIR: dir,
      PI_LUVUS_SESSION: options.sessionFile === false ? env.PI_LUVUS_SESSION : sessionFile,
    };
    const configPath = join(dir, "extensions", "pi-luvus", "config.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, configJson);

    const saved = new Map(Object.keys(fullEnv).map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(fullEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    const handlers: Record<string, Array<(event?: any, ctx?: any) => void>> = {};
    const tools: Array<any> = [];
    const sentMessages: Array<{ message: string; opts?: any }> = [];
    const mockPi: any = {
      on(name: string, handler: (event?: any, ctx?: any) => void) {
        (handlers[name] ??= []).push(handler);
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerShortcut() {},
      getAllTools() {
        return [];
      },
      setWidget() {},
      sendUserMessage(message: string, opts?: any) {
        sentMessages.push({ message, opts });
      },
    };

    let mod: any;
    try {
      mod = await import(
        `${pathToFileURL(join(REPO_ROOT, "pi-extension", "luvus", "luvus-done.ts")).href}?ctxalert=${++freshImports}`
      );
      (mod.default as (pi: unknown) => void)(mockPi);
    } catch (error) {
      restoreEnv(saved);
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }

    return {
      handlers,
      tools,
      sentMessages,
      sessionFile,
      configPath,
      mod,
      restore: () => {
        restoreEnv(saved);
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function restoreEnv(saved: Map<string, string | undefined>): void {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const fire = (
    handlers: Record<string, Array<(event?: any, ctx?: any) => void>>,
    name: string,
    event?: any,
    ctx?: any,
  ) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };

  const usageCtx = (tokens: number, percent = 10) => ({
    getContextUsage: () => ({ tokens, percent }),
  });

  const turnEnd = (stopReason = "stop") => ({
    turnIndex: 0,
    message: { role: "assistant", stopReason },
  });

  it("steers once over the threshold and not again on later turns", async () => {
    const { handlers, sentMessages, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
    );
    try {
      fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
      fire(handlers, "agent_start");

      // Below the threshold: no alert.
      fire(handlers, "turn_end", turnEnd(), usageCtx(50));
      assert.equal(sentMessages.length, 0);

      // At the threshold: one steer.
      fire(handlers, "turn_end", turnEnd(), usageCtx(100));
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0].opts, { deliverAs: "steer" });
      assert.match(sentMessages[0].message, /\b100\b/);
      assert.match(sentMessages[0].message, /luvus_done/);
      assert.match(sentMessages[0].message, /handoff/);

      // A later turn above the threshold: no second alert.
      fire(handlers, "turn_end", turnEnd(), usageCtx(500));
      assert.equal(sentMessages.length, 1);
    } finally {
      restore();
    }
  });

  it("unknown usage does nothing and a later turn can still fire", async () => {
    const { handlers, sentMessages, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
    );
    try {
      fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
      fire(handlers, "agent_start");
      fire(handlers, "turn_end", turnEnd(), { getContextUsage: () => undefined });
      fire(handlers, "turn_end", turnEnd(), {
        getContextUsage: () => ({ tokens: null, percent: null }),
      });
      assert.equal(sentMessages.length, 0);

      fire(handlers, "turn_end", turnEnd(), usageCtx(150));
      assert.equal(sentMessages.length, 1);
    } finally {
      restore();
    }
  });

  it("does not steer when the alert is off, the session env is missing, or the turn errored", async () => {
    const cases: Array<{
      name: string;
      withSession: boolean;
      config: string;
      stopReason?: string;
    }> = [
      {
        name: "alert off",
        withSession: true,
        config: JSON.stringify({ contextAlert: { enabled: false, threshold: 100 } }),
      },
      {
        name: "no PI_LUVUS_SESSION",
        withSession: false,
        config: JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
      },
      {
        name: "error turn",
        withSession: true,
        config: JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
        stopReason: "error",
      },
      {
        name: "aborted turn",
        withSession: true,
        config: JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
        stopReason: "aborted",
      },
    ];

    for (const testCase of cases) {
      const { handlers, sentMessages, restore } = await loadChildExtension(
        { PI_LUVUS_NUDGE_DISABLE: "1", PI_LUVUS_SESSION: testCase.withSession ? "set" : undefined },
        testCase.config,
        { sessionFile: testCase.withSession },
      );
      try {
        fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
        fire(handlers, "agent_start");
        fire(handlers, "turn_end", turnEnd(testCase.stopReason), usageCtx(500));
        assert.equal(sentMessages.length, 0, `case ${testCase.name} must not steer`);
      } finally {
        restore();
      }
    }
  });

  it("an invalid config still registers luvus_done and leaves the alert off", async () => {
    const { handlers, tools, sentMessages, configPath, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({ contextAlert: { enabled: true, threshold: "abc%" } }),
    );
    try {
      const doneTool = tools.find((tool) => tool.name === "luvus_done");
      assert.ok(doneTool, "expected luvus_done to be registered despite the bad config");

      // The bad block turned the alert off instead of stopping the load (D2).
      fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
      fire(handlers, "agent_start");
      fire(handlers, "turn_end", turnEnd(), usageCtx(500));
      assert.equal(sentMessages.length, 0);

      const { loadContextAlertConfig } = await import(
        `${pathToFileURL(join(REPO_ROOT, "pi-extension", "luvus", "luvus-done.ts")).href}?ctxalert-loader`
      );
      assert.deepEqual(loadContextAlertConfig(configPath), {
        enabled: false,
        threshold: { kind: "tokens", value: DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS },
      });
    } finally {
      restore();
    }
  });

  it("an auto-exit child after the alert writes no sidecar and gets the handoff nudge", async () => {
    const { handlers, sentMessages, sessionFile, restore } = await loadChildExtension(
      {
        PI_LUVUS_AUTO_EXIT: "1",
        PI_LUVUS_NUDGE_DELAY_MS: "1000",
      },
      JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
    );
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
      fire(handlers, "agent_start");

      // The alert fires; the takeover mark is set before the steer is sent.
      fire(handlers, "turn_end", turnEnd(), usageCtx(500));
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0].opts, { deliverAs: "steer" });

      // The auto-exit path must NOT fire: the alert counted as a takeover.
      let shutdownCalled = false;
      fire(
        handlers,
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        { shutdown: () => (shutdownCalled = true) },
      );
      assert.equal(shutdownCalled, false);
      assert.equal(existsSync(`${sessionFile}.exit`), false);

      // The completion nudge asks for luvus_done + handoff, not the generic text.
      mock.timers.tick(1000);
      assert.equal(sentMessages.length, 2);
      assert.equal(sentMessages[1].message, handoffNudgeText());
      assert.doesNotMatch(sentMessages[1].message, /already delivered/);
      assert.deepEqual(sentMessages[1].opts, { deliverAs: "followUp" });
    } finally {
      mock.timers.reset();
      restore();
    }
  });

  /** Run the registered `luvus_done` tool with a fake ctx, capturing shutdown. */
  async function callDone(
    tools: Array<any>,
    params: unknown,
  ): Promise<{ result: any; shutdown: boolean }> {
    const doneTool = tools.find((tool) => tool.name === "luvus_done");
    assert.ok(doneTool, "expected luvus_done to be registered");
    let shutdown = false;
    const result = await doneTool.execute("tool-id", params, undefined, undefined, {
      shutdown: () => {
        shutdown = true;
      },
    });
    return { result, shutdown };
  }

  it("luvus_done with handoff text writes the handoff sidecar and shuts down", async () => {
    const { tools, sessionFile, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({}),
    );
    try {
      const { shutdown } = await callDone(tools, { handoff: "Goal: X. Done: A. Left: B." });
      assert.equal(shutdown, true);
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        type: "handoff",
        message: "Goal: X. Done: A. Left: B.",
      });
    } finally {
      restore();
    }
  });

  it("luvus_done without handoff keeps the done sidecar", async () => {
    const { tools, sessionFile, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({}),
    );
    try {
      const { shutdown } = await callDone(tools, {});
      assert.equal(shutdown, true);
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
    } finally {
      restore();
    }
  });

  it("luvus_done with a whitespace-only handoff throws with no state change", async () => {
    const { tools, sessionFile, restore } = await loadChildExtension(
      { PI_LUVUS_NUDGE_DISABLE: "1" },
      JSON.stringify({}),
    );
    try {
      await assert.rejects(() => callDone(tools, { handoff: "   " }), /handoff/);
      // No sidecar, no shutdown: the session stays open and the model can retry.
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    } finally {
      restore();
    }
  });

  it("an alert followed by a handoff writes two log rows with the same session", async () => {
    const { handlers, tools, sentMessages, sessionFile, mod, restore } = await loadChildExtension(
      {
        PI_LUVUS_NUDGE_DISABLE: "1",
        PI_LUVUS_NAME: "LogChild",
        LUVUS_BIN_PATH: "in-process",
        LUVUS_SOCKET_PATH: "/tmp/mbv.sock",
      },
      JSON.stringify({ contextAlert: { enabled: true, threshold: 100 } }),
    );
    __setLuvusExecForTests__((args) => {
      assert.deepEqual(args, ["session", "list", "--json"]);
      return JSON.stringify({
        result: {
          sessions: [
            { name: "other", socket_path: "/tmp/other.sock" },
            { name: "mbv", socket_path: "/tmp/mbv.sock" },
          ],
        },
      });
    });
    try {
      fire(handlers, "session_start", undefined, { ui: { setWidget() {} } });
      fire(handlers, "agent_start");

      // The alert fires and starts its log row without waiting for it.
      fire(handlers, "turn_end", turnEnd(), usageCtx(500));
      assert.equal(sentMessages.length, 1);

      // The handoff exit starts its own row, also without waiting.
      const doneTool = tools.find((tool) => tool.name === "luvus_done");
      assert.ok(doneTool, "expected luvus_done to be registered");
      let shutdown = false;
      await doneTool.execute(
        "tool-id",
        { handoff: "Goal: X. Done: A. Left: B." },
        undefined,
        undefined,
        {
          shutdown: () => {
            shutdown = true;
          },
          getContextUsage: () => ({ tokens: 700, percent: 20 }),
        },
      );
      assert.equal(shutdown, true);

      // Wait for the fire-and-forget rows, then read the log (env is still set).
      await Promise.all(mod.__handoffLogWrites__);
      const lines = readFileSync(handoffLogPath(), "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      const alertRow = JSON.parse(lines[0]);
      const handoffRow = JSON.parse(lines[1]);

      assert.equal(alertRow.event, "alert");
      assert.equal(alertRow.child, "LogChild");
      assert.equal(alertRow.session, sessionFile);
      assert.equal(alertRow.tokens, 500);
      assert.equal(alertRow.threshold, 100);
      assert.match(alertRow.at, /^\d{4}-\d{2}-\d{2}T/);

      assert.equal(handoffRow.event, "handoff");
      assert.equal(handoffRow.child, "LogChild");
      assert.equal(handoffRow.session, sessionFile);
      assert.equal(handoffRow.tokens, 700);
      assert.equal(handoffRow.threshold, undefined);

      // Both rows resolved the same server session from the socket path.
      assert.equal(alertRow.luvusSession, "mbv");
      assert.equal(handoffRow.luvusSession, "mbv");
    } finally {
      __setLuvusExecForTests__(null);
      restore();
    }
  });
});
