/**
 * The launch record: the role values a spawn resolved, written beside the
 * child session file so a resume can start the same child again (design D3).
 *
 * Per-run values (subagent id, pane, activity file, parent roster file,
 * Claude Code sentinel, artifact directory) are deliberately absent; the
 * supervisor creates them again for every run.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Record version written by `writeLaunchRecord`; readers reject others. */
export const LAUNCH_RECORD_VERSION = 1;

export type LaunchBackendName = "pi" | "claude";

/** The role configuration of one child, as the spawn resolved it. */
export interface LaunchRecord {
  version: typeof LAUNCH_RECORD_VERSION;
  backend: LaunchBackendName;
  name: string;
  agent?: string;
  /** The working directory the spawn resolved, always present on spawn. */
  cwd?: string;
  /** The `.pi/agent` directory the spawn adopted, absent when it propagated
   * the global config dir. A resume must not adopt one the spawn did not. */
  localAgentDir?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  rolePrompt?: string;
  systemPromptMode?: "append" | "replace";
  denyTools: string[];
  autoExit: boolean;
  interactive: boolean;
  claudeSessionId?: string;
}

/** `<session>.launch.json`: the record sits beside the child session file. */
export function getLaunchRecordFile(sessionFile: string): string {
  return `${sessionFile}.launch.json`;
}

function invalid(message: string): never {
  throw new Error(`Invalid launch record: ${message}`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${field} must be a string`);
  return value;
}

/**
 * Check an unknown JSON payload and return it as a LaunchRecord. A payload
 * that fails any check is not a record, so `readLaunchRecord` treats it as
 * missing instead of resuming with half a role configuration.
 */
export function validateLaunchRecord(data: unknown): LaunchRecord {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    invalid("expected a JSON object");
  }
  const record = data as Record<string, unknown>;
  if (record.version !== LAUNCH_RECORD_VERSION) {
    invalid(
      `unknown version ${JSON.stringify(record.version)} (expected ${LAUNCH_RECORD_VERSION})`,
    );
  }
  if (record.backend !== "pi" && record.backend !== "claude") {
    invalid('backend must be "pi" or "claude"');
  }
  if (typeof record.name !== "string" || record.name.length === 0) invalid("missing name");

  const denyTools = record.denyTools;
  if (!Array.isArray(denyTools) || denyTools.some((tool) => typeof tool !== "string")) {
    invalid("denyTools must be an array of strings");
  }
  if (typeof record.autoExit !== "boolean") invalid("autoExit must be a boolean");
  if (typeof record.interactive !== "boolean") invalid("interactive must be a boolean");

  const rawSystemPromptMode = record.systemPromptMode;
  const systemPromptMode =
    rawSystemPromptMode === "append" || rawSystemPromptMode === "replace"
      ? rawSystemPromptMode
      : undefined;
  if (rawSystemPromptMode !== undefined && systemPromptMode === undefined) {
    invalid('systemPromptMode must be "append" or "replace"');
  }

  const agent = optionalString(record.agent, "agent");
  const cwd = optionalString(record.cwd, "cwd");
  const localAgentDir = optionalString(record.localAgentDir, "localAgentDir");
  const model = optionalString(record.model, "model");
  const thinking = optionalString(record.thinking, "thinking");
  const tools = optionalString(record.tools, "tools");
  const rolePrompt = optionalString(record.rolePrompt, "rolePrompt");
  const claudeSessionId = optionalString(record.claudeSessionId, "claudeSessionId");

  return {
    version: LAUNCH_RECORD_VERSION,
    backend: record.backend,
    name: record.name,
    denyTools: denyTools as string[],
    autoExit: record.autoExit,
    interactive: record.interactive,
    ...(agent !== undefined ? { agent } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(localAgentDir !== undefined ? { localAgentDir } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(rolePrompt !== undefined ? { rolePrompt } : {}),
    ...(systemPromptMode !== undefined ? { systemPromptMode } : {}),
    ...(claudeSessionId !== undefined ? { claudeSessionId } : {}),
  };
}

/** Write JSON with a temp file and a rename, creating its directory. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/** Write the record atomically, creating its directory. */
export function writeLaunchRecord(recordFile: string, record: LaunchRecord): void {
  writeJsonAtomic(recordFile, validateLaunchRecord(record));
}

/** Read a record; a missing, unreadable or invalid file reads as no record. */
export function readLaunchRecord(recordFile: string): LaunchRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordFile, "utf8"));
  } catch {
    return null;
  }
  try {
    return validateLaunchRecord(parsed);
  } catch {
    return null;
  }
}
