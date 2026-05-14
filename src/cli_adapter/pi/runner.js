import { spawnSync } from "node:child_process";

import { startCliJsonRun } from "../process-runner.js";
import { buildPiArgs } from "./args.js";
import { parseJsonlLine } from "./events.js";

const sandboxFlagSupportCache = new Map();

export function resetPiFeatureDetectionCache() {
  sandboxFlagSupportCache.clear();
}

export function detectPiSandboxFlagSupport({ cwd = process.cwd() } = {}) {
  const cacheKey = String(cwd || process.cwd());
  if (sandboxFlagSupportCache.has(cacheKey)) {
    return sandboxFlagSupportCache.get(cacheKey);
  }

  const result = spawnSync("pi", ["-h"], {
    encoding: "utf8",
    cwd,
    env: process.env
  });

  const helpText = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const supportsSandboxFlag = result.status === 0 && /--sandbox\b/.test(helpText);
  sandboxFlagSupportCache.set(cacheKey, supportsSandboxFlag);
  return supportsSandboxFlag;
}

function isPiTerminalEvent(event) {
  return event.type === "turn_end" || event.type === "agent_end";
}

export function startPiRun({
  workdir,
  sessionId,
  message,
  autoMode,
  model,
  reasoningEffort,
  developerInstructions,
  forceKillDelayMs = 3000,
  onEvent = async () => {},
  onStdErr = () => {}
}) {
  const args = buildPiArgs({
    sessionId,
    message,
    autoMode,
    model,
    reasoningEffort,
    developerInstructions,
    supportsSandboxFlag: detectPiSandboxFlagSupport({ cwd: workdir })
  });

  return startCliJsonRun({
    command: "pi",
    args,
    cwd: workdir,
    displayName: "pi",
    parseEventLine: parseJsonlLine,
    isTerminalEvent: isPiTerminalEvent,
    forceKillDelayMs,
    onEvent,
    onStdErr
  });
}
