import { splitPlainText } from "../../utils.js";

const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeTelegramMarkdown(text) {
  return String(text).replace(MARKDOWN_V2_SPECIAL_CHARS, "\\$&");
}

export function toTelegramMarkdownChunks(text) {
  return splitPlainText(String(text), 3500).map((chunk) => escapeTelegramMarkdown(chunk));
}
