import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Sandbox the Luvus ambient environment for the whole test process (see the
// same block in test.ts): an ambient Luvus session must never be reachable
// from an un-stubbed test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_")) delete process.env[key];
}
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LAUNCH_SPEC_VERSION,
  buildPaneTitle,
  paneCommandLine,
  readLaunchSpec,
  resolvePiCommand,
  validateLaunchSpec,
  writeLaunchSpec,
  type LaunchSpec,
} from "../pi-extension/luvus/launch.ts";
import { runSpec } from "../pi-extension/luvus/run.ts";
import { main } from "../pi-extension/luvus/cli.ts";
import { __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";
import { main as shimMain } from "../skills/pi-luvus/launch.ts";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-launch-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-run-test-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PI_STUB = join(TEST_DIR, "stubs", "pi-stub.ts");

/** Wait for a file the stub child writes, so a test can act while it runs. */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface RunOutcome {
  /** Exit code returned by `runSpec` (the code the CLI exits with). */
  code: number;
  stdout: string;
  stderr: string;
  /** Grace values passed to the injected `sleep`, in order. */
  sleptMs: number[];
  /** Pane ids passed to the injected `closePane`, in order. */
  closedPanes: string[];
  /** What the stub child recorded from its own argv and environment. */
  record: { args: string[]; env: Record<string, string> } | null;
  /** `<session>.exit` contents, or null when the stub wrote none. */
  sidecar: string | null;
}

interface RunCase {
  /** Spec fields merged over the stub defaults. */
  spec?: Partial<LaunchSpec>;
  /** Extra wrapper environment, merged over the test defaults. */
  env?: NodeJS.ProcessEnv;
  /** Prompt path passed to `runSpec`, if any. */
  prompt?: string;
}

/** Run the wrapper against the stub child with every side effect recorded. */
async function runStubCase(dir: string, options: RunCase = {}): Promise<RunOutcome> {
  const recordPath = join(dir, "record.json");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleptMs: number[] = [];
  const closedPanes: string[] = [];
  const spec: LaunchSpec = {
    version: LAUNCH_SPEC_VERSION,
    name: "scout-1",
    env: {},
    command: process.execPath,
    args: [PI_STUB],
    sessionFile: join(dir, "session.jsonl"),
    ...options.spec,
  };
  const exitPath = spec.sessionFile === undefined ? undefined : `${spec.sessionFile}.exit`;

  const code = await runSpec(spec, options.prompt, {
    env: {
      PATH: process.env.PATH,
      LUVUS_PANE_ID: "77",
      PI_STUB_RECORD: recordPath,
      PI_STUB_EXIT: exitPath,
      ...options.env,
    },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    sleep: async (ms) => {
      sleptMs.push(ms);
    },
    closePane: (pane) => closedPanes.push(pane),
  });

  const record = existsSync(recordPath)
    ? (JSON.parse(readFileSync(recordPath, "utf8")) as RunOutcome["record"])
    : null;
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    sleptMs,
    closedPanes,
    record,
    sidecar: exitPath !== undefined && existsSync(exitPath) ? readFileSync(exitPath, "utf8") : null,
  };
}

const SPEC: LaunchSpec = {
  version: LAUNCH_SPEC_VERSION,
  name: "scout-1",
  env: { PI_LUVUS_SESSION: "/tmp/session.jsonl" },
  command: "pi",
  args: ["--session", "/tmp/session.jsonl"],
  closeOnDone: { graceMs: 0 },
};

describe("launch spec", () => {
  it("round-trips a spec through writeLaunchSpec and readLaunchSpec", () => {
    withTempDir((dir) => {
      const specPath = join(dir, "nested", "scout-1.json");
      writeLaunchSpec(specPath, SPEC);
      assert.deepEqual(readLaunchSpec(specPath), SPEC);
    });
  });

  it("rejects malformed JSON", () => {
    withTempDir((dir) => {
      const specPath = join(dir, "bad.json");
      writeFileSync(specPath, "{ not json");
      assert.throws(() => readLaunchSpec(specPath), /Cannot read launch spec/);
    });
  });

  it("rejects a missing command", () => {
    assert.throws(
      () => validateLaunchSpec({ version: LAUNCH_SPEC_VERSION, name: "x", env: {}, args: [] }),
      /missing command/,
    );
  });

  it("rejects an unknown version", () => {
    assert.throws(() => validateLaunchSpec({ ...SPEC, version: 2 }), /unknown version 2/);
  });
});

describe("paneCommandLine", () => {
  it("builds the documented node command line and double-quotes every later token", () => {
    assert.equal(
      paneCommandLine("/ext/cli.ts", "/tmp/sc ratch/spec.json"),
      'node "/ext/cli.ts" "run" "/tmp/sc ratch/spec.json"',
    );
  });

  it("appends the prompt as the last token", () => {
    assert.equal(
      paneCommandLine("/ext/cli.ts", "/spec.json", "/tmp/prompt one.md"),
      'node "/ext/cli.ts" "run" "/spec.json" "/tmp/prompt one.md"',
    );
  });

  it("rejects a token with any character a supported shell would expand", () => {
    const unsafe = [
      "/tmp/a$b",
      "/tmp/a%b",
      '/tmp/a"b',
      "/tmp/a`b",
      "/tmp/a!b",
      "/tmp/a\\\\b",
      "/tmp/a\u0007b",
    ];
    for (const token of unsafe) {
      assert.throws(
        () => paneCommandLine("/ext/cli.ts", token),
        /Unsafe pane command token/,
        `expected rejection for ${JSON.stringify(token)}`,
      );
    }
  });

  it("allows single backslashes in a Windows path", () => {
    assert.equal(
      paneCommandLine("C:\\ext\\cli.ts", "C:\\spec.json"),
      'node "C:\\ext\\cli.ts" "run" "C:\\spec.json"',
    );
  });
});

