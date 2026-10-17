import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  createSupervisor,
  getArtifactDir,
  getRosterFile,
  type RunningSubagent,
  type SendOptions,
  type SteerMessage,
  type SupervisorContext,
  type SupervisorDeps,
} from "../pi-extension/luvus/supervisor.ts";
import { paneCommandLine, readLaunchSpec } from "../pi-extension/luvus/launch.ts";
import {
  LAUNCH_RECORD_VERSION,
  getLaunchRecordFile,
  readLaunchRecord,
  writeLaunchRecord,
  type LaunchRecord,
} from "../pi-extension/luvus/launch-record.ts";
import type { PollResult } from "../pi-extension/luvus/luvus.ts";
import type { UhpEventStream } from "../pi-extension/luvus/uhp-events.ts";
import {
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusSnapshot,
} from "../pi-extension/luvus/status.ts";

const SUBAGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pi-extension", "luvus");
const CLI = join(SUBAGENTS_DIR, "cli.ts");

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: { role: "user", content: [{ type: "text", text: "Hello, plan something" }] },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: { role: "assistant", content: [{ type: "text", text: "Here is my plan..." }] },
};

type LuvusPoll = SupervisorDeps["luvus"]["pollForExit"];

interface TestEnv {
  dir: string;
  ctx: SupervisorContext;
  restore(): void;
}

/**
 * Temp session and agent roots with fake LUVUS_* values. No test here talks to
 * Luvus: every deps.luvus operation is injected below.
 */
function createEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-test-"));
  const saved = new Map(
    ["PI_CODING_AGENT_DIR", "PI_LUVUS_SHELL_READY_DELAY_MS", "PI_LUVUS_NAME", "LUVUS_PANE_ID"].map(
      (key) => [key, process.env[key]],
    ),
  );
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.PI_LUVUS_SHELL_READY_DELAY_MS = "0";
  process.env.PI_LUVUS_NAME = "parent";
  process.env.LUVUS_PANE_ID = "21";
  const ctx: SupervisorContext = {
    cwd: dir,
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "sess-001",
      getSessionDir: () => join(dir, "sessions"),
    },
  };
  return {
    dir,
    ctx,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeAgentFile(agentsDir: string, name: string, frontmatter: string, body: string) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Every Luvus dep is a fake; polls stay pending until the test finishes one. */
function fakeEvents(): UhpEventStream {
  return {
    watch: () => () => {},
    onTrigger: () => () => {},
    isRunning: () => false,
    agentListSnapshot: () => null,
    shutdown() {},
  } as unknown as UhpEventStream;
}

function createPollQueue(override?: LuvusPoll) {
  const pending: Array<(result: PollResult) => void> = [];
  const signals: AbortSignal[] = [];
  const poll: LuvusPoll =
    override ??
    ((_surface, signal) => {
      signals.push(signal);
      return new Promise<PollResult>((resolve) => {
        pending.push(resolve);
        signal.addEventListener("abort", () => resolve({ reason: "done", exitCode: 0 }), {
          once: true,
        });
      });
    });
  return {
    poll,
    signals,
    finish(result: PollResult) {
      const resolve = pending.shift();
      assert.ok(resolve, "expected a pending poll");
      resolve(result);
    },
  };
}

interface SupervisorOptions {
  closeSurfaceThrows?: boolean;
  ui?: boolean;
  pollForExit?: LuvusPoll;
  onRunInPane?: (line: string) => void;
}

function makeSupervisor(env: TestEnv, options: SupervisorOptions = {}) {
  const sent: Array<{ message: SteerMessage; options: SendOptions | undefined }> = [];
  const runs: Array<{ surface: string; line: string }> = [];
  const closed: string[] = [];
  const polls = createPollQueue(options.pollForExit);
  let nextPane = 24;
  const supervisor = createSupervisor({
    send: (message, sendOptions) => sent.push({ message, options: sendOptions }),
    ui: () =>
      options.ui
        ? ({
            hasUI: true,
            ui: { setWidget() {} },
          } as unknown as ReturnType<SupervisorDeps["ui"]>)
        : null,
    luvus: {
      createSurface: () => String(nextPane++),
      runInPane: (surface, line) => {
        options.onRunInPane?.(line);
        runs.push({ surface, line });
      },
      closeSurface: (surface) => {
        closed.push(surface);
        if (options.closeSurfaceThrows) throw new Error("pane not found: already closed");
      },
      sendEscape: () => {},
      readScreen: () => "",
      pollForExit: polls.poll,
      agentPrompt: () => ({ submitted: true }),
    },
    events: fakeEvents,
    statusConfig: {
      enabled: true,
      lineLimit: 4,
      notifyEnabled: false,
      contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
    },
  });
  return {
    supervisor,
    sent,
    runs,
    closed,
    polls,
    newSupervisor: (next: SupervisorOptions = {}) => makeSupervisor(env, next),
  };
}

async function withHarness(
  run: (harness: ReturnType<typeof makeSupervisor>, env: TestEnv) => Promise<void>,
  options: SupervisorOptions = {},
): Promise<void> {
  const env = createEnv();
  const harness = makeSupervisor(env, options);
  try {
    await run(harness, env);
  } finally {
    harness.supervisor.shutdown();
    env.restore();
  }
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function activeObservation(): Parameters<typeof observeStatus>[1] {
  return {
    snapshot: "present",
    updatedAt: 5_000,
    sequence: 1,
    phase: "active",
    active: true,
    activeScope: "tool",
    activeSince: 5_000,
    activityLabel: "bash",
  } as Parameters<typeof observeStatus>[1];
}

function rosterChildren(env: TestEnv): unknown {
  const file = getRosterFile(getArtifactDir(join(env.dir, "sessions"), "sess-001"));
  return JSON.parse(readFileSync(file, "utf8")).children;
}

const BASE_RECORD: LaunchRecord = {
  version: LAUNCH_RECORD_VERSION,
  backend: "pi",
  name: "Worker",
  denyTools: ["luvus_spawn"],
  autoExit: true,
  interactive: false,
};

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "launch-record-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("launch record", () => {
  it("round trips a record through a temp file and a rename", () => {
    withTempDir((dir) => {
      const file = join(dir, "nested", "child.jsonl.launch.json");
      const record: LaunchRecord = {
        ...BASE_RECORD,
        agent: "worker",
        cwd: "/repo",
        model: "test-model",
        thinking: "high",
        tools: "read,bash",
        rolePrompt: "You are a worker.",
        systemPromptMode: "append",
      };

      writeLaunchRecord(file, record);

      assert.deepEqual(readLaunchRecord(file), record);
      // The record is renamed into place, not left behind as a temp file.
      assert.deepEqual(readdirSync(dirname(file)), ["child.jsonl.launch.json"]);
    });
  });

  it("treats a missing file as no record", () => {
    withTempDir((dir) => {
      assert.equal(readLaunchRecord(join(dir, "absent.jsonl.launch.json")), null);
    });
  });

  it("treats invalid JSON as no record", () => {
    withTempDir((dir) => {
      const file = join(dir, "broken.jsonl.launch.json");
      writeFileSync(file, '{"version": 1, "backend": ');
      assert.equal(readLaunchRecord(file), null);
    });
  });

  it("treats a wrong version as no record", () => {
    withTempDir((dir) => {
      const file = join(dir, "future.jsonl.launch.json");
      writeFileSync(file, JSON.stringify({ ...BASE_RECORD, version: 2 }));
      assert.equal(readLaunchRecord(file), null);
    });
  });

  it("keeps a record with no per-run fields", () => {
    withTempDir((dir) => {
      const file = join(dir, "minimal.jsonl.launch.json");
      writeLaunchRecord(file, BASE_RECORD);

      assert.deepEqual(readLaunchRecord(file), BASE_RECORD);
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const key of [
        "id",
        "surface",
        "task",
        "activityFile",
        "rosterFile",
        "sentinelFile",
        "artifactDir",
        "entryCountBefore",
      ]) {
        assert.equal(key in raw, false, `expected no per-run field ${key}`);
      }
    });
  });
});

