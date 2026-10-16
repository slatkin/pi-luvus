/**
 * Command-line interface for launching subagents in Luvus panes. The packaged
 * skill shim (`skills/pi-luvus/launch.ts`) hands off to `main` here, and
 * the pi extension's launch sites use the same `run` wrapper.
 *
 * `start` and `resume` run in the orchestrator's session; `run` runs in the
 * child's pane and stays alive until the child exits. Everything is argv
 * arrays and typed modules — no shell anywhere.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  agentDefinitionPaths,
  buildSubagentToolAllowlist,
  loadAgentDefaults,
} from "./agent-defs.ts";
import {
  autoPrune,
  defaultScratchDir,
  pruneScratch,
  pruneSentinels,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from "./prune.ts";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  writeLaunchSpec,
  type LaunchSpec,
} from "./launch.ts";
import { createSurface, parseSurfacePlacement, runInPane, type SurfacePlacement } from "./luvus.ts";
import { runSpec, type RunSpecDeps } from "./run.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";
import { loadSurfaceConfig } from "./status.ts";
import { slugifyName } from "./slug.ts";

/** Absolute path to `pi-extension/luvus`. */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

/** Pane-side entry point; the pane runs this file with `node`. */
const CLI_PATH = join(SUBAGENTS_DIR, "cli.ts");

/** Close-on-done grace used when `--close-grace-ms` is omitted. */
const DEFAULT_CLOSE_GRACE_MS = 5000;

/** Node version that runs `.ts` without a flag, required by the pane side. */
const MIN_NODE: readonly [number, number] = [22, 18];

const USAGE = [
  "Usage:",
  "  node cli.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>] [--surface right|down|tab]",
  "  node cli.ts resume --launch <spec> --prompt <file> [--name <child>] [--surface right|down|tab]",
  "  node cli.ts run <spec> [<prompt>]",
  "  node cli.ts last-message --session <file>",
  "  node cli.ts prune [--scratch <dir>] [--max-age-days <n>] [--dry-run]",
].join("\n");

