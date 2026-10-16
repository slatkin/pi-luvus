/**
 * Unit tests for the Luvus UHP event stream.
 *
 * Every test stubs the spawn seam, so no real `luvus` process runs. Frames are
 * pushed into a fake child's stdout, and the tests assert the classification,
 * the pane match, and the stream lifecycle (lazy start, stop, restart,
 * `agent list` snapshots, shutdown kill).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UHP_RESTART_DELAYS_MS,
  __setUhpSpawnForTests__,
  classifyUhpFrame,
  framePane,
  parseUhpEventLine,
  restartDelayMs,
  UhpEventStream,
  type AgentListSnapshot,
  type UhpSpawn,
} from "../pi-extension/luvus/uhp-events.ts";
import { pollForExit, __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";

interface FakeChild {
  stdout: AsyncIterable<Buffer>;
  kill(): void;
  push(text: string): void;
  end(): void;
  killed: boolean;
}

/** A child whose stdout is fed by the test and ends on `end()` or `kill()`. */
function fakeChild(): FakeChild {
  const chunks: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const child: FakeChild = {
    killed: false,
    stdout: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<Buffer>> {
            while (chunks.length === 0 && !closed) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            const next = chunks.shift();
            if (next === undefined) return { value: undefined, done: true };
            return { value: Buffer.from(next), done: false };
          },
        };
      },
    },
    push(text) {
      chunks.push(text);
      notify();
    },
    end() {
      closed = true;
      notify();
    },
    kill() {
      child.killed = true;
      closed = true;
      notify();
    },
  };
  return child;
}

/** The stream/agent-list children the seam produced, in call order. */
interface SpawnLog {
  streams: string[][];
  streamChildren: FakeChild[];
  agentLists: FakeChild[];
}

/**
 * Install a spawn stub. `agent list` calls answer with an empty result and
 * end; stream calls return a fresh child (or the supplied factory's child).
 */
function installSpawn(makeStreamChild?: () => FakeChild): { log: SpawnLog; spawn: UhpSpawn } {
  const log: SpawnLog = { streams: [], streamChildren: [], agentLists: [] };
  const spawn: UhpSpawn = (args) => {
    if (args[0] === "agent") {
      const child = fakeChild();
      child.push(`${JSON.stringify({ result: { agents: [] } })}\n`);
      child.end();
      log.agentLists.push(child);
      return child;
    }
    const child = makeStreamChild ? makeStreamChild() : fakeChild();
    log.streams.push(args);
    log.streamChildren.push(child);
    return child;
  };
  __setUhpSpawnForTests__(spawn);
  return { log, spawn };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  __setUhpSpawnForTests__(null);
  __setLuvusExecForTests__(null);
});

describe("UHP event frames", () => {
  it("parses event frames and ignores malformed or non-frame lines", () => {
    assert.deepEqual(
      parseUhpEventLine('{"event":"pane.closed","sequence":4,"data":{"pane":"7"}}'),
      {
        event: "pane.closed",
        sequence: 4,
        data: { pane: "7" },
      },
    );
    // The subscription envelope is valid JSON but not an event frame.
    assert.equal(
      parseUhpEventLine('{"id":"1","result":{"type":"subscription_started","sequence":9}}'),
      null,
    );
    assert.equal(parseUhpEventLine("not json"), null);
    assert.equal(parseUhpEventLine(""), null);
    assert.equal(parseUhpEventLine('{"event":"pane.closed"}'), null);
    assert.equal(parseUhpEventLine('{"event":"pane.closed","sequence":1,"data":null}'), null);
  });

  it("classifies only status and lifecycle events as triggers", () => {
    const frame = (event: string) =>
      parseUhpEventLine(JSON.stringify({ event, sequence: 1, data: {} }));
    assert.equal(classifyUhpFrame(frame("pane.agent_status_changed")!), "trigger");
    assert.equal(classifyUhpFrame(frame("terminal.exited")!), "trigger");
    assert.equal(classifyUhpFrame(frame("terminal.closed")!), "trigger");
    assert.equal(classifyUhpFrame(frame("pane.closed")!), "trigger");
    assert.equal(classifyUhpFrame(frame("events.resync_required")!), "resync");
    assert.equal(classifyUhpFrame(frame("terminal.frame")!), "ignore");
    assert.equal(classifyUhpFrame(frame("pane.renamed")!), "ignore");
  });

  it("matches a frame to a pane through pane or pane_id", () => {
    assert.equal(framePane({ event: "pane.closed", sequence: 1, data: { pane: "7" } }), "7");
    assert.equal(
      framePane({ event: "terminal.exited", sequence: 1, data: { pane_id: "12" } }),
      "12",
    );
    assert.equal(
      framePane({ event: "terminal.closed", sequence: 1, data: { detail: {} } }),
      undefined,
    );
  });

  it("bounds the restart delay and repeats the last value", () => {
    assert.equal(restartDelayMs(0, [100, 200]), 100);
    assert.equal(restartDelayMs(1, [100, 200]), 200);
    assert.equal(restartDelayMs(9, [100, 200]), 200);
    assert.equal(restartDelayMs(0), UHP_RESTART_DELAYS_MS[0]);
    assert.equal(restartDelayMs(99), UHP_RESTART_DELAYS_MS[UHP_RESTART_DELAYS_MS.length - 1]);
  });
});

