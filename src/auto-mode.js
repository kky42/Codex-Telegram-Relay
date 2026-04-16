export const AUTO_LEVEL_LOW = "low";
export const AUTO_LEVEL_MEDIUM = "medium";
export const AUTO_LEVEL_HIGH = "high";
export const AUTO_DEFAULT = AUTO_LEVEL_HIGH;

export function normalizeAutoMode(value, fieldPath = "auto") {
  if (typeof value !== "string") {
    throw new Error(`${fieldPath} must be one of: low, medium, high`);
  }

  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case AUTO_LEVEL_LOW:
    case AUTO_LEVEL_MEDIUM:
    case AUTO_LEVEL_HIGH:
      return normalized;
    default:
      throw new Error(`${fieldPath} must be one of: low, medium, high`);
  }
}

export function normalizeBotAuto(bot, fieldPrefix) {
  if (bot.auto === undefined) {
    return AUTO_DEFAULT;
  }

  return normalizeAutoMode(bot.auto, `${fieldPrefix}.auto`);
}

export function readPersistedAuto(chatState) {
  if (typeof chatState?.auto !== "string") {
    return null;
  }

  try {
    return normalizeAutoMode(chatState.auto);
  } catch {
    return null;
  }
}

export function parseAutoArgument(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "low":
    case "read-only":
    case "readonly":
    case "safe":
      return AUTO_LEVEL_LOW;
    case "medium":
    case "full-auto":
    case "workspace":
    case "workspace-write":
      return AUTO_LEVEL_MEDIUM;
    case "high":
    case "danger":
    case "danger-full-access":
      return AUTO_LEVEL_HIGH;
    default:
      return null;
  }
}

export function formatAuto(autoMode) {
  return normalizeAutoMode(autoMode);
}
