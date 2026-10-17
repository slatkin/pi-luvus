import type { AgentDefaults } from "./agent-defs.ts";

/**
 * The parent/child env contract. Producers write it with `encodeChildEnv`,
 * child-side readers parse it with `decodeChildEnv`.
 */
export interface ChildEnv {
  name?: string;
  agent?: string;
  sessionFile?: string;
  id?: string;
  activityFile?: string;
  surface?: string;
  parentRosterFile?: string;
  autoExit: boolean;
  denyTools: string[];
}

/** Encode the child env. Writes only fields that are set. */
export function encodeChildEnv(env: ChildEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.name !== undefined) out.PI_LUVUS_NAME = env.name;
  if (env.agent !== undefined) out.PI_LUVUS_AGENT = env.agent;
  if (env.sessionFile !== undefined) out.PI_LUVUS_SESSION = env.sessionFile;
  if (env.id !== undefined) out.PI_LUVUS_ID = env.id;
  if (env.activityFile !== undefined) out.PI_LUVUS_ACTIVITY_FILE = env.activityFile;
  if (env.surface !== undefined) out.PI_LUVUS_SURFACE = env.surface;
  if (env.parentRosterFile !== undefined) {
    out.PI_LUVUS_PARENT_ROSTER = env.parentRosterFile;
  }
  if (env.autoExit) out.PI_LUVUS_AUTO_EXIT = "1";
  if (env.denyTools.length > 0) out.PI_DENY_TOOLS = env.denyTools.join(",");
  return out;
}

/** Decode the child env. An empty string counts as not set. */
export function decodeChildEnv(env: NodeJS.ProcessEnv): ChildEnv {
  const value = (key: string): string | undefined => {
    const raw = env[key];
    return raw ? raw : undefined;
  };

  return {
    name: value("PI_LUVUS_NAME"),
    agent: value("PI_LUVUS_AGENT"),
    sessionFile: value("PI_LUVUS_SESSION"),
    id: value("PI_LUVUS_ID"),
    activityFile: value("PI_LUVUS_ACTIVITY_FILE"),
    surface: value("PI_LUVUS_SURFACE"),
    parentRosterFile: value("PI_LUVUS_PARENT_ROSTER"),
    autoExit: env.PI_LUVUS_AUTO_EXIT === "1",
    denyTools: (env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  };
}

/** True when this env belongs to a subagent child (it carries a session file). */
export function isSubagentChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return decodeChildEnv(env).sessionFile !== undefined;
}

/** Tools that are gated by `spawning: false`. */
const SPAWNING_TOOLS = new Set(["luvus_spawn", "luvus_interrupt", "luvus_list", "luvus_resume"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}
