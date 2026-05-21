import { routeCommandOrTurn } from "../common/command-router.js";

function normalizeMattermostUsername(username) {
  return String(username || "").trim().replace(/^@+/, "").toLowerCase();
}

function stripLeadingBotMention(text, botUsername) {
  const trimmed = String(text || "").trim();
  const normalizedBotUsername = normalizeMattermostUsername(botUsername);
  if (!normalizedBotUsername || !trimmed.startsWith("@")) {
    return trimmed;
  }

  const [token] = trimmed.split(/\s+/, 1);
  if (normalizeMattermostUsername(token) !== normalizedBotUsername) {
    return trimmed;
  }
  return trimmed.slice(token.length).trim();
}

export function parseCommand(text, botUsername) {
  const trimmed = stripLeadingBotMention(text, botUsername);
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeMattermostUsername(mention) !== normalizeMattermostUsername(botUsername)) {
    return { ignored: true };
  }

  return {
    command: commandName.toLowerCase(),
    args: trimmed.slice(token.length).trim()
  };
}

export async function routeTextMessage({ text, botUsername, session, runtime, replyTarget = null }) {
  const normalizedText = stripLeadingBotMention(text, botUsername);
  const parsedCommand = parseCommand(normalizedText, botUsername);
  if (parsedCommand?.ignored) {
    return;
  }

  await routeCommandOrTurn({
    command: parsedCommand?.command,
    args: parsedCommand?.args,
    text: parsedCommand ? normalizedText : text,
    session,
    runtime,
    replyTarget
  });
}
