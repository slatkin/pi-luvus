import { describe, it, before, after, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The whole suite drives the Luvus backend through its own seam and sets the
// LUVUS_* variables explicitly per test. An ambient Luvus session (running
// the suite inside a pi sub-agent pane) would turn any un-stubbed Luvus call
// into a real pane mutation — including `pane close $LUVUS_PANE_ID`, which
// kills the very session running the suite. Clear those keys for the entire
// test process. The same goes for PI_LUVUS_*: a suite run inside a
// sub-agent pane inherits its identity (PI_LUVUS_SESSION,
// PI_LUVUS_AUTO_EXIT, …), which flips the nudge/auto-exit paths under test
// and can write a `.exit` sidecar for the real session.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_") || key.startsWith("PI_LUVUS_")) {
    delete process.env[key];
  }
}
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/luvus/index.ts";

import {
  getNewEntries,
  findLastAssistantMessage,
  seedSubagentSessionFile,
} from "../pi-extension/luvus/session.ts";

import {
  pollForExit,
  sentinelLooksLive,
  closeSurface,
  createSurface,
  isMuxAvailable,
  readScreen,
  sendEscape,
  agentPrompt,
  readExitSidecar,
  runInPane,
  __pollForExitTest__,
  __setLuvusExecForTests__,
} from "../pi-extension/luvus/luvus.ts";
import { __setUhpSpawnForTests__ } from "../pi-extension/luvus/uhp-events.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
  parseSurfaceConfig,
  getDefaultConfigPath,
  loadSurfaceConfig,
  writeSurfaceConfig,
} from "../pi-extension/luvus/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/luvus/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  shouldScheduleAgentEndNudge,
  findLatestAssistantError,
} from "../pi-extension/luvus/luvus-done.ts";
import {
  DEFAULT_SUBAGENT_TOOLS,
  agentDefinitionPaths,
  getBundledAgentsDir,
  parseAgentDefinition,
} from "../pi-extension/luvus/agent-defs.ts";
import { __resetRegistrationForTests__ } from "../pi-extension/luvus/luvus-status.ts";
import subagentDoneExtension from "../pi-extension/luvus/luvus-done.ts";

// --- Fixture ---
// Captured live via `$LUVUS_BIN_PATH pane split $LUVUS_PANE_ID --no-focus` on 2026-09-28
// (design.md Decision 3): the new pane id is `result.pane`.
// {
//   "id": "1",
//   "result": {
//     "pane": "24",
//     "revision": 329037,
//     "tab": "1",
//     "type": "pane",
//     "workspace": "2"
//   }
// }

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

async function withTempDir(run: (dir: string) => void | Promise<void>) {
  const dir = createTestDir();
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("skips a torn trailing line from a child killed mid-append", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      appendFileSync(file, '{"type":"message","id":"torn-');
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(
        entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile),
        false,
      );
      assert.equal(
        entries.some((entry) => entry.type === "message"),
        false,
      );
    });
  });
});

