import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  StreamFilterView,
  StreamProjection,
  findChatContainer,
  type AttachState,
} from "../pi-extension/luvus/stream-projection.ts";

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

class Text {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(): string[] {
    return [this.text];
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
  onMouse: ((event: unknown) => unknown) | undefined;
  constructor(child: Component, onMouse?: (event: unknown) => unknown) {
    this.child = child;
    this.onMouse = onMouse;
  }
  render(width: number): string[] {
    return this.child.render(width);
  }
  invalidate(): void {}
}

class ToolExecutionComponent {
  toolName: string;
  toolCallId: string;
  constructor(toolName: string, toolCallId: string) {
    this.toolName = toolName;
    this.toolCallId = toolCallId;
  }
  render(): string[] {
    return [`[tool ${this.toolName}]`];
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

/**
 * Mirrors how pi's AssistantMessageComponent lays out its content container:
 * a leading spacer when any text or thinking block is non-empty, one Markdown
 * per text block, one MouseRegion per collapsed thinking run followed by a
 * spacer when visible content follows, and a trailing spacer plus Text for a
 * truncated, aborted, or failed message without tool calls.
 */
class AssistantMessageComponent extends Container {
  contentContainer = new Container();
  lastMessage: MessageLike | undefined;
  hasToolCalls = false;

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
    this.hasToolCalls = content.some((block) => block.type === "toolCall");
    if (message.stopReason === "length") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text("truncated"));
    } else if (!this.hasToolCalls) {
      if (message.stopReason === "aborted") {
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text("aborted"));
      } else if (message.stopReason === "error") {
        this.contentContainer.addChild(new Spacer(1));
        this.contentContainer.addChild(new Text("error"));
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

/** Regular-mode layout: document container among tui's direct children. */
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

/** Fullscreen layout: a layout root whose scroll view holds the document. */
function fullscreenLayout(chat: Container): { tui: FakeTui; document: Container } {
  const document = new Container();
  document.addChild(new Container());
  document.addChild(new Container());
  document.addChild(chat);
  const scroll = new Container();
  scroll.addChild(document);
  const root = new Container();
  root.addChild(scroll);
  const tui: FakeTui = {
    layoutRoot: root,
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
  };
  return { tui, document };
}

describe("findChatContainer", () => {
  test("finds the chat container in a regular-mode layout", () => {
    const chat = chatWith(assistant({ type: "text", text: "hello" }));
    const { tui } = regularLayout(chat);

    assert.deepEqual(findChatContainer(tui), {
      container: chat,
      parent: tui.children![0],
      index: 2,
    });
  });

  test("finds the chat container through a fullscreen layout root", () => {
    const chat = chatWith(assistant({ type: "text", text: "hello" }));
    const { tui, document } = fullscreenLayout(chat);

    const slot = findChatContainer(tui);
    assert.equal(slot?.container, chat);
    assert.equal(slot?.parent, document);
    assert.equal(slot?.index, 2);
  });

  test("mismatches when no container holds an assistant message", () => {
    const { tui } = regularLayout(new Container());

    assert.equal(findChatContainer(tui), undefined);
  });

  test("mismatches when several containers hold assistant messages", () => {
    const message = assistant({ type: "text", text: "hello" });
    const first = chatWith(message);
    const second = chatWith(assistant({ type: "text", text: "again" }));
    const tui = new Container();
    tui.addChild(first);
    tui.addChild(second);

    assert.equal(findChatContainer(tui), undefined);
  });

  test("mismatches when the assistant has no parent slot to swap", () => {
    const tui = new Container();
    tui.addChild(assistant({ type: "text", text: "hello" }));

    assert.equal(findChatContainer(tui), undefined);
  });
});

describe("StreamFilterView", () => {
  test("renders a thinking-only message as zero lines", () => {
    const chat = chatWith(assistant({ type: "thinking", thinking: "secret" }));
    const view = new StreamFilterView(chat);
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), []);
  });

  test("renders text and drops a thinking run that precedes it", () => {
    const message = assistant(
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "Answer" },
    );
    const view = new StreamFilterView(chatWith(message));
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), ["", "Answer"]);
  });

  test("renders text and drops a thinking run that follows it", () => {
    const message = assistant(
      { type: "text", text: "Answer" },
      { type: "thinking", thinking: "secret" },
    );
    const view = new StreamFilterView(chatWith(message));
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), ["", "Answer"]);
  });

  test("keeps thinking rendered when the thinking stream is not attached", () => {
    const message = assistant(
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "Answer" },
    );
    const chat = chatWith(message);
    const direct = chat.render(80);
    const view = new StreamFilterView(chat);
    view.setAttachState("tools");

    assert.deepEqual(view.render(80), direct);
  });

  test("drops tool rows and the spacer directly before them", () => {
    const chat = chatWith(
      new Text("user prompt"),
      new Spacer(1),
      new ToolExecutionComponent("bash", "t1"),
      assistant({ type: "text", text: "Answer" }),
    );
    const view = new StreamFilterView(chat);
    view.setAttachState("tools");

    assert.deepEqual(view.render(80), ["user prompt", "", "Answer"]);
  });

  test("keeps tool rows while only thinking is attached", () => {
    const chat = chatWith(
      new Text("user prompt"),
      new Spacer(1),
      new ToolExecutionComponent("bash", "t1"),
    );
    const view = new StreamFilterView(chat);
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), ["user prompt", "", "[tool bash]"]);
  });

  test("drops both tool rows and thinking runs when both streams are attached", () => {
    const chat = chatWith(
      new Text("user prompt"),
      new Spacer(1),
      new ToolExecutionComponent("bash", "t1"),
      assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" }),
    );
    const view = new StreamFilterView(chat);
    view.setAttachState("both");

    assert.deepEqual(view.render(80), ["user prompt", "", "Answer"]);
  });

  test("renders the source unchanged when no stream is attached", () => {
    const chat = chatWith(assistant({ type: "text", text: "Answer" }));
    const view = new StreamFilterView(chat);
    view.setAttachState("none");

    assert.deepEqual(view.render(80), chat.render(80));
  });

  test("keeps error and truncation text while thinking is attached", () => {
    const message = new AssistantMessageComponent({
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "aborted",
    });
    const view = new StreamFilterView(chatWith(message));
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), ["", "partial answer", "", "aborted"]);
  });

  test("reuses the visible list and shells while nothing changes", () => {
    const message = assistant(
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "Answer" },
    );
    const view = new StreamFilterView(chatWith(message));
    view.setAttachState("thinking");
    view.render(80);
    const entries = view.children;
    const shell = entries[0];

    assert.deepEqual(view.render(80), ["", "Answer"]);
    assert.equal(view.children, entries);
    assert.equal(view.children[0], shell);
  });

  test("re-syncs a shell when streaming mutates the same message object", () => {
    const message: MessageLike = { content: [{ type: "thinking", thinking: "secret" }] };
    const messageComponent = new AssistantMessageComponent(message);
    const view = new StreamFilterView(chatWith(messageComponent));
    view.setAttachState("thinking");
    assert.deepEqual(view.render(80), []);
    const shell = view.children[0];

    message.content.push({ type: "text", text: "Answer" });
    messageComponent.updateContent(message);

    assert.deepEqual(view.render(80), ["", "Answer"]);
    assert.equal(view.children[0], shell);
  });

  test("rebuilds the visible list when the chat container gains a child", () => {
    const chat = chatWith(assistant({ type: "text", text: "Answer" }));
    const view = new StreamFilterView(chat);
    view.setAttachState("tools");
    view.render(80);
    const entries = view.children;

    chat.addChild(new ToolExecutionComponent("bash", "t1"));
    assert.deepEqual(view.render(80), ["", "Answer"]);
    assert.notEqual(view.children, entries);
  });

  test("renders the source unchanged and reports a layout mismatch once", () => {
    // A bare Text where a text block's Markdown should be.
    const broken = new AssistantMessageComponent();
    broken.contentContainer.addChild(new Text("weird"));
    broken.lastMessage = { content: [{ type: "text", text: "hello" }] };
    const chat = chatWith(broken);
    const view = new StreamFilterView(chat);
    let mismatches = 0;
    view.onMismatch = () => {
      mismatches += 1;
    };
    view.setAttachState("thinking");

    assert.deepEqual(view.render(80), chat.render(80));
    view.render(80);
    assert.equal(mismatches, 1);
  });
});

