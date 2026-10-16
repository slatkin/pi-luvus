import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_GONE_MS,
  IDLE_MAX_NUDGES,
  IDLE_STEP_MS,
  decideGoneAction,
  decideIdleAction,
  type IdleWatchState,
} from "../pi-extension/luvus/idle-watchdog.ts";

const T0 = 1_000_000;

function decide(
  overrides: Partial<Parameters<typeof decideIdleAction>[0]> & { state?: IdleWatchState },
) {
  return decideIdleAction({
    interactive: false,
    phase: "waiting",
    waitingSince: T0,
    now: T0 + IDLE_STEP_MS,
    state: { nudges: 0 },
    ...overrides,
  });
}

describe("idle-watchdog decideGoneAction", () => {
  it("declares a non-interactive child gone once its snapshot ages past the threshold", () => {
    const state: IdleWatchState = { nudges: 0 };
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: true,
        activity: { updatedAt: T0 },
        now: T0 + IDLE_GONE_MS - 1,
        state,
      }),
      "none",
    );
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: true,
        activity: { updatedAt: T0 },
        now: T0 + IDLE_GONE_MS,
        state,
      }),
      "gone",
    );
    // Latched: no repeated decision once made.
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: true,
        activity: { updatedAt: T0 },
        now: T0 + IDLE_GONE_MS + 1,
        state,
      }),
      "none",
    );
  });

  it("resets when fresh snapshots return", () => {
    const state: IdleWatchState = { nudges: 0, gone: true };
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: true,
        activity: { updatedAt: T0 },
        now: T0,
        state,
      }),
      "none",
    );
    assert.equal(state.gone, false);
    assert.equal(state.failedReadSince, undefined);
  });

  it("ages failing reads the same way, from the read failure", () => {
    const state: IdleWatchState = { nudges: 0 };
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: { updatedAt: T0 },
        now: T0 + IDLE_GONE_MS - 1,
        state,
      }),
      "none",
    );
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: { updatedAt: T0 },
        now: T0 + IDLE_GONE_MS,
        state,
      }),
      "gone",
    );
    assert.equal(state.failedReadSince, T0 + IDLE_GONE_MS - 1);
  });

  it("waits a full IDLE_GONE_MS of failed reads before declaring a never-reporting child gone", () => {
    const state: IdleWatchState = { nudges: 0 };
    // The first failed read with no snapshot yet must not be immediate death.
    assert.equal(
      decideGoneAction({ interactive: false, readOk: false, activity: undefined, now: T0, state }),
      "none",
    );
    assert.equal(state.failedReadSince, T0);
    // Still short of the threshold.
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: undefined,
        now: T0 + IDLE_GONE_MS - 1,
        state,
      }),
      "none",
    );
    // Continuous silence past the threshold.
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: undefined,
        now: T0 + IDLE_GONE_MS,
        state,
      }),
      "gone",
    );
  });

  it("a good read resets the missing-snapshot silence", () => {
    const state: IdleWatchState = { nudges: 0 };
    assert.equal(
      decideGoneAction({ interactive: false, readOk: false, activity: undefined, now: T0, state }),
      "none",
    );
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: true,
        activity: { updatedAt: T0 + 1_000 },
        now: T0 + 1_000,
        state,
      }),
      "none",
    );
    assert.equal(state.failedReadSince, undefined);
    // The next failure restarts the clock; it is not aged from the first read.
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: undefined,
        now: T0 + 1_000,
        state,
      }),
      "none",
    );
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: undefined,
        now: T0 + 1_000 + IDLE_GONE_MS - 1,
        state,
      }),
      "none",
    );
    assert.equal(
      decideGoneAction({
        interactive: false,
        readOk: false,
        activity: undefined,
        now: T0 + 1_000 + IDLE_GONE_MS,
        state,
      }),
      "gone",
    );
  });

  it("never declares an interactive child gone", () => {
    const state: IdleWatchState = { nudges: 0 };
    assert.equal(
      decideGoneAction({
        interactive: true,
        readOk: false,
        activity: { updatedAt: T0 - IDLE_GONE_MS * 9 },
        now: T0 + IDLE_GONE_MS * 9,
        state,
      }),
      "none",
    );
    assert.equal(state.gone, undefined);
  });
});

