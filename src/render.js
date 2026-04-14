import { splitPlainText, truncateText } from "./utils.js";

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

  return queue
    .map((message, index) => `${index + 1}. ${truncateText(message.replace(/\s+/g, " ").trim(), 160)}`)
    .join("\n");
}

export function renderStatusMessage({ isRunning, workdir, usage, queue }) {
  const lines = [
    `running: ${isRunning ? "yes" : "no"}`,
    `workdir: ${workdir}`,
    `recent_usage: ${usage}`,
    "queue:",
    summarizeQueue(queue)
  ];

  return lines.join("\n");
}