describe("buildPaneTitle", () => {
  it("strips control characters and escape sequences from hostile task text", () => {
    assert.equal(
      buildPaneTitle("Scout", "Fix\x1b[2J the\x07 bug\nsecond line"),
      "Scout — Fix[2J the bug",
    );
    assert.equal(buildPaneTitle("Scout", "x".repeat(60)), "Scout — " + "x".repeat(48));
  });

  it("titles with the name alone when the task is missing or empty, and nothing for an unprintable name", () => {
    assert.equal(buildPaneTitle("Scout"), "Scout");
    assert.equal(buildPaneTitle("Scout", ""), "Scout");
    assert.equal(buildPaneTitle("Scout", "\n   \n"), "Scout");
    assert.equal(buildPaneTitle(""), "");
    assert.equal(buildPaneTitle("\x1b\x07"), "");
  });
});

describe("resolvePiCommand", () => {
  it("prefers PI_LUVUS_PI_ENTRY and runs it with the current node", () => {
    assert.deepEqual(
      resolvePiCommand({
        platform: "linux",
        env: { PI_LUVUS_PI_ENTRY: "/opt/pi/entry.js" },
        execPath: "/usr/bin/node",
      }),
      ["/usr/bin/node", "/opt/pi/entry.js"],
    );
  });

  it("resolves a win32 npm pi.cmd to the sibling package bin entry", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "pi.cmd"), "@echo off\n");
      const packageDir = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(join(packageDir, "dist", "bundle"), { recursive: true });
      writeFileSync(join(packageDir, "dist", "bundle", "cli.js"), "// pi entry\n");
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          bin: { pi: "dist/bundle/cli.js" },
        }),
      );
      assert.deepEqual(
        resolvePiCommand({
          platform: "win32",
          env: { PATH: `C:\\Windows;${dir}` },
          execPath: "C:\\node.exe",
        }),
        ["C:\\node.exe", join(packageDir, "dist", "bundle", "cli.js")],
      );
    });
  });

  it("skips a win32 pi.cmd that has no sibling pi package and falls back to pi", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "pi.cmd"), "@echo off\n");
      assert.deepEqual(
        resolvePiCommand({ platform: "win32", env: { PATH: dir }, execPath: "/node" }),
        ["pi"],
      );
    });
  });

  it("falls back to pi on posix", () => {
    assert.deepEqual(
      resolvePiCommand({ platform: "linux", env: { PATH: "/usr/bin" }, execPath: "/node" }),
      ["pi"],
    );
  });
});

describe("runSpec", () => {
  it("wakes the parent when the child exits without a report", async () => {
    await withTempDirAsync(async (dir) => {
      const session = join(dir, "session.jsonl");
      // An earlier run's report and the footer placeholder must not count.
      writeFileSync(session, "agent send boss 'old report'\nagent send boss '<text>'\n");
      const sent: string[] = [];
      await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "rev",
          env: {},
          command: process.execPath,
          args: [PI_STUB],
          sessionFile: session,
          parent: "boss",
        },
        undefined,
        {
          env: { PATH: process.env.PATH },
          stdout: () => {},
          stderr: () => {},
          sendToParent: (to, text) => sent.push(`${to}:${text}`),
        },
      );
      assert.equal(sent.length, 1);
      assert.match(sent[0], /^boss:rev exited without sending a report/);
    });
  });

  it("stays quiet when the session gained a report", async () => {
    await withTempDirAsync(async (dir) => {
      const session = join(dir, "session.jsonl");
      const stub = join(dir, "reporter.mjs");
      writeFileSync(
        stub,
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(session)}, "agent send boss 'PASS'\\n");`,
      );
      const sent: string[] = [];
      await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "rev",
          env: {},
          command: process.execPath,
          args: [stub],
          sessionFile: session,
          parent: "boss",
        },
        undefined,
        {
          env: { PATH: process.env.PATH },
          stdout: () => {},
          stderr: () => {},
          sendToParent: (to, text) => sent.push(`${to}:${text}`),
        },
      );
      assert.deepEqual(sent, []);
    });
  });

  it("counts a double-quoted report", async () => {
    await withTempDirAsync(async (dir) => {
      const session = join(dir, "session.jsonl");
      const stub = join(dir, "reporter.mjs");
      // JSONL escapes the quote: luvus agent send boss \"$(cat r.txt)\"
      writeFileSync(
        stub,
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(session)}, 'agent send boss \\\\"$(cat r.txt)\\\\"\\n');`,
      );
      const sent: string[] = [];
      await runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "rev",
          env: {},
          command: process.execPath,
          args: [stub],
          sessionFile: session,
          parent: "boss",
        },
        undefined,
        {
          env: { PATH: process.env.PATH },
          stdout: () => {},
          stderr: () => {},
          sendToParent: (to, text) => sent.push(`${to}:${text}`),
        },
      );
      assert.deepEqual(sent, []);
    });
  });

  it("prints the sentinel and returns the child's code (0)", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_CODE: "0" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.equal(result.code, 0);
      assert.deepEqual(result.record?.args, []);
    });
  });

  it("prints the sentinel and returns the child's code (1)", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_CODE: "1" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_1__\n");
      assert.equal(result.code, 1);
    });
  });

  it("reports 127 and names the command when the child cannot start", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { spec: { command: "definitely-not-a-real-pi-xyz" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_127__\n");
      assert.equal(result.code, 127);
      assert.match(result.stderr, /definitely-not-a-real-pi-xyz/);
      assert.equal(result.record, null);
    });
  });

  it("reports 128 + signal when a signal ended the child", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_SIGNAL: "SIGTERM" } });
      assert.equal(result.stdout, "__SUBAGENT_DONE_143__\n");
      assert.equal(result.code, 143);
    });
  });

  it("merges spec env over the wrapper env, with PI_LUVUS_SURFACE from the wrapper's pane", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        env: { LUVUS_PANE_ID: "55", PI_RUN_BASE: "base", PI_RUN_SHARED: "base" },
        spec: { env: { PI_RUN_SPEC: "spec", PI_RUN_SHARED: "spec" } },
      });
      assert.ok(result.record);
      assert.equal(result.record.env.PI_LUVUS_SURFACE, "55");
      assert.equal(result.record.env.PI_RUN_BASE, "base");
      assert.equal(result.record.env.PI_RUN_SPEC, "spec");
      assert.equal(result.record.env.PI_RUN_SHARED, "spec");
    });
  });

  it("appends the prompt as one @ argument, with no shell interpretation", async () => {
    await withTempDirAsync(async (dir) => {
      const prompt = join(dir, "a $HOME prompt.md");
      writeFileSync(prompt, "follow up\n");
      const result = await runStubCase(dir, {
        spec: { args: [PI_STUB, "--session", join(dir, "s.jsonl")] },
        prompt,
      });
      assert.deepEqual(result.record?.args, ["--session", join(dir, "s.jsonl"), `@${prompt}`]);
    });
  });

  // SIGINT is ignored for the wrapper, not sent to a child here: `process.kill`
  // on Windows would terminate the test runner instead.
  it("ignores SIGINT while the child runs", { skip: process.platform === "win32" }, async () => {
    await withTempDirAsync(async (dir) => {
      const recordPath = join(dir, "record.json");
      const stdout: string[] = [];
      const listenersBefore = process.listenerCount("SIGINT");
      const running = runSpec(
        {
          version: LAUNCH_SPEC_VERSION,
          name: "scout-1",
          env: {},
          command: process.execPath,
          args: [PI_STUB],
          sessionFile: join(dir, "session.jsonl"),
        },
        undefined,
        {
          env: {
            PATH: process.env.PATH,
            LUVUS_PANE_ID: "77",
            PI_STUB_RECORD: recordPath,
            PI_STUB_DELAY_MS: "500",
          },
          stdout: (text) => stdout.push(text),
          stderr: () => {},
        },
      );
      await waitForFile(recordPath);
      assert.equal(process.listenerCount("SIGINT"), listenersBefore + 1);
      process.kill(process.pid, "SIGINT");
      assert.equal(await running, 0);
      assert.equal(stdout.join(""), "__SUBAGENT_DONE_0__\n");
      assert.equal(process.listenerCount("SIGINT"), listenersBefore);
    });
  });
});