describe("subagent session dir naming", () => {
  it("gives distinct cwds with the same slug distinct directories", async () => {
    await withTempDir((dir) => {
      const testApi = (subagentsModule as any).__test__;
      const first = testApi.getDefaultSessionDirFor("/a/b-c", dir);
      const second = testApi.getDefaultSessionDirFor("/a-b/c", dir);
      assert.notEqual(first, second);
      assert.ok(existsSync(first) && existsSync(second));
    });
  });

  it("migrates a legacy session dir into the hashed name", async () => {
    await withTempDir((dir) => {
      const testApi = (subagentsModule as any).__test__;
      const legacyDir = join(dir, "sessions", "--a-b-c--");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "transcript.jsonl"), "legacy\n");

      const sessionDir = testApi.getDefaultSessionDirFor("/a/b-c", dir);
      assert.ok(existsSync(sessionDir));
      assert.equal(readFileSync(join(sessionDir, "transcript.jsonl"), "utf8"), "legacy\n");
      assert.equal(existsSync(legacyDir), false);
    });
  });

  it("leaves an existing hashed session dir untouched", async () => {
    await withTempDir((dir) => {
      const testApi = (subagentsModule as any).__test__;
      const sessionDir = testApi.getDefaultSessionDirFor("/a/b-c", dir);
      writeFileSync(join(sessionDir, "current.jsonl"), "current\n");
      const legacyDir = join(dir, "sessions", "--a-b-c--");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "old.jsonl"), "old\n");

      const again = testApi.getDefaultSessionDirFor("/a/b-c", dir);
      assert.equal(again, sessionDir);
      assert.equal(readFileSync(join(sessionDir, "current.jsonl"), "utf8"), "current\n");
      assert.equal(existsSync(join(sessionDir, "old.jsonl")), false);
      assert.ok(existsSync(legacyDir));
    });
  });

  it("creates the hashed dir when no legacy dir exists", async () => {
    await withTempDir((dir) => {
      const testApi = (subagentsModule as any).__test__;
      const sessionDir = testApi.getDefaultSessionDirFor("/a/b-c", dir);
      assert.ok(existsSync(sessionDir));
      assert.equal(existsSync(join(dir, "sessions", "--a-b-c--")), false);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
      notifyEnabled: true,
      contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
    });
  });

  it("parses the optional notify.enabled, default true", () => {
    assert.equal(parseStatusConfig({}).notifyEnabled, true);
    assert.equal(parseStatusConfig({ status: { enabled: true } }).notifyEnabled, true);
    assert.equal(parseStatusConfig({ notify: { enabled: false } }).notifyEnabled, false);
    assert.equal(parseStatusConfig({ notify: {} }).notifyEnabled, true);
  });

  it("rejects an invalid or unsupported notify block", () => {
    assert.throws(
      () => parseStatusConfig({ notify: { enabled: "yes" } }),
      /notify\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ notify: { enabled: true, level: "error" } }),
      /notify has unsupported key\(s\): level/,
    );
    assert.throws(() => parseStatusConfig({ notify: "yes" }), /notify must be an object/);
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
      notifyEnabled: true,
      contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2) + "\n");

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
        notifyEnabled: true,
        contextAlert: { enabled: false, threshold: { kind: "tokens", value: 200000 } },
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2) + "\n");

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("resolves the surface placement default: right/down/tab as given, legacy pane, junk and absent -> right", () => {
    assert.equal(parseSurfaceConfig({ surface: "tab" }), "tab");
    assert.equal(parseSurfaceConfig({ surface: "down" }), "down");
    assert.equal(parseSurfaceConfig({ surface: "right" }), "right");
    assert.equal(parseSurfaceConfig({ surface: "pane" }), "right");
    assert.equal(parseSurfaceConfig({ surface: "junk" }), "right");
    assert.equal(parseSurfaceConfig({}), "right");
  });

  it("loads the surface placement from a temp config file", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, JSON.stringify({ status: { enabled: true }, surface: "tab" }));
      assert.equal(loadSurfaceConfig(configPath, examplePath), "tab");

      writeFileSync(configPath, JSON.stringify({ surface: "junk" }));
      assert.equal(loadSurfaceConfig(configPath, examplePath), "right");

      assert.equal(loadSurfaceConfig(join(dir, "missing.json"), examplePath), "right");
    });
  });

  it("persists the surface placement while keeping other config keys", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, JSON.stringify({ status: { enabled: false } }, null, 2) + "\n");

      writeSurfaceConfig("tab", configPath, examplePath);

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved, { status: { enabled: false }, surface: "tab" });
      assert.equal(loadSurfaceConfig(configPath, examplePath), "tab");
    });
  });

  it("creates config.json from the shipped example when persisting the surface", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, JSON.stringify({ status: { enabled: true } }, null, 2) + "\n");

      writeSurfaceConfig("down", configPath, examplePath);

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved, { status: { enabled: true }, surface: "down" });
    });
  });

  it("prefers the extensions-dir config, falling back to the legacy package-root config", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "extensions", "pi-luvus", "config.json");
      const legacyPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(legacyPath, JSON.stringify({ surface: "tab" }));

      assert.equal(loadSurfaceConfig(configPath, examplePath, legacyPath), "tab");

      mkdirSync(join(dir, "extensions", "pi-luvus"), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ surface: "down" }));
      assert.equal(loadSurfaceConfig(configPath, examplePath, legacyPath), "down");
    });
  });

  it("migrates the legacy config to the new location when persisting the surface", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "extensions", "pi-luvus", "config.json");
      const legacyPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(legacyPath, JSON.stringify({ status: { enabled: false } }, null, 2) + "\n");

      writeSurfaceConfig("tab", configPath, examplePath, legacyPath);

      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(saved, { status: { enabled: false }, surface: "tab" });
    });
  });

  it("resolves the default config under PI_CODING_AGENT_DIR", () => {
    withTempDir((dir) => {
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = dir;
      try {
        assert.equal(getDefaultConfigPath(), join(dir, "extensions", "pi-luvus", "config.json"));
      } finally {
        restoreEnvVar("PI_CODING_AGENT_DIR", previous);
      }
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      5_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: "present",
        updatedAt: 96_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 96_000,
        latestEvent: "agent_end",
      },
      96_000,
    );
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 5_000,
      },
      5_000,
    );
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 10_000,
        activityLabel: "bash",
      },
      10_000,
    );

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 3,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_001,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      11_000,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      21_000,
    );
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(
      stale,
      {
        snapshot: "present",
        updatedAt: 20_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 20_000,
        activityLabel: "bash",
      },
      22_000,
    );
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(
      sameTimestamp,
      {
        snapshot: "present",
        sequence: 2,
        updatedAt: 25_000,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 25_000,
        activityLabel: "streaming",
      },
      25_000,
    );
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(
      longName,
      classifyStatus(activeState, 300_000),
      "recovered",
    );

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 300_000));
    const recoveredLine = formatTransitionLine(
      "Worker",
      classifyStatus(activeState, 420_000),
      "recovered",
    );
    const lines = [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
      "Reviewer running 4m.",
      "Helper running 6m.",
    ];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("surface placement resolution", () => {
  it("modeHint names luvus_done for auto-exit agents too", () => {
    assert.match(subagentsModule.resolveModeHint(true), /Call luvus_done when finished/);
    assert.match(subagentsModule.resolveModeHint(false), /call the luvus_done tool/);
    assert.match(subagentsModule.resolveModeHint(undefined), /call the luvus_done tool/);
  });
  it("prefers the tool param over the configured default and ignores invalid values", () => {
    const saved = subagentsModule.getSurfaceDefault();
    try {
      subagentsModule.setSurfaceDefault("tab");
      assert.equal(subagentsModule.resolveSurfacePlacement(undefined), "tab");
      assert.equal(subagentsModule.resolveSurfacePlacement("down"), "down");
      assert.equal(subagentsModule.resolveSurfacePlacement("pane"), "right");

      subagentsModule.setSurfaceDefault("down");
      assert.equal(subagentsModule.resolveSurfacePlacement("junk"), "down");
      assert.equal(subagentsModule.resolveSurfacePlacement("tab"), "tab");
    } finally {
      subagentsModule.setSurfaceDefault(saved);
    }
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        ["name: interactive-unset-test-agent", "model: anthropic/test-interactive-unset"].join(
          "\n",
        ),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}), true);
    // Bare spawn with no agent defs (e.g. a forked spawn) is interactive by default.
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null), true);
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: false }),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled scout/worker/reviewer agents resolve as non-interactive", () => {
    for (const name of ["scout", "worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      );
    }
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T" },
        { sessionMode: "lineage-only" },
      ),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,luvus_done,luvus_message",
    );
  });

  it("buildSubagentToolAllowlist falls back to the default tools for a role without tools", () => {
    const expected = "read,bash,edit,write,grep,find,ls,caller_ping,luvus_done,luvus_message";
    assert.equal(DEFAULT_SUBAGENT_TOOLS, "read,bash,edit,write,grep,find,ls");

    // The pi parent calls this same builder with the loaded role's `tools` value.
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), expected);
    assert.equal(testApi.buildSubagentToolAllowlist(""), expected);
  });

  it("treats a blank frontmatter value as empty instead of swallowing the next line", () => {
    const parsed = parseAgentDefinition(
      ["---", "name: empty-model-test-agent", "model: ", "thinking: low", "---", "", "Body."].join(
        "\n",
      ),
      "empty-model-test-agent",
    );

    assert.ok(parsed, "expected the definition to parse");
    assert.equal(parsed.model, "");
    assert.equal(parsed.thinking, "low");
  });

  it("parses a CRLF role file the same as its LF twin", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      const lf = [
        "---",
        "name: crlf-test-agent",
        "model: anthropic/test-crlf",
        "tools: read,bash",
        "auto-exit: true",
        "---",
        "",
        "Body line one.",
        "Body line two.",
      ].join("\n");
      writeFileSync(join(projectAgentsDir, "crlf-test-agent.md"), lf.replace(/\n/g, "\r\n"));
      writeFileSync(join(projectAgentsDir, "lf-test-agent.md"), `${lf}\n`);

      const crlf = testApi.loadAgentDefaults("crlf-test-agent");
      const lfTwin = testApi.loadAgentDefaults("lf-test-agent");
      assert.ok(crlf && lfTwin, "expected both role files to parse");
      assert.deepEqual(crlf, lfTwin);
      assert.equal(crlf.model, "anthropic/test-crlf");
      assert.equal(crlf.tools, "read,bash");
      assert.equal(crlf.autoExit, true);
      assert.equal(crlf.body, "Body line one.\nBody line two.");
    });
  });

  it("searches the project, global and package agent directories in order", async () => {
    await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir, globalAgentsDir }) => {
      const frontmatter = (model: string) =>
        ["name: search-order-test-agent", `model: ${model}`].join("\n");
      const projectFile = join(projectAgentsDir, "search-order-test-agent.md");
      const globalFile = join(globalAgentsDir, "search-order-test-agent.md");

      writeAgentFile(
        projectAgentsDir,
        "search-order-test-agent",
        frontmatter("anthropic/test-project"),
      );
      writeAgentFile(
        globalAgentsDir,
        "search-order-test-agent",
        frontmatter("anthropic/test-global"),
      );

      const paths = agentDefinitionPaths("search-order-test-agent", projectDir);
      assert.deepEqual(paths, [
        projectFile,
        globalFile,
        join(getBundledAgentsDir(), "search-order-test-agent.md"),
      ]);

      assert.equal(
        testApi.loadAgentDefaults("search-order-test-agent")?.model,
        "anthropic/test-project",
      );
      assert.equal(
        testApi.loadAgentDefaults("search-order-test-agent", projectDir)?.model,
        "anthropic/test-project",
      );

      rmSync(projectFile);
      assert.equal(
        testApi.loadAgentDefaults("search-order-test-agent")?.model,
        "anthropic/test-global",
      );

      rmSync(globalFile);
      assert.equal(testApi.loadAgentDefaults("search-order-test-agent"), null);

      // Bundled roles resolve from the package directory, the last leg of the search.
      assert.ok(testApi.loadAgentDefaults("scout"), "expected bundled scout to resolve");
    });
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review,lint",
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review",
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "luvus_list");
      assert.ok(tool, "expected luvus_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "luvus_list");
      assert.ok(tool, "expected luvus_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "luvus_list");
      assert.ok(tool, "expected luvus_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"),
        false,
      );
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("luvus-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("luvus-done nudge", () => {
  /** Load the child extension with a mock pi API under the given env. */
  function loadChildExtension(env: Record<string, string | undefined>) {
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const handlers: Record<string, Array<(event?: any, ctx?: any) => void>> = {};
    const tools: Array<any> = [];
    const sentMessages: Array<{ message: string; opts?: any }> = [];
    const mockPi: any = {
      on(name: string, handler: (event?: any, ctx?: any) => void) {
        (handlers[name] ??= []).push(handler);
      },
      registerTool(tool: any) {
        tools.push(tool);
      },
      registerShortcut() {},
      getAllTools() {
        return [];
      },
      setWidget() {},
      sendUserMessage(message: string, opts?: any) {
        sentMessages.push({ message, opts });
      },
    };
    try {
      (subagentDoneExtension as any)(mockPi);
    } catch (error) {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      throw error;
    }
    const restoreEnv = () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    return { handlers, tools, sentMessages, restoreEnv };
  }

  const fire = (
    handlers: Record<string, Array<(event?: any, ctx?: any) => void>>,
    name: string,
    event?: any,
    ctx?: any,
  ) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };

  it("decides to nudge only on a normal model stop", () => {
    assert.equal(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "stop" }]), true);
    assert.equal(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "error" }]), false);
    assert.equal(
      shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "aborted" }]),
      false,
    );
    assert.equal(shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "length" }]), false);
    assert.equal(shouldScheduleAgentEndNudge(undefined), false);
  });

  it("agent_end on a normal stop does not write the done sidecar", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_NUDGE_DISABLE: "1",
      });
      try {
        fire(handlers, "agent_start");
        let shutdownCalled = false;
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown: () => (shutdownCalled = true) },
        );

        assert.equal(shutdownCalled, false);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        restoreEnv();
      }
    });
  });

  it("auto-exit agent_end on a normal stop writes the done sidecar and shuts down", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_AUTO_EXIT: "1",
        PI_LUVUS_NUDGE_DISABLE: "1",
      });
      try {
        fire(handlers, "agent_start");
        let shutdownCalled = false;
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown: () => (shutdownCalled = true) },
        );

        assert.equal(shutdownCalled, true);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
      } finally {
        restoreEnv();
      }
    });
  });

  it("auto-exit agent_end on an aborted stop keeps the session open", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_AUTO_EXIT: "1",
        PI_LUVUS_NUDGE_DISABLE: "1",
      });
      try {
        fire(handlers, "agent_start");
        let shutdownCalled = false;
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "aborted" }] },
          { shutdown: () => (shutdownCalled = true) },
        );

        assert.equal(shutdownCalled, false);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        restoreEnv();
      }
    });
  });

  it("user takeover keeps an auto-exit session open after a normal stop", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_AUTO_EXIT: "1",
        PI_LUVUS_NUDGE_DISABLE: "1",
      });
      try {
        fire(handlers, "agent_start");
        fire(handlers, "input");
        let shutdownCalled = false;
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown: () => (shutdownCalled = true) },
        );

        assert.equal(shutdownCalled, false);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        restoreEnv();
      }
    });
  });

  it("agent_end on an error stop still writes the error sidecar and shuts down", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, restoreEnv } = loadChildExtension({ PI_LUVUS_SESSION: sessionFile });
      try {
        fire(handlers, "agent_start");
        let shutdownCalled = false;
        fire(
          handlers,
          "agent_end",
          {
            messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }],
          },
          { shutdown: () => (shutdownCalled = true) },
        );

        assert.equal(shutdownCalled, true);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "error",
          errorMessage: "529 overloaded",
          stopReason: "error",
        });
      } finally {
        restoreEnv();
      }
    });
  });

  it("calls luvus_done before agent_end: sidecar written and no nudge fires", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const { handlers, tools, sentMessages, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_NUDGE_DELAY_MS: "1000",
      });
      try {
        const doneTool = tools.find((t) => t.name === "luvus_done");
        assert.ok(doneTool, "expected luvus_done to be registered");
        await doneTool.execute("t1", {}, undefined, undefined, { shutdown() {} });
        assert.equal(existsSync(`${sessionFile}.exit`), true);

        fire(handlers, "agent_start");
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown() {} },
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(sentMessages.length, 0);
      } finally {
        restoreEnv();
      }
    });
  });

  it("nudge fires after the delay when the agent stays idle", async () => {
    await withTempDir(async (_dir) => {
      // Mock timers: the 1000ms nudge delay is exact, so the assertion does not
      // race a real 1000-vs-1100ms wall-clock margin on a loaded machine.
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const { handlers, sentMessages, restoreEnv } = loadChildExtension({
          PI_LUVUS_NUDGE_DELAY_MS: "1000",
        });
        try {
          fire(handlers, "agent_start");
          fire(
            handlers,
            "agent_end",
            { messages: [{ role: "assistant", stopReason: "stop" }] },
            { shutdown() {} },
          );

          assert.equal(sentMessages.length, 0);
          mock.timers.tick(999);
          assert.equal(sentMessages.length, 0);
          mock.timers.tick(1);
          assert.equal(sentMessages.length, 1);
          assert.match(sentMessages[0].message, /luvus_done/);
          assert.deepEqual(sentMessages[0].opts, { deliverAs: "followUp" });
        } finally {
          restoreEnv();
        }
      } finally {
        mock.timers.reset();
      }
    });
  });

  it("pending nudge is cancelled by user input and by a new agent cycle", async () => {
    await withTempDir(async (_dir) => {
      const { handlers, sentMessages, restoreEnv } = loadChildExtension({
        PI_LUVUS_NUDGE_DELAY_MS: "1000",
      });
      try {
        fire(handlers, "agent_start");
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown() {} },
        );
        fire(handlers, "input");
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(sentMessages.length, 0);

        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown() {} },
        );
        fire(handlers, "before_agent_start");
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(sentMessages.length, 0);
      } finally {
        restoreEnv();
      }
    });
  });

  it("input that arrives mid-run does not silence the nudge", async () => {
    await withTempDir(async (_dir) => {
      const { handlers, sentMessages, restoreEnv } = loadChildExtension({
        PI_LUVUS_NUDGE_DELAY_MS: "1000",
      });
      try {
        fire(handlers, "agent_start");
        fire(handlers, "input");
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown() {} },
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(sentMessages.length, 1);
      } finally {
        restoreEnv();
      }
    });
  });

  /**
   * In-process Luvus fake: logs each invocation together with whether the
   * `.exit` sidecar existed at that moment, so a test can prove the terminal
   * status report ran before the sidecar write.
   */
  function installFakeLuvus(dir: string, sidecarFile: string): { bin: string; log: string } {
    const log = join(dir, "luvus-stub.log");
    __setLuvusExecForTests__((args) => {
      const sidecar = existsSync(sidecarFile) ? "sidecar=yes" : "sidecar=no";
      appendFileSync(log, `${sidecar} ${args.join(" ")}\n`);
      return '{"id":"1","result":{"revision":1,"type":"ok"}}';
    });
    return { bin: "in-process", log };
  }

  it("reports done to Luvus before writing the done sidecar", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      const { bin, log } = installFakeLuvus(dir, `${sessionFile}.exit`);
      const { tools, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: bin,
        LUVUS_PANE_ID: "7",
      });
      try {
        const doneTool = tools.find((t) => t.name === "luvus_done");
        assert.ok(doneTool, "expected luvus_done to be registered");
        await doneTool.execute("t1", {}, undefined, undefined, { shutdown() {} });

        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
        const lines = readFileSync(log, "utf8").trim().split("\n");
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^sidecar=no /);
        assert.match(lines[0], /--status done /);
        assert.doesNotMatch(lines[0], /--message/);
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });

  it("reports blocked with the ping question before writing the ping sidecar", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      const { bin, log } = installFakeLuvus(dir, `${sessionFile}.exit`);
      const { tools, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_NAME: "PingChild",
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: bin,
        LUVUS_PANE_ID: "7",
      });
      try {
        const pingTool = tools.find((t) => t.name === "caller_ping");
        assert.ok(pingTool, "expected caller_ping to be registered");
        await pingTool.execute("t1", { message: "which target?" }, undefined, undefined, {
          shutdown() {},
        });

        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "ping",
          name: "PingChild",
          message: "which target?",
        });
        const line = readFileSync(log, "utf8").trim();
        assert.match(line, /^sidecar=no /);
        assert.match(line, /--status blocked /);
        assert.match(line, /--message which target\?/);
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });

  it("reports done before the auto-exit sidecar", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      const { bin, log } = installFakeLuvus(dir, `${sessionFile}.exit`);
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        PI_LUVUS_AUTO_EXIT: "1",
        PI_LUVUS_NUDGE_DISABLE: "1",
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: bin,
        LUVUS_PANE_ID: "7",
      });
      try {
        fire(handlers, "agent_start");
        fire(
          handlers,
          "agent_end",
          { messages: [{ role: "assistant", stopReason: "stop" }] },
          { shutdown() {} },
        );

        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
        const lines = readFileSync(log, "utf8").trim().split("\n");
        assert.match(lines.at(-1)!, /^sidecar=no /);
        assert.match(lines.at(-1)!, /--status done /);
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });

  it("reports blocked with the error text before the error sidecar", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      const { bin, log } = installFakeLuvus(dir, `${sessionFile}.exit`);
      const { handlers, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: bin,
        LUVUS_PANE_ID: "7",
      });
      try {
        fire(handlers, "agent_start");
        fire(
          handlers,
          "agent_end",
          {
            messages: [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }],
          },
          { shutdown() {} },
        );

        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "error",
          errorMessage: "529 overloaded",
          stopReason: "error",
        });
        const lines = readFileSync(log, "utf8").trim().split("\n");
        assert.match(lines.at(-1)!, /^sidecar=no /);
        assert.match(lines.at(-1)!, /--status blocked /);
        assert.match(lines.at(-1)!, /--message 529 overloaded/);
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });

  it("writes the sidecar and shuts down when the status report fails", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      __setLuvusExecForTests__(() => {
        throw new Error("stub Luvus failed");
      });
      const { tools, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: "in-process",
        LUVUS_PANE_ID: "7",
      });
      try {
        const doneTool = tools.find((t) => t.name === "luvus_done");
        assert.ok(doneTool, "expected luvus_done to be registered");
        let shutdownCalled = false;
        await doneTool.execute("t1", {}, undefined, undefined, {
          shutdown: () => (shutdownCalled = true),
        });

        assert.equal(shutdownCalled, true);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });

  it("does not report a terminal status outside Luvus", async () => {
    await withTempDir(async (dir) => {
      __resetRegistrationForTests__();
      const sessionFile = join(dir, "child.jsonl");
      const { bin, log } = installFakeLuvus(dir, `${sessionFile}.exit`);
      const { tools, restoreEnv } = loadChildExtension({
        PI_LUVUS_SESSION: sessionFile,
        LUVUS_ENV: undefined,
        LUVUS_BIN_PATH: bin,
        LUVUS_PANE_ID: "7",
      });
      try {
        const doneTool = tools.find((t) => t.name === "luvus_done");
        assert.ok(doneTool, "expected luvus_done to be registered");
        await doneTool.execute("t1", {}, undefined, undefined, { shutdown() {} });

        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done" });
        assert.equal(existsSync(log), false);
      } finally {
        __setLuvusExecForTests__(null);
        restoreEnv();
      }
    });
  });
});