describe("supervisor launch", () => {
  it("writes a launch spec and runs one node line, with no shell script", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn(
        { name: "Scout", task: "Fix the login bug", model: "test-model" },
        env.ctx,
        { placement: "right" },
      );

      const launchPath = running.launchScriptFile as string;
      assert.ok(launchPath.endsWith(".json"), `expected a JSON spec, got ${launchPath}`);

      // Exactly one pane run, and it follows the shell-neutral node line.
      assert.equal(h.runs.length, 1);
      assert.equal(h.runs[0].surface, "24");
      assert.equal(h.runs[0].line, paneCommandLine(CLI, launchPath));
      assert.match(h.runs[0].line, /^node ".*cli\.ts" "run" ".*\.json"$/);

      // The spec carries the child argv and env; the parent owns the close.
      const spec = readLaunchSpec(launchPath);
      assert.equal(spec.command, "pi");
      assert.deepEqual(spec.args.slice(0, 2), ["--session", running.sessionFile]);
      assert.equal(spec.sessionFile, running.sessionFile);
      assert.equal(spec.closeOnDone, undefined);
      assert.equal(spec.cwd, undefined);
      assert.equal(spec.title, "Scout — Fix the login bug");
      assert.equal(spec.env.PI_LUVUS_NAME, "Scout");
      assert.equal(spec.env.PI_LUVUS_SESSION, running.sessionFile);
      assert.equal(spec.env.PI_LUVUS_SURFACE, "24");
      assert.equal(flagValue(spec.args, "--model"), "test-model");
      assert.equal(
        flagValue(spec.args, "--tools"),
        "read,bash,edit,write,grep,find,ls,caller_ping,luvus_done,luvus_message",
      );

      // The spec is written where the old shell script went, and it is no script.
      const scriptsDir = join(env.dir, "sessions", "artifacts", "sess-001", "luvus-scripts");
      assert.deepEqual(
        readFileNames(scriptsDir).filter((file) => file.endsWith(".sh")),
        [],
      );
      assert.equal(readFileNames(scriptsDir).length, 1);
    });
  });

  it("writes a launch record before the pane line and keeps the pi launch spec", async () => {
    const recordExistedAtPaneRun: boolean[] = [];

    await withHarness(
      async (h, env) => {
        const repoDir = join(env.dir, "repo");
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "scout",
          `spawning: false\ncwd: ${repoDir}\nmodel: test-model\ntools: read,bash\nsystem-prompt: append`,
          "You are a scout.",
        );

        const running = await h.supervisor.spawn(
          { name: "Scout", task: "Fix the login bug", agent: "scout" },
          env.ctx,
        );

        const recordFile = getLaunchRecordFile(running.sessionFile);
        assert.equal(existsSync(recordFile), true);

        const record = readLaunchRecord(recordFile);
        assert.ok(record);
        assert.equal(record.version, LAUNCH_RECORD_VERSION);
        assert.equal(record.backend, "pi");
        assert.equal(record.agent, "scout");
        assert.equal(record.cwd, repoDir);
        assert.equal(record.model, "test-model");
        assert.equal(record.tools, "read,bash");
        assert.equal(record.rolePrompt, "You are a scout.");
        assert.equal(record.systemPromptMode, "append");
        assert.deepEqual([...record.denyTools].sort(), [
          "luvus_interrupt",
          "luvus_list",
          "luvus_resume",
          "luvus_spawn",
        ]);
        assert.equal(record.autoExit, false);
        assert.equal(record.interactive, true);

        // The record holds role values only: no task text, pane or run id.
        assert.equal("task" in record, false);
        assert.equal("id" in record, false);
        assert.doesNotMatch(JSON.stringify(record), /Fix the login bug/);
        assert.doesNotMatch(JSON.stringify(record), new RegExp(running.id));

        // The spec keeps the argv and env the spawn built before the record.
        const spec = readLaunchSpec(running.launchScriptFile as string);
        assert.equal(spec.command, "pi");
        assert.equal(spec.cwd, repoDir);
        assert.equal(spec.sessionFile, running.sessionFile);

        const syspromptPath = flagValue(spec.args, "--append-system-prompt");
        assert.match(syspromptPath ?? "", /sysprompt-.*\.md$/);
        assert.equal(readFileSync(syspromptPath as string, "utf8"), "You are a scout.");

        const taskArg = spec.args.at(-1) ?? "";
        assert.match(taskArg, /^@.*\.md$/);
        assert.match(readFileSync(taskArg.slice(1), "utf8"), /Fix the login bug/);

        assert.deepEqual(spec.args, [
          "--session",
          running.sessionFile,
          "-e",
          join(SUBAGENTS_DIR, "luvus-done.ts"),
          "--model",
          "test-model",
          "--append-system-prompt",
          syspromptPath,
          "--tools",
          "read,bash,caller_ping,luvus_done,luvus_message",
          taskArg,
        ]);
        assert.deepEqual(spec.env, {
          PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
          PI_DENY_TOOLS: "luvus_spawn,luvus_interrupt,luvus_list,luvus_resume",
          PI_LUVUS_NAME: "Scout",
          PI_LUVUS_AGENT: "scout",
          PI_LUVUS_SESSION: running.sessionFile,
          PI_LUVUS_ID: running.id,
          PI_LUVUS_ACTIVITY_FILE: running.activityFile,
          PI_LUVUS_SURFACE: running.surface,
          PI_LUVUS_PARENT_ROSTER: getRosterFile(
            getArtifactDir(join(env.dir, "sessions"), "sess-001"),
          ),
        });
        assert.equal("PI_LUVUS_AUTO_EXIT" in spec.env, false);

        // The record is on disk by the time the pane line runs.
        assert.deepEqual(recordExistedAtPaneRun, [true]);
      },
      {
        onRunInPane: (line) => {
          const specPath = /"([^"]+\.json)"/.exec(line)?.[1];
          assert.ok(specPath, `expected a launch spec path in ${line}`);
          const spec = readLaunchSpec(specPath);
          recordExistedAtPaneRun.push(
            spec.sessionFile !== undefined && existsSync(getLaunchRecordFile(spec.sessionFile)),
          );
        },
      },
    );
  });

  it("writes a Claude launch spec with a tmpdir sentinel", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "model: claude-model\ncli: claude",
        "You are Claude.",
      );

      const running = await h.supervisor.spawn(
        { name: "ClaudeWorker", task: "Do the thing", agent: "claude-role" },
        env.ctx,
      );

      assert.equal(running.cli, "claude");
      const spec = readLaunchSpec(running.launchScriptFile as string);
      assert.equal(spec.command, "claude");
      assert.equal(spec.args[0], "--dangerously-skip-permissions");
      assert.equal(flagValue(spec.args, "--model"), "claude-model");
      assert.equal(spec.args.at(-1), "Do the thing");
      assert.equal(flagValue(spec.args, "--plugin-dir"), join(SUBAGENTS_DIR, "plugin"));
      assert.equal(spec.env.PI_CLAUDE_SENTINEL, running.sentinelFile);
      assert.ok(String(spec.env.PI_CLAUDE_SENTINEL).startsWith(tmpdir()));
      assert.equal(spec.closeOnDone, undefined);
      assert.equal(h.runs.length, 1);

      const record = readLaunchRecord(getLaunchRecordFile(running.sessionFile));
      assert.ok(record);
      assert.equal(record.backend, "claude");
      assert.equal(record.agent, "claude-role");
      assert.equal(record.model, "claude-model");
      assert.equal(record.rolePrompt, "You are Claude.");
      assert.equal(record.systemPromptMode, undefined);
    });
  });
});

function readFileNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe("supervisor watcher", () => {
  it("keeps the session summary when the pane is already gone (pi)", async () => {
    await withHarness(
      async (h, env) => {
        const running = await h.supervisor.spawn({ name: "Scout", task: "survey" }, env.ctx);
        writeFileSync(
          running.sessionFile,
          [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the result steer");

        assert.deepEqual(h.closed, [running.surface]);
        assert.equal(h.sent[0].message.customType, "luvus_result");
        assert.match(h.sent[0].message.content, /Here is my plan\.\.\./);
        assert.doesNotMatch(h.sent[0].message.content, /Subagent cancelled/);
        assert.deepEqual(h.supervisor.running(), []);
      },
      { closeSurfaceThrows: true },
    );
  });

  it("keeps the sentinel summary when the pane is already gone (claude)", async () => {
    await withHarness(
      async (h, env) => {
        writeAgentFile(
          join(env.dir, "agent", "agents"),
          "claude-role",
          "cli: claude",
          "You are Claude.",
        );
        const running = await h.supervisor.spawn(
          { name: "Scout", task: "survey", agent: "claude-role" },
          env.ctx,
        );
        writeFileSync(running.sentinelFile as string, "All checks pass.\n");

        h.polls.finish({ reason: "done", exitCode: 0 });
        await waitFor(() => h.sent.length === 1, "the result steer");

        assert.deepEqual(h.closed, [running.surface]);
        assert.equal(h.sent[0].message.customType, "luvus_result");
        assert.match(h.sent[0].message.content, /All checks pass\./);
        assert.equal(h.supervisor.running().length, 0);
      },
      { closeSurfaceThrows: true },
    );
  });

  it("sends one luvus_handoff steer for a handoff result", async () => {
    await withHarness(async (h, env) => {
      const realNow = Date.now;
      let nowMs = 1_000;
      Date.now = () => nowMs;
      try {
        const running = await h.supervisor.spawn(
          { name: "Worker", task: "implement rows 3.x" },
          env.ctx,
        );

        nowMs = 81_000;
        h.polls.finish({
          reason: "handoff",
          exitCode: 0,
          handoff: { message: "Goal: X. Done: A. Left: B." },
        });
        await waitFor(() => h.sent.length === 1, "the handoff steer");

        assert.equal(h.sent.length, 1);
        const { message, options } = h.sent[0];
        assert.equal(message.customType, "luvus_handoff");
        assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
        assert.match(
          message.content,
          /Sub-agent "Worker" handed off at the context alert \(1m 20s\)\. The task is not complete\./,
        );
        assert.match(message.content, /Goal: X\. Done: A\. Left: B\./);
        assert.match(
          message.content,
          /Start a new subagent with this handoff in its task\. Do not resume this session\./,
        );
        assert.ok(message.content.includes(`Session: ${running.sessionFile}`));
        // No `Resume:` line — a handoff tells the parent to start a NEW subagent.
        assert.doesNotMatch(message.content, /Resume:/);
      } finally {
        Date.now = realNow;
      }
    });
  });
});

describe("supervisor interrupt", () => {
  it("resolves interrupt targets by exact id and reports name ambiguity", async () => {
    await withHarness(async (h, env) => {
      await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      const scout = await h.supervisor.spawn({ name: "Scout", task: "" }, env.ctx);

      const byId = h.supervisor.interrupt({ id: scout.id, name: "Worker" });
      assert.match(byId.content[0].text, /Interrupt requested for subagent "Scout"\./);

      const ambiguous = h.supervisor.interrupt({ name: "Worker" });
      assert.match(ambiguous.content[0].text, /Ambiguous subagent name/);
    });
  });

  it("returns an explicit error when Escape delivery fails", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);

      const result = h.supervisor.interrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      });

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(running.abortController?.signal.aborted, false);
      assert.equal("interruptRequested" in running, false);
    });
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      running.statusState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        activeObservation(),
        5_000,
      );

      const result = withMockedNow(20_000, () =>
        h.supervisor.interrupt({ name: "Worker" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(running.statusState, 20_000).kind, "active");
    });
  });

  it("sends Escape without aborting or mutating running state", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      let sentSurface = "";

      const result = h.supervisor.interrupt({ name: "Worker" }, (surface: string) => {
        sentSurface = surface;
      });

      assert.match(result.content[0].text, /Interrupt requested for subagent "Worker"\./);
      assert.equal(sentSurface, running.surface);
      assert.equal(running.abortController?.signal.aborted, false);
      assert.equal("interruptRequested" in running, false);
    });
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      writeFileSync(
        running.activityFile as string,
        `${JSON.stringify({
          version: 1,
          runningChildId: running.id,
          createdAt: 1_000,
          updatedAt: 19_000,
          sequence: 7,
          latestEvent: "tool_execution_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: true,
          activeScope: "tool",
          activeSince: 19_000,
          toolName: "bash",
        })}\n`,
      );

      withMockedNow(20_000, () => h.supervisor.interrupt({ name: "Worker" }, () => {}));

      const snapshot: StatusSnapshot = classifyStatus(running.statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(running.statusState.lastActivityAtMs, 20_000);
      assert.equal(running.statusState.lastActivitySequence, 7);
      assert.equal(running.statusState.localOverrideSequence, 7);
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      running.statusState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        activeObservation(),
        5_000,
      );

      const result = withMockedNow(20_000, () =>
        h.supervisor.interrupt({ name: "Worker" }, () => {}),
      );

      assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
      assert.deepEqual(result.details, {
        id: running.id,
        name: "Worker",
        status: "interrupt_requested",
      });
      const snapshot = classifyStatus(running.statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(
        h.supervisor.running().some((agent) => agent.id === running.id),
        true,
      );
    });
  });

  it("sends Escape again for repeated interrupt requests", async () => {
    await withHarness(async (h, env) => {
      const running = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      const surfaces: string[] = [];

      h.supervisor.interrupt({ name: "Worker" }, (surface: string) => surfaces.push(surface));
      h.supervisor.interrupt({ name: "Worker" }, (surface: string) => surfaces.push(surface));

      assert.deepEqual(surfaces, [running.surface, running.surface]);
      assert.equal(
        h.supervisor.running().some((agent) => agent.id === running.id),
        true,
      );
    });
  });

  it("rejects Claude-backed interrupt requests before delivery", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "cli: claude",
        "You are Claude.",
      );
      const running = await h.supervisor.spawn(
        { name: "Worker", task: "", agent: "claude-role" },
        env.ctx,
      );
      let delivered = false;

      const result = h.supervisor.interrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(result.content[0].text, /currently supported only for Pi-backed subagents/i);
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: running.id,
        name: "Worker",
      });
    });
  });
});

