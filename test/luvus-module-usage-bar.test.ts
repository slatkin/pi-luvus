/**
 * Unit tests for the Luvus pi-usage Bar module.
 *
 * The parsing and formatting functions are pure and tested directly. The
 * collection tests write real fixture session files into a temporary sessions
 * root and drive `indexSessionFiles` + `collectUsage`, so file naming and the
 * mtime/size cache are exercised end to end. `main` runs against a stub Luvus
 * binary, so no live Luvus is needed.
 */
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildBarArgs,
  buildBarRemoveArgs,
  collectUsage,
  emptyUsageCache,
  formatCost,
  formatTokens,
  main,
  parseAgentList,
  parseSessionUsage,
  piSessionIds,
  BAR_ID,
  type AgentEntry,
} from "../luvus-module/usage-bar.ts";
import { indexSessionFiles } from "../luvus-module/titles.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-usage-bar-"));
  roots.push(root);
  return root;
}

function assistantMessage(cost: number, totalTokens: number): unknown {
  return {
    type: "message",
    message: { role: "assistant", usage: { cost: { total: cost }, totalTokens } },
  };
}

/** One JSONL session file's text from raw entries. */
function sessionText(entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
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

function pane(session: string, agent = "pi"): AgentEntry {
  return { agent, session };
}

/** The rendered text of a Bar content segment list (`·` joins the values). */
function renderSegments(content: unknown): string {
  const segments = JSON.parse(String(content)) as Array<{ type: string; text?: string }>;
  return segments
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text ?? "")
    .join(" · ");
}

describe("parseSessionUsage", () => {
  it("sums assistant cost and keeps the last totalTokens, skipping bad lines", () => {
    const text = [
      "not json",
      JSON.stringify({ type: "message", message: { role: "user" } }),
      JSON.stringify(assistantMessage(0.4, 31385)),
      JSON.stringify({ type: "session_info", name: "x" }),
      JSON.stringify(assistantMessage(0.85, 142000)),
    ].join("\n");
    assert.deepEqual(parseSessionUsage(text), { cost: 1.25, contextTokens: 142000 });
  });

  it("returns zeros with no assistant message", () => {
    assert.deepEqual(parseSessionUsage(""), { cost: 0, contextTokens: 0 });
    assert.deepEqual(parseSessionUsage(sessionText([{ type: "model_change" }])), {
      cost: 0,
      contextTokens: 0,
    });
  });

  it("ignores a usage block with missing or non-numeric fields", () => {
    const text = [
      JSON.stringify({ type: "message", message: { role: "assistant", usage: {} } }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { cost: { total: "1" } } },
      }),
      JSON.stringify(assistantMessage(0.5, 10)),
    ].join("\n");
    assert.deepEqual(parseSessionUsage(text), { cost: 0.5, contextTokens: 10 });
  });
});

describe("formatCost", () => {
  it("shows dollars and two decimals", () => {
    assert.equal(formatCost(1.25), "$1.25");
    assert.equal(formatCost(0.004), "$0.00");
    assert.equal(formatCost(0), "$0.00");
  });
});

describe("formatTokens", () => {
  it("renders the number, thousands, and millions forms", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(31385), "31k");
    assert.equal(formatTokens(1250000), "1.3M");
    assert.equal(formatTokens(1000), "1k");
    assert.equal(formatTokens(1000000), "1.0M");
  });
});

