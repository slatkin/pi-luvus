/**
 * Transcript projection for `/stream` follower panes.
 *
 * While a stream is attached, a `StreamFilterView` takes the chat container's
 * slot in its parent and renders a projected child list: tool rows are dropped
 * whole (with a directly preceding spacer) while the tools stream is attached,
 * and each assistant message is replaced by a shell that holds only its text
 * slots while the thinking stream is attached. The real container is kept as
 * `source` and never mutated, so detaching restores the exact original tree.
 *
 * The projection reads pi's rendered component tree structurally. Anything
 * that does not match the expected shape is a layout mismatch: the view then
 * renders the source unchanged and the controller uninstalls, so the
 * transcript never renders partially or incorrectly.
 */
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";

/** Which streams are attached to follower panes. */
export type AttachState = "none" | "thinking" | "tools" | "both";

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
}

interface AssistantMessageLike {
  content?: ContentBlock[];
  stopReason?: unknown;
}

type AssistantComponent = Container & {
  contentContainer: Container;
  lastMessage?: AssistantMessageLike;
};

/** Where the chat container sits: its parent and the slot index inside it. */
export interface ChatSlot {
  container: Container;
  parent: Container;
  index: number;
}

type ComponentClass = abstract new (...args: any[]) => unknown;

function classNameOf(value: unknown): string | undefined {
  const ctor = (value as { constructor?: { name?: unknown } } | null | undefined)?.constructor;
  return typeof ctor?.name === "string" ? ctor.name : undefined;
}

function matchesClass(value: unknown, cls: ComponentClass, name: string): boolean {
  return value instanceof cls || classNameOf(value) === name;
}

function isAssistantComponent(value: unknown): value is AssistantComponent {
  return matchesClass(value, AssistantMessageComponent, "AssistantMessageComponent");
}

function isToolComponent(value: unknown): boolean {
  return matchesClass(value, ToolExecutionComponent, "ToolExecutionComponent");
}

function isSpacer(value: unknown): boolean {
  return matchesClass(value, Spacer, "Spacer");
}

function isMarkdown(value: unknown): boolean {
  return matchesClass(value, Markdown, "Markdown");
}

function isMouseRegion(value: unknown): boolean {
  return matchesClass(value, MouseRegion, "MouseRegion");
}

function isText(value: unknown): boolean {
  return matchesClass(value, Text, "Text");
}

interface NodeWithChildren {
  children: unknown[];
}

function hasChildren(node: unknown): node is NodeWithChildren {
  return Array.isArray((node as NodeWithChildren | null | undefined)?.children);
}

/**
 * Find the transcript's chat container from a `tui`-shaped root.
 *
 * Walks the component tree for the one container whose direct children include
 * an assistant message component. Returns its parent and slot index so the
 * caller can swap the slot; a shape with zero or several candidates is a
 * mismatch and returns undefined.
 */
export function findChatContainer(tui: unknown): ChatSlot | undefined {
  const root =
    tui && typeof tui === "object"
      ? ((tui as { layoutRoot?: unknown }).layoutRoot ?? tui)
      : undefined;
  if (!root || typeof root !== "object") return undefined;

  const candidates: ChatSlot[] = [];
  const visited = new Set<unknown>();
  const walk = (node: unknown, parent: unknown, index: number): void => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (!hasChildren(node)) return;
    if (parent && node !== root && node.children.some((child) => isAssistantComponent(child))) {
      candidates.push({
        container: node as Container,
        parent: parent as Container,
        index,
      });
    }
    for (let i = 0; i < node.children.length; i += 1) {
      walk(node.children[i], node, i);
    }
  };
  walk(root, undefined, -1);

  return candidates.length === 1 ? candidates[0] : undefined;
}

const MISMATCH = Symbol("stream-projection.mismatch");
type Mismatch = typeof MISMATCH;

function isTextBlock(block: ContentBlock | undefined): block is { type: "text"; text: string } {
  return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0;
}

function isThinkingBlock(
  block: ContentBlock | undefined,
): block is { type: "thinking"; thinking: string } {
  return (
    block?.type === "thinking" &&
    typeof block.thinking === "string" &&
    block.thinking.trim().length > 0
  );
}

