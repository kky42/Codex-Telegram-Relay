import { startCliJsonRun } from "../process-runner.js";
import { buildClaudeArgs } from "./args.js";
import { parseJsonlLine } from "./events.js";

function isClaudeTerminalEvent(event) {
  return event.type === "result" || event.type === "error";
}

export function startClaudeRun({
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
  const args = buildClaudeArgs({
    sessionId,
    message,
    autoMode,
    model,
    reasoningEffort,
    developerInstructions
  });

  return startCliJsonRun({
    command: "claude",
    args,
    cwd: workdir,
    displayName: "claude",
    parseEventLine: parseJsonlLine,
    isTerminalEvent: isClaudeTerminalEvent,
    resolveNonZeroTerminalEvent: true,
    forceKillDelayMs,
    onEvent,
    onStdErr
  });
}
