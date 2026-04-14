export const YOLO_OFF = false;
export const YOLO_ON = true;
export const YOLO_DEFAULT = YOLO_ON;

export function normalizeYolo(value, fieldPath = "yolo") {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldPath} must be a boolean`);
  }

  return value;
}

export function normalizeBotYolo(bot, fieldPrefix) {
  return bot.yolo === undefined ? YOLO_DEFAULT : normalizeYolo(bot.yolo, `${fieldPrefix}.yolo`);
}

export function readPersistedYolo(chatState) {
  return typeof chatState?.yolo === "boolean" ? chatState.yolo : null;
}

export function parseYoloArgument(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "on":
    case "true":
    case "1":
    case "yes":
    case "yolo":
      return YOLO_ON;
    case "off":
    case "false":
    case "0":
    case "no":
    case "safe":
      return YOLO_OFF;
    default:
      return null;
  }
}

export function formatYolo(yolo) {
  return yolo ? "on" : "off";
}