describe("StreamProjection", () => {
  function messageComponent(): AssistantMessageComponent {
    return assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" });
  }

  test("installs the view in the chat slot and restores it on detach", () => {
    const chat = chatWith(messageComponent());
    const { tui, document } = regularLayout(chat);
    const projection = new StreamProjection({ warn: () => {} });

    projection.apply("thinking", tui);
    assert.equal(projection.isInstalled, true);
    assert.notEqual(document.children[2], chat);
    assert.deepEqual((document.children[2] as Container).render(80), ["", "Answer"]);
    assert.ok(tui.renders > 0);

    projection.apply("none", tui);
    assert.equal(projection.isInstalled, false);
    assert.equal(document.children[2], chat);
    assert.ok(tui.renders > 1);
  });

  test("switches attach states without reinstalling", () => {
    const chat = chatWith(new ToolExecutionComponent("bash", "t1"), messageComponent());
    const { tui, document } = regularLayout(chat);
    const projection = new StreamProjection({ warn: () => {} });

    projection.apply("tools", tui);
    const view = document.children[2] as StreamFilterView;
    assert.deepEqual(view.render(80), ["", "secret", "", "Answer"]);

    projection.apply("both", tui);
    assert.equal(document.children[2], view);
    assert.deepEqual(view.render(80), ["", "Answer"]);
  });

  test("warns once when the transcript layout is not recognised", () => {
    const warns: string[] = [];
    const chat = chatWith(new Container());
    const { tui } = regularLayout(chat);
    const projection = new StreamProjection({ warn: (message) => warns.push(message) });

    projection.apply("thinking", tui);
    assert.equal(projection.isInstalled, false);
    assert.equal(tui.renders, 0);

    projection.apply("none", tui);
    projection.apply("tools", tui);
    assert.equal(warns.length, 1);
  });

  test("uninstalls and warns once on a render-time mismatch", () => {
    const warns: string[] = [];
    const broken = new AssistantMessageComponent();
    broken.contentContainer.addChild(new Text("weird"));
    broken.lastMessage = { content: [{ type: "text", text: "hello" }] };
    const chat = chatWith(broken);
    const { tui, document } = regularLayout(chat);
    const projection = new StreamProjection({ warn: (message) => warns.push(message) });

    projection.apply("thinking", tui);
    const view = document.children[2] as StreamFilterView;
    assert.deepEqual(view.render(80), chat.render(80));
    assert.equal(document.children[2], chat);
    assert.equal(warns.length, 1);

    projection.apply("none", tui);
    projection.apply("thinking", tui);
    assert.equal(warns.length, 1);
    (document.children[2] as StreamFilterView).render(80);
    assert.equal(warns.length, 1);
  });

  test("treats every attach-state combination distinctly", () => {
    const chat = chatWith(
      new ToolExecutionComponent("bash", "t1"),
      assistant({ type: "thinking", thinking: "secret" }, { type: "text", text: "Answer" }),
    );
    const expected: Record<AttachState, string[]> = {
      none: ["[tool bash]", "", "secret", "", "Answer"],
      thinking: ["[tool bash]", "", "Answer"],
      tools: ["", "secret", "", "Answer"],
      both: ["", "Answer"],
    };
    for (const [state, lines] of Object.entries(expected) as [AttachState, string[]][]) {
      const view = new StreamFilterView(chat);
      view.setAttachState(state);
      assert.deepEqual(view.render(80), lines, state);
    }
  });
});