describe("buildBarArgs and buildBarRemoveArgs", () => {
  it("renders the two-pane totals and the compact form", () => {
    const args = buildBarArgs({ panes: 2, cost: 1.25, contextTokens: 142000 });
    assert.deepEqual(args.slice(0, 5), ["bar", "push", "--id", BAR_ID, "--content"]);
    assert.equal(renderSegments(args[5]), "π 2 · $1.25 · ctx 142k");
    assert.equal(args[6], "--compact-content");
    assert.equal(renderSegments(args[7]), "π2 $1.25");
  });

  it("uses a separator segment between the values", () => {
    const content = JSON.parse(
      buildBarArgs({ panes: 2, cost: 1.25, contextTokens: 142000 })[5] as string,
    );
    assert.deepEqual(content, [
      { type: "text", text: "π 2" },
      { type: "separator" },
      { type: "text", text: "$1.25" },
      { type: "separator" },
      { type: "text", text: "ctx 142k" },
    ]);
  });

  it("builds the remove argv", () => {
    assert.deepEqual(buildBarRemoveArgs(), ["bar", "remove", "--id", BAR_ID]);
  });
});

describe("parseAgentList and piSessionIds", () => {
  it("reads the Luvus envelope, a bare list, and junk", () => {
    const rows = [pane("a"), { agent: "claude", session: "b" }];
    assert.deepEqual(parseAgentList(JSON.stringify({ id: "1", result: { agents: rows } })), rows);
    assert.deepEqual(parseAgentList(JSON.stringify(rows)), rows);
    assert.deepEqual(parseAgentList("not json"), []);
  });

  it("keeps pi panes with a session", () => {
    const panes = [pane("a"), { agent: "claude", session: "b" }, { agent: "pi" }, pane("c")];
    assert.deepEqual(piSessionIds(panes), ["a", "c"]);
  });
});

describe("collectUsage fixtures", () => {
  it("counts a pane with a missing session file and still totals the others", () => {
    const root = makeRoot();
    writeSession(root, "known", sessionText([assistantMessage(0.4, 31385)]));
    const { totals, reads } = collectUsage(
      [pane("known"), pane("missing")],
      emptyUsageCache(),
      indexSessionFiles(root),
      (path) => readFileSync(path, "utf8"),
    );
    assert.deepEqual(totals, { panes: 2, cost: 0.4, contextTokens: 31385 });
    assert.equal(reads, 1);
  });

  it("ignores a session with no assistant message", () => {
    const root = makeRoot();
    writeSession(root, "empty", sessionText([{ type: "model_change" }]));
    const { totals } = collectUsage(
      [pane("empty")],
      emptyUsageCache(),
      indexSessionFiles(root),
      (path) => readFileSync(path, "utf8"),
    );
    assert.deepEqual(totals, { panes: 1, cost: 0, contextTokens: 0 });
  });

  it("re-reads only a changed file and keeps the totals of an unchanged one", () => {
    const root = makeRoot();
    const pathA = writeSession(root, "a", sessionText([assistantMessage(0.4, 31385)]), T0);
    writeSession(root, "b", sessionText([assistantMessage(0.85, 142000)]), T0);
    const panes = [pane("a"), pane("b")];

    let reads = 0;
    const read = (path: string) => {
      reads++;
      return readFileSync(path, "utf8");
    };
    const first = collectUsage(panes, emptyUsageCache(), indexSessionFiles(root), read);
    assert.equal(reads, 2);
    assert.deepEqual(first.totals, { panes: 2, cost: 1.25, contextTokens: 142000 });

    // Unchanged files are served from the cache: no reads.
    reads = 0;
    const second = collectUsage(panes, first.cache, indexSessionFiles(root), read);
    assert.equal(reads, 0);
    assert.deepEqual(second.totals, first.totals);

    // Rewriting A with a newer mtime re-reads only A.
    writeFileSync(pathA, sessionText([assistantMessage(0.1, 500)]), "utf8");
    const newer = new Date(T0 + 60_000);
    utimesSync(pathA, newer, newer);
    reads = 0;
    const third = collectUsage(panes, second.cache, indexSessionFiles(root), read);
    assert.equal(reads, 1);
    assert.deepEqual(third.totals, { panes: 2, cost: 0.95, contextTokens: 142000 });
  });

  it("drops cache entries for sessions not in this run", () => {
    const root = makeRoot();
    writeSession(root, "a", sessionText([assistantMessage(0.4, 100)]));
    const first = collectUsage([pane("a")], emptyUsageCache(), indexSessionFiles(root), (path) =>
      readFileSync(path, "utf8"),
    );
    assert.equal(Object.keys(first.cache.files).length, 1);
    const second = collectUsage([], first.cache, indexSessionFiles(root), (path) =>
      readFileSync(path, "utf8"),
    );
    assert.deepEqual(second.totals, { panes: 0, cost: 0, contextTokens: 0 });
    assert.equal(Object.keys(second.cache.files).length, 0);
  });
});

