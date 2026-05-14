import {
  AUTO_DEFAULT,
  AUTO_LEVEL_HIGH,
  AUTO_LEVEL_LOW,
  AUTO_LEVEL_MEDIUM,
  normalizeAutoMode
} from "../../auto-mode.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "../../runtime-settings.js";

const PI_SANDBOX_MODES = {
  [AUTO_LEVEL_LOW]: "readonly",
  [AUTO_LEVEL_MEDIUM]: "on",
  [AUTO_LEVEL_HIGH]: "off"
};

/**
 * @typedef {object} PiRunRequest
 * @property {string | null | undefined} [sessionId]
 * @property {string} message
 * @property {string} [autoMode]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string | null | undefined} [developerInstructions]
 * @property {boolean} [supportsSandboxFlag]
 */

/**
 * @param {PiRunRequest} request
 */
export function buildPiArgs({
  sessionId,
  message,
  autoMode = AUTO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  developerInstructions = null,
  supportsSandboxFlag = false
}) {
  const normalizedAutoMode = normalizeAutoMode(autoMode, "autoMode");
  const sandboxArgs = supportsSandboxFlag
    ? ["--sandbox", PI_SANDBOX_MODES[normalizedAutoMode]]
    : [];
  const modelArgs = model === DEFAULT_MODEL ? [] : ["--model", model];
  const reasoningArgs =
    reasoningEffort === DEFAULT_REASONING_EFFORT
      ? []
      : ["--thinking", reasoningEffort];
  const developerInstructionArgs = developerInstructions
    ? ["--append-system-prompt", developerInstructions]
    : [];
  const sessionArgs = sessionId ? ["--session", sessionId] : [];

  return [
    "-p",
    "--mode",
    "json",
    ...sandboxArgs,
    ...modelArgs,
    ...reasoningArgs,
    ...developerInstructionArgs,
    ...sessionArgs,
    message
  ];
}
