/**
 * Claude Code `Stop` hook for pi-spawned Claude sessions. Writes the sentinel
 * file the parent polls when Claude finishes autonomously (no user
 * interjection). Runs as `node <plugin root>/hooks/on-stop.js` with the hook
 * JSON on stdin; the hook always exits 0, so a bad payload never fails a turn.
 *
 * Plain JavaScript on purpose: Claude Code runs this with whatever `node` the
 * orchestrator has (its own floor is node >= 18), while the rest of this
 * package needs node >= 22.18 to load TypeScript. Keep this file free of
 * type-stripped syntax so old nodes never fail a Stop event; document the
 * shapes with JSDoc instead.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";

/**
 * @typedef {object} HookInput
 * @property {unknown} [stop_hook_active]
 * @property {unknown} [transcript_path]
 * @property {unknown} [last_assistant_message]
 */

/** Read the hook JSON from stdin; an unreadable or empty stdin is empty text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** @returns {HookInput} */
function parseInput(raw) {
  try {
    const data = JSON.parse(raw);
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

/** @param {string} path @returns {boolean} */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Count transcript entries that are real human messages: `type: "user"` whose
 * `message.content` is a string. Tool results carry an array content and are
 * not counted. Unreadable lines are skipped.
 * @param {string} transcriptPath @returns {number}
 */
function countUserMessages(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return 0;
  }

  let count = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.type !== "user") continue;
    if (typeof entry.message !== "object" || entry.message === null) continue;
    if (typeof entry.message.content === "string") count++;
  }
  return count;
}

/** Write a hook file; a failure must never fail the turn. */
function writeText(path, text) {
  try {
    writeFileSync(path, text);
  } catch {
    // The sentinel directory belongs to the parent; a failed write is not fatal.
  }
}

/** Apply the hook guards and writes. @param {HookInput} input */
function handle(input) {
  // Loop guard: this stop was itself triggered by the hook.
  if (input.stop_hook_active === true) return;

  // Guard: only act for pi-spawned sessions.
  const sentinel = process.env.PI_CLAUDE_SENTINEL;
  if (!sentinel) return;

  const transcriptPath = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (!transcriptPath || !isFile(transcriptPath)) return;

  // Always write the transcript path so the parent can copy the session file.
  writeText(`${sentinel}.transcript`, `${transcriptPath}\n`);

  // Exactly one real human message means the child ran autonomously — signal
  // completion with the last assistant message as the result.
  if (countUserMessages(transcriptPath) === 1) {
    const last = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
    writeText(sentinel, `${last}\n`);
  }
}

try {
  handle(parseInput(await readStdin()));
} catch {
  // A hook must never fail the turn, so any unexpected error exits 0.
}