describe("main", () => {
  function writeStub(work: string, agents: unknown[], log: string): string {
    const bin = join(work, "luvus-stub.mjs");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "import { appendFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");`,
        "if (args[0] === 'agent' && args[1] === 'list') {",
        `  process.stdout.write(${JSON.stringify(JSON.stringify({ id: "1", result: { agents } }))});`,
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  function readLog(log: string): string[][] {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  }

  it("pushes the totals for two pi panes", () => {
    const work = makeRoot();
    const agentDir = makeRoot();
    const dir = join(agentDir, "sessions", "--fixture--");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-10-10T00-00-00-000Z_a.jsonl"),
      sessionText([assistantMessage(0.4, 31385)]),
      "utf8",
    );
    writeFileSync(
      join(dir, "2026-10-10T00-00-00-000Z_b.jsonl"),
      sessionText([assistantMessage(0.85, 142000)]),
      "utf8",
    );
    const log = join(work, "log.jsonl");
    const bin = writeStub(work, [pane("a"), pane("b"), { agent: "claude", session: "c" }], log);

    const code = main({
      LUVUS_BIN_PATH: bin,
      PI_CODING_AGENT_DIR: agentDir,
      LUVUS_MODULE_STATE_DIR: makeRoot(),
    });
    assert.equal(code, 0);
    const calls = readLog(log);
    assert.deepEqual(calls[0], ["agent", "list"]);
    assert.equal(calls[1]?.[0], "bar");
    assert.equal(calls[1]?.[1], "push");
    assert.equal(calls[1]?.[3], BAR_ID);
    assert.equal(renderSegments(calls[1]?.[5]), "π 2 · $1.25 · ctx 142k");
  });

  it("removes the widget when no pi pane is live", () => {
    const work = makeRoot();
    const log = join(work, "log.jsonl");
    const bin = writeStub(work, [{ agent: "claude", session: "c" }], log);

    const code = main({
      LUVUS_BIN_PATH: bin,
      PI_CODING_AGENT_DIR: makeRoot(),
      LUVUS_MODULE_STATE_DIR: makeRoot(),
    });
    assert.equal(code, 0);
    assert.deepEqual(readLog(log)[1], ["bar", "remove", "--id", BAR_ID]);
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

describe("module manifest", () => {
  const manifest = readFileSync(
    new URL("../luvus-module/luvus-module.toml", import.meta.url),
    "utf8",
  );

  it("keeps the module id and declares one pi-usage bar", () => {
    assert.match(manifest, /^id = "pi-luvus\.pane-titles"$/m);
    assert.equal(manifest.match(/^\[\[bars\]\]$/gm)?.length, 1);
    assert.match(manifest, /^id = "pi-usage"$/m);
    assert.match(manifest, /^title = "pi usage"$/m);
  });

  it("runs both module scripts on startup and on each trigger", () => {
    assert.equal(manifest.match(/^\[\[startup\]\]$/gm)?.length, 2);
    assert.equal(manifest.match(/^\[\[events\]\]$/gm)?.length, 4);
    assert.equal(manifest.match(/^on = "pane\.agent_status_changed"$/gm)?.length, 2);
    assert.equal(manifest.match(/^on = "pane\.closed"$/gm)?.length, 2);
    assert.equal(manifest.match(/command = \["node", "titles\.ts"\]/g)?.length, 3);
    assert.equal(manifest.match(/command = \["node", "usage-bar\.ts"\]/g)?.length, 3);
  });
});
