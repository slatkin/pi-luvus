/**
 * Luvus module auto-link — keep the packaged `luvus-module/` registered.
 *
 * The resumable-session titles live in the Luvus module
 * `pi-luvus.pane-titles`. That module needs a manual
 * `luvus module link <path>` before Luvus runs it, so a fresh install shows
 * no titles until the user links it. This helper removes that step: on
 * startup the parent pi process checks `module info` and links the bundled
 * module dir when it is absent, points elsewhere, or reports an older
 * version.
 *
 * The check runs once per process, in the background. It never blocks the
 * pi event loop and never throws: a failed read means unknown, a failed
 * link means the titles stay missing until the next start.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getModuleInfoAsync,
  isMuxAvailable,
  linkModuleAsync,
  type LuvusModuleInfo,
} from "./luvus.ts";

/** The packaged module id, from `luvus-module/luvus-module.toml`. */
export const MODULE_ID = "pi-luvus.pane-titles";

/** Absolute path to the package root (the dir that holds `luvus-module/`). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Absolute path to the bundled module dir. */
export function moduleDir(packageRoot: string = PACKAGE_ROOT): string {
  return join(packageRoot, "luvus-module");
}

/** Read the `version = "x"` line of a module manifest. Null when unreadable. */
export function readModuleVersion(manifestPath: string): string | null {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
  return parseModuleVersion(text);
}

/** Parse the `version = "x"` line of a `luvus-module.toml` text. */
export function parseModuleVersion(text: string): string | null {
  const match = text.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
  return match ? match[1] : null;
}

/**
 * True when the registered module needs a (re-)link: no registration, a
 * different checkout path, a disabled entry, or an older version than the
 * bundled manifest. An unreadable local version never forces a link — the
 * absent-registration case already covers a fresh install.
 */
export function moduleNeedsLink(
  remote: LuvusModuleInfo | null,
  localRoot: string,
  localVersion: string | null,
): boolean {
  if (remote === null) return true;
  if (typeof remote.root !== "string" || remote.root !== localRoot) return true;
  if (remote.enabled === false) return true;
  if (
    localVersion !== null &&
    typeof remote.version === "string" &&
    remote.version !== localVersion
  ) {
    return true;
  }
  return false;
}

/**
 * True when this process should run the ensure: inside a Luvus pane, in a
 * parent pi (never in a subagent child — N children must not race to link),
 * and with auto-link enabled in config.
 */
export function shouldEnsureModule(env: NodeJS.ProcessEnv = process.env, enabled = true): boolean {
  if (!enabled) return false;
  if (env.PI_LUVUS_SESSION) return false;
  return isMuxAvailable(env);
}

export type ModuleEnsureResult = "skipped" | "ok" | "linked" | "failed";

let ensureStarted = false;

/** Test seam: allow the suite to run the ensure more than once per process. */
export function __resetModuleEnsureForTests__(): void {
  ensureStarted = false;
}

/**
 * Check the registration and link when needed. Runs once per process;
 * later calls return `"skipped"`. Never throws — every failure resolves
 * to `"failed"` so callers can fire and forget.
 */
export async function ensureLuvusModuleLinked(
  options: {
    env?: NodeJS.ProcessEnv;
    enabled?: boolean;
    localDir?: string;
    localVersion?: string | null;
    info?: (id: string) => Promise<LuvusModuleInfo | null>;
    link?: (path: string) => Promise<void>;
  } = {},
): Promise<ModuleEnsureResult> {
  if (ensureStarted) return "skipped";
  ensureStarted = true;
  const env = options.env ?? process.env;
  if (!shouldEnsureModule(env, options.enabled ?? true)) return "skipped";
  const localDir = options.localDir ?? moduleDir();
  let localVersion = options.localVersion;
  if (localVersion === undefined) {
    localVersion = readModuleVersion(join(localDir, "luvus-module.toml"));
  }
  const readInfo = options.info ?? getModuleInfoAsync;
  const runLink = options.link ?? linkModuleAsync;
  let remote: LuvusModuleInfo | null;
  try {
    remote = await readInfo(MODULE_ID);
  } catch {
    return "failed";
  }
  if (!moduleNeedsLink(remote, localDir, localVersion)) return "ok";
  try {
    await runLink(localDir);
  } catch {
    return "failed";
  }
  return "linked";
}