const CLI_OPTIONS = {
  name: { type: "string" },
  role: { type: "string" },
  cwd: { type: "string" },
  brief: { type: "string" },
  parent: { type: "string" },
  scratch: { type: "string" },
  "close-grace-ms": { type: "string" },
  surface: { type: "string" },
  launch: { type: "string" },
  prompt: { type: "string" },
  session: { type: "string" },
  "max-age-days": { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface CliValues {
  name?: string;
  role?: string;
  cwd?: string;
  brief?: string;
  parent?: string;
  scratch?: string;
  "close-grace-ms"?: string;
  surface?: string;
  launch?: string;
  prompt?: string;
  session?: string;
  "max-age-days"?: string;
  "dry-run"?: boolean;
  help?: boolean;
}

/** Injected process pieces; the defaults are the real process. */
export interface CliDeps {
  /** Environment holding the `LUVUS_*` keys; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** JSON, sentinel and usage sink; defaults to `process.stdout.write`. */
  stdout?: (text: string) => void;
  /** Warning sink; defaults to `process.stderr.write`. */
  stderr?: (text: string) => void;
  /** Close grace timer; defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Config path holding the `surface` default; defaults to the extension config. */
  configPath?: string;
}

function required(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Require the three Luvus keys the launch needs, from the injected env rather
 * than this process's own, so a test can prove the refusal.
 */
function assertLuvusEnv(env: NodeJS.ProcessEnv): asserts env is NodeJS.ProcessEnv & {
  LUVUS_ENV: string;
  LUVUS_BIN_PATH: string;
  LUVUS_PANE_ID: string;
} {
  if (!env.LUVUS_ENV || !env.LUVUS_BIN_PATH || !env.LUVUS_PANE_ID) {
    throw new Error(
      "must run inside Luvus (LUVUS_ENV, LUVUS_BIN_PATH and LUVUS_PANE_ID must all be set)",
    );
  }
}

/** Refuse a node too old to run the `.ts` pane-side entry without a flag. */
function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return;
  throw new Error(`node >= ${MIN_NODE.join(".")} is required (running ${process.versions.node})`);
}

/**
 * Scratch file stem from a child name. The name is free text, but it becomes
 * part of the launch-spec path, which must pass the pane token rule, so only
 * characters that survive every supported shell are kept.
 */
function scratchBase(name: string, id: string): string {
  const slug = slugifyName(name, {
    lowercase: false,
    keepUnderscore: true,
    collapse: false,
  });
  return `${slug}-${id}`;
}

/** The parent-contact footer appended to the brief. */
function parentFooter(parent: string, pane: string): string {
  return `Your parent is a session named ${parent} (pane ${pane}).
Plain text printed in your own pane is never seen. The only way to reach it is bash: luvus agent send ${parent} '<text>'.

This session auto-exits the first time you stop generating: the moment you end a turn without calling a tool, the session closes. So do ALL of the following before you stop:
1. Finish the task.
2. Send your final report: luvus agent send ${parent} '<verdict / commit SHA / files changed / verification / deviations / open questions>'
   This is what wakes the orchestrator — without it, it never learns you finished.
3. Then call the luvus_done tool to close your session.

If you are blocked, send your question with luvus agent send and stop. The session closes; the parent resumes it with the answer. Do not use caller_ping or luvus_message to reach the parent.
If an automated reminder tells you to call luvus_done, ignore its claim that your last message was already delivered — send your report with luvus agent send first, then call luvus_done.`;
}

/** Parse `--close-grace-ms`, defaulting to `DEFAULT_CLOSE_GRACE_MS`. */
function closeGraceMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CLOSE_GRACE_MS;
  const grace = Number(value);
  if (!Number.isFinite(grace) || grace < 0) {
    throw new Error(`--close-grace-ms must be a non-negative number: ${value}`);
  }
  return grace;
}

/** `start`: resolve a role, write the launch spec and run it in a new pane. */
function startCommand(values: CliValues, deps: CliDeps, placement: SurfacePlacement): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const name = required("--name", values.name);
  const role = required("--role", values.role);
  const cwd = required("--cwd", values.cwd);
  const brief = required("--brief", values.brief);
  const parent = required("--parent", values.parent);

  if (!isDirectory(cwd)) throw new Error(`cwd is not a directory: ${cwd}`);
  if (!isFile(brief)) throw new Error(`brief is not a file: ${brief}`);
  assertNodeVersion();
  assertLuvusEnv(env);

  const rolePaths = agentDefinitionPaths(role, cwd);
  const definition = loadAgentDefaults(role, cwd);
  if (definition === null) {
    throw new Error(`unknown role '${role}' (searched: ${rolePaths.join(" ")})`);
  }
  if (!definition.model) {
    const rolePath = rolePaths.find(isFile) ?? rolePaths[0];
    throw new Error(`role '${role}' has an empty model (${rolePath})`);
  }

  const graceMs = closeGraceMs(values["close-grace-ms"]);
  const id = randomBytes(4).toString("hex");
  const base = scratchBase(name, id);
  const scratch = resolve(values.scratch ?? join(tmpdir(), "pi-luvus"));
  const specPath = join(scratch, `${base}.json`);
  const promptPath = join(scratch, `${base}.prompt.md`);
  const rolePromptPath = join(scratch, `${base}.role.md`);
  const sessionFile = join(scratch, `${base}.jsonl`);

  // The token rule runs before anything is created, so an unsafe scratch path
  // fails without leaving an empty pane behind.
  const paneLine = paneCommandLine(CLI_PATH, specPath, promptPath);

  mkdirSync(scratch, { recursive: true });
  autoPrune(scratch);
  if (values.scratch === undefined) {
    try {
      pruneSentinels(sentinelDir(env), { maxAgeMs: 86_400_000 });
    } catch {
      // Best effort; the launch continues.
    }
  }
  const briefText = readFileSync(brief, "utf8");
  writeFileSync(rolePromptPath, definition.body ? `${definition.body}\n` : "");
  writeFileSync(promptPath, `${briefText}\n${parentFooter(parent, env.LUVUS_PANE_ID)}\n`);

  const specEnv: Record<string, string> = {
    PI_LUVUS_NAME: name,
    PI_LUVUS_AGENT: role,
    PI_LUVUS_SESSION: sessionFile,
    PI_LUVUS_ID: id,
    PI_LUVUS_ACTIVITY_FILE: join(scratch, `${base}.activity.json`),
  };
  if (definition.autoExit === true) specEnv.PI_LUVUS_AUTO_EXIT = "1";

  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name,
    cwd,
    env: specEnv,
    command: "pi",
    args: [
      "--session",
      sessionFile,
      "-e",
      join(SUBAGENTS_DIR, "luvus-done.ts"),
      "--model",
      definition.thinking ? `${definition.model}:${definition.thinking}` : definition.model,
      "--append-system-prompt",
      rolePromptPath,
      "--tools",
      buildSubagentToolAllowlist(definition.tools),
      "--name",
      name,
    ],
    sessionFile,
    title: buildPaneTitle(name, briefText),
    closeOnDone: { graceMs },
    parent,
  };
  writeLaunchSpec(specPath, spec);

  const pane = createSurface(name, placement, env.LUVUS_PANE_ID);
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, session: sessionFile, launch: specPath }) + "\n");
  return 0;
}