/**
 * One expected child of an assistant's content container. `keep` records the
 * projection decision; spacer entries get theirs from the child that follows.
 */
interface ExpectedChild {
  kind: "spacer" | "text" | "thinking" | "terminal";
  keep?: boolean;
}

/**
 * Derive the content container's child sequence from the assistant message,
 * mirroring how pi renders one: a leading spacer when any text or thinking
 * block is non-empty, one Markdown per non-empty text block, one MouseRegion
 * per collapsed thinking run followed by a spacer when visible content
 * follows, and a trailing spacer plus Text for a truncated, aborted, or
 * failed message without tool calls.
 */
function deriveExpected(message: AssistantMessageLike, thinkingAttached: boolean): ExpectedChild[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const expected: ExpectedChild[] = [];
  if (content.some((block) => isTextBlock(block) || isThinkingBlock(block))) {
    expected.push({ kind: "spacer" });
  }
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (isTextBlock(block)) {
      expected.push({ kind: "text", keep: true });
    } else if (block?.type === "thinking") {
      const run = scanThinkingRun(content, i);
      i = run.end - 1;
      if (!run.hasThinking) continue;
      const followedByVisible = content
        .slice(run.end)
        .some((b) => isTextBlock(b) || isThinkingBlock(b));
      expected.push({ kind: "thinking", keep: !thinkingAttached });
      if (followedByVisible) expected.push({ kind: "spacer" });
    }
  }
  const hasToolCalls = content.some((block) => block?.type === "toolCall");
  if (message.stopReason === "length") {
    expected.push({ kind: "spacer" }, { kind: "terminal", keep: true });
  } else if (
    !hasToolCalls &&
    (message.stopReason === "aborted" || message.stopReason === "error")
  ) {
    expected.push({ kind: "spacer" }, { kind: "terminal", keep: true });
  }
  return expected;
}

/** Scan the collapsed thinking run that starts at `start`. */
function scanThinkingRun(
  content: ContentBlock[],
  start: number,
): { end: number; hasThinking: boolean } {
  let end = start;
  let hasThinking = false;
  for (; end < content.length; end += 1) {
    const block = content[end];
    if (block?.type !== "thinking") break;
    if (isThinkingBlock(block)) hasThinking = true;
  }
  return { end, hasThinking };
}

/** A spacer is kept exactly when the child that follows it is kept. */
function resolveSpacerKeeps(expected: ExpectedChild[]): boolean[] {
  const keep: boolean[] = Array.from({ length: expected.length }, () => false);
  let next = false;
  for (let i = expected.length - 1; i >= 0; i -= 1) {
    if (expected[i].kind === "spacer") {
      keep[i] = next;
    } else {
      next = expected[i].keep === true;
    }
  }
  return keep;
}

/** Structural check for the child one kind of expected slot requires. */
const KIND_CHECKS: Record<ExpectedChild["kind"], (child: unknown) => boolean> = {
  spacer: isSpacer,
  text: isMarkdown,
  thinking: isMouseRegion,
  terminal: isText,
};

/** Kinds that are dropped while the thinking stream is attached. */
function isDroppableKind(kind: ExpectedChild["kind"]): boolean {
  return kind === "spacer" || kind === "thinking";
}

interface AssistantMatch {
  kept: Component[];
  droppedAny: boolean;
}

/**
 * Match an assistant's content container children against the derived
 * sequence and return the children kept under the current attach state.
 */
function matchAssistant(
  source: AssistantComponent,
  thinkingAttached: boolean,
): AssistantMatch | Mismatch {
  const contentContainer = source.contentContainer;
  const message = source.lastMessage;
  if (!contentContainer) return MISMATCH;
  const children = contentContainer.children;
  if (!message) return children.length === 0 ? { kept: [], droppedAny: false } : MISMATCH;

  const expected = deriveExpected(message, thinkingAttached);
  const keep = resolveSpacerKeeps(expected);
  if (expected.length !== children.length) return MISMATCH;

  const kept: Component[] = [];
  let droppedAny = false;
  for (let i = 0; i < expected.length; i += 1) {
    const child = children[i];
    const kind = expected[i].kind;
    if (!KIND_CHECKS[kind](child)) return MISMATCH;
    if (isDroppableKind(kind) && !keep[i]) {
      droppedAny = true;
    } else {
      kept.push(child);
    }
  }
  return { kept, droppedAny };
}

