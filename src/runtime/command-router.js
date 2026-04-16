import { normalizeTelegramUsername } from "../utils.js";

export function parseCommand(text, botUsername) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [token] = trimmed.split(/\s+/, 1);
  const [commandName, mention] = token.slice(1).split("@");
  if (mention && normalizeTelegramUsername(mention) !== normalizeTelegramUsername(botUsername)) {
    return { ignored: true };
  }

  return {
    command: commandName.toLowerCase(),
    args: trimmed.slice(token.length).trim()
  };
}

export async function routeTextMessage({ text, botUsername, session, runtime }) {
  const parsedCommand = parseCommand(text, botUsername);
  if (parsedCommand?.ignored) {
    return;
  }

  switch (parsedCommand?.command) {
    case "status":
      await session.handleStatus();
      return;
    case "schedule":
      await runtime.scheduleService.handleCommand(session, parsedCommand.args);
      return;
    case "auto":
      await session.handleAuto(parsedCommand.args);
      return;
    case "workdir":
      await session.handleWorkdir(parsedCommand.args);
      return;
    case "yolo":
      await session.sendText("Use /auto low, /auto medium, or /auto high.");
      return;
    case "model":
      await session.handleModel(parsedCommand.args);
      return;
    case "reasoning":
      await session.handleReasoningEffort(parsedCommand.args);
      return;
    case "clear_cache":
      await runtime.handleClearCache(session.chatId);
      return;
    case "abort":
      await session.handleAbort();
      return;
    case "new":
      await session.handleNewSession();
      return;
    case "reset":
      await session.handleReset();
      return;
    default:
      await session.enqueueMessage(text);
  }
}
