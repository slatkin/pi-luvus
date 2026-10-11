/**
 * Skill shim: find the pi-luvus package and hand the argv to its
 * CLI. `npx skills add` copies this file into the skill directory, so it
 * stays self-contained (Node builtins only) and loads the CLI from the
 * package root it finds at run time.
 *
 * Lookup order: `PI_LUVUS_DIR`, then the checkout holding this
 * file's resolved real path, then pi's git install under the agent config
 * directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Paths that mark a package root, relative to it. */
const CLI_RELATIVE = join("pi-extension", "luvus", "cli.ts");
const DONE_RELATIVE = join("pi-extension", "luvus", "luvus-done.ts");

/** Install command named by the not-found error. */
const INSTALL_COMMAND = "pi install git:github.com/slatkin/pi-luvus";

/** Injected process pieces, forwarded to the CLI; the defaults are the real process. */
export interface ShimDeps {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The agent config directory for the given environment. `env.HOME` is
 * consulted before `homedir()` so an injected environment is honoured.
 */
function agentConfigDir(env: NodeJS.ProcessEnv): string {
  return env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent");
}

/** Package roots to try for a shim at `shimPath`, in lookup order. */
export function packageRootCandidates(shimPath: string, env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.PI_LUVUS_DIR) candidates.push(env.PI_LUVUS_DIR);
  // This file lives at <root>/skills/pi-luvus/launch.ts.
  candidates.push(resolve(dirname(resolved(shimPath)), "..", ".."));
  candidates.push(join(agentConfigDir(env), "git", "github.com", "slatkin", "pi-luvus"));
  return candidates;
}

/** First candidate holding both extension entry points; throws otherwise. */
export function findPackageRoot(shimPath: string, env: NodeJS.ProcessEnv): string {
  const candidates = packageRootCandidates(shimPath, env);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, CLI_RELATIVE)) && existsSync(join(candidate, DONE_RELATIVE))) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot find the pi-luvus extension (no ${CLI_RELATIVE} and ${DONE_RELATIVE} in: ` +
      `${candidates.join(", ")}). Install it with: ${INSTALL_COMMAND}`,
  );
}

/**
 * Run one CLI invocation from the skill dir: find the package root, load its
 * CLI, and run it. Throws when no root holds the extension, before the CLI —
 * and therefore any Luvus call — runs.
 */
export async function main(argv: string[], deps: ShimDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const root = findPackageRoot(fileURLToPath(import.meta.url), env);
  const cli = (await import(pathToFileURL(join(root, CLI_RELATIVE)).href)) as {
    main: (argv: string[], deps: ShimDeps) => Promise<number>;
  };
  return cli.main(argv, deps);
}

/** True when this file is the process entry, not an import from a test. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolved(entry) === resolved(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`launch.ts: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
