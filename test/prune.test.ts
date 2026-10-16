import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Sandbox the Luvus ambient environment for the whole test process: an
// ambient Luvus session must never be reachable from an un-stubbed test.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("LUVUS_")) delete process.env[key];
}
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../pi-extension/luvus/cli.ts";
import { isSentinelFile, pruneScratch, pruneSentinels } from "../pi-extension/luvus/prune.ts";
import { __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";

const DAY_MS = 86_400_000;
let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "prune-test-"));
});

after(() => {
  __setLuvusExecForTests__(null);
  rmSync(workdir, { recursive: true, force: true });
});

/** Write a file with an mtime `ageMs` in the past. */
function seed(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(16));
  const past = new Date(Date.now() - ageMs);
  utimesSync(path, past, past);
  return path;
}

describe("pruneScratch", () => {
  it("deletes old managed files and keeps fresh and foreign ones", () => {
    const dir = mkdtempSync(join(workdir, "scratch-"));
    const oldSession = seed(dir, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const oldSpec = seed(dir, "scout-deadbeef.json", 8 * DAY_MS);
    const freshSession = seed(dir, "scout-cafe0001.jsonl", DAY_MS);
    const foreign = seed(dir, "notes.txt", 30 * DAY_MS);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS });
    assert.equal(existsSync(oldSession), false);
    assert.equal(existsSync(oldSpec), false);
    assert.equal(existsSync(freshSession), true);
    assert.equal(existsSync(foreign), true);
    assert.equal(result.deleted.length, 2);
    assert.equal(result.deletedBytes, 32);
  });

  it("lists without deleting on dry run", () => {
    const dir = mkdtempSync(join(workdir, "dry-"));
    const old = seed(dir, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const result = pruneScratch(dir, { maxAgeMs: 7 * DAY_MS, dryRun: true });
    assert.equal(existsSync(old), true);
    assert.deepEqual(result.deleted, [old]);
  });

  it("recognizes only Claude sentinel names", () => {
    assert.equal(isSentinelFile("pi-claude-abc123-done"), true);
    assert.equal(isSentinelFile("pi-claude-abc123-done.transcript"), true);
    assert.equal(isSentinelFile("pi-luvus"), false);
    assert.equal(isSentinelFile("scout-deadbeef.jsonl"), false);
  });

  it("deletes only old sentinels", () => {
    const dir = mkdtempSync(join(workdir, "sentinels-"));
    const old = seed(dir, "pi-claude-abc123-done", 2 * DAY_MS);
    const oldTranscript = seed(dir, "pi-claude-abc123-done.transcript", 2 * DAY_MS);
    const fresh = seed(dir, "pi-claude-fresh99-done", 1000);
    const foreign = seed(dir, "other-done", 30 * DAY_MS);
    const result = pruneSentinels(dir, { maxAgeMs: DAY_MS });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(oldTranscript), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(foreign), true);
    assert.equal(result.deleted.length, 2);
  });
});

describe("cli.ts prune", () => {
  it("clears a scratch dir and prints JSON", async () => {
    const dir = mkdtempSync(join(workdir, "cli-"));
    const scratch = join(dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    seed(scratch, "scout-deadbeef.jsonl", 8 * DAY_MS);
    const sentinels = mkdtempSync(join(workdir, "cli-sent-"));
    const stdout: string[] = [];
    const code = await main(["prune", "--scratch", scratch, "--max-age-days", "7"], {
      env: { PATH: process.env.PATH, PI_LUVUS_SENTINEL_DIR: sentinels },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      sleep: async () => {},
    });
    assert.equal(code, 0);
    const report = JSON.parse(stdout.join(""));
    assert.equal(report.deleted.length, 1);
    assert.equal(readdirSync(scratch).length, 0);
  });

  it("succeeds empty on a missing directory", async () => {
    const sentinels = mkdtempSync(join(workdir, "cli-miss-sent-"));
    const stdout: string[] = [];
    const code = await main(["prune", "--scratch", join(workdir, "no-such-dir")], {
      env: { PATH: process.env.PATH, PI_LUVUS_SENTINEL_DIR: sentinels },
      stdout: (text) => stdout.push(text),
      stderr: () => {},
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout.join("")).deleted, []);
  });

  it("rejects a negative max age", async () => {
    const sentinels = mkdtempSync(join(workdir, "cli-neg-sent-"));
    let message = "";
    try {
      await main(["prune", "--max-age-days", "-1"], {
        env: { PATH: process.env.PATH, PI_LUVUS_SENTINEL_DIR: sentinels },
        stdout: () => {},
        stderr: () => {},
        sleep: async () => {},
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /max-age-days/);
  });

  it("start removes old scratch files in the same directory", async () => {
    __setLuvusExecForTests__((args) => {
      if (args[0] === "pane" && args[1] === "split") {
        return JSON.stringify({
          id: "1",
          result: { pane: "24", revision: 1, type: "pane", tab: "1", workspace: "2" },
        });
      }
      return JSON.stringify({ id: "1", result: { revision: 1, type: "ok" } });
    });
    const dir = mkdtempSync(join(workdir, "autoprune-"));
    const cwd = mkdtempSync(join(dir, "cwd-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "worker.md"),
      "---\nmodel: test-model\n---\n\nBody.\n",
    );
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "# Task\n\nDo the thing.\n");
    const scratch = join(dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    const old = seed(scratch, "old-deadbeef.jsonl", 8 * DAY_MS);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ surface: "right" }));
    const stdout: string[] = [];
    const code = await main(
      [
        "start",
        "--name",
        "scout-1",
        "--role",
        "worker",
        "--cwd",
        cwd,
        "--brief",
        brief,
        "--parent",
        "orch",
        "--scratch",
        scratch,
      ],
      {
        env: {
          PATH: process.env.PATH,
          LUVUS_ENV: "1",
          LUVUS_BIN_PATH: "in-process",
          LUVUS_PANE_ID: "21",
        },
        stdout: (text) => stdout.push(text),
        stderr: () => {},
        sleep: async () => {},
        configPath,
      },
    );
    assert.equal(code, 0);
    assert.equal(existsSync(old), false);
    assert.ok(readdirSync(scratch).some((file) => file.endsWith(".prompt.md")));
  });
});
