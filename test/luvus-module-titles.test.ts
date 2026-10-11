/**
 * Unit tests for the Luvus pane-titles module.
 *
 * The parsing functions are pure and tested directly. The collection tests
 * write real fixture session files into a temporary sessions root and drive
 * `indexSessionFiles` + `collectTitles`, so file naming, mtime caching, and
 * the 256-session cap are exercised end to end.
 */
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTitlePushArgs,
  capTitleBytes,
  collectTitles,
  emptyCache,
  indexSessionFiles,
  main,
  MAX_SESSIONS,
  parseAgentSessions,
  parseSessionTitle,
  piSessions,
  sessionIdFromFileName,
  sessionsRoot,
  titleFromEntries,
  type AgentSession,
} from "../luvus-module/titles.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-pane-titles-"));
  roots.push(root);
  return root;
}

/** One JSONL session file's text from raw entries. */
function sessionText(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function userMessage(text: string): unknown {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

const T0 = Date.parse("2026-10-10T00:00:00.000Z");

/** Write a session file named `<stamp>_<id>.jsonl` with a fixed mtime. */
function writeSession(root: string, id: string, text: string, mtimeMs = T0): string {
  const dir = join(root, "--fixture--");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-10T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, text, "utf8");
  const when = new Date(mtimeMs);
  utimesSync(path, when, when);
  return path;
}

function session(id: string): AgentSession {
  return { agent: "pi", session_id: id, cwd: "/work/app" };
}

describe("parseAgentSessions", () => {
  it("reads the Luvus envelope, a bare list, and junk", () => {
    const rows = [session("a"), { agent: "claude", session_id: "b" }];
    assert.deepEqual(parseAgentSessions(JSON.stringify({ id: "1", result: { sessions: rows } })), rows);
    assert.deepEqual(parseAgentSessions(JSON.stringify(rows)), rows);
    assert.deepEqual(parseAgentSessions(JSON.stringify({ sessions: rows })), rows);
    assert.deepEqual(parseAgentSessions("not json"), []);
    assert.deepEqual(parseAgentSessions(JSON.stringify({ result: { sessions: [{ agent: "pi" }] } })), []);
  });
});

describe("sessionIdFromFileName", () => {
  it("reads the id after the last underscore", () => {
    assert.equal(sessionIdFromFileName("2026-10-02T15-25-11-301Z_01a0fd38-2905-7368.jsonl"), "01a0fd38-2905-7368");
    assert.equal(sessionIdFromFileName("01a0fd38.jsonl"), "01a0fd38");
    assert.equal(sessionIdFromFileName("notes.txt"), null);
  });
});

describe("sessionsRoot", () => {
  it("respects PI_CODING_AGENT_DIR and defaults under the home dir", () => {
    assert.equal(sessionsRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" }), join("/tmp/agent", "sessions"));
    assert.ok(sessionsRoot({}).endsWith(join(".pi", "agent", "sessions")));
  });
});

describe("titleFromEntries", () => {
  it("prefers the last session_info name", () => {
    assert.equal(
      titleFromEntries([
        { type: "session_info", name: "first name" },
        { type: "model_change" },
        { type: "session_info", name: "auth refactor" },
        userMessage("Fix it"),
      ]),
      "auth refactor",
    );
  });

  it("falls back to the first user message when unnamed", () => {
    assert.equal(
      titleFromEntries([
        { type: "model_change" },
        { type: "message", message: { role: "assistant", content: "hi" } },
        userMessage("Map the auth flow"),
        userMessage("second prompt"),
      ]),
      "Map the auth flow",
    );
  });

  it("falls back to the prompt when the name is blank", () => {
    assert.equal(
      titleFromEntries([{ type: "session_info", name: "   " }, userMessage("Real prompt")]),
      "Real prompt",
    );
  });

  it("returns nothing with no name and no user message", () => {
    assert.equal(titleFromEntries([{ type: "model_change" }, { type: "session_info", name: "" }]), "");
    assert.equal(titleFromEntries([]), "");
  });

  it("cuts the first line to the shared 48 characters", () => {
    assert.equal(titleFromEntries([userMessage(`${"x".repeat(60)}\nsecond`)]), "x".repeat(48));
  });
});

describe("parseSessionTitle", () => {
  it("parses JSONL and skips malformed lines", () => {
    const text = ["not json", JSON.stringify({ type: "model_change" }), JSON.stringify(userMessage("Recovered"))].join("\n");
    assert.equal(parseSessionTitle(text), "Recovered");
    assert.equal(parseSessionTitle(""), "");
  });
});

describe("capTitleBytes", () => {
  it("leaves titles at or under the cap", () => {
    assert.equal(capTitleBytes("short"), "short");
    assert.equal(capTitleBytes("x".repeat(256)).length, 256);
  });

  it("cuts at the cap without splitting a code point", () => {
    const title = "😀".repeat(100); // 400 UTF-8 bytes
    const capped = capTitleBytes(title, 256);
    assert.equal(Buffer.byteLength(capped, "utf8"), 256);
    assert.equal(capped, "😀".repeat(64));
  });
});

describe("piSessions and buildTitlePushArgs", () => {
  it("keeps only pi rows and caps the count", () => {
    const all = [session("a"), { agent: "claude", session_id: "b" }, session("c")];
    assert.deepEqual(piSessions(all).map((row) => row.session_id), ["a", "c"]);
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session(`s${i}`));
    assert.equal(piSessions(many).length, MAX_SESSIONS);
    assert.equal(piSessions(many).at(-1)?.session_id, `s${MAX_SESSIONS - 1}`);
  });

  it("builds one push argv with the JSON rows", () => {
    const rows = [{ agent: "pi", session_id: "a", title: "Ship it" }];
    assert.deepEqual(buildTitlePushArgs(rows), ["ui", "agent-title", "push", "--titles", JSON.stringify(rows)]);
  });
});

describe("collectTitles fixtures", () => {
  it("titles a named and an unnamed session and skips one with no user message", () => {
    const root = makeRoot();
    writeSession(root, "named", sessionText([{ type: "session_info", name: "auth refactor" }, userMessage("Fix it")]));
    writeSession(root, "unnamed", sessionText([{ type: "model_change" }, userMessage("Map the auth flow")]));
    writeSession(root, "empty", sessionText([{ type: "model_change" }]));
    const index = indexSessionFiles(root);
    assert.equal(index.size, 3);

    const { rows, reads } = collectTitles(
      [session("named"), session("unnamed"), session("empty")],
      emptyCache(),
      index,
      (path) => readFileSync(path, "utf8"),
    );
    assert.deepEqual(rows, [
      { agent: "pi", session_id: "named", title: "auth refactor" },
      { agent: "pi", session_id: "unnamed", title: "Map the auth flow" },
    ]);
    assert.equal(reads, 3);
  });

  it("ignores non-pi rows and sessions with no session file", () => {
    const root = makeRoot();
    writeSession(root, "known", sessionText([userMessage("Known prompt")]));
    const index = indexSessionFiles(root);
    const { rows } = collectTitles(
      [{ agent: "claude", session_id: "known" }, session("missing")],
      emptyCache(),
      index,
      (path) => readFileSync(path, "utf8"),
    );
    assert.deepEqual(rows, []);
  });

  it("pushes only the most recent 256 sessions", () => {
    const root = makeRoot();
    const total = MAX_SESSIONS + 4;
    const sessions: AgentSession[] = [];
    for (let i = 0; i < total; i++) {
      const id = String(i).padStart(3, "0");
      writeSession(root, id, sessionText([userMessage(`prompt ${id}`)]));
      sessions.push(session(id));
    }
    const { rows } = collectTitles(sessions, emptyCache(), indexSessionFiles(root), (path) =>
      readFileSync(path, "utf8"),
    );
    assert.equal(rows.length, MAX_SESSIONS);
    assert.equal(rows[0].session_id, "000");
    assert.equal(rows.at(-1)?.session_id, String(MAX_SESSIONS - 1).padStart(3, "0"));
  });

  it("re-reads only a changed file and keeps the title of an unchanged one", () => {
    const root = makeRoot();
    const pathA = writeSession(root, "a", sessionText([userMessage("Prompt A")]), T0);
    writeSession(root, "b", sessionText([{ type: "session_info", name: "bee" }]), T0);
    const sessions = [session("a"), session("b")];

    let reads = 0;
    const read = (path: string) => {
      reads++;
      return readFileSync(path, "utf8");
    };
    const first = collectTitles(sessions, emptyCache(), indexSessionFiles(root), read);
    assert.equal(reads, 2);
    assert.deepEqual(first.rows, [
      { agent: "pi", session_id: "a", title: "Prompt A" },
      { agent: "pi", session_id: "b", title: "bee" },
    ]);

    // Unchanged files are served from the cache: no reads.
    reads = 0;
    const second = collectTitles(sessions, first.cache, indexSessionFiles(root), read);
    assert.equal(reads, 0);
    assert.deepEqual(second.rows, first.rows);

    // Rewriting A with a newer mtime re-reads only A.
    writeFileSync(pathA, sessionText([userMessage("Prompt A changed")]), "utf8");
    const newer = new Date(T0 + 60_000);
    utimesSync(pathA, newer, newer);
    reads = 0;
    const third = collectTitles(sessions, second.cache, indexSessionFiles(root), read);
    assert.equal(reads, 1);
    assert.deepEqual(third.rows, [
      { agent: "pi", session_id: "a", title: "Prompt A changed" },
      { agent: "pi", session_id: "b", title: "bee" },
    ]);
  });

  it("skips an unreadable session file and still titles the others", () => {
    const root = makeRoot();
    const pathBad = writeSession(root, "bad", sessionText([userMessage("Gone")]));
    writeSession(root, "good", sessionText([userMessage("Keep me")]));
    const index = indexSessionFiles(root);

    const { rows, reads } = collectTitles(
      [session("bad"), session("good")],
      emptyCache(),
      index,
      (path) => {
        if (path === pathBad) throw new Error("ENOENT: file vanished");
        return readFileSync(path, "utf8");
      },
    );
    assert.deepEqual(rows, [{ agent: "pi", session_id: "good", title: "Keep me" }]);
    assert.equal(reads, 1);
  });
});

describe("main", () => {
  it("returns 0 and titles the readable sessions when one listed session has no file", () => {
    const work = makeRoot();
    const agentDir = makeRoot();
    const dir = join(agentDir, "sessions", "--fixture--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-10-10T00-00-00-000Z_good.jsonl"),
      sessionText([userMessage("Keep me")]),
      "utf8",
    );

    const pushFile = join(work, "push.json");
    const bin = join(work, "luvus-stub.mjs");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "if (args[0] === 'agent' && args[1] === 'sessions') {",
        "  process.stdout.write(JSON.stringify({ id: '1', result: { sessions: [",
        "    { agent: 'pi', cwd: '/work/app', session_id: 'good' },",
        "    { agent: 'pi', cwd: '/work/app', session_id: 'missing' },",
        "  ] } }));",
        "} else if (args[0] === 'ui' && args[1] === 'agent-title') {",
        `  writeFileSync(${JSON.stringify(pushFile)}, args[4] ?? '');`,
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);

    const code = main({
      LUVUS_BIN_PATH: bin,
      PI_CODING_AGENT_DIR: agentDir,
      LUVUS_MODULE_STATE_DIR: makeRoot(),
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(pushFile, "utf8")), [
      { agent: "pi", session_id: "good", title: "Keep me" },
    ]);
  });

  it("refuses to run when LUVUS_BIN_PATH is unset instead of resolving luvus on PATH", () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const code = main({ PI_CODING_AGENT_DIR: makeRoot(), LUVUS_MODULE_STATE_DIR: makeRoot() });
      assert.equal(code, 1);
      assert.equal(spy.mock.callCount(), 1);
      assert.match(String(spy.mock.calls[0]?.arguments[0]), /LUVUS_BIN_PATH/);
    } finally {
      mock.restoreAll();
    }
  });
});
