/**
 * Unit tests for the `/stream` command (unit 3): argument handling with a
 * fake `ctx.ui.notify`, follower pane creation observed through the Luvus
 * test seam, the tailer command line builder, and the refusal to open a
 * stream without a Luvus pane id.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tailerCommandLine } from "../pi-extension/luvus/launch.ts";
import { createStreamHarness } from "./stream-harness.ts";

describe("stream command", () => {
  const harness = createStreamHarness();
  const { notifications, calls } = harness;
  const { setEnv, test_ } = harness;

  before(() => harness.start());
  after(() => harness.stop());
  beforeEach(() => harness.reset());
  afterEach(() => harness.reset());

  const run = (args: string) => harness.run(args);
  const texts = () => notifications.map((n) => `${n.level}: ${n.text}`).join("\n");

  it("registers the /stream command", () => {
    assert.ok(harness.command, "expected a /stream command to be registered");
  });

  it("reports the attached state for no argument", async () => {
    await run("");
    assert.match(texts(), /thinking: not attached/);
    assert.match(texts(), /tools: not attached/);
    assert.deepEqual(calls, []);
  });

  it("reports attached for a recorded stream", async () => {
    await run("thinking");
    notifications.length = 0;
    await run("");
    assert.match(texts(), /thinking: attached/);
    assert.match(texts(), /tools: not attached/);
  });

  it("rejects an unknown argument and changes nothing", async () => {
    await run("alles");
    const warning = notifications.find((n) => n.level === "warning");
    assert.ok(warning, "expected a warning");
    assert.match(warning.text, /thinking, tools, both, close/);
    assert.deepEqual(calls, []);
    assert.deepEqual(test_.streamPaneEntries(), []);
  });

  it("opens the thinking pane right of the pi pane, named and unfocused", async () => {
    await run("thinking");
    assert.deepEqual(calls[0], ["pane", "split", "7", "--right", "--no-focus"]);
    assert.deepEqual(calls[1], ["pane", "name", "thinking", "--pane", "101"]);
    assert.equal(calls[2][0], "pane");
    assert.equal(calls[2][1], "run");
    assert.equal(calls[2][2], "101");
    assert.match(texts(), /thinking stream is attached/i);
    assert.deepEqual(test_.streamPaneEntries(), [["thinking", "101"]]);
  });

  it("opens the tools pane right of the pi pane when it is the only pane", async () => {
    await run("tools");
    assert.deepEqual(calls[0], ["pane", "split", "7", "--right", "--no-focus"]);
    assert.deepEqual(calls[1], ["pane", "name", "tools", "--pane", "101"]);
    assert.equal(calls[2][2], "101");
    const line = calls[2].slice(3).join(" ");
    assert.match(line, /--stream" "tools/);
    assert.deepEqual(test_.streamPaneEntries(), [["tools", "101"]]);
  });

  it("opens both: thinking right of pi, tools below the thinking pane", async () => {
    await run("both");
    assert.deepEqual(calls[0], ["pane", "split", "7", "--right", "--no-focus"]);
    assert.deepEqual(calls[1], ["pane", "name", "thinking", "--pane", "101"]);
    assert.deepEqual(calls[3], ["pane", "split", "101", "--down", "--no-focus"]);
    assert.deepEqual(calls[4], ["pane", "name", "tools", "--pane", "102"]);
    assert.equal(calls[5][2], "102");
    const entries = test_.streamPaneEntries();
    assert.deepEqual(entries, [
      ["thinking", "101"],
      ["tools", "102"],
    ]);
  });

  it("opens the tools pane below an existing thinking pane opened earlier", async () => {
    await run("thinking");
    calls.length = 0;
    harness.newPaneId = 201;
    await run("tools");
    assert.deepEqual(calls[0], ["pane", "split", "101", "--down", "--no-focus"]);
    assert.deepEqual(calls[1], ["pane", "name", "tools", "--pane", "201"]);
  });

  it("runs the tailer with the hub socket and the stream name", async () => {
    await run("thinking");
    const runCall = calls.find((entry) => entry[0] === "pane" && entry[1] === "run")!;
    const line = runCall.slice(3).join(" ");
    assert.match(line, /^node "/);
    assert.match(line, /stream-tail\.mjs" "--socket" "[^"]+" "--stream" "thinking"/);
  });

  it("treats a repeat request as idempotent", async () => {
    await run("thinking");
    const before = calls.length;
    notifications.length = 0;
    await run("thinking");
    assert.equal(calls.length, before);
    assert.match(texts(), /already attached/i);
    assert.deepEqual(test_.streamPaneEntries(), [["thinking", "101"]]);
  });

  it("serializes concurrent opens so each stream splits exactly one pane", async () => {
    // Issue the second invocation while the first is still suspended at its
    // `await hub.start()`: both pass the record pre-check before either has
    // written a record. The gate must let only the first invocation split.
    const first = run("both");
    const second = run("both");
    await Promise.all([first, second]);

    const splits = calls.filter((entry) => entry[0] === "pane" && entry[1] === "split");
    assert.deepEqual(splits, [
      ["pane", "split", "7", "--right", "--no-focus"],
      ["pane", "split", "101", "--down", "--no-focus"],
    ]);
    assert.deepEqual(test_.streamPaneEntries(), [
      ["thinking", "101"],
      ["tools", "102"],
    ]);
    assert.match(texts(), /already attached/i);

    // `/stream close` closes exactly the recorded panes, no leaked pane.
    calls.length = 0;
    notifications.length = 0;
    await run("close");
    const closeCalls = calls.filter((entry) => entry[0] === "pane" && entry[1] === "close");
    assert.deepEqual(closeCalls, [
      ["pane", "close", "101"],
      ["pane", "close", "102"],
    ]);
    assert.match(texts(), /Closed 2 stream panes/);
    assert.deepEqual(test_.streamPaneEntries(), []);
  });

  it("closes the recorded panes and forgets them", async () => {
    await run("both");
    notifications.length = 0;
    await run("close");
    const closeCalls = calls.filter((entry) => entry[0] === "pane" && entry[1] === "close");
    assert.deepEqual(closeCalls, [
      ["pane", "close", "101"],
      ["pane", "close", "102"],
    ]);
    assert.match(texts(), /Closed 2 stream panes/);
    assert.deepEqual(test_.streamPaneEntries(), []);
  });

  it("reports no panes for close with nothing open", async () => {
    await run("close");
    assert.match(texts(), /no stream panes are open/i);
    assert.deepEqual(calls, []);
  });

  it("refuses to open a stream without a Luvus pane id and changes nothing", async () => {
    setEnv("LUVUS_PANE_ID", undefined);
    await run("thinking");
    const warning = notifications.find((n) => n.level === "warning");
    assert.ok(warning, "expected a warning");
    assert.match(warning.text, /requires a Luvus pane/i);
    assert.deepEqual(calls, []);
    assert.deepEqual(test_.streamPaneEntries(), []);
    await run("");
    assert.match(texts(), /thinking: not attached/);
  });
});

describe("tailerCommandLine", () => {
  it("builds a bare-node, double-quoted command line", () => {
    const line = tailerCommandLine(
      "/run/pi-luvus/stream-abc.sock",
      "thinking",
      "/ext/stream-tail.mjs",
    );
    assert.equal(
      line,
      `node "/ext/stream-tail.mjs" "--socket" "/run/pi-luvus/stream-abc.sock" "--stream" "thinking"`,
    );
  });

  it("rejects tokens a shell would expand", () => {
    assert.throws(() => tailerCommandLine("/tmp/x$(reboot).sock", "thinking", "/ext/tail.mjs"));
    assert.throws(() => tailerCommandLine("/tmp/ok.sock", "thinking", '/ext/ta"il.mjs'));
    assert.throws(() => tailerCommandLine("/tmp/ok.sock", "thinking", "/ext/ta`il.mjs"));
  });
});
