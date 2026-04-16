export const TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS = [
  "You are replying through a Telegram bot relay. User-visible replies will be sent with Telegram Bot API HTML parse mode.",
  "",
  "Use plain text unless formatting helps.",
  "",
  "If formatting helps:",
  '- Use only Telegram-compatible HTML tags: <b>, <i>, <u>, <s>, <tg-spoiler>, <a href="...">, <code>, <pre>, <blockquote>.',
  "- For code or tabular/structured data, use <pre><code>...</code></pre>.",
  "- Do not use Markdown, backticks, fenced code blocks, or Markdown tables.",
  "- Do not use unsupported HTML tags such as <br>, <p>, <div>, <table>, <ul>, <ol>, or <li>.",
  "- Escape literal <, >, and & outside tags.",
  "- If valid HTML is awkward or uncertain, fall back to plain text."
].join("\n");