describe("luvus.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }), {
      reason: "ping",
      exitCode: 0,
      ping: { name: "Worker", message: "need help" },
    });
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("decodes handoff payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "handoff", message: "Goal: X. Left: B." }), {
      reason: "handoff",
      exitCode: 0,
      handoff: { message: "Goal: X. Left: B." },
    });
  });

  it("falls back to a placeholder when the handoff payload has no usable message", () => {
    for (const payload of [
      { type: "handoff" },
      { type: "handoff", message: "   " },
      { type: "handoff", message: 42 },
    ]) {
      const result = interpretExitSidecar(payload);
      assert.equal(result.reason, "handoff");
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.handoff, { message: "(handoff text missing)" });
    }
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("luvus-surface command", () => {
  function loadCommand() {
    const { api, registeredCommands } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const command = registeredCommands.find((c: any) => c.name === "luvus-surface");
    assert.ok(command, "expected /luvus-surface to be registered");
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    };
    return { command, notifications, ctx };
  }

  it("shows the current default with no argument", () => {
    const { command, notifications, ctx } = loadCommand();
    command.handler("", ctx);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /^Subagent surface: (right|down|tab)$/);
  });

  it("sets a valid placement, persists it, and reports the new value", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify({ status: { enabled: false } }));
      (subagentsModule as any).__surfaceTest__.setConfigPath(configPath);
      const saved = subagentsModule.getSurfaceDefault();
      try {
        const { command, notifications, ctx } = loadCommand();
        command.handler("tab", ctx);

        assert.equal(subagentsModule.getSurfaceDefault(), "tab");
        assert.equal(notifications[0].level, "info");
        assert.match(notifications[0].message, /set to "tab" \(saved to config\.json\)/);
        assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
          status: { enabled: false },
          surface: "tab",
        });
      } finally {
        (subagentsModule as any).__surfaceTest__.setConfigPath(undefined);
        subagentsModule.setSurfaceDefault(saved);
      }
    });
  });

  it("keeps the default and explains accepted values on an invalid argument", () => {
    const saved = subagentsModule.getSurfaceDefault();
    const { command, notifications, ctx } = loadCommand();
    try {
      command.handler("window", ctx);
      assert.equal(subagentsModule.getSurfaceDefault(), saved);
      assert.equal(notifications[0].level, "warning");
      assert.match(notifications[0].message, /accepted: right, down, tab/);
    } finally {
      subagentsModule.setSurfaceDefault(saved);
    }
  });
});

