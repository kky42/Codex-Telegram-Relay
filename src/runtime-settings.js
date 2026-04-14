export const DEFAULT_MODEL = "default";
export const DEFAULT_REASONING_EFFORT = "default";

function normalizeSettingValue(value, fieldPath) {
  if (typeof value !== "string") {
    throw new Error(`${fieldPath} must be a string`);
  }

  return value.trim();
}

export function normalizeBotModel(bot, fieldPrefix) {
  if (bot.model === undefined) {
    return DEFAULT_MODEL;
  }

  return normalizeSettingValue(bot.model, `${fieldPrefix}.model`);
}

export function normalizeBotReasoningEffort(bot, fieldPrefix) {
  if (bot.reasoningEffort === undefined) {
    return DEFAULT_REASONING_EFFORT;
  }

  return normalizeSettingValue(bot.reasoningEffort, `${fieldPrefix}.reasoningEffort`);
}

export function readPersistedModel(chatState) {
  return typeof chatState?.model === "string" ? chatState.model : null;
}

export function readPersistedReasoningEffort(chatState) {
  return typeof chatState?.reasoningEffort === "string" ? chatState.reasoningEffort : null;
}

export function normalizeSettingArgument(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