describe("idle-watchdog decideIdleAction", () => {
  it("does nothing before the child has waited a full step", () => {
    assert.equal(decide({ now: T0 + IDLE_STEP_MS - 1 }), "none");
  });

  it("nudges after a full step of waiting", () => {
    assert.equal(decide({}), "nudge");
  });

  it("never acts on interactive children or children that are not waiting", () => {
    assert.equal(decide({ interactive: true, now: T0 + 10 * IDLE_STEP_MS }), "none");
    assert.equal(decide({ phase: "active" }), "none");
    assert.equal(decide({ phase: "done" }), "none");
    assert.equal(decide({ waitingSince: undefined }), "none");
  });

  it("waits a step between reminders", () => {
    const state: IdleWatchState = { nudges: 1, lastNudgeAt: T0 + IDLE_STEP_MS, stretchSince: T0 };
    assert.equal(decide({ now: T0 + IDLE_STEP_MS + IDLE_STEP_MS - 1, state }), "none");
    assert.equal(decide({ now: T0 + 2 * IDLE_STEP_MS, state }), "nudge");
  });

  it("finishes once the reminders are used up and the child is still waiting", () => {
    // The reminders belong to the current stretch (the child never restarted).
    const state: IdleWatchState = {
      nudges: IDLE_MAX_NUDGES,
      lastNudgeAt: T0 + IDLE_STEP_MS,
      stretchSince: T0,
    };
    assert.equal(decide({ now: T0 + 2 * IDLE_STEP_MS - 1, state }), "none");
    assert.equal(decide({ now: T0 + 2 * IDLE_STEP_MS, state }), "finish");
  });

  it("a child that answers a reminder and stops again earns a fresh reminder budget (stretch reset)", () => {
    // Reminder at T0+step; child ran, then stopped again at T0+step+5s (new waitingSince).
    // The new stretch resets the budget, so the next action is a reminder, not a finish.
    const restartedAt = T0 + IDLE_STEP_MS + 5_000;
    const state: IdleWatchState = { nudges: IDLE_MAX_NUDGES, lastNudgeAt: T0 + IDLE_STEP_MS };
    assert.equal(
      decide({ waitingSince: restartedAt, now: restartedAt + IDLE_STEP_MS - 1, state }),
      "none",
    );
    assert.equal(
      decide({ waitingSince: restartedAt, now: restartedAt + IDLE_STEP_MS, state }),
      "nudge",
    );
    // The budget restarted with the stretch; the caller increments the counter.
    assert.deepEqual(state, { nudges: 0, lastNudgeAt: undefined, stretchSince: restartedAt });
  });

  it("never force-finishes a working child, however many stretches it pauses through", () => {
    let state: IdleWatchState = { nudges: 0 };
    for (let round = 1; round <= 5; round++) {
      // 35s of work, then a 35s wait; decideIdleAction is only asked about the waits.
      const stretch = T0 + round * 70_000;
      for (let now = stretch; now <= stretch + 70_000; now += 1_000) {
        const action = decide({ waitingSince: stretch, now, state });
        if (action === "nudge") {
          state = { ...state, nudges: state.nudges + 1, lastNudgeAt: now };
        } else if (action === "finish") {
          assert.fail(`finished on waiting stretch ${round} despite fresh reminders`);
        }
      }
    }
  });

  it("still finishes a child that ignores two reminders inside one stretch", () => {
    const state: IdleWatchState = { nudges: 2, lastNudgeAt: T0 + IDLE_STEP_MS, stretchSince: T0 };
    assert.equal(decide({ now: T0 + 2 * IDLE_STEP_MS, state }), "finish");
  });

  it("walks a silent child from waiting to finished in nudge, nudge, finish", () => {
    const state: IdleWatchState = { nudges: 0 };
    const actions: string[] = [];
    for (let now = T0; now <= T0 + 4 * IDLE_STEP_MS; now += 1_000) {
      const action = decide({ now, state });
      if (action === "nudge") {
        state.nudges += 1;
        state.lastNudgeAt = now;
      }
      if (action !== "none") actions.push(action);
      if (action === "finish") break;
    }
    assert.deepEqual(actions, ["nudge", "nudge", "finish"]);
  });
});
