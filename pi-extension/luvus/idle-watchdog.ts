/**
 * Parent-side backstop for subagents that finish their turn and never exit.
 *
 * The child extension nudges a forgetful agent itself, but that depends on child
 * state and on the model reacting. This watches the child's activity file from
 * the parent instead: a non-interactive child stuck in `waiting` gets reminded
 * from outside, and is finished by the parent if it still does nothing.
 */

/** Continuous `waiting` time before the first reminder, and between later steps. */
export const IDLE_STEP_MS = 30_000;
/** Reminders sent before the parent gives up and finishes the subagent. */
export const IDLE_MAX_NUDGES = 2;

/**
 * How long a non-interactive child may stop reporting before the parent
 * declares it gone. Children snapshot their activity at least every ~500 ms
 * while alive (even while idle), so a silent file means the process died or
 * the session was reloaded; either way no sidecar will ever appear and the
 * watcher would poll forever. Generous, because it is terminal.
 */
export const IDLE_GONE_MS = 180_000;

export const IDLE_NUDGE_TEXT =
  "[Automated reminder] Your last turn ended but this session is still open.\n" +
  "If your task is complete, call the luvus_done tool now, with no other text. " +
  "Your last message was already delivered as your report — do not repeat or summarise it.\n" +
  "If you are blocked and need input from the caller, call caller_ping with your question.\n" +
  "Otherwise, continue working.";

/**
 * Decide whether a child has stopped reporting and must be finished with an
 * error sidecar (see `IDLE_GONE_MS`). Mutates `state`:
 * - `failedReadSince` records the first failing activity read since the last
 *   good read, for callers that want the stale duration;
 * - `gone` latches the decision, so the caller writes the sidecar exactly once
 *   and a late snapshot never re-triggers it.
 *
 * Interactive children are never declared gone — the user may sit in their
 * pane for arbitrarily long, and a reloaded session is theirs to restart.
 *
 * `readOk`/`activity` describe the most recent watch tick: a valid read carries
 * the snapshot (its `updatedAt` is what freshness is measured against); a
 * failed read keeps the last valid snapshot for the age check. If no snapshot
 * has ever been read (a brand-new child that has not written its first one
 * yet), the silence is measured from the first failed read instead, so it is
 * only declared gone after `IDLE_GONE_MS` of continuous failed reads.
 */
export function decideGoneAction(params: {
  interactive: boolean;
  readOk: boolean;
  activity: { updatedAt: number } | undefined;
  now: number;
  state: IdleWatchState;
}): "none" | "gone" {
  if (params.interactive) return "none";

  if (params.readOk) params.state.failedReadSince = undefined;
  else params.state.failedReadSince ??= params.now;

  const staleMs = params.activity === undefined
    ? Math.max(0, params.now - (params.state.failedReadSince ?? params.now))
    : Math.max(0, params.now - params.activity.updatedAt);
  if (staleMs < IDLE_GONE_MS) {
    params.state.gone = false;
    return "none";
  }

  if (params.state.gone) return "none";
  params.state.gone = true;
  return "gone";
}

export type IdleAction = "none" | "nudge" | "finish";

export interface IdleWatchState {
  /** Reminders the parent has sent so far. */
  nudges: number;
  /** When the parent last sent a reminder. */
  lastNudgeAt?: number;
  /** The `waitingSince` the current reminder counter applies to. A new
   * waiting stretch (the child produced a turn after a reminder) resets the
   * reminder budget, so `finish` is only reachable after two unanswered
   * reminders inside one continuous stretch. */
  stretchSince?: number;
  /** First failing activity read since the last good read, from
   * `decideGoneAction`. */
  failedReadSince?: number;
  /** Set once a gone-sidecar write succeeded, so no repeated writes. */
  gone?: boolean;
}

export function decideIdleAction(params: {
  interactive: boolean;
  phase: string | undefined;
  waitingSince: number | undefined;
  now: number;
  state: IdleWatchState;
}): IdleAction {
  const { interactive, phase, waitingSince, now, state } = params;
  if (interactive || phase !== "waiting" || waitingSince === undefined) return "none";

  // New waiting stretch: whatever reminders came before belong to a stretch
  // the child already answered (or worked through) — reset the budget.
  if (state.stretchSince !== waitingSince) {
    state.stretchSince = waitingSince;
    state.nudges = 0;
    state.lastNudgeAt = undefined;
  }

  if (now - waitingSince < IDLE_STEP_MS) return "none";

  const sinceNudge = state.lastNudgeAt === undefined ? Infinity : now - state.lastNudgeAt;
  if (sinceNudge < IDLE_STEP_MS) return "none";

  return state.nudges >= IDLE_MAX_NUDGES ? "finish" : "nudge";
}
