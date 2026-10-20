/**
 * Unit tests for the projection wiring (unit 3b.1): the zero-height widget
 * hands the projection a fake `tui`, the `/stream` command installs the
 * projection on the first attach, keeps and refreshes the same view when the
 * attach state changes, and restores the chat container's original slot when
 * the last stream detaches. Hub client changes drive the same sync, and a
 * layout mismatch warns once through the session's UI.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { Container } from "@earendil-works/pi-tui";
import { StreamFilterView } from "../pi-extension/luvus/stream-projection.ts";
import { assistant, chatWith, regularLayout, type FakeTui } from "./stream-fakes.ts";
import { createStreamHarness } from "./stream-harness.ts";

describe("stream projection wiring", () => {
  /** The tui the widget factory receives; each test points it where it needs. */
  let currentTui: FakeTui | undefined;

  const harness = createStreamHarness({
    ctx: { sessionManager: { getSessionId: () => "projection-wiring-session" } },
    ui: {
      setWidget(_key: string, content: unknown) {
        if (typeof content === "function") {
          (content as (tui: unknown, theme: unknown) => unknown)(currentTui, undefined);
        }
      },
    },
  });
  const { notifications } = harness;
  const test_ = harness.test_;

  before(() => harness.start());
  after(() => harness.stop());
  beforeEach(() => harness.reset());
  afterEach(() => harness.reset());

  const run = (args: string) => harness.run(args);
  const startSession = () => harness.handler("session_start")!(undefined, harness.ctx);
  const slotChild = (document: Container) => document.children[2];

  async function waitForState(state: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (test_.streamAttachState() !== state) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for state ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function connectClient(stream: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(test_.streamSocketPath());
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ hello: stream })}\n`);
        resolve(socket);
      });
    });
  }

  it("installs the projection on the first attach", async () => {
    const chat = chatWith(
      assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" }),
    );
    const { tui, document } = regularLayout(chat);
    currentTui = tui;

    startSession();
    await run("thinking");

    const view = slotChild(document) as StreamFilterView;
    assert.notEqual(slotChild(document), chat);
    assert.ok(view instanceof StreamFilterView, "expected the projected view in the chat slot");
    assert.equal(view.source, chat);
    assert.equal(view.attachState, "thinking");
    assert.deepEqual(view.render(80), ["", "Answer"]);
    assert.ok(tui.renders > 0);
  });

  it("keeps and refreshes the same view when the attach state changes", async () => {
    const chat = chatWith(
      assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" }),
    );
    const { tui, document } = regularLayout(chat);
    currentTui = tui;

    startSession();
    await run("thinking");
    const view = slotChild(document) as StreamFilterView;

    await run("tools");
    assert.equal(slotChild(document), view, "expected the same view after the state change");
    assert.equal(view.attachState, "both");
    assert.deepEqual(view.render(80), ["", "Answer"]);
  });

  it("restores the original chat container after the last detach", async () => {
    const chat = chatWith(assistant({ type: "thinking", thinking: "secret" }));
    const { tui, document } = regularLayout(chat);
    currentTui = tui;

    startSession();
    await run("both");
    assert.notEqual(slotChild(document), chat);

    await run("close");
    assert.equal(slotChild(document), chat, "expected the identical chat object restored");
    assert.equal(test_.streamAttachState(), "none");
  });

  it("syncs on hub client changes without a recorded pane", async () => {
    const chat = chatWith(
      assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" }),
    );
    const { tui, document } = regularLayout(chat);
    currentTui = tui;

    startSession();
    await run("thinking");
    const view = slotChild(document) as StreamFilterView;

    // A hand-started tailer attaches through the hub alone.
    const socket = await connectClient("tools");
    try {
      await waitForState("both");
      assert.equal(view.attachState, "both");

      socket.destroy();
      await waitForState("thinking");
      assert.equal(slotChild(document), view, "expected the view kept while one stream remains");
    } finally {
      socket.destroy();
    }
  });

  it("warns once on a layout mismatch and leaves the transcript untouched", async () => {
    const chat = chatWith(new Container());
    const { tui, document } = regularLayout(chat);
    currentTui = tui;

    startSession();
    await run("thinking");
    const warnings = notifications.filter(
      (n) => n.level === "warning" && /transcript layout/i.test(n.text),
    );
    assert.equal(warnings.length, 1);
    assert.equal(slotChild(document), chat);
    assert.equal(test_.streamAttachState(), "thinking");

    // A fresh session with a recognised layout installs without warning again.
    await test_.resetStreamState();
    notifications.length = 0;
    const goodChat = chatWith(assistant({ type: "thinking", thinking: "secret" }));
    const good = regularLayout(goodChat);
    currentTui = good.tui;
    startSession();
    await run("thinking");
    assert.notEqual(slotChild(good.document), goodChat);
    assert.equal(notifications.filter((n) => /transcript layout/i.test(n.text)).length, 0);
  });
});
