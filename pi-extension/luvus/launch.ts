/**
 * Launch mechanics shared by the pane-side CLI, the pi extension and the
 * skill: a typed launch spec, the one shell-neutral pane command line, the
 * OSC title, and shell-free pi resolution.
 *
 * Nothing here executes a shell. The pane command line is the single
 * irreducible shell surface: Luvus `pane run` types it into the pane's
 * interactive shell, so every token it carries must mean the same thing in
 * bash, zsh, fish, PowerShell and cmd.exe.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanTitleText, cutPromptTitle } from "./live-title.ts";
import type { StreamName } from "./stream-state.ts";

/** Launch spec version written by `writeLaunchSpec`; readers reject others. */
export const LAUNCH_SPEC_VERSION = 1;

/**
 * Everything a pane needs to start one child: the executable and argv (no
 * shell), the env delta, and the optional close-on-done rule.
 */
export interface LaunchSpec {
  version: typeof LAUNCH_SPEC_VERSION;
  /** Subagent name (pane title and `pane name`). */
  name: string;
  /** Child working directory; defaults to the pane's cwd. */
  cwd?: string;
  /** Extra environment variables, merged over `process.env`. */
  env: Record<string, string>;
  /** Child executable name — `pi`, `claude`, or another CLI. */
  command: string;
  /** Child argv, without the optional `run <spec> [<prompt>]` prompt. */
  args: string[];
  /** pi session file, used for the `.exit` sidecar. */
  sessionFile?: string;
  /** OSC title; defaults to the title built from `name` and the task. */
  title?: string;
  /** Close the pane this long after a `done` sidecar (skill launches only). */
  closeOnDone?: { graceMs: number };
  /** Parent pane name; the wrapper wakes it if the child exits without reporting. */
  parent?: string;
}

function invalid(message: string): never {
  throw new Error(`Invalid launch spec: ${message}`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string`);
  return value;
}

/**
 * Check an unknown JSON payload and return it as a LaunchSpec. The spec is
 * versioned so a spec written by another package version fails loudly instead
 * of launching the wrong child.
 */
export function validateLaunchSpec(data: unknown): LaunchSpec {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    invalid("expected a JSON object");
  }
  const spec = data as Record<string, unknown>;
  if (spec.version !== LAUNCH_SPEC_VERSION) {
    invalid(`unknown version ${JSON.stringify(spec.version)} (expected ${LAUNCH_SPEC_VERSION})`);
  }
  if (typeof spec.name !== "string" || spec.name.length === 0) invalid("missing name");
  if (typeof spec.command !== "string" || spec.command.length === 0) invalid("missing command");

  const env = spec.env === undefined ? {} : spec.env;
  if (env === null || typeof env !== "object" || Array.isArray(env))
    invalid("env must be an object");
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string") invalid(`env.${key} must be a string`);
  }

  const args = spec.args === undefined ? [] : spec.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    invalid("args must be an array of strings");
  }

  const cwd = optionalString(spec.cwd, "cwd");
  const sessionFile = optionalString(spec.sessionFile, "sessionFile");
  const title = optionalString(spec.title, "title");
  const parent = optionalString(spec.parent, "parent");

  let graceMs: number | undefined;
  if (spec.closeOnDone !== undefined) {
    const closeOnDone = spec.closeOnDone;
    if (closeOnDone === null || typeof closeOnDone !== "object" || Array.isArray(closeOnDone)) {
      invalid("closeOnDone must be an object");
    }
    graceMs = (closeOnDone as Record<string, unknown>).graceMs as number;
    if (typeof graceMs !== "number" || !Number.isFinite(graceMs) || graceMs < 0) {
      invalid("closeOnDone.graceMs must be a non-negative number");
    }
  }

  return {
    version: LAUNCH_SPEC_VERSION,
    name: spec.name,
    env: env as Record<string, string>,
    command: spec.command,
    args: args as string[],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(sessionFile !== undefined ? { sessionFile } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(graceMs !== undefined ? { closeOnDone: { graceMs } } : {}),
  };
}

/** Write a launch spec as JSON, creating the parent directory. */
export function writeLaunchSpec(specPath: string, spec: LaunchSpec): void {
  validateLaunchSpec(spec);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
}

/** Read and validate a launch spec written by `writeLaunchSpec`. */
export function readLaunchSpec(specPath: string): LaunchSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read launch spec ${specPath}: ${detail}`, { cause: error });
  }
  try {
    return validateLaunchSpec(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read launch spec ${specPath}: ${detail}`, { cause: error });
  }
}

/** Characters double quotes cannot make literal in every supported shell. */
// eslint-disable-next-line no-control-regex -- control characters must be rejected here
const UNSAFE_PANE_TOKEN = /["`$%!]|\\\\|[\x00-\x1f\x7f-\x9f]/;

function assertPaneToken(value: string): void {
  if (UNSAFE_PANE_TOKEN.test(value)) {
    throw new Error(
      `Unsafe pane command token (contains a character that expands or changes under one of the supported shells): ${value}`,
    );
  }
}

/**
 * Build the single command line `luvus pane run` types into a pane. The bare
 * `node` avoids PowerShell treating a quoted executable path as a string;
 * every later token is double-quoted, and a token carrying anything a shell
 * would expand is rejected before any pane is split.
 */
export function paneCommandLine(cliPath: string, specPath: string, promptPath?: string): string {
  const tokens = [cliPath, "run", specPath, ...(promptPath !== undefined ? [promptPath] : [])];
  for (const token of tokens) assertPaneToken(token);
  return ["node", ...tokens.map((token) => `"${token}"`)].join(" ");
}

/** Path of the stream tailer script, next to this module. */
export function streamTailScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "stream-tail.mjs");
}

