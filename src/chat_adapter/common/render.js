import { formatAuto } from "../../auto-mode.js";
import { summarizeTurn } from "./attachments.js";

export const CHAT_COMMANDS = [
  { command: "status", description: "Show current agent status" },
  { command: "cli", description: "Show or change the agent CLI for this chat" },
  { command: "workdir", description: "Show or change the bot workdir" },
  { command: "auto", description: "Set agent automation level for this chat" },
  { command: "model", description: "Set model for future runs" },
  { command: "reasoning", description: "Set reasoning effort for future runs" },
  { command: "clear_cache", description: "Clear cached attachments for this chat" },
  { command: "abort", description: "Abort current run and clear queued messages" },
  { command: "new", description: "Start a fresh session and clear context" },
  { command: "reset", description: "Reload config defaults for this chat" }
];

export const ROUTED_COMMAND_NAMES = new Set(CHAT_COMMANDS.map((command) => command.command));

export function summarizeQueue(queue) {
  if (queue.length === 0) {
    return "empty";
  }

  return queue.map((turn, index) => `${index + 1}. ${summarizeTurn(turn)}`).join("\n");
}

export function renderStatusMessage({
  isRunning,
  cli,
  workdir,
  auto,
  model,
  reasoningEffort,
  usage,
  queue
}) {
  const lines = [
    `running: ${isRunning ? "yes" : "no"}`,
    `cli: ${cli}`,
    `workdir: ${workdir}`,
    `auto: ${formatAuto(auto)}`,
    `model: ${model}`,
    `reasoning_effort: ${reasoningEffort}`,
    `context_length: ${usage.contextLength}`,
    "queue:",
    summarizeQueue(queue)
  ];

  return lines.join("\n");
}