describe("UHP event stream lifecycle", () => {
  it("starts lazily on the first watcher and snapshots agent list once per start", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    await flush();
    assert.equal(log.streams.length, 0);
    assert.equal(stream.isRunning(), false);

    const release = stream.watch("7");
    await flush();

    assert.deepEqual(log.streams, [["uhp", "events"]]);
    assert.equal(log.agentLists.length, 1);
    assert.equal(stream.isRunning(), true);
    release();
  });

  it("runs one stream for several watched panes", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    const releaseA = stream.watch("7");
    const releaseB = stream.watch("8");
    await flush();
    assert.equal(log.streams.length, 1);
    releaseA();
    assert.equal(stream.isRunning(), true);
    releaseB();
  });

  it("stops and kills the stream when the last watcher releases", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    const release = stream.watch("7");
    await flush();
    assert.equal(log.streamChildren[0].killed, false);
    release();
    assert.equal(log.streamChildren[0].killed, true);
    assert.equal(stream.isRunning(), false);
  });

  it("kills the stream on shutdown", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    stream.watch("7");
    await flush();
    stream.shutdown();
    assert.equal(log.streamChildren[0].killed, true);
    assert.equal(stream.isRunning(), false);
  });

  it("runs agent list again on a resync-required frame", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    const release = stream.watch("7");
    await flush();
    assert.equal(log.agentLists.length, 1);

    log.streamChildren[0].push(
      `${JSON.stringify({ event: "events.resync_required", sequence: 2, data: { reason: "subscriber_overflow" } })}\n`,
    );
    await flush();

    assert.equal(log.agentLists.length, 2);
    release();
  });

  it("restarts a stopped stream after a bounded delay and re-snapshots", async () => {
    let firstStreamEnds = true;
    const { log } = installSpawn(() => {
      const child = fakeChild();
      if (firstStreamEnds) {
        firstStreamEnds = false;
        child.end();
      }
      return child;
    });
    const stream = new UhpEventStream({ restartDelaysMs: [1] });
    const release = stream.watch("7");

    await sleep(25);

    assert.ok(
      log.streams.length >= 2,
      `expected a restart, saw ${log.streams.length} stream start(s)`,
    );
    assert.ok(
      log.agentLists.length >= 2,
      `expected a snapshot per start, saw ${log.agentLists.length}`,
    );
    release();
  });

  it("keeps events non-authoritative until an agent list snapshot succeeds", async () => {
    const triggers: string[] = [];
    const streamChild = fakeChild();
    let listCalls = 0;
    __setUhpSpawnForTests__((args) => {
      if (args[0] === "agent") {
        listCalls += 1;
        const child = fakeChild();
        // The first snapshot ends without a result envelope; later ones succeed.
        if (listCalls > 1) child.push(`${JSON.stringify({ result: { agents: [] } })}\n`);
        child.end();
        return child;
      }
      return streamChild;
    });
    const stream = new UhpEventStream({ restartDelaysMs: [50] });
    stream.onTrigger("7", (pane) => triggers.push(pane));
    const release = stream.watch("7");
    await flush();
    assert.equal(listCalls, 1);
    assert.equal(stream.agentListSnapshot(), null);

    streamChild.push(
      `${JSON.stringify({ event: "pane.closed", sequence: 1, data: { pane: "7" } })}\n`,
    );
    await flush();
    assert.deepEqual(triggers, [], "events before a successful snapshot must not trigger");

    await sleep(80);
    assert.ok(listCalls >= 2, `expected a snapshot retry, saw ${listCalls}`);
    streamChild.push(
      `${JSON.stringify({ event: "pane.closed", sequence: 2, data: { pane: "7" } })}\n`,
    );
    await flush();
    assert.deepEqual(triggers, ["7"]);
    release();
  });

  it("kills an in-flight agent list child on stop", async () => {
    const streamChild = fakeChild();
    const listChildren: FakeChild[] = [];
    __setUhpSpawnForTests__((args) => {
      if (args[0] === "agent") {
        const child = fakeChild(); // never ends, so the snapshot stays in flight
        listChildren.push(child);
        return child;
      }
      return streamChild;
    });
    const stream = new UhpEventStream();
    const release = stream.watch("7");
    await flush();
    assert.equal(listChildren.length, 1);
    assert.equal(listChildren[0].killed, false);

    release();

    assert.equal(listChildren[0].killed, true);
    assert.equal(streamChild.killed, true);
  });

  it("drops buffered lines from a child that is no longer current", async () => {
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    const release = stream.watch("7");
    await flush();
    assert.equal(log.agentLists.length, 1);

    // Queue a resync frame, then release the last watcher before it is read.
    log.streamChildren[0].push(
      `${JSON.stringify({ event: "events.resync_required", sequence: 2, data: { reason: "subscriber_overflow" } })}\n`,
    );
    release();
    await flush();

    assert.equal(log.agentLists.length, 1, "a stale child's resync must not run agent list");
  });
});