/**
 * Build the command line that runs the stream tailer in a follower pane: bare
 * `node`, then double-quoted tokens, rejecting any token a shell would expand —
 * the same shell-neutral shape as `paneCommandLine`.
 */
export function tailerCommandLine(
  socketPath: string,
  stream: StreamName,
  scriptPath: string = streamTailScriptPath(),
): string {
  const tokens = [scriptPath, "--socket", socketPath, "--stream", stream];
  for (const token of tokens) assertPaneToken(token);
  return ["node", ...tokens.map((token) => `"${token}"`)].join(" ");
}

/**
 * Build the OSC 2 title for a subagent pane: `<name> — <task>`, with the task
 * taken from its first non-empty line and truncated to 48 characters; the
 * name alone when there is no task text, or "" when the name has no printable
 * text. Control characters are stripped so untrusted task text cannot smuggle
 * terminal escape sequences. The prompt cut is shared with the live
 * first-prompt title in `live-title.ts`.
 */
export function buildPaneTitle(name: string, task?: string): string {
  const cleanName = cleanTitleText(name);
  if (cleanName.length === 0) return "";
  const taskText = cutPromptTitle(task ?? "");
  return taskText.length > 0 ? `${cleanName} — ${taskText}` : cleanName;
}

/** Test seams for `resolvePiCommand`: platform, PATH env, and file lookups. */
export interface ResolvePiDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  execPath?: string;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
}

/**
 * Resolve the pi executable without a shell, at run time so the pane's PATH
 * applies: an explicit JS entry, then (on Windows) the pi package next to an
 * npm `pi.cmd` shim — child_process refuses `.cmd` files directly — and
 * finally the `pi` name for the runtime's own PATH lookup.
 */
export function resolvePiCommand(deps: ResolvePiDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const fileExists = deps.existsSync ?? existsSync;
  const readText = deps.readFileSync ?? ((path: string) => readFileSync(path, "utf8"));

  const entry = env.PI_LUVUS_PI_ENTRY;
  if (entry) return [execPath, entry];

  if (platform === "win32") {
    for (const dir of (env.PATH ?? "").split(";").filter((item) => item.length > 0)) {
      if (!fileExists(join(dir, "pi.cmd"))) continue;
      const packageDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      try {
        const pkg = JSON.parse(readText(join(packageDir, "package.json"))) as {
          bin?: { pi?: unknown };
        };
        const binPi = pkg?.bin?.pi;
        if (typeof binPi === "string" && binPi.length > 0) {
          return [execPath, join(packageDir, binPi)];
        }
      } catch {
        // Unreadable or malformed package.json — try the next PATH entry.
      }
    }
  }
  return ["pi"];
}
