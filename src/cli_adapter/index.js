import { buildClaudeArgs } from "./claude/args.js";
import { eventToActions as claudeEventToActions } from "./claude/events.js";
import { startClaudeRun } from "./claude/runner.js";
import { buildCodexArgs } from "./codex/args.js";
import { readContextLengthForSession } from "./codex/context-length.js";
import { eventToActions as codexEventToActions } from "./codex/events.js";
import { startCodexRun } from "./codex/runner.js";
import { buildPiArgs } from "./pi/args.js";
import { readContextLengthForSession as readPiContextLengthForSession } from "./pi/context-length.js";
import { eventToActions as piEventToActions } from "./pi/events.js";
import { startPiRun } from "./pi/runner.js";

export const SUPPORTED_AGENT_CLIS = ["codex", "claude", "pi"];

const CLI_ADAPTERS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    buildArgs: buildCodexArgs,
    eventToActions: codexEventToActions,
    startRun: startCodexRun,
    resolveContextLength: readContextLengthForSession
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    buildArgs: buildClaudeArgs,
    eventToActions: claudeEventToActions,
    startRun: startClaudeRun,
    resolveContextLength: async () => null
  },
  pi: {
    id: "pi",
    displayName: "Pi",
    buildArgs: buildPiArgs,
    eventToActions: piEventToActions,
    startRun: startPiRun,
    resolveContextLength: readPiContextLengthForSession
  }
};

export function cliAdapterFor(cli) {
  const adapter = CLI_ADAPTERS[String(cli ?? "").trim().toLowerCase()];
  if (!adapter) {
    throw new Error(`Unsupported agent CLI: ${cli}`);
  }
  return adapter;
}
