import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MODULE_ID,
  __resetModuleEnsureForTests__,
  ensureLuvusModuleLinked,
  moduleDir,
  moduleNeedsLink,
  parseModuleVersion,
  shouldEnsureModule,
} from "../pi-extension/luvus/module-ensure.ts";
import { __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";

describe("luvus module-ensure pure helpers", () => {
  it("names the packaged module id", () => {
    assert.equal(MODULE_ID, "pi-luvus.pane-titles");
  });

  it("resolves the bundled module dir from the package root", () => {
    assert.equal(moduleDir("/pkg"), "/pkg/luvus-module");
  });

  it("parses the version line of a module manifest", () => {
    assert.equal(parseModuleVersion('id = "x"\nversion = "0.1.0"\n'), "0.1.0");
    assert.equal(parseModuleVersion("no version here"), null);
  });

  it("needs a link when no registration exists", () => {
    assert.equal(moduleNeedsLink(null, "/pkg/luvus-module", "0.1.0"), true);
  });

  it("needs a link when the root points elsewhere", () => {
    assert.equal(
      moduleNeedsLink(
        { root: "/other/luvus-module", version: "0.1.0", enabled: true },
        "/pkg/luvus-module",
        "0.1.0",
      ),
      true,
    );
  });

  it("needs a link when the entry is disabled", () => {
    assert.equal(
      moduleNeedsLink(
        { root: "/pkg/luvus-module", version: "0.1.0", enabled: false },
        "/pkg/luvus-module",
        "0.1.0",
      ),
      true,
    );
  });

  it("needs a link when the registered version is older", () => {
    assert.equal(
      moduleNeedsLink(
        { root: "/pkg/luvus-module", version: "0.0.9", enabled: true },
        "/pkg/luvus-module",
        "0.1.0",
      ),
      true,
    );
  });

  it("needs no link when root and version match", () => {
    assert.equal(
      moduleNeedsLink(
        { root: "/pkg/luvus-module", version: "0.1.0", enabled: true },
        "/pkg/luvus-module",
        "0.1.0",
      ),
      false,
    );
  });

  it("gates on Luvus presence, parent role, and the config flag", () => {
    const live = { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" };
    assert.equal(shouldEnsureModule(live, true), true);
    assert.equal(shouldEnsureModule(live, false), false);
    assert.equal(shouldEnsureModule({ ...live, PI_LUVUS_SESSION: "/s.jsonl" }, true), false);
    assert.equal(shouldEnsureModule({}, true), false);
  });
});

describe("luvus module-ensure flow", () => {
  beforeEach(() => {
    __resetModuleEnsureForTests__();
    __setLuvusExecForTests__(null);
  });

  afterEach(() => {
    __setLuvusExecForTests__(null);
    __resetModuleEnsureForTests__();
  });

  it("skips outside Luvus without a Luvus call", async () => {
    const calls: string[][] = [];
    __setLuvusExecForTests__(async (args) => {
      calls.push(args);
      return JSON.stringify({ result: {} });
    });
    const result = await ensureLuvusModuleLinked({ env: {}, localDir: "/pkg/luvus-module" });
    assert.equal(result, "skipped");
    assert.deepEqual(calls, []);
  });

  it("skips in a subagent child without a Luvus call", async () => {
    const calls: string[][] = [];
    __setLuvusExecForTests__(async (args) => {
      calls.push(args);
      return JSON.stringify({ result: {} });
    });
    const result = await ensureLuvusModuleLinked({
      env: {
        LUVUS_ENV: "1",
        LUVUS_BIN_PATH: "/bin/luvus",
        LUVUS_PANE_ID: "7",
        PI_LUVUS_SESSION: "/s.jsonl",
      },
      localDir: "/pkg/luvus-module",
    });
    assert.equal(result, "skipped");
    assert.deepEqual(calls, []);
  });

  it("links when the module is absent", async () => {
    const calls: string[][] = [];
    __setLuvusExecForTests__(async (args) => {
      calls.push(args);
      if (args[0] === "module" && args[1] === "info") {
        return JSON.stringify({ error: { code: "module_error", message: "no module" }, id: "1" });
      }
      return JSON.stringify({ result: {} });
    });
    const result = await ensureLuvusModuleLinked({
      env: { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" },
      localDir: "/pkg/luvus-module",
      localVersion: "0.1.0",
    });
    assert.equal(result, "linked");
    assert.deepEqual(calls, [
      ["module", "info", "pi-luvus.pane-titles"],
      ["module", "link", "/pkg/luvus-module"],
    ]);
  });

  it("leaves a matching registration alone", async () => {
    const calls: string[][] = [];
    __setLuvusExecForTests__(async (args) => {
      calls.push(args);
      return JSON.stringify({
        result: { root: "/pkg/luvus-module", version: "0.1.0", enabled: true },
      });
    });
    const result = await ensureLuvusModuleLinked({
      env: { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" },
      localDir: "/pkg/luvus-module",
      localVersion: "0.1.0",
    });
    assert.equal(result, "ok");
    assert.deepEqual(calls, [["module", "info", "pi-luvus.pane-titles"]]);
  });

  it("runs only once per process", async () => {
    let reads = 0;
    __setLuvusExecForTests__(async () => {
      reads++;
      return JSON.stringify({
        result: { root: "/pkg/luvus-module", version: "0.1.0", enabled: true },
      });
    });
    const env = { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" };
    assert.equal(
      await ensureLuvusModuleLinked({ env, localDir: "/pkg/luvus-module", localVersion: "0.1.0" }),
      "ok",
    );
    assert.equal(await ensureLuvusModuleLinked({ env, localDir: "/pkg/luvus-module" }), "skipped");
    assert.equal(reads, 1);
  });

  it("reports failure instead of throwing when the link fails", async () => {
    __setLuvusExecForTests__(async (args) => {
      if (args[0] === "module" && args[1] === "info") {
        return JSON.stringify({ error: { code: "module_error", message: "no module" }, id: "1" });
      }
      throw new Error("link failed");
    });
    const result = await ensureLuvusModuleLinked({
      env: { LUVUS_ENV: "1", LUVUS_BIN_PATH: "/bin/luvus", LUVUS_PANE_ID: "7" },
      localDir: "/pkg/luvus-module",
      localVersion: "0.1.0",
    });
    assert.equal(result, "failed");
  });
});
