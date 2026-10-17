import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeChildEnv,
  encodeChildEnv,
  isSubagentChild,
  type ChildEnv,
} from "../pi-extension/luvus/child-env.ts";

test("round-trips a full ChildEnv", () => {
  const full: ChildEnv = {
    name: "child",
    agent: "scout",
    sessionFile: "/tmp/s.jsonl",
    id: "id-1",
    activityFile: "/tmp/a.json",
    surface: "surface-1",
    parentRosterFile: "/tmp/r.json",
    autoExit: true,
    denyTools: ["luvus_spawn", "claude"],
  };
  assert.deepEqual(decodeChildEnv(encodeChildEnv(full)), full);
});

test("round-trips a minimal ChildEnv", () => {
  const minimal: ChildEnv = { autoExit: false, denyTools: [] };
  const decoded = decodeChildEnv(encodeChildEnv(minimal));
  assert.equal(decoded.autoExit, false);
  assert.deepEqual(decoded.denyTools, []);
  assert.equal(decoded.name, undefined);
  assert.equal(decoded.sessionFile, undefined);
});

test("encodeChildEnv leaves out an empty deny list and autoExit false", () => {
  assert.deepEqual(encodeChildEnv({ autoExit: false, denyTools: [] }), {});
});

test("decodeChildEnv trims and drops empty deny entries", () => {
  const env = decodeChildEnv({ PI_DENY_TOOLS: " luvus_spawn, ,claude ," });
  assert.deepEqual(env.denyTools, ["luvus_spawn", "claude"]);
});

test("decodeChildEnv treats an empty string as not set", () => {
  const env = decodeChildEnv({
    PI_LUVUS_NAME: "",
    PI_LUVUS_SESSION: "",
    PI_LUVUS_AUTO_EXIT: "",
    PI_DENY_TOOLS: "",
  });
  assert.equal(env.name, undefined);
  assert.equal(env.sessionFile, undefined);
  assert.equal(env.autoExit, false);
  assert.deepEqual(env.denyTools, []);
});

test("isSubagentChild is true only when PI_LUVUS_SESSION is set", () => {
  assert.equal(isSubagentChild({ PI_LUVUS_SESSION: "/tmp/s.jsonl" }), true);
  assert.equal(isSubagentChild({ PI_LUVUS_SESSION: "" }), false);
  assert.equal(isSubagentChild({ PI_LUVUS_NAME: "child" }), false);
  assert.equal(isSubagentChild({}), false);
});
