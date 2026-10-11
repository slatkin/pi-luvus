import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `pi-extension/luvus`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

/**
 * Tools a role without an explicit `tools` frontmatter line runs with.
 *
 * Both launch paths use this list, so such a role no longer receives every pi
 * tool. A role that needs more lists its tools explicitly.
 */
export const DEFAULT_SUBAGENT_TOOLS = "read,bash,edit,write,grep,find,ls";

/** Tools every child keeps, so it can always reach its parent and finish. */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "luvus_done", "luvus_message"] as const;

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  // Role files may use CRLF line endings; normalize so both parse identically.
  const text = content.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = text.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Paths searched for a role definition, in precedence order. */
export function agentDefinitionPaths(name: string, cwd = process.cwd()): string[] {
  return [
    join(cwd, ".pi", "agents", `${name}.md`),
    join(getAgentConfigDir(), "agents", `${name}.md`),
    join(getBundledAgentsDir(), `${name}.md`),
  ];
}

export function loadAgentDefaults(agentName: string, cwd = process.cwd()): AgentDefaults | null {
  for (const p of agentDefinitionPaths(agentName, cwd)) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from luvus-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call luvus_done.
 * A role without a `tools` line falls back to DEFAULT_SUBAGENT_TOOLS.
 */
export function buildSubagentToolAllowlist(effectiveTools?: string): string {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  const allow = new Set(requested.length > 0 ? requested : DEFAULT_SUBAGENT_TOOLS.split(","));
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}
