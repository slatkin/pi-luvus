import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  alertText,
  handoffNudgeText,
  parseContextAlertConfig,
  shouldAlert,
  DEFAULT_CONTEXT_ALERT_THRESHOLD_TOKENS,
} from "../pi-extension/luvus/context-alert.ts";
import { loadStatusConfig, parseStatusConfig } from "../pi-extension/luvus/status.ts";
import subagentDoneExtension from "../pi-extension/luvus/luvus-done.ts";

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
    assert.throws(() => parseContextAlertConfig({ enabled: "yes" }), /contextAlert\.enabled must be a boolean/);
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

describe("context-alert in the child (luvus-done)", () => {
  let freshImports = 0;

  interface ChildHarness {
    handlers: Record<string, Array<(event?: any, ctx?: any) => void>>;
    tools: Array<any>;
    sentMessages: Array<{ message: string; opts?: any }>;
    sessionFile: string;
    configPath: string;
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

    try {
      const mod = await import(
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

  const usageCtx = (tokens: number, percent = 10) => ({ getContextUsage: () => ({ tokens, percent }) });

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
      fire(handlers, "turn_end", turnEnd(), { getContextUsage: () => ({ tokens: null, percent: null }) });
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
  async function callDone(tools: Array<any>, params: unknown): Promise<{ result: any; shutdown: boolean }> {
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
});
