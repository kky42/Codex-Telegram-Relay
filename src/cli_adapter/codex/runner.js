import { startCliJsonRun } from "../process-runner.js";
import { buildCodexArgs } from "./args.js";
import { parseJsonlLine } from "./events.js";

function isCodexTerminalEvent(event) {
  return event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error";
}

export function startCodexRun({
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
  const args = buildCodexArgs({
    sessionId,
    message,
    autoMode,
    model,
    reasoningEffort,
    developerInstructions
  });

  return startCliJsonRun({
    command: "codex",
    args,
    cwd: workdir,
    displayName: "codex",
    parseEventLine: parseJsonlLine,
    isTerminalEvent: isCodexTerminalEvent,
    forceKillDelayMs,
    onEvent,
    onStdErr
  });
}
