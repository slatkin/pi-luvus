import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import {
  StreamFilterView,
  StreamProjection,
  findChatContainer,
  type AttachState,
} from "../pi-extension/luvus/stream-projection.ts";
import {
  AssistantMessageComponent,
  Spacer,
  Text,
  ToolExecutionComponent,
  assistant,
  chatWith,
  fullscreenLayout,
  regularLayout,
  type MessageLike,
} from "./stream-fakes.ts";

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