describe("tool registration", () => {
  it("registers the optional surface parameter on luvus_spawn and luvus_resume", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    for (const toolName of ["luvus_spawn", "luvus_resume"]) {
      const tool = registeredTools.find((t: any) => t.name === toolName);
      assert.ok(tool, `expected ${toolName} to be registered`);
      assert.ok(tool.parameters.properties.surface, `${toolName} should accept surface`);
      assert.match(tool.description, /surface parameter/);
      assert.match(tool.promptSnippet, /surface parameter/);
    }
  });

  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent interruption", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("luvus_spawn"), true);
    assert.equal(denied.has("luvus_interrupt"), true);
    assert.equal(denied.has("luvus_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "luvus_spawn");
    assert.ok(subagentTool, "expected luvus_spawn tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers luvus_resume with an autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "luvus_resume");
    assert.ok(resumeTool, "expected luvus_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "luvus-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  it("registers luvus_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(
      registeredTools.some((tool) => tool.name === "luvus_interrupt"),
      true,
    );
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /luvus_resume/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent messaging", () => {
  const testApi = () => (subagentsModule as any).__test__;

  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers luvus_message in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(
      registeredTools.some((tool) => tool.name === "luvus_message"),
      true,
    );
  });

  it("includes PI_LUVUS_PARENT_ROSTER in both spawn and resume env builders", () => {
    const rosterFile = "/s/artifacts/parent/luvus-roster.json";
    const spawn = testApi().buildSpawnEnvParts({
      name: "Worker",
      subagentSessionFile: "/s/worker.jsonl",
      id: "a1",
      activityFile: "/s/a1.activity.json",
      surface: "24",
      denySet: new Set(),
      parentRosterFile: rosterFile,
    });
    assert.equal(spawn.PI_LUVUS_PARENT_ROSTER, rosterFile);
    assert.equal(spawn.PI_LUVUS_SURFACE, "24");

    const resume = testApi().buildResumeEnvParts({
      name: "Worker",
      sessionPath: "/s/worker.jsonl",
      id: "a1",
      activityFile: "/s/a1.activity.json",
      autoExit: true,
      parentRosterFile: rosterFile,
    });
    assert.equal(resume.PI_LUVUS_PARENT_ROSTER, rosterFile);
    assert.equal(resume.PI_LUVUS_AUTO_EXIT, "1");
  });

  it("resolves parent, children and siblings and excludes self", () => {
    // From Reviewer's perspective: Worker is a sibling, Scout is its own child.
    const base = {
      hasParent: true,
      ownChildren: [{ id: "d4", name: "Scout", surface: "27" }],
      parentRoster: {
        parentPane: "21",
        parentName: "parent",
        children: [
          { id: "b2", name: "Reviewer", pane: "25", cli: "pi" },
          { id: "c3", name: "Worker", pane: "26", cli: "pi" },
        ],
      },
      selfId: "b2",
    };

    assert.deepEqual(testApi().resolveMessageTarget({ ...base, to: "parent" }), {
      target: { relation: "parent", name: "parent" },
    });
    assert.deepEqual(testApi().resolveMessageTarget({ ...base, to: "Scout" }), {
      target: { relation: "child", id: "d4", name: "Scout", pane: "27" },
    });
    assert.deepEqual(testApi().resolveMessageTarget({ ...base, to: "Worker" }), {
      target: { relation: "sibling", id: "c3", name: "Worker", pane: "26" },
    });
    assert.match(
      testApi().resolveMessageTarget({ ...base, to: "Reviewer" }).error,
      /No reachable agent/,
    );
  });

  it("lists reachable names for a finished target and reports ambiguity with ids", () => {
    const base = {
      hasParent: true,
      ownChildren: [{ id: "d4", name: "Scout", surface: "27" }],
      parentRoster: {
        parentPane: "21",
        parentName: "parent",
        children: [{ id: "b2", name: "Worker", pane: "25", cli: "pi" }],
      },
      selfId: "x9",
    };

    const unknown = testApi().resolveMessageTarget({ ...base, to: "Finished" });
    assert.match(unknown.error, /Reachable: parent, Scout, Worker/);

    const ambiguous = testApi().resolveMessageTarget({
      ...base,
      ownChildren: [
        { id: "d4", name: "Scout", surface: "27" },
        { id: "e5", name: "Scout", surface: "28" },
      ],
      to: "Scout",
    });
    assert.match(ambiguous.error, /Ambiguous subagent name "Scout".+Scout \[d4\].+Scout \[e5\]/);

    assert.equal(testApi().resolveMessageTarget({ ...base, to: "d4" }).target.id, "d4");
  });

  it("lists reachable names when ownChildren is a one-shot Map iterator", () => {
    // Regression: resolveMessageTarget must not consume the iterator while
    // matching and then find it empty when building the error.
    const running = new Map<string, any>();
    running.set("d4", { id: "d4", name: "Scout", surface: "27", cli: "pi" });

    const result = testApi().resolveMessageTarget({
      hasParent: false,
      ownChildren: running.values(),
      parentRoster: null,
      selfId: "",
      to: "Finished",
    });

    assert.match(result.error, /Reachable: Scout/);
  });

  it("reports no parent for a top-level agent", () => {
    const result = testApi().resolveMessageTarget({
      hasParent: false,
      ownChildren: [],
      parentRoster: null,
      selfId: "",
      to: "parent",
    });
    assert.match(result.error, /no parent/);
  });

  it("builds the sender header for each relation", () => {
    assert.equal(
      testApi().formatMessageHeader({ senderName: "Worker", targetRelation: "parent" }),
      "[subagent message from Worker (child)]",
    );
    assert.equal(
      testApi().formatMessageHeader({ senderName: "parent", targetRelation: "child" }),
      "[subagent message from parent]",
    );
    assert.equal(
      testApi().formatMessageHeader({ senderName: "Worker", targetRelation: "sibling" }),
      "[subagent message from Worker (sibling)]",
    );
  });

  it("rejects an empty message without delivering", () => {
    let prompted = false;
    let appended = false;
    const result = testApi().sendSubagentMessage(
      { to: "parent", message: "  " },
      {
        hasParent: true,
        ownChildren: [],
        parentRoster: null,
        selfId: "a1",
        senderName: "Worker",
        parentMessageFile: "/tmp/worker.jsonl.msg",
      },
      {
        prompt: () => {
          prompted = true;
        },
        append: () => {
          appended = true;
        },
      },
    );
    assert.match(result.error, /must not be empty/);
    assert.equal(prompted, false);
    assert.equal(appended, false);
  });

  it("delivers parent-bound messages through the message file, never agentPrompt", () => {
    const appended: Array<{ file: string; payload: any }> = [];
    const prompted: string[] = [];
    const result = testApi().sendSubagentMessage(
      { to: "parent", message: "Which DB driver?" },
      {
        hasParent: true,
        ownChildren: [],
        parentRoster: null,
        selfId: "a1",
        senderName: "Worker",
        parentMessageFile: "/s/worker.jsonl.msg",
      },
      {
        prompt: (pane: string, text: string) => prompted.push(`${pane}:${text}`),
        append: (file: string, payload: any) => appended.push({ file, payload }),
      },
    );

    assert.equal("ok" in result, true);
    assert.equal(prompted.length, 0);
    assert.deepEqual(appended, [
      {
        file: "/s/worker.jsonl.msg",
        payload: {
          header: "[subagent message from Worker (child)]",
          message: "Which DB driver?",
        },
      },
    ]);
  });

  it("delivers child and sibling messages through Luvus with the header", () => {
    const prompted: string[] = [];
    const result = testApi().sendSubagentMessage(
      { to: "Reviewer", message: "API is in src/api" },
      {
        hasParent: true,
        ownChildren: [{ id: "b2", name: "Reviewer", surface: "25" }],
        parentRoster: null,
        selfId: "a1",
        senderName: "parent",
        parentMessageFile: null,
      },
      {
        prompt: (pane: string, text: string) => prompted.push(`${pane}\u0000${text}`),
        append: () => {},
      },
    );

    assert.equal("ok" in result, true);
    assert.deepEqual(prompted, ["25\u0000[subagent message from parent]\nAPI is in src/api"]);
  });

  it("registers luvus_message with a validated schema", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t) => t.name === "luvus_message");
    assert.ok(tool, "expected luvus_message to be registered");
    assert.equal(tool.parameters.properties.to.type, "string");
    assert.equal(tool.parameters.properties.message.type, "string");
  });

  it("holds a partial trailing message-file line until its newline arrives", () => {
    withTempDir((dir) => {
      const file = join(dir, "worker.jsonl.msg");
      appendFileSync(
        file,
        JSON.stringify({ header: "[subagent message from Worker (child)]", message: "one" }) + "\n",
      );
      appendFileSync(file, '{"header":"[subagent message from Worker (child)]","message":"two');

      const first = testApi().readParentMessages(file, 0);
      assert.equal(first.messages.length, 1);
      assert.equal(first.messages[0].message, "one");

      appendFileSync(file, '"}\n');
      const second = testApi().readParentMessages(file, first.offset);
      assert.equal(second.messages.length, 1);
      assert.equal(second.messages[0].message, "two");
    });
  });

  it("drains a message written just before exit, then removes the file", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, "");
      const msgFile = `${sessionFile}.msg`;
      appendFileSync(
        msgFile,
        JSON.stringify({ header: "[subagent message from Worker (child)]", message: "bye" }) + "\n",
      );
      // The child exits immediately after writing the message.
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));

      const { api, sentMessages } = createMockExtensionApi();
      testApi().drainAndRemoveParentMessages(makeRunning({ sessionFile }), api);

      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].message.content, "[subagent message from Worker (child)]\nbye");
      assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "steer" });
      assert.equal(existsSync(msgFile), false);
    });
  });

  it("names parent and running siblings in the launch prompt", () => {
    const hint = testApi().buildLaunchMessagingHint(["Worker"]);
    assert.match(hint, /`parent`/);
    assert.match(hint, /`Worker`/);

    const prompt = testApi().buildSubagentTaskPrompt({
      task: "do the thing",
      roleBlock: "role",
      modeHint: "Complete your task autonomously.",
      summaryInstruction: "Summarize.",
      messagingHint: hint,
      inheritsConversationContext: false,
    });
    assert.match(prompt, /You can message `parent`, `Worker` with luvus_message/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "luvus_status");
    assert.ok(rendererEntry, "expected luvus_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Helper running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "luvus_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "luvus_status");
    assert.ok(rendererEntry, "expected luvus_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "luvus_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_LUVUS_SHELL_READY_DELAY_MS;
    delete process.env.PI_LUVUS_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_LUVUS_SHELL_READY_DELAY_MS;
      else process.env.PI_LUVUS_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_LUVUS_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_LUVUS_SHELL_READY_DELAY_MS;
    process.env.PI_LUVUS_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_LUVUS_SHELL_READY_DELAY_MS;
      else process.env.PI_LUVUS_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime: 1_000_000 - 13_000,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
          },
          {
            id: "a2",
            name: "B",
            task: "",
            surface: "s2",
            startTime: 1_000_000 - 21_000,
            sessionFile: "sess2",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
          },
          {
            id: "a3",
            name: "C",
            task: "",
            surface: "s3",
            startTime: 1_000_000 - 27_000,
            sessionFile: "sess3",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
          },
        ],
        16,
      );

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime,
            sessionFile: "sess1",
            statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
          },
        ],
        width,
      );

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("luvus.ts", () => {
  it("still exports the pane helpers the extension uses", () => {
    assert.equal(typeof runInPane, "function");
    assert.equal(typeof readExitSidecar, "function");
  });
});