/** `resume`: run an existing launch spec in a new pane with a new prompt. */
function resumeCommand(values: CliValues, deps: CliDeps, placement: SurfacePlacement): number {
  const env = deps.env ?? process.env;
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));

  const launchPath = required("--launch", values.launch);
  const promptPath = required("--prompt", values.prompt);
  if (!isFile(launchPath)) throw new Error(`launch spec is not a file: ${launchPath}`);
  if (!isFile(promptPath)) throw new Error(`prompt is not a file: ${promptPath}`);
  assertLuvusEnv(env);

  const spec = readLaunchSpec(launchPath);
  // A resume reuses the spec unchanged, so its session and close grace carry
  // over; only the prompt and the pane are new.
  // `start` appends the parent-contact footer; a resume must too, or the child
  // has no instruction to send its report (the orchestrator then never wakes).
  let sentPrompt = promptPath;
  if (spec.parent !== undefined) {
    sentPrompt = `${promptPath}.resume.md`;
    writeFileSync(
      sentPrompt,
      `${readFileSync(promptPath, "utf8")}\n${parentFooter(spec.parent, env.LUVUS_PANE_ID)}\n`,
    );
  }
  const paneLine = paneCommandLine(CLI_PATH, launchPath, sentPrompt);

  const pane = createSurface(values.name ?? spec.name, placement, env.LUVUS_PANE_ID);
  runInPane(pane, paneLine);

  write(JSON.stringify({ pane, launch: launchPath }) + "\n");
  return 0;
}

/**
 * `run`: the pane-side wrapper. Resolve `pi` in this pane (so the pane's PATH
 * applies) and hand the spec to `runSpec`, which returns the exit code.
 */
async function runCommand(positionals: string[], deps: CliDeps): Promise<number> {
  const specPath = positionals[0];
  if (!specPath) throw new Error("missing <spec>");
  const promptPath = positionals[1];

  const spec = readLaunchSpec(specPath);
  const resolved =
    spec.command === "pi" ? resolvePiCommand({ env: deps.env ?? process.env }) : [spec.command];
  const command = resolved[0];
  const runDeps: RunSpecDeps = {
    env: deps.env,
    stdout: deps.stdout,
    stderr: deps.stderr,
    sleep: deps.sleep,
  };
  return runSpec(
    { ...spec, command, args: [...resolved.slice(1), ...spec.args] },
    promptPath,
    runDeps,
  );
}

/** Sentinel root, overridable for tests so they never touch the real tmp folder. */
function sentinelDir(env: NodeJS.ProcessEnv): string {
  return env.PI_LUVUS_SENTINEL_DIR ?? tmpdir();
}

/** Parse `--max-age-days`, defaulting to `DEFAULT_PRUNE_MAX_AGE_DAYS`. */
function pruneMaxAgeDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PRUNE_MAX_AGE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--max-age-days must be a non-negative number: ${value}`);
  }
  return days;
}

/** `prune`: delete launcher files older than the retention. */
function pruneCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const scratch = resolve(values.scratch ?? defaultScratchDir());
  const maxAgeDays = pruneMaxAgeDays(values["max-age-days"]);
  const dryRun = values["dry-run"] === true;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const files = pruneScratch(scratch, { maxAgeMs, dryRun });
  const sentinels = pruneSentinels(sentinelDir(deps.env ?? process.env), {
    maxAgeMs: 86_400_000,
    dryRun,
  });
  write(
    JSON.stringify({
      scratch,
      maxAgeDays,
      dryRun,
      scanned: files.scanned,
      deleted: files.deleted,
      deletedBytes: files.deletedBytes,
      sentinelScanned: sentinels.scanned,
      sentinelDeleted: sentinels.deleted,
    }) + "\n",
  );
  return 0;
}

/** `last-message`: print a session's last assistant message. */
function lastMessageCommand(values: CliValues, deps: CliDeps): number {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const sessionPath = required("--session", values.session);
  const text = findLastAssistantMessage(getNewEntries(sessionPath, 0));
  write(`${text ?? "(no assistant message)"}\n`);
  return 0;
}

/**
 * Run one CLI invocation and return the code the process should exit with.
 * Failures throw; the shim and the direct-entry wrapper turn them into a
 * message on stderr and a non-zero exit.
 */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const writeErr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const { values, positionals } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const command = positionals[0];

  if (values.help === true || command === "help") {
    write(`${USAGE}\n`);
    return 0;
  }
  if (command === undefined) {
    writeErr(`${USAGE}\n`);
    return 2;
  }
  if (command === "start" || command === "resume") {
    const requested = values.surface;
    const parsed = requested === undefined ? undefined : parseSurfacePlacement(requested);
    if (requested !== undefined && parsed === undefined) {
      writeErr(`invalid --surface value: ${requested} (expected right, down or tab)\n`);
      return 2;
    }
    // Explicit flag wins; otherwise the extension's configured default.
    const placement = parsed ?? loadSurfaceConfig(deps.configPath);
    if (command === "start") return startCommand(values as CliValues, deps, placement);
    return resumeCommand(values as CliValues, deps, placement);
  }
  if (command === "run") return runCommand(positionals.slice(1), deps);
  if (command === "last-message") return lastMessageCommand(values as CliValues, deps);
  if (command === "prune") return pruneCommand(values as CliValues, deps);
  throw new Error(`unknown subcommand: ${command}\n${USAGE}`);
}

/**
 * True when this module is the process entry, not an import from the shim.
 * Symlinks are resolved: an ESM loader that resolved a symlink would
 * otherwise leave the CLI silent.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(CLI_PATH);
  } catch {
    return resolve(entry) === CLI_PATH;
  }
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cli.ts: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
