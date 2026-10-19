/**
 * Shared fakes and harness helpers for the stream test files.
 *
 * The component fakes mirror the runtime shape of pi's transcript components;
 * class names match the real components so the projection's structural checks
 * classify them the same way. Both the projection tests and the wiring tests
 * build on this one family, so a change in pi's layout is mirrored once.
 */
import { Container, type Component } from "@earendil-works/pi-tui";

export class Spacer {
  lines: number;
  constructor(lines = 1) {
    this.lines = lines;
  }
  render(): string[] {
    return Array.from({ length: this.lines }, () => "");
  }
  invalidate(): void {}
}

export class Text {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(): string[] {
    return [this.text];
  }
  invalidate(): void {}
}

export class Markdown {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(): string[] {
    return [this.text];
  }
  invalidate(): void {}
}

export class MouseRegion {
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

export class ToolExecutionComponent {
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

export interface Block {
  type: string;
  text?: string;
  thinking?: string;
}

export interface MessageLike {
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
export class AssistantMessageComponent extends Container {
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

export function assistant(...blocks: Block[]): AssistantMessageComponent {
  return new AssistantMessageComponent({ content: blocks });
}

export function chatWith(...children: Component[]): Container {
  const chat = new Container();
  for (const child of children) chat.addChild(child);
  return chat;
}

export interface FakeTui {
  layoutRoot?: Container;
  children?: Container[];
  renders: number;
  requestRender(): void;
}

/** Regular-mode layout: the document container is tui's first direct child. */
export function regularLayout(chat: Container): { tui: FakeTui; document: Container } {
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
export function fullscreenLayout(chat: Container): { tui: FakeTui; document: Container } {
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

/** A captured ui.notify call. */
export interface Notification {
  text: string;
  level: string;
}

export type Handler = (event: unknown, ctx: unknown) => void;

/** Minimal ExtensionAPI mock that records registered commands and handlers. */
export function createMockApi() {
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

/** Save-and-restore guard for the process env keys a test file sets. */
export function createEnvGuard() {
  const saved = new Map<string, string | undefined>();
  return {
    set(name: string, value: string | undefined): void {
      if (!saved.has(name)) saved.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    },
    restore(): void {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}
