/**
 * Live first-prompt OSC title for unnamed pi panes.
 *
 * pi sets its own OSC title (`π - <cwd>`, or `π - <name> - <cwd>`) on session
 * bind. An unnamed pane therefore shows only its folder, so every unnamed pi
 * pane looks the same in the Luvus AGENTS sidebar. This module sets a title
 * from the first user prompt instead: `π - <prompt> - <cwd basename>`.
 *
 * Only an OSC title wins in Luvus, and only a non-subagent unnamed session
 * may claim one. pi resets the title on reload, so the title is set again on
 * `session_start` from the first user message already in the session.
 *
 * The prompt-cut rule is shared with the subagent pane title in `launch.ts`,
 * so both cut a long first line to the same 48 characters.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

/** Characters that cannot appear in an OSC title: C0, DEL, and C1 controls. */
const TITLE_CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/** Longest prompt line kept in a title, shared with the subagent pane title. */
export const PROMPT_TITLE_MAX_CHARS = 48;

/** Strip OSC-illegal control characters and trim. */
export function cleanTitleText(text: string): string {
  return text.replace(TITLE_CONTROL_CHARS, "").trim();
}

/**
 * First non-empty line of `text`, control characters stripped, trimmed, and
 * cut to `PROMPT_TITLE_MAX_CHARS` characters. The one prompt-cut rule shared
 * by the subagent pane title (`buildPaneTitle`) and the live first-prompt
 * title. Returns "" when no line carries printable text.
 */
export function cutPromptTitle(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    return Array.from(cleanTitleText(line)).slice(0, PROMPT_TITLE_MAX_CHARS).join("");
  }
  return "";
}

/** `π - <prompt> - <cwd basename>`, or "" when the prompt has no printable text. */
export function buildFirstPromptTitle(prompt: string, cwd: string): string {
  const cut = cutPromptTitle(prompt);
  if (cut.length === 0) return "";
  const dir = basename(cwd.replace(/[\\/]+$/, ""));
  return dir.length > 0 ? `π - ${cut} - ${dir}` : `π - ${cut}`;
}

/** The part of a session entry the first user message is read from. */
export interface SessionEntryLike {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Text of one user message content value (string or text-part array). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** Text of the first user message in `entries`, or "" when there is none. */
export function firstUserPromptText(entries: readonly SessionEntryLike[]): string {
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    if (entry.message?.role !== "user") continue;
    const text = messageText(entry.message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

export interface LiveTitleController {
  register(pi: ExtensionAPI): void;
  /** Set the title from a prompt when the conditions hold (test seam). */
  setFromPrompt(ctx: ExtensionContext, prompt: string): void;
  /** Set the title from the session's first user message (test seam). */
  setFromSession(ctx: ExtensionContext): void;
}

/** Module-level, so it dies with the extension runtime on /reload. */
let registeredInRuntime = false;

/** Test hook: reset the per-runtime registration guard. */
export function __resetLiveTitleForTests__(): void {
  registeredInRuntime = false;
}

/**
 * Build the live-title controller. `env` is the process environment, so the
 * subagent-child check reads `PI_LUVUS_NAME` the same way the rest of the
 * extension does.
 */
export function createLiveTitleController(env: NodeJS.ProcessEnv = process.env): LiveTitleController {
  /** Set once the first-prompt title is claimed for this runtime. */
  let firstPromptTitleSet = false;

  function shouldSet(ctx: ExtensionContext): boolean {
    if (env.PI_LUVUS_NAME) return false;
    const name = ctx.sessionManager.getSessionName();
    if (name !== undefined && name.trim().length > 0) return false;
    return !firstPromptTitleSet;
  }

  function apply(ctx: ExtensionContext, prompt: string): void {
    const title = buildFirstPromptTitle(prompt, ctx.cwd);
    if (title.length === 0) return;
    firstPromptTitleSet = true;
    ctx.ui.setTitle(title);
  }

  function setFromPrompt(ctx: ExtensionContext, prompt: string): void {
    if (!shouldSet(ctx)) return;
    apply(ctx, prompt);
  }

  function setFromSession(ctx: ExtensionContext): void {
    if (!shouldSet(ctx)) return;
    const prompt = firstUserPromptText(ctx.sessionManager.getEntries());
    if (prompt.length === 0) return;
    apply(ctx, prompt);
  }

  function register(pi: ExtensionAPI): void {
    if (registeredInRuntime) return;
    registeredInRuntime = true;
    pi.on("before_agent_start", (event, ctx) => {
      setFromPrompt(ctx, event?.prompt ?? "");
    });
    pi.on("session_start", (_event, ctx) => {
      setFromSession(ctx);
    });
  }

  return { register, setFromPrompt, setFromSession };
}