describe("runSpec close on done", () => {
  const DONE = '{"type":"done"}';

  it("closes the pane after the grace when the sidecar is done, and keeps the sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: DONE },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.deepEqual(result.sleptMs, [5000]);
      assert.deepEqual(result.closedPanes, ["77"]);
      assert.equal(result.sidecar, DONE);
    });
  });

  it("closes at once with grace 0", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 0 } },
        env: { PI_STUB_EXIT_BODY: DONE },
      });
      assert.deepEqual(result.sleptMs, []);
      assert.deepEqual(result.closedPanes, ["77"]);
      assert.equal(result.sidecar, DONE);
    });
  });

  it("leaves the pane open for an error sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: '{"type":"error","message":"boom"}', PI_STUB_CODE: "1" },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_1__\n");
      assert.deepEqual(result.sleptMs, []);
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, '{"type":"error","message":"boom"}');
    });
  });

  it("leaves the pane open when the child wrote no sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { spec: { closeOnDone: { graceMs: 5000 } } });
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, null);
    });
  });

  it("closes the pane after the grace for a handoff sidecar too", async () => {
    await withTempDirAsync(async (dir) => {
      const HANDOFF = '{"type":"handoff","message":"Goal: X. Done: A. Left: B."}';
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: HANDOFF },
      });
      assert.equal(result.stdout, "__SUBAGENT_DONE_0__\n");
      assert.deepEqual(result.sleptMs, [5000]);
      assert.deepEqual(result.closedPanes, ["77"]);
      assert.equal(result.sidecar, HANDOFF);
    });
  });

  it("leaves the pane open for a malformed sidecar", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: "not json" },
      });
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, "not json");
    });
  });

  it("leaves the pane open for an unknown sidecar type", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, {
        spec: { closeOnDone: { graceMs: 5000 } },
        env: { PI_STUB_EXIT_BODY: '{"type":"weird"}' },
      });
      assert.deepEqual(result.closedPanes, []);
    });
  });

  it("leaves the pane open for a pi-parent launch without closeOnDone", async () => {
    await withTempDirAsync(async (dir) => {
      const result = await runStubCase(dir, { env: { PI_STUB_EXIT_BODY: DONE } });
      assert.deepEqual(result.closedPanes, []);
      assert.equal(result.sidecar, DONE);
    });
  });
});

// ─── cli.ts ─────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(TEST_DIR, "..");
const CLI = join(REPO_ROOT, "pi-extension", "luvus", "cli.ts");

let workdir = "";
const luvusCalls: string[] = [];
let defaultConfigPath = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "cli-cli-test-"));
  // Sandbox the surface default: the CLI reads config.json, so a test must
  // never see the machine's real one.
  defaultConfigPath = join(workdir, "config.json");
  writeFileSync(defaultConfigPath, JSON.stringify({ status: { enabled: true }, surface: "right" }));
  // In-process Luvus seam: logs each argv line and returns canned JSON
  // envelopes. `pane split` yields pane 24; `agent list` places the caller in
  // tab 7; everything else is ok.
  __setLuvusExecForTests__((args) => {
    luvusCalls.push(args.join(" "));
    if (args[0] === "agent" && args[1] === "list") {
      return JSON.stringify({ id: "1", result: { agents: [{ pane: "21", tab: "7" }] } });
    }
    if (args[0] === "pane" && args[1] === "split") {
      return JSON.stringify({
        id: "1",
        result: { pane: "24", revision: 1, type: "pane", tab: "1", workspace: "2" },
      });
    }
    return JSON.stringify({ id: "1", result: { revision: 1, type: "ok" } });
  });
});