describe("luvus backend", () => {
  // In-process Luvus seam: echoes the same canned JSON envelopes per command
  // as the old CLI stub, driven by $LUVUS_STUB_MODE, and logs each invocation
  // to $LUVUS_STUB_LOG so tests can assert the exact argv.
  function installLuvusStub(): void {
    __setLuvusExecForTests__((args) => {
      const log = process.env.LUVUS_STUB_LOG;
      if (log) appendFileSync(log, args.join(" ") + "\n");
      const mode = process.env.LUVUS_STUB_MODE;
      if (mode === "error") return '{"error":{"code":"boom","message":"stub exploded"}}';
      if (mode === "no-pane") return '{"id":"1","result":{"revision":1,"type":"pane"}}';
      if (mode === "not-ready") {
        return '{"error":{"code":"agent_not_ready","message":"agent_not_ready: target is showing a blocked prompt"}}';
      }
      switch (`${args[0]} ${args[1]}`) {
        case "pane split":
          return '{"id":"1","result":{"pane":"24","revision":329037,"tab":"1","type":"pane","workspace":"2"}}';
        case "pane read": {
          // LUVUS_STUB_SCREEN lets a test put a specific text on the pane.
          const screen = process.env.LUVUS_STUB_SCREEN ?? "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
          return JSON.stringify({
            id: "1",
            result: { revision: 1, text: screen, type: "pane_read" },
          });
        }
        case "agent prompt":
          return '{"id":"1","result":{"pane":"24","submitted":true,"evidence":"queued","status":"idle","type":"agent_prompt"}}';
        case "agent list": {
          const agents = process.env.LUVUS_STUB_AGENTS
            ? JSON.parse(process.env.LUVUS_STUB_AGENTS)
            : mode === "no-caller"
              ? [{ pane: "99", tab: "2", type: "agent" }]
              : [{ pane: "21", tab: "1", focused: true, type: "agent" }];
          return JSON.stringify({ id: "1", result: { agents, type: "agent_list" } });
        }
        case "pane move":
          return mode === "move-error"
            ? '{"error":{"code":"boom","message":"stub move exploded"}}'
            : '{"id":"1","result":{"pane":"24","revision":2,"tab":"3","type":"pane_move","workspace":"1"}}';
        case "tab focus":
          return mode === "focus-error"
            ? '{"error":{"code":"boom","message":"stub focus exploded"}}'
            : '{"id":"1","result":{"revision":3,"type":"ok"}}';
        case "pane close":
          return mode === "close-error"
            ? '{"error":{"code":"pane_not_found","message":"pane not found: already closed"}}'
            : '{"id":"1","result":{"revision":1,"type":"ok"}}';
        default:
          return '{"id":"1","result":{"revision":1,"type":"ok"}}';
      }
    });
  }

  /**
   * Set env vars for the duration of fn, restoring afterwards. Undefined
   * deletes the variable — tests must pass all three LUVUS_* keys explicitly
   * because the runner itself may run inside Luvus with them ambient.
   */
  function withLuvusEnv(env: Record<string, string | undefined>, fn: () => unknown): unknown {
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const allLuvusKeys = (over: Record<string, string | undefined>) => ({
    LUVUS_ENV: undefined,
    LUVUS_BIN_PATH: undefined,
    LUVUS_PANE_ID: undefined,
    ...over,
  });

  let stubDir: string;
  let stubPath: string;

  /** A UHP child whose stdout ends only when killed (a healthy, silent stream). */
  function silentUhpChild(): { stdout: AsyncIterable<Buffer>; kill(): void } {
    let wake: (() => void) | null = null;
    let closed = false;
    const stdout: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Buffer>> {
            while (!closed) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            return { value: undefined, done: true };
          },
        };
      },
    };
    return {
      stdout,
      kill() {
        closed = true;
        const w = wake;
        wake = null;
        w?.();
      },
    };
  }

  before(() => {
    stubDir = mkdtempSync(join(tmpdir(), "luvus-stub-"));
    stubPath = "in-process";
    installLuvusStub();
    // The module-level UHP event stream is faked in tests: no child process
    // spawns, and `agent list` answers an empty snapshot and exits.
    __setUhpSpawnForTests__((args) => {
      if (args[0] === "agent") {
        return {
          stdout: (async function* () {
            yield Buffer.from(`${JSON.stringify({ result: { agents: [] } })}\n`);
          })(),
          kill() {},
        };
      }
      return silentUhpChild();
    });
  });

  after(() => {
    __setLuvusExecForTests__(null);
    __setUhpSpawnForTests__(null);
    rmSync(stubDir, { recursive: true, force: true });
  });

  it("is available only when all three LUVUS_* env vars are set", () => {
    assert.equal(
      withLuvusEnv(
        allLuvusKeys({ LUVUS_ENV: "1", LUVUS_BIN_PATH: stubPath, LUVUS_PANE_ID: "21" }),
        isMuxAvailable,
      ),
      true,
    );
    assert.equal(
      withLuvusEnv(allLuvusKeys({ LUVUS_BIN_PATH: stubPath, LUVUS_PANE_ID: "21" }), isMuxAvailable),
      false,
    );
    assert.equal(
      withLuvusEnv(allLuvusKeys({ LUVUS_ENV: "1", LUVUS_BIN_PATH: stubPath }), isMuxAvailable),
      false,
    );
    assert.equal(
      withLuvusEnv(allLuvusKeys({ LUVUS_ENV: "1", LUVUS_PANE_ID: "21" }), isMuxAvailable),
      false,
    );
    assert.equal(withLuvusEnv(allLuvusKeys({}), isMuxAvailable), false);
  });

  it("createSurface splits the caller pane unfocused and reads the pane id from the 1.1 fixture", () => {
    const log = join(stubDir, "calls.log");
    const surface = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => createSurface("Scout"),
    );
    assert.equal(surface, "24");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "pane split 21 --right --no-focus",
      "pane name scout --pane 24",
    ]);
  });

  it("createSurface slugifies free-text names into valid Luvus pane names", () => {
    const log = join(stubDir, "calls-slug.log");
    withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => createSurface("Review: API diff!"),
    );
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls[1], "pane name review-api-diff --pane 24");
  });

  it("createSurface throws with the raw JSON when the split result has no pane id", () => {
    assert.throws(
      () =>
        withLuvusEnv(
          allLuvusKeys({
            LUVUS_ENV: "1",
            LUVUS_BIN_PATH: stubPath,
            LUVUS_PANE_ID: "21",
            LUVUS_STUB_MODE: "no-pane",
          }),
          () => createSurface("Scout"),
        ),
      /no pane id/,
    );
  });

  it("createSurface tab placement looks up the caller tab, moves the pane, and restores focus", () => {
    const log = join(stubDir, "calls-tab.log");
    const surface = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => createSurface("Scout", "tab"),
    );
    assert.equal(surface, "24");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "agent list",
      "pane split 21 --right --no-focus",
      "pane name scout --pane 24",
      "pane move 24 --new-tab",
      "tab focus 1",
    ]);
  });

  it("createSurface tab placement keeps pane placement when the caller tab is unknown", () => {
    const log = join(stubDir, "calls-nocaller.log");
    const surface = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
        LUVUS_STUB_MODE: "no-caller",
      }),
      () => createSurface("Scout", "tab"),
    );
    assert.equal(surface, "24");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.includes("agent list"));
    assert.ok(!calls.some((call) => call.startsWith("pane move")));
    assert.ok(!calls.some((call) => call.startsWith("tab focus")));
  });

  it("createSurface tab placement keeps the pane when the move fails and skips focus restore", () => {
    const log = join(stubDir, "calls-moveerr.log");
    const surface = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
        LUVUS_STUB_MODE: "move-error",
      }),
      () => createSurface("Scout", "tab"),
    );
    assert.equal(surface, "24");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.includes("pane move 24 --new-tab"));
    assert.ok(!calls.some((call) => call.startsWith("tab focus")));
  });

  it("createSurface tab placement still succeeds when focus restore fails", () => {
    const log = join(stubDir, "calls-focuserr.log");
    const surface = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
        LUVUS_STUB_MODE: "focus-error",
      }),
      () => createSurface("Scout", "tab"),
    );
    assert.equal(surface, "24");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.includes("pane move 24 --new-tab"));
    assert.ok(calls.includes("tab focus 1"));
  });

  it("createSurface right placement never calls agent list", () => {
    const log = join(stubDir, "calls-plainpane.log");
    withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => createSurface("Scout", "right"),
    );
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["pane split 21 --right --no-focus", "pane name scout --pane 24"]);
  });

  it("createSurface down placement stacks the pane below the caller", () => {
    const log = join(stubDir, "calls-down.log");
    withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => createSurface("Scout", "down"),
    );
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["pane split 21 --down --no-focus", "pane name scout --pane 24"]);
  });

  it("surfaces the Luvus .error message as an Error", () => {
    assert.throws(
      () =>
        withLuvusEnv(
          allLuvusKeys({
            LUVUS_ENV: "1",
            LUVUS_BIN_PATH: stubPath,
            LUVUS_PANE_ID: "21",
            LUVUS_STUB_MODE: "error",
          }),
          () => closeSurface("24"),
        ),
      /stub exploded/,
    );
  });

  it("readScreen tails the screen to n lines", () => {
    const screen = withLuvusEnv(
      allLuvusKeys({ LUVUS_ENV: "1", LUVUS_BIN_PATH: stubPath, LUVUS_PANE_ID: "21" }),
      () => readScreen("24", 3),
    );
    assert.equal(screen, "l6\nl7\nl8");
  });

  it("sendEscape sends the escape key through agent keys", () => {
    const log = join(stubDir, "calls-esc.log");
    withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => sendEscape("24"),
    );
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["agent keys 24 esc"]);
  });

  it("runInPane sends one command line to the pane", () => {
    const log = join(stubDir, "calls-run.log");
    withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => runInPane("24", 'node "/ext/cli.ts" "run" "/spec.json"'),
    );
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      'pane run 24 node "/ext/cli.ts" "run" "/spec.json"',
    ]);
  });

  it("readExitSidecar returns the payload, or null for a missing or malformed sidecar", async () => {
    await withTempDir(async (dir) => {
      const sessionFile = join(dir, "child.jsonl");
      assert.equal(readExitSidecar(sessionFile), null);
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      assert.deepEqual(readExitSidecar(sessionFile), { type: "done" });
      writeFileSync(`${sessionFile}.exit`, "{ nope");
      assert.equal(readExitSidecar(sessionFile), null);
    });
  });

  it("agentPrompt sends `agent prompt` without --wait and unwraps the queued answer", () => {
    const log = join(stubDir, "calls-prompt.log");
    const result = withLuvusEnv(
      allLuvusKeys({
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: stubPath,
        LUVUS_PANE_ID: "21",
        LUVUS_STUB_LOG: log,
      }),
      () => agentPrompt("24", "hello"),
    ) as { submitted?: boolean; evidence?: string; pane?: string };
    assert.equal(result.submitted, true);
    assert.equal(result.evidence, "queued");
    assert.equal(result.pane, "24");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["agent prompt 24 hello"]);
    assert.equal(calls.join("\n").includes("--wait"), false);
  });

  it("agentPrompt surfaces agent_not_ready without retrying", () => {
    const log = join(stubDir, "calls-prompt-notready.log");
    assert.throws(
      () =>
        withLuvusEnv(
          allLuvusKeys({
            LUVUS_ENV: "1",
            LUVUS_BIN_PATH: stubPath,
            LUVUS_PANE_ID: "21",
            LUVUS_STUB_MODE: "not-ready",
            LUVUS_STUB_LOG: log,
          }),
          () => agentPrompt("24", "hi"),
        ),
      /agent_not_ready/,
    );
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["agent prompt 24 hi"]);
  });

  // Adopts the close-error stub mode: `pane close` fails as if the user
  // closed the pane by hand. Unlike withLuvusEnv above, this helper holds
  // the env across awaits so watchSubagent still sees the stub after its
  // first tick.
  async function withLuvusEnvAsync(
    env: Record<string, string | undefined>,
    fn: () => Promise<any>,
  ): Promise<any> {
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  describe("pollForExit screen handling", () => {
    /** Run pollForExit until it ends or the deadline aborts it; report the
     * last argv logged and whether a result was produced. */
    async function pollUntil(
      env: Record<string, string | undefined>,
      options: Partial<Parameters<typeof pollForExit>[2]> & {
        deadlineMs: number;
        interval?: number;
      },
    ): Promise<{
      result: Awaited<ReturnType<typeof pollForExit>> | null;
      aborted: boolean;
      calls: string[];
    }> {
      const log = join(stubDir, `calls-${Math.random().toString(16).slice(2)}.log`);
      return withLuvusEnvAsync(allLuvusKeys({ ...env, LUVUS_STUB_LOG: log }), async () => {
        // Self-contained seam: don't depend on the enclosing describe's before hook.
        installLuvusStub();
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), options.deadlineMs);
        let result: Awaited<ReturnType<typeof pollForExit>> | null = null;
        let aborted = false;
        try {
          result = await pollForExit("24", controller.signal, {
            interval: options.interval ?? 10,
            ...options,
          });
        } catch (error) {
          if (!/Aborted/.test(String(error)))
            console.error("POLLFOREXIT-RAW-ERROR", JSON.stringify(String(error?.stack ?? error)));
          aborted = /Aborted/.test(String(error));
        } finally {
          clearTimeout(deadline);
          installLuvusStub();
        }
        const calls = existsSync(log)
          ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
          : [];
        return { result, aborted, calls };
      });
    }

    it("accepts a matched screen sentinel when no live agent hosts the pane", async () => {
      const outcome = await pollUntil(
        {
          LUVUS_ENV: "1",
          LUVUS_BIN_PATH: stubPath,
          LUVUS_PANE_ID: "21",
          LUVUS_STUB_SCREEN: "done __SUBAGENT_DONE_3__",
          // No entry for pane 24 at all.
          LUVUS_STUB_AGENTS: "[]",
        },
        { deadlineMs: 1000 },
      );
      assert.equal(outcome.aborted, false);
      assert.deepEqual(outcome.result, { reason: "sentinel", exitCode: 3 });
      assert.ok(outcome.calls.includes("pane read 24"));
      assert.ok(outcome.calls.includes("agent list"));
    });

    it("accepts a screen sentinel when the pane only holds a terminal done lease", async () => {
      const outcome = await pollUntil(
        {
          LUVUS_ENV: "1",
          LUVUS_BIN_PATH: stubPath,
          LUVUS_PANE_ID: "21",
          LUVUS_STUB_SCREEN: "__SUBAGENT_DONE_0__\n",
          LUVUS_STUB_AGENTS: '[{"pane":"24","status":"done","authority":"integration_report"}]',
        },
        { deadlineMs: 1000 },
      );
      assert.deepEqual(outcome.result, { reason: "sentinel", exitCode: 0 });
    });

    for (const [label, agents] of [
      [
        "a working process-tree agent",
        '[{"pane":"24","status":"working","authority":"process_tree"}]',
      ],
      ["an idle process-tree agent", '[{"pane":"24","status":"idle","authority":"process_tree"}]'],
      [
        "an agent with a non-terminal lease",
        '[{"pane":"24","status":"working","authority":"integration_report"}]',
      ],
    ] as Array<[string, string]>) {
      it(`keeps polling when the sentinel text sits under ${label}`, async () => {
        const outcome = await pollUntil(
          {
            LUVUS_ENV: "1",
            LUVUS_BIN_PATH: stubPath,
            LUVUS_PANE_ID: "21",
            LUVUS_STUB_SCREEN: "done __SUBAGENT_DONE_3__",
            LUVUS_STUB_AGENTS: agents,
          },
          { deadlineMs: 160, interval: 30 },
        );
        assert.equal(outcome.result, null);
        assert.equal(outcome.aborted, true);
        // Every tick re-scanned and re-confirmed instead of claiming completion.
        assert.ok(outcome.calls.filter((call) => call === "pane read 24").length >= 2);
        assert.ok(outcome.calls.filter((call) => call === "agent list").length >= 2);
      });
    }

    it("skips the whole screen scan while maySkipScreenScan returns true", async () => {
      const outcome = await pollUntil(
        {
          LUVUS_ENV: "1",
          LUVUS_BIN_PATH: stubPath,
          LUVUS_PANE_ID: "21",
          LUVUS_STUB_SCREEN: "__SUBAGENT_DONE_0__\n",
        },
        { deadlineMs: 120, interval: 30, maySkipScreenScan: () => true },
      );
      assert.equal(outcome.result, null);
      assert.equal(outcome.aborted, true);
      assert.deepEqual(outcome.calls, []);
    });

    it("sentinelLooksLive classifies agent-list rows without touching the CLI", () => {
      assert.equal(
        sentinelLooksLive(
          { agents: [{ pane: "24", status: "working", authority: "process_tree" }] },
          "24",
        ),
        true,
      );
      assert.equal(
        sentinelLooksLive(
          { agents: [{ pane: "24", status: "idle", authority: "process_tree" }] },
          "24",
        ),
        true,
      );
      assert.equal(
        sentinelLooksLive(
          { agents: [{ pane: "24", status: "done", authority: "integration_report" }] },
          "24",
        ),
        false,
      );
      assert.equal(sentinelLooksLive({ agents: [{ pane: "24", status: "blocked" }] }, "24"), false);
      assert.equal(sentinelLooksLive({ agents: [{ pane: "99", status: "done" }] }, "24"), false);
      assert.equal(sentinelLooksLive({ agents: [] }, "24"), false);
      assert.equal(sentinelLooksLive(null, "24"), false);
    });
  });
});