describe("UHP event stream triggers", () => {
  it("triggers for a watched pane, ignores output events and other panes", async () => {
    const triggers: string[] = [];
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    stream.onTrigger("7", (pane) => triggers.push(pane));
    const release = stream.watch("7");
    await flush();

    const child = log.streamChildren[0];
    child.push(
      `${JSON.stringify({ event: "terminal.frame", sequence: 1, data: { pane_id: "7" } })}\n`,
    );
    child.push(
      `${JSON.stringify({ event: "pane.agent_status_changed", sequence: 2, data: { pane: "9" } })}\n`,
    );
    child.push(
      `${JSON.stringify({ event: "pane.agent_status_changed", sequence: 3, data: { pane: "7" } })}\n`,
    );
    await flush();

    assert.deepEqual(triggers, ["7"]);
    assert.equal(stream.lastEventSequence(), 3);
    release();
  });

  it("reassembles a frame split across chunks", async () => {
    const triggers: string[] = [];
    const { log } = installSpawn();
    const stream = new UhpEventStream();
    stream.onTrigger("7", (pane) => triggers.push(pane));
    const release = stream.watch("7");
    await flush();

    const child = log.streamChildren[0];
    child.push('{"event":"pane.closed","sequence":5,"data":{"pane":"7"');
    await flush();
    assert.deepEqual(triggers, []);
    child.push("}}\n");
    await flush();

    assert.deepEqual(triggers, ["7"]);
    release();
  });
});

/** A stand-in for `UhpEventStream` that tests drive directly. */
function fakeEventStream(
  snapshot: AgentListSnapshot | null = {
    agents: [{ pane: "24", status: "done", authority: "integration_report" }],
  },
) {
  const listeners = new Map<string, Set<(pane: string) => void>>();
  return {
    running: true,
    isRunning(): boolean {
      return this.running;
    },
    onTrigger(pane: string, listener: (pane: string) => void): () => void {
      const set = listeners.get(pane) ?? new Set();
      set.add(listener);
      listeners.set(pane, set);
      return () => set.delete(listener);
    },
    agentListSnapshot(): AgentListSnapshot | null {
      return snapshot;
    },
    fire(pane: string): void {
      for (const listener of [...(listeners.get(pane) ?? [])]) listener(pane);
    },
  };
}

describe("pollForExit with an event stream", () => {
  it("runs a screen check on a trigger and uses the stream snapshot, never agent list", async () => {
    const calls: string[][] = [];
    let screen = "still working";
    __setLuvusExecForTests__((args) => {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "read") {
        return JSON.stringify({ result: { text: screen } });
      }
      return JSON.stringify({ result: { agents: [] } });
    });

    const stream = fakeEventStream();
    const controller = new AbortController();
    let settled = false;
    const poll = pollForExit("24", controller.signal, { interval: 5000, eventStream: stream }).then(
      (r) => {
        settled = true;
        return r;
      },
    );

    await flush();
    assert.equal(
      calls.filter((call) => call[0] === "pane").length,
      0,
      "no interval screen read while the stream runs",
    );

    // An event with no sidecar and no sentinel keeps the wait open.
    stream.fire("24");
    await flush();
    assert.equal(
      calls.filter((call) => call[0] === "pane").length,
      1,
      "one immediate screen check for the trigger",
    );
    assert.equal(settled, false);

    // A later event with the sentinel on screen ends the wait with the result.
    screen = "done __SUBAGENT_DONE_4__";
    stream.fire("24");
    const result = await poll;

    assert.deepEqual(result, { reason: "sentinel", exitCode: 4 });
    assert.equal(
      calls.filter((call) => call[0] === "agent").length,
      0,
      "the stream snapshot replaces the agent list call",
    );
  });
});