after(() => {
  __setLuvusExecForTests__(null);
  rmSync(workdir, { recursive: true, force: true });
});

beforeEach(() => {
  luvusCalls.length = 0;
});

/** Luvus environment for a CLI run, with ambient LUVUS_* keys replaced. */
function luvusEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LUVUS_ENV: "1",
    LUVUS_BIN_PATH: "in-process",
    LUVUS_PANE_ID: "21",
    ...extra,
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliDepsLike {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  configPath?: string;
}

/** A `main(argv, deps)` entry point: the CLI itself or the skill shim. */
type CliEntry = (argv: string[], deps: CliDepsLike) => Promise<number>;

/** Run an entry point with captured output and no real close timer. */
async function capture(
  entry: CliEntry,
  argv: string[],
  env: NodeJS.ProcessEnv,
  configPath = defaultConfigPath,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await entry(argv, {
    env,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    sleep: async () => {},
    configPath,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  configPath?: string,
): Promise<CliResult> {
  return capture(main, argv, env, configPath);
}

/** Write a role definition under the child cwd's `.pi/agents/`. */
function writeRole(cwd: string, name: string, frontmatter: string, body: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

interface StartCase {
  cwd: string;
  role?: string;
  child?: string;
  parent?: string;
  scratch?: string;
  closeGraceMs?: number;
  brief?: string;
  /** Run with no Luvus env at all. */
  bare?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Config file holding the `surface` default; defaults to the sandbox config. */
  configPath?: string;
  /** Explicit `--surface` flag. */
  surface?: string;
}

interface Started extends CliResult {
  json: { pane: string; session: string; launch: string };
  spec: LaunchSpec;
  scratch: string;
  promptPath: string;
  rolePromptPath: string;
}

/** Start a child through a CLI entry point and return its JSON, spec and scratch files. */
async function runStartWith(entry: CliEntry, options: StartCase): Promise<Started> {
  const dir = mkdtempSync(join(workdir, "start-"));
  const brief = join(dir, "brief.md");
  writeFileSync(brief, options.brief ?? "# Task\n\nDo the thing.\n");
  const scratch = options.scratch ?? join(dir, "scratch");
  const env = options.bare ? { PATH: process.env.PATH } : luvusEnv(options.env);
  const argv = [
    "start",
    "--name",
    options.child ?? "scout-1",
    "--role",
    options.role ?? "worker",
    "--cwd",
    options.cwd,
    "--brief",
    brief,
    "--parent",
    options.parent ?? "orch",
    "--scratch",
    scratch,
  ];
  if (options.closeGraceMs !== undefined)
    argv.push("--close-grace-ms", String(options.closeGraceMs));
  if (options.surface !== undefined) argv.push("--surface", options.surface);

  const result = await capture(entry, argv, env, options.configPath);
  const json = JSON.parse(result.stdout) as Started["json"];
  const promptName = readdirSync(scratch).find((file) => file.endsWith(".prompt.md"));
  const roleName = readdirSync(scratch).find((file) => file.endsWith(".role.md"));
  assert.ok(promptName && roleName, "expected the scratch files to be written");
  return {
    ...result,
    json,
    spec: readLaunchSpec(json.launch),
    scratch,
    promptPath: join(scratch, promptName),
    rolePromptPath: join(scratch, roleName),
  };
}

async function runStart(options: StartCase): Promise<Started> {
  return runStartWith(main, options);
}

/** Run a failing start and return the error message. */
async function startFailure(options: StartCase): Promise<string> {
  return startFailureWith(main, options);
}

async function startFailureWith(entry: CliEntry, options: StartCase): Promise<string> {
  try {
    await runStartWith(entry, options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected start to fail, but it succeeded");
}

describe("cli.ts start", () => {
  it("fails outside Luvus and creates nothing", async () => {
    const dir = mkdtempSync(join(workdir, "outside-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    const scratch = join(dir, "scratch");
    const message = await startFailure({ cwd, scratch, bare: true });
    assert.match(message, /Luvus/);
    assert.equal(existsSync(scratch), false);
  });

  it("writes the spec, the prompts and the pane line, and prints JSON", async () => {
    const cwd = mkdtempSync(join(workdir, "contract-cwd-"));
    writeRole(
      cwd,
      "doer",
      "model: test-model\nthinking: high\ntools: read\nauto-exit: true",
      "Doer role body.",
    );
    const res = await runStart({ cwd, role: "doer", child: "fix-7", parent: "orch" });

    // Stdout is exactly one JSON document with pane, session and launch.
    assert.equal(res.code, 0);
    assert.equal(res.json.pane, "24");
    assert.ok(res.json.session.endsWith(".jsonl"));
    assert.ok(existsSync(res.json.launch));

    // Recorded Luvus calls, in order.
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name fix-7 --pane 24",
      `pane run 24 ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
    ]);

    // Footer names the parent and pane, and forbids the wrong channels.
    const promptText = readFileSync(res.promptPath, "utf8");
    assert.ok(promptText.includes("# Task"));
    assert.ok(promptText.includes("luvus agent send orch"));
    assert.ok(promptText.includes("pane 21"));
    assert.ok(promptText.includes("luvus_done"));

    // Role prompt holds the role body.
    assert.ok(readFileSync(res.rolePromptPath, "utf8").includes("Doer role body."));

    // The spec holds everything the pane needs, and no surface: it stays
    // pane-independent.
    const { spec } = res;
    assert.equal(spec.name, "fix-7");
    assert.equal(spec.cwd, cwd);
    assert.equal(spec.command, "pi");
    assert.equal(spec.sessionFile, res.json.session);
    assert.equal(spec.env.PI_LUVUS_NAME, "fix-7");
    assert.equal(spec.env.PI_LUVUS_AGENT, "doer");
    assert.equal(spec.env.PI_LUVUS_SESSION, res.json.session);
    assert.equal(spec.env.PI_LUVUS_SURFACE, undefined);
    assert.equal(spec.env.PI_LUVUS_AUTO_EXIT, "1");
    assert.match(String(spec.env.PI_LUVUS_ID), /^[0-9a-f]{8}$/);
    assert.ok(String(spec.env.PI_LUVUS_ACTIVITY_FILE).endsWith(".activity.json"));
    assert.equal(argValue(spec.args, "--session"), res.json.session);
    assert.equal(
      argValue(spec.args, "-e"),
      join(REPO_ROOT, "pi-extension", "luvus", "luvus-done.ts"),
    );
    assert.equal(argValue(spec.args, "--model"), "test-model:high");
    assert.equal(argValue(spec.args, "--append-system-prompt"), res.rolePromptPath);
    assert.equal(argValue(spec.args, "--tools"), "read,caller_ping,luvus_done,luvus_message");
    assert.equal(argValue(spec.args, "--name"), "fix-7");
    assert.equal(spec.closeOnDone?.graceMs, 5000);
    assert.equal(spec.title, "fix-7 — # Task");
  });

  it("sets PI_LUVUS_AUTO_EXIT=1 only for auto-exit roles", async () => {
    const fastCwd = mkdtempSync(join(workdir, "fast-"));
    writeRole(fastCwd, "fast", "model: m\nthinking: low\nauto-exit: true", "Fast body.");
    assert.equal((await runStart({ cwd: fastCwd, role: "fast" })).spec.env.PI_LUVUS_AUTO_EXIT, "1");

    const slowCwd = mkdtempSync(join(workdir, "slow-"));
    writeRole(slowCwd, "slow", "model: m\nthinking: low", "Slow body.");
    assert.equal(
      (await runStart({ cwd: slowCwd, role: "slow" })).spec.env.PI_LUVUS_AUTO_EXIT,
      undefined,
    );
  });

  it("appends missing control tools to the role tools", async () => {
    const cwd = mkdtempSync(join(workdir, "thin-"));
    writeRole(
      cwd,
      "thin",
      "model: m\nthinking: low\ntools: read, bash\nauto-exit: true",
      "Thin body.",
    );
    const res = await runStart({ cwd, role: "thin" });
    assert.equal(
      argValue(res.spec.args, "--tools"),
      "read,bash,caller_ping,luvus_done,luvus_message",
    );
  });

  it("uses the default tool list when the role has no tools", async () => {
    const cwd = mkdtempSync(join(workdir, "plain-"));
    writeRole(cwd, "plain", "model: m\nthinking: low\nauto-exit: true", "Plain body.");
    const res = await runStart({ cwd, role: "plain" });
    assert.equal(
      argValue(res.spec.args, "--tools"),
      "read,bash,edit,write,grep,find,ls,caller_ping,luvus_done,luvus_message",
    );
  });

  it("stores the close grace from --close-grace-ms", async () => {
    const cwd = mkdtempSync(join(workdir, "grace-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const res = await runStart({ cwd, role: "doer", closeGraceMs: 0 });
    assert.equal(res.spec.closeOnDone?.graceMs, 0);
  });

  it("fails before splitting for an unknown role", async () => {
    const cwd = mkdtempSync(join(workdir, "norole-"));
    const message = await startFailure({ cwd, role: "nope" });
    assert.match(message, /unknown role 'nope'/);
    assert.match(message, /\.pi\/agents/);
    assert.equal(luvusCalls.length, 0);
  });

  it("fails before splitting when model is empty", async () => {
    const cwd = mkdtempSync(join(workdir, "nomodel-"));
    writeRole(cwd, "nomodel", "model: \nthinking: low", "No model body.");
    const message = await startFailure({ cwd, role: "nomodel" });
    assert.match(message, /empty model/);
    assert.equal(luvusCalls.length, 0);
  });

  it("records no pane split call on role failures", async () => {
    const cwd = mkdtempSync(join(workdir, "rolefail-"));
    writeRole(cwd, "nomodel2", "model: \nthinking: low", "No model body.");
    assert.match(await startFailure({ cwd, role: "missing-role" }), /unknown role/);
    assert.match(await startFailure({ cwd, role: "nomodel2" }), /empty model/);
    assert.equal(luvusCalls.filter((call) => call.startsWith("pane split")).length, 0);
  });

  it("fails before splitting when the scratch path is unsafe", async () => {
    const cwd = mkdtempSync(join(workdir, "unsafe-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const message = await startFailure({ cwd, role: "doer", scratch: join(workdir, "sc$ratch") });
    assert.match(message, /Unsafe pane command token/);
    assert.match(message, /sc\$ratch/);
    assert.equal(luvusCalls.length, 0);
  });

  it("keeps hostile names out of the pane line and delivers them as arguments", async () => {
    const cwd = mkdtempSync(join(workdir, "hostile-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const child = "a;b $(touch pwned) 'q";
    const res = await runStart({
      cwd,
      role: "doer",
      child,
      scratch: join(mkdtempSync(join(workdir, "hostile-")), "sc ratch"),
    });

    // The pane line follows the token rule by construction: the scratch paths
    // carry no character a shell would expand.
    assert.equal(res.json.launch.includes("$"), false);
    assert.equal(res.promptPath.includes("$"), false);
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name a-b-touch-pwned-q --pane 24",
      `pane run 24 ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
    ]);

    // Running the spec the way the pane does delivers the raw name and the
    // prompt path as single argv entries, with no shell in between.
    const recordPath = join(dirname(res.json.launch), "record.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(["run", res.json.launch, res.promptPath], {
      env: luvusEnv({
        PI_LUVUS_PI_ENTRY: PI_STUB,
        PI_STUB_RECORD: recordPath,
        LUVUS_PANE_ID: "99",
      }),
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.equal(stderr.join(""), "");
    assert.equal(stdout.join(""), "__SUBAGENT_DONE_0__\n");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { args: string[] };
    assert.equal(argValue(record.args, "--name"), child);
    assert.equal(record.args[record.args.length - 1], `@${res.promptPath}`);
  });

  it("--surface tab moves the new pane into its own tab and restores the caller's focus", async () => {
    const cwd = mkdtempSync(join(workdir, "tab-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const res = await runStart({ cwd, role: "doer", child: "fix-7", surface: "tab" });

    assert.equal(res.code, 0);
    assert.equal(res.json.pane, "24");
    assert.deepEqual(luvusCalls, [
      "agent list",
      "pane split 21 --right --no-focus",
      "pane name fix-7 --pane 24",
      "pane move 24 --new-tab",
      "tab focus 7",
      `pane run 24 ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
    ]);
  });

  it("closes the tab pane on done, not the caller's pane", async () => {
    const cwd = mkdtempSync(join(workdir, "tabclose-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const started = await runStart({ cwd, role: "doer", child: "fix-7", surface: "tab" });

    // Run the launch spec the way the tab's run wrapper does. `LUVUS_PANE_ID`
    // is the tab pane (24), so close-on-done closes the wrapper's own pane —
    // and with it the tab — never the caller's pane (21).
    const closed: string[] = [];
    const code = await runSpec(
      { ...readLaunchSpec(started.json.launch), command: process.execPath, args: [PI_STUB] },
      undefined,
      {
        env: {
          PATH: process.env.PATH,
          LUVUS_PANE_ID: "24",
          PI_STUB_EXIT: `${started.json.session}.exit`,
          PI_STUB_EXIT_BODY: '{"type":"done"}',
        },
        stdout: () => {},
        stderr: () => {},
        sleep: async () => {},
        closePane: (pane) => closed.push(pane),
      },
    );
    assert.equal(code, 0);
    assert.deepEqual(closed, ["24"]);
  });

  it("defaults --surface to the config.json value", async () => {
    const cwd = mkdtempSync(join(workdir, "cfgsurface-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const configPath = join(mkdtempSync(join(workdir, "surface-config-")), "config.json");
    writeFileSync(configPath, JSON.stringify({ surface: "down" }));

    const res = await runStart({ cwd, role: "doer", configPath });
    assert.equal(res.code, 0);
    assert.deepEqual(luvusCalls, [
      "pane split 21 --down --no-focus",
      "pane name scout-1 --pane 24",
      `pane run 24 ${paneCommandLine(CLI, res.json.launch, res.promptPath)}`,
    ]);
  });

  it("rejects an unknown --surface value with exit code 2 and no pane", async () => {
    const cwd = mkdtempSync(join(workdir, "badsurface-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low", "Body.");
    const dir = mkdtempSync(join(workdir, "badsurface-"));
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "Do it.\n");

    const res = await runCli(
      [
        "start",
        "--name",
        "fix-7",
        "--role",
        "doer",
        "--cwd",
        cwd,
        "--brief",
        brief,
        "--parent",
        "orch",
        "--scratch",
        join(dir, "scratch"),
        "--surface",
        "sideways",
      ],
      luvusEnv(),
    );
    assert.equal(res.code, 2);
    assert.match(res.stderr, /invalid --surface value: sideways/);
    assert.deepEqual(luvusCalls, []);
  });
});

describe("cli.ts resume", () => {
  /** Start a named child whose spec carries a non-default close grace. */
  async function startNamedChild(): Promise<Started> {
    const cwd = mkdtempSync(join(workdir, "resume-cwd-"));
    writeRole(cwd, "doer", "model: m\nthinking: low\nauto-exit: true", "Body.");
    const started = await runStart({ cwd, role: "doer", child: "fix-7", closeGraceMs: 2500 });
    luvusCalls.length = 0;
    return started;
  }

  it("splits a new pane, runs the same spec with the new prompt, and keeps the session and grace", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up task.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--name", "fix-7"],
      luvusEnv(),
    );
    const json = JSON.parse(res.stdout) as { pane: string; launch: string };
    assert.equal(res.code, 0);
    assert.equal(json.pane, "24");
    assert.equal(json.launch, started.json.launch);
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name fix-7 --pane 24",
      `pane run 24 ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
    ]);

    // The resume prompt carries the parent-contact footer, as `start` does.
    const sent = readFileSync(`${followup}.resume.md`, "utf8");
    assert.match(sent, /^Follow-up task\./);
    assert.match(sent, /luvus agent send /);

    // The spec is reused unchanged: pi resumes the same session, and the
    // close grace carries over.
    const spec = readLaunchSpec(started.json.launch);
    assert.equal(spec.sessionFile, started.json.session);
    assert.equal(argValue(spec.args, "--session"), started.json.session);
    assert.equal(spec.closeOnDone?.graceMs, 2500);
  });

  it("uses the spec name when --name is omitted", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");

    await runCli(["resume", "--launch", started.json.launch, "--prompt", followup], luvusEnv());
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name fix-7 --pane 24",
      `pane run 24 ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
    ]);
  });

  it("fails before splitting when the prompt path is unsafe", async () => {
    const started = await startNamedChild();
    const unsafe = join(dirname(started.json.launch), "pro$mpt.md");
    writeFileSync(unsafe, "Follow-up.\n");
    await assert.rejects(
      runCli(["resume", "--launch", started.json.launch, "--prompt", unsafe], luvusEnv()),
      /Unsafe pane command token/,
    );
    assert.equal(
      luvusCalls.some((call) => call.startsWith("pane split")),
      false,
    );
  });

  it("--surface tab moves the resumed pane into its own tab", async () => {
    const started = await startNamedChild();
    const followup = join(dirname(started.json.launch), "followup.md");
    writeFileSync(followup, "Follow-up.\n");

    const res = await runCli(
      ["resume", "--launch", started.json.launch, "--prompt", followup, "--surface", "tab"],
      luvusEnv(),
    );
    assert.equal(res.code, 0);
    assert.deepEqual(luvusCalls, [
      "agent list",
      "pane split 21 --right --no-focus",
      "pane name fix-7 --pane 24",
      "pane move 24 --new-tab",
      "tab focus 7",
      `pane run 24 ${paneCommandLine(CLI, started.json.launch, `${followup}.resume.md`)}`,
    ]);
  });
});

describe("cli.ts run", () => {
  it("resolves pi from PI_LUVUS_PI_ENTRY and returns the child's code", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "spec.json");
      writeLaunchSpec(specPath, {
        version: LAUNCH_SPEC_VERSION,
        name: "scout-1",
        env: {},
        command: "pi",
        args: [],
        sessionFile: join(dir, "session.jsonl"),
      });
      const res = await runCli(
        ["run", specPath],
        luvusEnv({ PI_LUVUS_PI_ENTRY: PI_STUB, PI_STUB_CODE: "3" }),
      );
      assert.equal(res.code, 3);
      assert.equal(res.stdout, "__SUBAGENT_DONE_3__\n");
    });
  });

  it("fails naming the file for a corrupt spec", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "bad.json");
      writeFileSync(specPath, "{ not json");
      await assert.rejects(runCli(["run", specPath], luvusEnv()), /Cannot read launch spec/);
    });
  });

  it("fails naming the file when the spec is invalid", async () => {
    await withTempDirAsync(async (dir) => {
      const specPath = join(dir, "nocmd.json");
      writeFileSync(
        specPath,
        JSON.stringify({ version: LAUNCH_SPEC_VERSION, name: "x", env: {}, args: [] }),
      );
      await assert.rejects(runCli(["run", specPath], luvusEnv()), (error: Error) => {
        assert.match(error.message, /Cannot read launch spec/);
        assert.ok(error.message.includes(specPath));
        return true;
      });
    });
  });
});

describe("cli.ts last-message", () => {
  function writeSession(path: string, entries: unknown[]): void {
    writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }

  it("prints the last assistant message with text", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      writeSession(sessionPath, [
        { type: "session", id: "s1" },
        {
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "do it" }] },
        },
        {
          type: "message",
          id: "m2",
          message: { role: "assistant", content: [{ type: "text", text: "draft" }] },
        },
        {
          type: "message",
          id: "m3",
          message: { role: "assistant", content: [{ type: "text", text: "final report" }] },
        },
      ]);
      const res = await runCli(["last-message", "--session", sessionPath], luvusEnv());
      assert.equal(res.code, 0);
      assert.equal(res.stdout, "final report\n");
    });
  });

  it("prints (no assistant message) when the session has none", async () => {
    await withTempDirAsync(async (dir) => {
      const sessionPath = join(dir, "session.jsonl");
      writeSession(sessionPath, [
        { type: "session", id: "s1" },
        {
          type: "message",
          id: "m1",
          message: { role: "user", content: [{ type: "text", text: "do it" }] },
        },
      ]);
      const res = await runCli(["last-message", "--session", sessionPath], luvusEnv());
      assert.equal(res.stdout, "(no assistant message)\n");
    });
  });
});

// ─── skills/pi-luvus/launch.ts ──────────────────────────────────────────

const SHIM = join(REPO_ROOT, "skills", "pi-luvus", "launch.ts");
const SHIM_CLI = join(REPO_ROOT, "pi-extension", "luvus", "cli.ts");
const SHIM_DONE = join(REPO_ROOT, "pi-extension", "luvus", "luvus-done.ts");
const GIT_INSTALL_RELATIVE = join("git", "github.com", "slatkin", "pi-luvus");

interface ShimModule {
  main: CliEntry;
}

let shimImports = 0;

/**
 * Import a shim file by path. The query makes each copy a fresh module, so a
 * copied shim sees its own location rather than the shipped one.
 */
async function importShim(path: string): Promise<ShimModule> {
  return (await import(`${pathToFileURL(path).href}?shim=${++shimImports}`)) as ShimModule;
}

/** Copy the shipped shim into its own `<root>/skills/pi-luvus/` tree. */
function copyShim(root: string): string {
  const dir = join(root, "skills", "pi-luvus");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "launch.ts");
  copyFileSync(SHIM, path);
  return path;
}

/**
 * A fake extension root with this checkout's behaviour: a copy of
 * `pi-extension/luvus` whose `luvus.ts` re-exports the checkout's own
 * module, so this process's Luvus seam still sees the pane calls. Returns the
 * resolved root.
 */
function makeInstall(root: string): string {
  mkdirSync(join(root, "pi-extension"), { recursive: true });
  cpSync(join(REPO_ROOT, "pi-extension", "luvus"), join(root, "pi-extension", "luvus"), {
    recursive: true,
  });
  const checkoutLuvus = pathToFileURL(join(REPO_ROOT, "pi-extension", "luvus", "luvus.ts")).href;
  writeFileSync(
    join(root, "pi-extension", "luvus", "luvus.ts"),
    `export * from ${JSON.stringify(checkoutLuvus)};\n`,
  );
  return realpathSync(root);
}

/** A child cwd holding the role in its own `.pi/agents/`. */
function startCwd(caseDir: string): string {
  const cwd = mkdtempSync(join(caseDir, "cwd-"));
  writeRole(cwd, "worker", "model: m\nthinking: low", "Body.");
  return cwd;
}

describe("skills/pi-luvus/launch.ts", () => {
  it("prefers PI_LUVUS_DIR over the checkout", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-override-"));
    const home = mkdtempSync(join(caseDir, "home-"));
    const install = makeInstall(join(caseDir, "dev-override"));
    const started = await runStartWith(shimMain, {
      cwd: startCwd(caseDir),
      env: { HOME: home, PI_LUVUS_DIR: install },
    });
    // The override root wins over this checkout, so its own CLI wrote the
    // spec and its sentinel is on -e.
    assert.equal(
      argValue(started.spec.args, "-e"),
      join(install, "pi-extension", "luvus", "luvus-done.ts"),
    );
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name scout-1 --pane 24",
      `pane run 24 ${paneCommandLine(join(install, "pi-extension", "luvus", "cli.ts"), started.json.launch, started.promptPath)}`,
    ]);
  });

  it("resolves the extension from the launcher's real-path checkout", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-checkout-"));
    const started = await runStartWith(shimMain, {
      cwd: startCwd(caseDir),
      env: { HOME: mkdtempSync(join(caseDir, "home-")) },
    });
    assert.equal(argValue(started.spec.args, "-e"), SHIM_DONE);
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name scout-1 --pane 24",
      `pane run 24 ${paneCommandLine(SHIM_CLI, started.json.launch, started.promptPath)}`,
    ]);
  });

  it("fails naming pi install and the candidates, and records no Luvus call", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-missing-"));
    const copy = copyShim(caseDir);
    const shim = await importShim(copy);
    const home = mkdtempSync(join(caseDir, "home-"));
    const gitInstall = join(home, ".pi", "agent", GIT_INSTALL_RELATIVE);
    const message = await startFailureWith(shim.main, {
      cwd: startCwd(caseDir),
      env: { HOME: home },
    });
    assert.match(message, /pi install git:github\.com\/slatkin\/pi-luvus/);
    assert.ok(message.includes(caseDir), `expected the checkout candidate in: ${message}`);
    assert.ok(message.includes(gitInstall), `expected the git install candidate in: ${message}`);
    assert.deepEqual(luvusCalls, []);

    // The direct entry turns the same failure into a non-zero exit.
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [copy, "help"], {
        env: { HOME: home, PATH: process.env.PATH },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 1;
      stderr = String(failure.stderr ?? "");
    }
    assert.equal(status, 1);
    assert.match(stderr, /launch\.ts: Cannot find the pi-luvus extension/);
    assert.deepEqual(luvusCalls, []);
  });

  it("finds a pi git install under a temp HOME from a copied shim", async () => {
    const caseDir = mkdtempSync(join(workdir, "shim-git-"));
    const copy = copyShim(caseDir);
    const home = mkdtempSync(join(caseDir, "home-"));
    const install = makeInstall(join(home, ".pi", "agent", GIT_INSTALL_RELATIVE));

    // Direct entry, the way the skill runs it: `node <copy> help` finds the
    // install and runs its CLI, with no Luvus call.
    const help = execFileSync(process.execPath, [copy, "help"], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(help, /Usage:/);

    // A start through the copy uses the install's own CLI and sentinel.
    const shim = await importShim(copy);
    const started = await runStartWith(shim.main, {
      cwd: startCwd(caseDir),
      env: { HOME: home },
    });
    const installCli = join(install, "pi-extension", "luvus", "cli.ts");
    assert.equal(
      argValue(started.spec.args, "-e"),
      join(install, "pi-extension", "luvus", "luvus-done.ts"),
    );
    assert.deepEqual(luvusCalls, [
      "pane split 21 --right --no-focus",
      "pane name scout-1 --pane 24",
      `pane run 24 ${paneCommandLine(installCli, started.json.launch, started.promptPath)}`,
    ]);
  });
});

// ─── plugin/hooks/on-stop.js ─────────────────────────────────────────────────

const HOOK = join(REPO_ROOT, "pi-extension", "luvus", "plugin", "hooks", "on-stop.js");

interface HookOutcome {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the stop hook the way Claude Code does: node, JSON on stdin, no shell. */
function runHook(input: string, env: NodeJS.ProcessEnv, cwd?: string): HookOutcome {
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** A transcript with `userMessages` real human entries, a tool result and an assistant turn. */
function writeTranscript(path: string, userMessages: string[]): void {
  const lines = [
    ...userMessages.map((content) =>
      JSON.stringify({ type: "user", message: { role: "user", content } }),
    ),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("plugin/hooks/on-stop.js", () => {
  it("writes the sentinel and the transcript path for one autonomous message", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(readFileSync(sentinel, "utf8"), "All done.\n");
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8"), `${transcript}\n`);
    });
  });

  it("writes only the transcript path after a second user message", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing", "now do more"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8"), `${transcript}\n`);
    });
  });

  it("writes nothing when the loop guard is active", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({
          stop_hook_active: true,
          transcript_path: transcript,
          last_assistant_message: "All done.",
        }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });

  it("writes nothing when PI_CLAUDE_SENTINEL is unset", () => {
    withTempDir((dir) => {
      const transcript = join(dir, "transcript.jsonl");
      writeTranscript(transcript, ["do the thing"]);
      const cwd = join(dir, "cwd");
      mkdirSync(cwd);

      const outcome = runHook(
        JSON.stringify({ transcript_path: transcript, last_assistant_message: "All done." }),
        {},
        cwd,
      );

      assert.equal(outcome.status, 0);
      assert.deepEqual(readdirSync(cwd), []);
    });
  });

  it("exits 0 and writes nothing for malformed stdin", () => {
    withTempDir((dir) => {
      const sentinel = join(dir, "child-done");

      const outcome = runHook("not json {", { PI_CLAUDE_SENTINEL: sentinel });

      assert.equal(outcome.status, 0);
      assert.equal(outcome.stderr, "");
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });

  it("writes nothing when the transcript file is missing", () => {
    withTempDir((dir) => {
      const sentinel = join(dir, "child-done");

      const outcome = runHook(
        JSON.stringify({
          transcript_path: join(dir, "absent.jsonl"),
          last_assistant_message: "All done.",
        }),
        { PI_CLAUDE_SENTINEL: sentinel },
      );

      assert.equal(outcome.status, 0);
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
    });
  });
});