/**
 * A projection shell for one assistant message: an object that inherits from
 * the real component but carries its own `contentContainer` and `children`,
 * so rendering it draws only the kept children while the real component stays
 * untouched.
 */
interface AssistantShell {
  shell: AssistantComponent;
  contentShell: Container;
  kept: Component[];
}

function invalidateShell(this: AssistantComponent): void {
  for (const child of this.children) child.invalidate();
}

function buildShell(source: AssistantComponent, kept: Component[]): AssistantShell {
  const contentShell = Object.create(source.contentContainer) as Container;
  contentShell.children = kept;
  const shell = Object.create(source) as AssistantComponent;
  shell.contentContainer = contentShell;
  const outer = [...source.children];
  const index = outer.indexOf(source.contentContainer);
  if (index >= 0) outer[index] = contentShell;
  else outer.push(contentShell);
  shell.children = outer;
  // Skip the assistant's own invalidate, which would rebuild the content
  // container from the full message and resurrect the dropped children.
  shell.invalidate = invalidateShell;
  return { shell, contentShell, kept };
}

function syncShell(entry: AssistantShell, kept: Component[]): boolean {
  if (sameReferences(entry.kept, kept)) return false;
  entry.kept = kept;
  entry.contentShell.children = kept;
  return true;
}

function sameReferences(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The projected transcript view. Installed in the chat container's parent
 * slot while any stream is attached; every render rebuilds the visible child
 * list from `source.children` and delegates to `Container.render`, so mouse
 * routing matches exactly what was drawn.
 */
export class StreamFilterView extends Container {
  readonly source: Container;

  private state: AttachState = "none";
  private shells = new Map<AssistantComponent, AssistantShell>();
  private cachedKey: unknown[] | undefined;
  private cachedEntries: Component[] | undefined;
  private broken = false;

  /** Called when a render hits a layout mismatch. */
  onMismatch?: () => void;

  constructor(source: Container) {
    super();
    this.source = source;
  }

  get attachState(): AttachState {
    return this.state;
  }

  setAttachState(state: AttachState): void {
    if (state === this.state) return;
    this.state = state;
    this.broken = false;
    this.dropCache();
  }

  render(width: number): string[] {
    if (this.state === "none" || this.broken) {
      this.children = this.source.children;
      return super.render(width);
    }
    const key = this.cacheKey();
    const reuse =
      this.cachedKey && sameReferences(this.cachedKey, key) ? this.cachedEntries : undefined;
    const entries = this.projectEntries(reuse);
    if (entries === MISMATCH) {
      this.children = this.source.children;
      const lines = super.render(width);
      this.dropCache();
      // Render the source unchanged from now on; the controller uninstalls.
      this.broken = true;
      this.onMismatch?.();
      return lines;
    }
    this.cachedKey = key;
    this.cachedEntries = entries;
    this.children = entries;
    return super.render(width);
  }

  /** Attach state plus the identity of everything the projection reads. */
  private cacheKey(): unknown[] {
    const parts: unknown[] = [this.state, this.source.children, this.source.children.length];
    for (const child of this.source.children) {
      parts.push(child);
      if (isAssistantComponent(child)) parts.push(child.lastMessage);
    }
    return parts;
  }

  private dropCache(): void {
    this.shells.clear();
    this.cachedKey = undefined;
    this.cachedEntries = undefined;
  }

  /**
   * Build the visible child list for the current attach state. Reuses the
   * previous list when nothing changed, and reuses and re-syncs each
   * assistant shell so a streaming message that mutates in place stays
   * current without rebuilding shells.
   */
  private projectEntries(reuse: Component[] | undefined): Component[] | Mismatch {
    const thinkingAttached = this.state === "thinking" || this.state === "both";
    const toolsAttached = this.state === "tools" || this.state === "both";
    const out: Component[] = [];
    const pendingSpacers: Component[] = [];
    let changed = false;

    const flush = (child: Component): void => {
      out.push(...pendingSpacers, child);
      pendingSpacers.length = 0;
    };

    for (const child of this.source.children) {
      if (isSpacer(child)) {
        pendingSpacers.push(child);
        continue;
      }
      if (toolsAttached && isToolComponent(child)) {
        // Tool rows are dropped whole; a spacer sitting directly before one
        // goes with it.
        pendingSpacers.length = 0;
        changed = true;
        continue;
      }
      if (thinkingAttached && isAssistantComponent(child)) {
        const projected = this.projectAssistant(child);
        if (projected === MISMATCH) return MISMATCH;
        if (projected.changed) changed = true;
        flush(projected.entry);
        continue;
      }
      flush(child);
    }
    out.push(...pendingSpacers);

    if (!changed && reuse && sameReferences(reuse, out)) return reuse;
    return out;
  }

  /** Project one assistant message, reusing and re-syncing its shell. */
  private projectAssistant(
    child: AssistantComponent,
  ): { entry: Component; changed: boolean } | Mismatch {
    const match = matchAssistant(child, true);
    if (match === MISMATCH) return MISMATCH;
    const existing = this.shells.get(child);
    if (!match.droppedAny) {
      this.shells.delete(child);
      return { entry: child, changed: existing !== undefined };
    }
    if (existing) return { entry: existing.shell, changed: syncShell(existing, match.kept) };
    const entry = buildShell(child, match.kept);
    this.shells.set(child, entry);
    return { entry: entry.shell, changed: true };
  }
}

export interface StreamProjectionOptions {
  /** Reports a layout mismatch; invoked at most once per instance. */
  warn: (message: string) => void;
}

/**
 * Install and uninstall the projection view as the transcript's attach state
 * changes. A layout mismatch installs nothing, renders the transcript
 * untouched, and warns once per instance.
 */
export class StreamProjection {
  private readonly warn: (message: string) => void;
  private view: StreamFilterView | undefined;
  private slot: ChatSlot | undefined;
  private state: AttachState = "none";
  private tui: unknown;
  private warned = false;

  constructor(options: StreamProjectionOptions) {
    this.warn = options.warn;
  }

  /** True while the projected view is in the transcript. */
  get isInstalled(): boolean {
    return this.view !== undefined;
  }

  /**
   * Apply a new attach state. `tui` is the live TUI object from the widget
   * factory; the latest one seen is kept for later renders and refreshes.
   */
  apply(state: AttachState, tui: unknown): void {
    if (!tui) return;
    this.tui = tui;
    if (state === this.state && (state === "none") === !this.view) return;
    this.state = state;
    if (state === "none") {
      this.uninstall();
      return;
    }
    if (this.view) {
      this.view.setAttachState(state);
      this.refresh();
      return;
    }
    this.install();
  }

  /** Remove the view and restore the original transcript tree. */
  uninstall(): void {
    const view = this.view;
    if (!view) return;
    this.view = undefined;
    const slot = this.slot;
    this.slot = undefined;
    if (slot) {
      const index = slot.parent.children.indexOf(view);
      if (index !== -1) slot.parent.children[index] = slot.container;
      slot.container.invalidate();
    }
    this.requestRender();
  }

  private install(): void {
    const slot = findChatContainer(this.tui);
    if (!slot) {
      this.warnMismatch("Luvus streams: transcript layout not recognised; showing it unchanged");
      return;
    }
    const view = new StreamFilterView(slot.container);
    view.setAttachState(this.state);
    view.onMismatch = () => {
      this.uninstall();
      this.warnMismatch("Luvus streams: transcript layout changed; restoring the transcript");
    };
    const index = slot.parent.children.indexOf(slot.container);
    if (index === -1) {
      this.warnMismatch("Luvus streams: transcript layout not recognised; showing it unchanged");
      return;
    }
    slot.parent.children[index] = view;
    this.view = view;
    this.slot = slot;
    this.refresh();
  }

  private refresh(): void {
    this.view?.invalidate();
    this.requestRender();
  }

  private requestRender(): void {
    const tui = this.tui as { requestRender?: () => void } | undefined;
    tui?.requestRender?.();
  }

  private warnMismatch(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(message);
  }
}
