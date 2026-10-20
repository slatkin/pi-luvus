/**
 * Shared harness for the `/stream` command and projection-wiring suites.
 *
 * Both suites need the same setup: register the extension against the mock pi
 * API, point XDG_RUNTIME_DIR at a temp directory, stub the Luvus CLI, and
 * reset the extension's stream state between tests. Keeping it here means a
 * change to the stub protocol or env setup is made once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as subagentsModule from "../pi-extension/luvus/index.ts";
import { __setLuvusExecForTests__ } from "../pi-extension/luvus/luvus.ts";
import { createEnvGuard, createMockApi, type Handler, type Notification } from "./stream-fakes.ts";

export interface StreamCommand {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

export interface StreamHarnessOptions {
  /** Extra `ctx` fields, e.g. a session manager. */
  ctx?: Record<string, unknown>;
  /** Extra `ctx.ui` methods, e.g. a `setWidget` capture. */
  ui?: Record<string, unknown>;
}

export interface StreamHarness {
  /** The extension's test surface. */
  readonly test_: any;
  readonly notifications: Notification[];
  readonly calls: string[][];
  readonly ctx: any;
  /** The registered `/stream` command, available after `start`. */
  readonly command: StreamCommand | undefined;
  /** The pane id the next stubbed split returns; resets to 101. */
  newPaneId: number;
  /** The last handler registered for an event, after `start`. */
  handler(name: string): Handler | undefined;
  setEnv(name: string, value: string | undefined): void;
  run(args: string): Promise<void>;
  /** Register the extension and create the runtime directory. */
  start(): Promise<void>;
  /** Clear notifications, calls, stream state, the pane counter and env. */
  reset(): Promise<void>;
  /** Clear the Luvus stub, restore env and remove the runtime directory. */
  stop(): void;
}

export function createStreamHarness(options: StreamHarnessOptions = {}): StreamHarness {
  const env = createEnvGuard();
  const notifications: Notification[] = [];
  const calls: string[][] = [];
  const test_ = (subagentsModule as any).__test__;
  let nextPaneId = 101;
  let runtimeDir: string | undefined;
  let command: StreamCommand | undefined;
  let handlers = new Map<string, Handler[]>();

  const ctx = {
    ...options.ctx,
    ui: {
      notify(text: string, level: string) {
        notifications.push({ text, level });
      },
      ...options.ui,
    },
  };

  const setEnv = (name: string, value: string | undefined) => env.set(name, value);

  return {
    test_,
    notifications,
    calls,
    ctx,
    get command() {
      return command;
    },
    get newPaneId() {
      return nextPaneId;
    },
    set newPaneId(value: number) {
      nextPaneId = value;
    },
    handler(name) {
      return handlers.get(name)?.at(-1);
    },
    setEnv,
    run(args) {
      return command!.handler(args, ctx);
    },
    async start() {
      const { api, commands, handlers: registered } = createMockApi();
      (subagentsModule as any).default(api);
      command = commands.find((entry) => entry.name === "stream");
      handlers = registered;
      runtimeDir = mkdtempSync(join(tmpdir(), "pi-luvus-stream-test-"));
      setEnv("XDG_RUNTIME_DIR", runtimeDir);
    },
    async reset() {
      await test_.resetStreamState();
      notifications.length = 0;
      calls.length = 0;
      nextPaneId = 101;
      __setLuvusExecForTests__((args) => {
        calls.push([...args]);
        if (args[0] === "pane" && args[1] === "split") {
          return JSON.stringify({ result: { pane: String(nextPaneId++) } });
        }
        return JSON.stringify({ result: {} });
      });
      setEnv("LUVUS_ENV", "1");
      setEnv("LUVUS_BIN_PATH", "/usr/bin/luvus");
      setEnv("LUVUS_PANE_ID", "7");
    },
    stop() {
      __setLuvusExecForTests__(null);
      env.restore();
      if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}
