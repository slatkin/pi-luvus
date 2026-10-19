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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { Container, type Component } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/luvus/index.ts";
import { StreamFilterView } from "../pi-extension/luvus/stream-projection.ts";
import { __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";

/**
 * Fakes that mirror the runtime shape of pi's transcript components. Class
 * names match the real components so the projection's structural checks
 * classify them the same way.
 */
class Spacer {
  lines: number;
  constructor(lines = 1) {
    this.lines = lines;
  }
  render(): string[] {
    return Array.from({ length: this.lines }, () => "");
  }
  invalidate(): void {}
}

class Markdown {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(): string[] {
    return [this.text];
  }
  invalidate(): void {}
}

class MouseRegion {
  child: Component;
  constructor(child: Component) {
    this.child = child;
  }
  render(width: number): string[] {
    return this.child.render(width);
  }
  invalidate(): void {}
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
}

interface MessageLike {
  content: Block[];
  stopReason?: string;
}

/** Mirrors pi's AssistantMessageComponent content layout for the fakes. */
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  lastMessage: MessageLike | undefined;

  constructor(message?: MessageLike) {
    super();
    this.addChild(this.contentContainer);
    if (message) this.updateContent(message);
  }

  updateContent(message: MessageLike): void {
    this.lastMessage = message;
    this.contentContainer.clear();
    const content = message.content;
    const visible = (block: Block) =>
      (block.type === "text" && block.text?.trim()) ||
      (block.type === "thinking" && block.thinking?.trim());
    if (content.some(visible)) this.contentContainer.addChild(new Spacer(1));
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (block.type === "text" && visible(block)) {
        this.contentContainer.addChild(new Markdown(block.text!.trim()));
      } else if (block.type === "thinking") {
        const thoughts: string[] = [];
        for (; i < content.length; i += 1) {
          const run = content[i];
          if (run.type !== "thinking") break;
          if (run.thinking?.trim()) thoughts.push(run.thinking.trim());
        }
        i -= 1;
        if (thoughts.length === 0) continue;
        const followedByVisible = content.slice(i + 1).some(visible);
        this.contentContainer.addChild(new MouseRegion(new Markdown(thoughts.join("\n\n"))));
        if (followedByVisible) this.contentContainer.addChild(new Spacer(1));
      }
    }
  }
}

function assistant(...blocks: Block[]): AssistantMessageComponent {
  return new AssistantMessageComponent({ content: blocks });
}

function chatWith(...children: Component[]): Container {
  const chat = new Container();
  for (const child of children) chat.addChild(child);
  return chat;
}

interface FakeTui {
  layoutRoot?: Container;
  children?: Container[];
  renders: number;
  requestRender(): void;
}

/** Regular-mode layout: the document container is tui's first direct child. */
function regularLayout(chat: Container): { tui: FakeTui; document: Container } {
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const tui: FakeTui = {
    children: [document, new Container(), new Container(), new Container()],
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
  };
  return { tui, document };
}

interface Notification {
  text: string;
  level: string;
}

type Handler = (event: unknown, ctx: unknown) => void;

function createMockApi() {
  const commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> =
    [];
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerTool() {},
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.push({ name, ...command });
    },
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() {
      return [];
    },
  } as any;
  return { api, commands, handlers };
}

describe("stream projection wiring", () => {
  const savedEnv = new Map<string, string | undefined>();
  let runtimeDir: string;
  let calls: string[][];
  let nextPaneId: number;
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let sessionStart: Handler | undefined;

  const setEnv = (name: string, value: string | undefined) => {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const notifications: Notification[] = [];
  const test_ = (subagentsModule as any).__test__;

  /** The tui the widget factory receives; each test points it where it needs. */
  let currentTui: FakeTui | undefined;

  const ctx = {
    sessionManager: { getSessionId: () => "projection-wiring-session" },
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
      setWidget(_key: string, content: unknown) {
        if (typeof content === "function") {
          (content as (tui: unknown, theme: unknown) => unknown)(currentTui, undefined);
        }
      },
    },
  };

  before(async () => {
    const { api, commands, handlers } = createMockApi();
    (subagentsModule as any).default(api);
    command = commands.find((entry) => entry.name === "stream");
    sessionStart = handlers.get("session_start")?.at(-1);
    runtimeDir = mkdtempSync(join(tmpdir(), "pi-luvus-projection-test-"));
    setEnv("XDG_RUNTIME_DIR", runtimeDir);
  });

  after(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await test_.resetStreamState();
    notifications.length = 0;
    calls = [];
    nextPaneId = 101;
    __setLuvusExecForTests__((args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "split") {
        return JSON.stringify({ result: { pane: String(nextPaneId++) } });
      }
      return JSON.stringify({ result: {} });
    });
    setEnv("LUVUS_ENV", "1");
    setEnv("LUVUS_BIN_PATH", "/usr/bin/luvus");
    setEnv("LUVUS_PANE_ID", "7");
  });

  afterEach(async () => {
    __setLuvusExecForTests__(null);
    await test_.resetStreamState();
  });

  const run = (args: string) => command!.handler(args, ctx);
  const startSession = () => sessionStart!(undefined, ctx);
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

  it("does nothing without a captured tui", async () => {
    currentTui = undefined;
    startSession();
    await run("thinking");
    assert.deepEqual(test_.streamPaneEntries(), [["thinking", "101"]]);
    assert.equal(test_.streamAttachState(), "thinking");
    // No projection state existed to crash; nothing to assert beyond no-throw.
  });
});
