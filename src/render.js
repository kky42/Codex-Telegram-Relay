import { summarizeTurn } from "./attachments.js";
import { formatAuto } from "./auto-mode.js";
import { splitPlainText } from "./utils.js";

const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeTelegramMarkdown(text) {
  return String(text).replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$&");
}

export function toTelegramMarkdownChunks(text) {
  return splitPlainText(String(text), 3500).map((chunk) => escapeTelegramMarkdown(chunk));
}

export function summarizeQueue(queue) {
  if (queue.length === 0) {
    return "empty";
  }

  return queue.map((turn, index) => `${index + 1}. ${summarizeTurn(turn)}`).join("\n");
}

export function renderStatusMessage({
  isRunning,
  workdir,
  auto,
  model,
  reasoningEffort,
  usage,
  queue
}) {
  const lines = [
    `running: ${isRunning ? "yes" : "no"}`,
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
