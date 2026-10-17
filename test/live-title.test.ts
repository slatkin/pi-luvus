/**
 * Unit tests for the live first-prompt OSC title.
 *
 * The controller is driven directly (its `setFromPrompt` / `setFromSession`
 * seams) and through a mock `pi.on` for the wiring. The prompt-cut rule is
 * shared with `buildPaneTitle`, whose own tests live in `cli.test.ts`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildFirstPromptTitle,
  createLiveTitleController,
  cutPromptTitle,
  firstUserPromptText,
  __resetLiveTitleForTests__,
  type SessionEntryLike,
} from "../pi-extension/luvus/live-title.ts";

interface MockCtx {
  titles: string[];
  ctx: ExtensionContext;
}

function makeCtx(
  opts: { cwd?: string; name?: string; entries?: readonly SessionEntryLike[] } = {},
): MockCtx {
  const titles: string[] = [];
  const ctx = {
    cwd: opts.cwd ?? "/work/app",
    ui: { setTitle: (title: string) => titles.push(title) },
    sessionManager: {
      getSessionName: () => opts.name,
      getEntries: () => opts.entries ?? [],
    },
  } as unknown as ExtensionContext;
  return { titles, ctx };
}

function userEntry(content: unknown): SessionEntryLike {
  return { type: "message", message: { role: "user", content } };
}

function makePi() {
  const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => void>>();
  return {
    handlers,
    pi: {
      on: (event: string, fn: (event?: unknown, ctx?: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      },
    },
    fire(event: string, ctx?: unknown, eventData?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(eventData, ctx);
    },
  };
}

beforeEach(() => {
  __resetLiveTitleForTests__();
});

describe("cutPromptTitle", () => {
  it("takes the first non-empty line, strips controls, trims, and cuts to 48", () => {
    assert.equal(cutPromptTitle("Fix\x1b[2J the\x07 bug\nsecond line"), "Fix[2J the bug");
    assert.equal(cutPromptTitle("\n   \nFix the login redirect"), "Fix the login redirect");
    assert.equal(cutPromptTitle("x".repeat(60)), "x".repeat(48));
    assert.equal(cutPromptTitle("   padded   "), "padded");
    assert.equal(cutPromptTitle("\n   \n"), "");
    assert.equal(cutPromptTitle("\x1b\x07"), "");
  });
});

describe("buildFirstPromptTitle", () => {
  it("formats pi's own title shape with the cwd basename", () => {
    assert.equal(
      buildFirstPromptTitle("Fix the login redirect\nmore text", "/work/app"),
      "π - Fix the login redirect - app",
    );
    assert.equal(buildFirstPromptTitle("Go", "/work/app/"), "π - Go - app");
    assert.equal(buildFirstPromptTitle("Go", "/"), "π - Go");
  });

  it("returns nothing for a prompt with no printable text", () => {
    assert.equal(buildFirstPromptTitle("\n  \n", "/work/app"), "");
    assert.equal(buildFirstPromptTitle("\x1b\x07", "/work/app"), "");
  });
});

describe("firstUserPromptText", () => {
  it("reads string and text-part content and skips non-user entries", () => {
    assert.equal(firstUserPromptText([userEntry("plain prompt")]), "plain prompt");
    assert.equal(
      firstUserPromptText([userEntry([{ type: "text", text: "from parts" }])]),
      "from parts",
    );
    assert.equal(
      firstUserPromptText([
        { type: "model_change" },
        { type: "message", message: { role: "assistant", content: "hi" } },
        userEntry("second"),
      ]),
      "second",
    );
  });

  it("returns nothing when there is no user message", () => {
    assert.equal(firstUserPromptText([]), "");
    assert.equal(
      firstUserPromptText([{ type: "message", message: { role: "assistant", content: "hi" } }]),
      "",
    );
    assert.equal(firstUserPromptText([userEntry("   ")]), "");
  });
});

describe("live title controller", () => {
  it("sets the title from the first prompt of an unnamed non-subagent session", () => {
    const { titles, ctx } = makeCtx();
    createLiveTitleController({}).setFromPrompt(ctx, "Fix the login redirect\nmore");
    assert.deepEqual(titles, ["π - Fix the login redirect - app"]);
  });

  it("skips a subagent child (PI_LUVUS_SESSION set)", () => {
    const { titles, ctx } = makeCtx();
    createLiveTitleController({ PI_LUVUS_SESSION: "/tmp/s.jsonl" }).setFromPrompt(ctx, "Fix it");
    assert.deepEqual(titles, []);
  });

  it("sets the title when only PI_LUVUS_NAME is set", () => {
    const { titles, ctx } = makeCtx();
    createLiveTitleController({ PI_LUVUS_NAME: "scout" }).setFromPrompt(ctx, "Fix it");
    assert.deepEqual(titles, ["π - Fix it - app"]);
  });

  it("skips a session that has a name", () => {
    const { titles, ctx } = makeCtx({ name: "auth refactor" });
    createLiveTitleController({}).setFromPrompt(ctx, "Fix it");
    assert.deepEqual(titles, []);
  });

  it("sets the first-prompt title once and never overwrites it", () => {
    const { titles, ctx } = makeCtx();
    const controller = createLiveTitleController({});
    controller.setFromPrompt(ctx, "First prompt");
    controller.setFromPrompt(ctx, "Second prompt");
    assert.deepEqual(titles, ["π - First prompt - app"]);
  });

  it("reload: sets the title from the first user message in the session", () => {
    const { titles, ctx } = makeCtx({
      entries: [
        { type: "model_change" },
        userEntry("Map the auth flow"),
        { type: "message", message: { role: "assistant", content: "ok" } },
      ],
    });
    createLiveTitleController({}).setFromSession(ctx);
    assert.deepEqual(titles, ["π - Map the auth flow - app"]);
  });

  it("reload: a session with no user messages leaves the title alone", () => {
    const { titles, ctx } = makeCtx({ entries: [{ type: "model_change" }] });
    createLiveTitleController({}).setFromSession(ctx);
    assert.deepEqual(titles, []);
  });

  it("reload: a named session keeps pi's named title", () => {
    const { titles, ctx } = makeCtx({ name: "auth refactor", entries: [userEntry("Fix it")] });
    createLiveTitleController({}).setFromSession(ctx);
    assert.deepEqual(titles, []);
  });

  it("registers before_agent_start and session_start handlers", () => {
    const { titles, ctx } = makeCtx({ entries: [userEntry("Reloaded prompt")] });
    const target = makePi();
    createLiveTitleController({}).register(target.pi as never);
    target.fire("session_start", ctx, { type: "session_start", reason: "reload" });
    target.fire("before_agent_start", ctx, { messageType: "user", prompt: "New prompt" });
    assert.deepEqual(titles, ["π - Reloaded prompt - app"]);
  });

  it("ignores a custom steer run from pi.sendMessage with triggerTurn", () => {
    const { titles, ctx } = makeCtx();
    const target = makePi();
    createLiveTitleController({}).register(target.pi as never);
    target.fire("before_agent_start", ctx, {
      messageType: "custom",
      message: { customType: "luvus_result", content: "done", display: true },
    });
    assert.deepEqual(titles, []);
  });
});