describe("subagent child status ownership", () => {
  beforeEach(() => {
    // The status reporter's registration guard is module-level; reset it so
    // each test below registers through a fresh runtime.
    __resetRegistrationForTests__();
  });

  /** Record every Luvus CLI call the extension makes through the test seam. */
  function recordLuvusCalls(): string[][] {
    const calls: string[][] = [];
    __setLuvusExecForTests__((args) => {
      calls.push(args);
      return "{}";
    });
    return calls;
  }

  function makeRecordingPi() {
    const handlers = new Map<string, Array<(data?: unknown, ctx?: unknown) => void>>();
    const registeredTools: Array<any> = [];
    const sentMessages: Array<any> = [];
    return {
      fire(event: string, data?: unknown, ctx?: unknown) {
        for (const fn of handlers.get(event) ?? []) fn(data, ctx);
      },
      registeredTools,
      sentMessages,
      pi: {
        on(event: string, fn: (data?: unknown, ctx?: unknown) => void) {
          handlers.set(event, [...(handlers.get(event) ?? []), fn]);
        },
        registerTool(tool: any) {
          registeredTools.push(tool);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerShortcut() {},
        sendUserMessage() {},
        sendMessage(message: any, options?: any) {
          sentMessages.push({ message, options });
        },
        getAllTools() {
          return [];
        },
      } as any,
    };
  }

  const CTX = {
    cwd: "/tmp",
    ui: { setTitle() {} },
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionName: () => "test",
      getEntries: () => [],
    },
  };

  /** Set the Luvus env plus an optional child marker; returns a restore function. */
  function withStatusEnv(childSession: string | null): () => void {
    const keys = ["LUVUS_ENV", "LUVUS_BIN_PATH", "LUVUS_PANE_ID", "PI_LUVUS_SESSION"];
    const saved = new Map(keys.map((k) => [k, process.env[k]]));
    process.env.LUVUS_ENV = "1";
    process.env.LUVUS_BIN_PATH = "/bin/luvus";
    process.env.LUVUS_PANE_ID = "7";
    if (childSession === null) delete process.env.PI_LUVUS_SESSION;
    else process.env.PI_LUVUS_SESSION = childSession;
    return () => {
      for (const [k, v] of saved) restoreEnvVar(k, v);
      __setLuvusExecForTests__(null);
    };
  }

  /** Status lease calls only: agent report / agent release. */
  function statusCalls(calls: string[][]): string[][] {
    return calls.filter((a) => a[0] === "agent" && (a[1] === "report" || a[1] === "release"));
  }

  it("isSubagentChild detects a child by PI_LUVUS_SESSION", () => {
    assert.equal(
      subagentsModule.isSubagentChild({ PI_LUVUS_SESSION: "/tmp/s.jsonl" } as NodeJS.ProcessEnv),
      true,
    );
    assert.equal(subagentsModule.isSubagentChild({} as NodeJS.ProcessEnv), false);
  });

  it("skips the status reporter in a subagent child", async () => {
    const restore = withStatusEnv("/tmp/sub-session.jsonl");
    try {
      const calls = recordLuvusCalls();
      const target = makeRecordingPi();
      subagentsModule.default(target.pi);
      target.fire("session_start", undefined, CTX);
      await new Promise((resolve) => setImmediate(resolve));
      // An aborted turn keeps the turn notifier silent; only the status
      // reporter could react to agent_end here.
      target.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, CTX);
      await new Promise((resolve) => setImmediate(resolve));
      target.fire("session_shutdown", undefined, CTX);
      assert.deepEqual(statusCalls(calls), []);
    } finally {
      restore();
    }
  });

  it("registers the status reporter in a plain pane", async () => {
    const restore = withStatusEnv(null);
    try {
      const calls = recordLuvusCalls();
      const target = makeRecordingPi();
      subagentsModule.default(target.pi);
      target.fire("session_start", undefined, CTX);
      await new Promise((resolve) => setImmediate(resolve));
      target.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, CTX);
      await new Promise((resolve) => setImmediate(resolve));
      target.fire("session_shutdown", undefined, CTX);
      const seen = statusCalls(calls);
      assert.equal(
        seen.filter((a) => a[1] === "report" && a[a.indexOf("--status") + 1] === "idle").length >=
          1,
        true,
      );
      assert.equal(seen.filter((a) => a[1] === "release").length, 1);
    } finally {
      restore();
    }
  });

  it("spawns through the current supervisor after a session restart", async () => {
    await withTempDir(async (dir) => {
      const calls: string[][] = [];
      __setLuvusExecForTests__((args) => {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "split") {
          return '{"id":"1","result":{"pane":"24","revision":1,"type":"pane","tab":"1","workspace":"2"}}';
        }
        return '{"id":"1","result":{"revision":1,"type":"ok"}}';
      });
      const saved: Array<[string, string | undefined]> = [
        ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
        ["PI_LUVUS_SHELL_READY_DELAY_MS", process.env.PI_LUVUS_SHELL_READY_DELAY_MS],
        ["LUVUS_ENV", process.env.LUVUS_ENV],
        ["LUVUS_BIN_PATH", process.env.LUVUS_BIN_PATH],
        ["LUVUS_PANE_ID", process.env.LUVUS_PANE_ID],
      ];
      process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
      process.env.PI_LUVUS_SHELL_READY_DELAY_MS = "0";
      process.env.LUVUS_ENV = "1";
      process.env.LUVUS_BIN_PATH = "in-process";
      process.env.LUVUS_PANE_ID = "21";
      const testApi = (subagentsModule as any).__test__;
      const target = makeRecordingPi();
      try {
        subagentsModule.default(target.pi);
        // Session teardown shuts the registration-time supervisor down...
        target.fire("session_shutdown", undefined, CTX);
        // ...and the next session installs its replacement.
        target.fire("session_start", undefined, CTX);

        const spawnTool = target.registeredTools.find((tool: any) => tool.name === "luvus_spawn");
        assert.ok(spawnTool, "expected luvus_spawn tool to be registered");

        const ctx = {
          cwd: dir,
          sessionManager: {
            getSessionFile: () => join(dir, "parent.jsonl"),
            getSessionId: () => "sess-restart",
            getSessionDir: () => join(dir, "sessions"),
          },
        };
        const result = await spawnTool.execute(
          "call-1",
          { name: "Scout", task: "survey the repo" },
          undefined,
          undefined,
          ctx,
        );
        assert.equal(result.details.status, "started");

        // The child must be tracked by the supervisor session_start installed,
        // not the shut-down registration-time one — a watcher on the shut-down
        // supervisor's abort controller would report "Subagent cancelled."
        // for a child that is still running.
        const supervisor = testApi.getCurrentSupervisor();
        assert.equal(
          supervisor.running().some((agent: any) => agent.id === result.details.id),
          true,
        );
        assert.equal(supervisor.getAbortController().signal.aborted, false);

        // End the watcher through the sidecar and let the current supervisor
        // finish the run, so no poll loop outlives the test.
        writeFileSync(`${result.details.sessionFile}.exit`, JSON.stringify({ type: "done" }));
        for (let i = 0; i < 150 && supervisor.running().length > 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(supervisor.running().length, 0);
        assert.equal(
          target.sentMessages.some(
            (sent: any) =>
              sent.message?.customType === "luvus_result" &&
              /Subagent cancelled\./.test(sent.message?.content ?? ""),
          ),
          false,
        );
      } finally {
        // Stop the replacement supervisor's intervals, watcher and stream.
        target.fire("session_shutdown", undefined, CTX);
        for (const [name, value] of saved) restoreEnvVar(name, value);
        __setLuvusExecForTests__(null);
      }
    });
  });
});
