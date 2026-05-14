import {
  AUTO_DEFAULT,
  AUTO_LEVEL_LOW,
  AUTO_LEVEL_MEDIUM,
  normalizeAutoMode
} from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";

/**
 * @typedef {object} CodexRunRequest
 * @property {string | null | undefined} [sessionId]
 * @property {string} message
 * @property {string} [autoMode]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string | null | undefined} [developerInstructions]
 */

function buildConfigOverrideArg(key, rawValue) {
  return `${key}=${JSON.stringify(String(rawValue))}`;
}

/**
 * @param {CodexRunRequest} request
 */
export function buildCodexArgs({
  sessionId,
  message,
  autoMode = AUTO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  developerInstructions = null
}) {
  const normalizedAutoMode = normalizeAutoMode(autoMode, "autoMode");
  const modeArgs =
    normalizedAutoMode === AUTO_LEVEL_LOW
      ? ["--sandbox", "read-only"]
      : normalizedAutoMode === AUTO_LEVEL_MEDIUM
        ? ["--sandbox", "workspace-write"]
        : ["--dangerously-bypass-approvals-and-sandbox"];
  const modelArgs = model === DEFAULT_MODEL ? [] : ["--model", model];
  const reasoningArgs =
    reasoningEffort === DEFAULT_REASONING_EFFORT
      ? []
      : ["-c", buildConfigOverrideArg("model_reasoning_effort", reasoningEffort)];
  const developerInstructionArgs =
    !sessionId && developerInstructions
      ? ["-c", buildConfigOverrideArg("developer_instructions", developerInstructions)]
      : [];

  const baseArgs = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...developerInstructionArgs,
    ...modeArgs,
    ...modelArgs,
    ...reasoningArgs
  ];

  if (sessionId) {
    return [...baseArgs, "resume", sessionId, message];
  }

  return [...baseArgs, message];
}