describe("supervisor roster", () => {
  it("builds the roster from the running map after add and remove", async () => {
    await withHarness(async (h, env) => {
      writeAgentFile(
        join(env.dir, "agent", "agents"),
        "claude-role",
        "cli: claude",
        "You are Claude.",
      );
      const worker = await h.supervisor.spawn({ name: "Worker", task: "" }, env.ctx);
      const scout = await h.supervisor.spawn(
        { name: "Scout", task: "", agent: "claude-role" },
        env.ctx,
      );

      assert.deepEqual(rosterChildren(env), [
        { id: worker.id, name: "Worker", pane: "24", cli: "pi" },
        { id: scout.id, name: "Scout", pane: "25", cli: "claude" },
      ]);

      h.polls.finish({ reason: "done", exitCode: 0 });
      await waitFor(() => h.supervisor.running().length === 1, "the worker to leave");

      assert.deepEqual(rosterChildren(env), [
        { id: scout.id, name: "Scout", pane: "25", cli: "claude" },
      ]);
    });
  });
});

describe("supervisor shutdown", () => {
  it("aborts its watchers and clears its intervals on shutdown", async () => {
    await withHarness(
      async (h, env) => {
        const created: unknown[] = [];
        const cleared: unknown[] = [];
        const realSetInterval = globalThis.setInterval;
        const realClearInterval = globalThis.clearInterval;
        globalThis.setInterval = ((fn: any, ms: any) => {
          const handle = realSetInterval(fn, ms);
          created.push(handle);
          return handle;
        }) as typeof globalThis.setInterval;
        globalThis.clearInterval = ((handle: any) => {
          cleared.push(handle);
          return realClearInterval(handle);
        }) as typeof globalThis.clearInterval;

        try {
          const running: RunningSubagent = await h.supervisor.spawn(
            { name: "Worker", task: "" },
            env.ctx,
          );
          assert.equal(created.length, 2);
          assert.equal(running.abortController?.signal.aborted, false);

          h.supervisor.shutdown();

          assert.equal(h.supervisor.isShutdown, true);
          assert.deepEqual(h.supervisor.running(), []);
          assert.equal(running.abortController?.signal.aborted, true);
          assert.deepEqual(
            created.filter((handle) => !cleared.includes(handle)),
            [],
          );
        } finally {
          globalThis.setInterval = realSetInterval;
          globalThis.clearInterval = realClearInterval;
        }
      },
      { ui: true },
    );
  });

  it("starts a second supervisor empty and with a live poll signal", async () => {
    await withHarness(async (h, env) => {
      h.supervisor.shutdown();
      assert.equal(h.supervisor.isShutdown, true);

      const pollSignals: boolean[] = [];
      const second = h.newSupervisor({
        pollForExit: (_surface, signal) => {
          pollSignals.push(signal.aborted);
          return new Promise<PollResult>((resolve) => {
            signal.addEventListener("abort", () => resolve({ reason: "done", exitCode: 0 }), {
              once: true,
            });
          });
        },
      });

      try {
        assert.deepEqual(second.supervisor.running(), []);
        assert.equal(second.supervisor.getAbortController().signal.aborted, false);

        await second.supervisor.spawn({ name: "Scout", task: "" }, env.ctx);
        assert.deepEqual(pollSignals, [false]);
      } finally {
        second.supervisor.shutdown();
      }
    });
  });
});
