import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createTurnNotifier,
  turnLabel,
  turnOutcome,
  type TurnNotifierDeps,
} from "../pi-extension/luvus/turn-notify.ts";
import {
  isPaneFocusedAsync,
  pushNotificationAsync,
  __setLuvusExecForTests__,
} from "../pi-extension/luvus/luvus.ts";

// A suite run inside a real pi/Luvus pane inherits live identity vars. Clear
// them so no test can reach real Luvus; each test sets what it needs.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_") || key.startsWith("PI_LUVUS_")) {
    delete process.env[key];
  }
}

const IN_LUVUS = { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" };
const CTX = { cwd: "/work/app", sessionManager: { getSessionName: () => undefined } };

/** Let the fire-and-forget notification chain settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makePi() {
  const handlers = new Map<string, Array<(a?: unknown, b?: unknown) => void>>();
  return {
    pi: {
      on: (event: string, fn: (a?: unknown, b?: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
    },
    fire(event: string, eventData: unknown, ctx: unknown = CTX) {
      for (const fn of handlers.get(event) ?? []) fn(eventData, ctx);
    },
  };
}

function makeDeps(overrides: Partial<TurnNotifierDeps> = {}) {
  const pushed: Array<{ text: string; level: string }> = [];
  const focusChecks: string[] = [];
  const deps: TurnNotifierDeps = {
    isPaneFocused: async (pane) => {
      focusChecks.push(pane);
      return false;
    },
    pushNotification: async (text, level) => {
      pushed.push({ text, level });
    },
    ...overrides,
  };
  return { deps, pushed, focusChecks };
}

function ending(stopReason: string) {
  return { messages: [{ role: "assistant", stopReason }], willRetry: false };
}

describe("turnOutcome", () => {
  const cases: Array<[string, ReturnType<typeof turnOutcome>]> = [
    ["stop", "ended"],
    ["toolUse", "ended"],
    ["length", "ended"],
    ["aborted", "none"],
    ["error", "failed"],
    ["timeout", "failed"],
  ];

  const table = cases.map(([stopReason, expected]) => ({ stopReason, expected }));

  for (const { stopReason, expected } of table) {
    it(`maps ${stopReason} to ${expected}`, () => {
      assert.equal(turnOutcome(ending(stopReason).messages), expected);
    });
  }

  it("uses the last assistant message and treats a missing one as ended", () => {
    const messages = [
      { role: "assistant", stopReason: "error" },
      { role: "user" },
      { role: "assistant", stopReason: "stop" },
    ];
    assert.equal(turnOutcome(messages), "ended");
    assert.equal(turnOutcome([]), "ended");
  });
});

describe("turnLabel", () => {
  it("uses the session name when present, else the cwd basename", () => {
    assert.equal(turnLabel("auth refactor", "/work/app"), "auth refactor");
    assert.equal(turnLabel(undefined, "/work/app"), "app");
    assert.equal(turnLabel("   ", "/work/app"), "app");
  });
});

describe("createTurnNotifier", () => {
  it("pushes success to an unfocused pane with the cwd basename label", async () => {
    const { deps, pushed, focusChecks } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(focusChecks, ["7"]);
    assert.deepEqual(pushed, [{ text: "pi turn ended: app", level: "success" }]);
  });

  it("uses the session name in the label", async () => {
    const { deps, pushed } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("stop"), {
      cwd: "/work/app",
      sessionManager: { getSessionName: () => "auth refactor" },
    });
    await flush();

    assert.deepEqual(pushed, [{ text: "pi turn ended: auth refactor", level: "success" }]);
  });

  it("pushes an error for a failed turn", async () => {
    const { deps, pushed } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("error"));
    await flush();

    assert.deepEqual(pushed, [{ text: "pi turn failed: app", level: "error" }]);
  });

  it("makes no call when the pane has focus", async () => {
    const { deps, pushed } = makeDeps({ isPaneFocused: async () => true });
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(pushed, []);
  });

  it("makes no call for an aborted turn", async () => {
    const { deps, pushed, focusChecks } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("aborted"));
    await flush();

    assert.deepEqual(focusChecks, []);
    assert.deepEqual(pushed, []);
  });

  it("makes no call in a subagent child", async () => {
    const { deps, pushed, focusChecks } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier({ ...IN_LUVUS, PI_LUVUS_NAME: "worker" }, true, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(focusChecks, []);
    assert.deepEqual(pushed, []);
  });

  it("makes no call outside Luvus", async () => {
    const { deps, pushed, focusChecks } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(
      { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus" },
      true,
      deps,
    ).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(focusChecks, []);
    assert.deepEqual(pushed, []);
  });

  it("makes no call when notifications are disabled", async () => {
    const { deps, pushed, focusChecks } = makeDeps();
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, false, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(focusChecks, []);
    assert.deepEqual(pushed, []);
  });

  it("pushes nothing and does not throw when the focus check fails", async () => {
    const { deps, pushed } = makeDeps({
      isPaneFocused: async () => {
        throw new Error("luvus down");
      },
    });
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();

    assert.deepEqual(pushed, []);
  });

  it("does not throw when the push fails", async () => {
    const { deps } = makeDeps({
      pushNotification: async () => {
        throw new Error("luvus down");
      },
    });
    const { pi, fire } = makePi();
    createTurnNotifier(IN_LUVUS, true, deps).register(pi as never);

    fire("agent_end", ending("stop"));
    await flush();
    assert.ok(true, "no unhandled rejection escaped the listener");
  });
});

describe("luvus turn-notify helpers", () => {
  const calls: string[][] = [];

  beforeEach(() => {
    calls.length = 0;
    __setLuvusExecForTests__(async (args) => {
      calls.push(args);
      if (args[0] === "agent") {
        return JSON.stringify({ result: { agents: [{ pane: "7", focused: true }] } });
      }
      return JSON.stringify({ result: {} });
    });
  });

  afterEach(() => {
    __setLuvusExecForTests__(null);
  });

  it("reads focus from agent list for the exact pane", async () => {
    assert.equal(await isPaneFocusedAsync("7"), true);
    assert.deepEqual(calls, [["agent", "list"]]);
  });

  it("treats an unlisted pane as unfocused", async () => {
    assert.equal(await isPaneFocusedAsync("9"), false);
  });

  it("pushes a notification with the exact args", async () => {
    await pushNotificationAsync("pi turn ended: app", "success");
    assert.deepEqual(calls, [
      ["ui", "notification", "push", "--text", "pi turn ended: app", "--level", "success"],
    ]);
  });
});
