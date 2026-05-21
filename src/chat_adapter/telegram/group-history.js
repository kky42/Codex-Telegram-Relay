import { attachmentDescriptorFromMessage } from "./attachments.js";
import {
  DEFAULT_GROUP_HISTORY_HOURS,
  DEFAULT_GROUP_HISTORY_MESSAGES
} from "../common/group-history-defaults.js";
import { normalizeTelegramUsername, truncateText } from "../../utils.js";
import { parseCommand } from "./command-router.js";

export { DEFAULT_GROUP_HISTORY_HOURS, DEFAULT_GROUP_HISTORY_MESSAGES };

const TEXT_PREVIEW_LIMIT = 4000;

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function messageTimestamp(message) {
  return parseFiniteNumber(message?.date) ?? Math.floor(Date.now() / 1000);
}

function messageId(message) {
  return parseFiniteNumber(message?.message_id);
}

function messageText(message) {
  if (typeof message?.text === "string") {
    return message.text;
  }
  if (typeof message?.caption === "string") {
    return message.caption;
  }
  return "";
}

function messageEntities(message) {
  if (Array.isArray(message?.entities)) {
    return message.entities;
  }
  if (Array.isArray(message?.caption_entities)) {
    return message.caption_entities;
  }
  return [];
}

function entitySlice(text, entity) {
  const offset = Number(entity?.offset);
  const length = Number(entity?.length);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    return "";
  }
  return String(text).slice(offset, offset + length);
}

function commandTokenTargetsBot(text, botUsername) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }

  const [token] = trimmed.split(/\s+/, 1);
  if (!token.includes("@")) {
    return false;
  }

  const parsed = parseCommand(trimmed, botUsername);
  return Boolean(parsed && !parsed.ignored);
}

function textMentionsBot(text, botUsername) {
  const escapedUsername = String(botUsername).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escapedUsername}(?=$|[^A-Za-z0-9_])`, "i").test(
    String(text ?? "")
  );
}

export function isBotAddressed(message, botUsername) {
  const normalizedBotUsername = normalizeTelegramUsername(botUsername);
  if (!normalizedBotUsername) {
    return false;
  }

  const text = messageText(message);
  if (commandTokenTargetsBot(text, normalizedBotUsername)) {
    return true;
  }
  if (textMentionsBot(text, normalizedBotUsername)) {
    return true;
  }

  for (const entity of messageEntities(message)) {
    if (entity?.type === "mention") {
      const mentioned = normalizeTelegramUsername(entitySlice(text, entity));
      if (mentioned === normalizedBotUsername) {
        return true;
      }
    }

    if (entity?.type === "text_mention") {
      const mentioned = normalizeTelegramUsername(entity.user?.username);
      if (mentioned === normalizedBotUsername) {
        return true;
      }
    }
  }

  return false;
}

function userLabel(user) {
  const username = normalizeTelegramUsername(user?.username);
  if (username) {
    return `@${username}`;
  }

  const name = [user?.first_name, user?.last_name]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .trim();
  if (name) {
    return name;
  }

  const id = parseFiniteNumber(user?.id);
  return id === null ? "unknown" : `id ${id}`;
}

function formatTime(timestampSeconds) {
  const timestampMs = timestampSeconds * 1000;
  return new Date(timestampMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function attachmentMetaFromMessage(message) {
  const descriptor = attachmentDescriptorFromMessage(message);
  if (!descriptor) {
    return [];
  }

  return [
    {
      kind: descriptor.kind,
      fileName: descriptor.fileName,
      mimeType: descriptor.mimeType,
      fileSize: descriptor.fileSize
    }
  ];
}

function entryFromMessage(message) {
  const id = messageId(message);
  if (id === null) {
    return null;
  }

  const text = messageText(message).trim();
  const attachments = attachmentMetaFromMessage(message);
  if (!text && attachments.length === 0) {
    return null;
  }

  return {
    messageId: id,
    timestamp: messageTimestamp(message),
    user: userLabel(message?.from),
    text,
    attachments
  };
}

function formatAttachmentMeta(attachment) {
  const parts = [`attachment: ${attachment.kind}`];
  if (attachment.fileName) {
    parts.push(attachment.fileName);
  }
  if (attachment.mimeType) {
    parts.push(attachment.mimeType);
  }
  if (attachment.fileSize !== null && attachment.fileSize !== undefined) {
    parts.push(`${attachment.fileSize} bytes`);
  }
  return `[${parts.join("; ")}]`;
}

function formatEntryLine(entry) {
  const prefix = `[${formatTime(entry.timestamp)}] [user ${entry.user}]:`;
  const text = truncateText(entry.text.replace(/\s+/g, " "), TEXT_PREVIEW_LIMIT);
  const attachmentText = entry.attachments.map(formatAttachmentMeta).join(" ");
  const body = [text, attachmentText].filter(Boolean).join(" ");
  return body ? `${prefix} ${body}` : `${prefix} (no text)`;
}

function formatMessage(message) {
  const entry = entryFromMessage(message);
  if (!entry) {
    return "[unknown time] [user unknown]: (unsupported message)";
  }
  return formatEntryLine(entry);
}

function formatAttachmentSection(title, messages) {
  const lines = [title];
  let count = 0;

  for (const message of messages) {
    const descriptor = attachmentDescriptorFromMessage(message);
    if (!descriptor) {
      continue;
    }
    count += 1;
    lines.push(`- ${formatAttachmentMeta({
      kind: descriptor.kind,
      fileName: descriptor.fileName,
      mimeType: descriptor.mimeType,
      fileSize: descriptor.fileSize
    })}`);
  }

  if (count === 0) {
    lines.push("(none)");
  }

  return lines.join("\n");
}

export class GroupHistory {
  constructor({ maxHours = DEFAULT_GROUP_HISTORY_HOURS, maxMessages = DEFAULT_GROUP_HISTORY_MESSAGES } = {}) {
    this.maxHours = maxHours;
    this.maxMessages = maxMessages;
    this.entries = [];
    this.lastTriggerMessageId = null;
  }

  remember(message) {
    const entry = entryFromMessage(message);
    if (!entry) {
      return null;
    }

    this.entries.push(entry);
    this.prune(entry.timestamp);
    return entry;
  }

  prune(anchorTimestamp = Math.floor(Date.now() / 1000)) {
    const oldestAllowed = anchorTimestamp - this.maxHours * 60 * 60;
    this.entries = this.entries.filter((entry) => entry.timestamp >= oldestAllowed);

    if (this.entries.length > this.maxMessages) {
      this.entries = this.entries.slice(this.entries.length - this.maxMessages);
    }
  }

  contextBefore(message) {
    const currentMessageId = messageId(message);
    const anchorTimestamp = messageTimestamp(message);
    const oldestAllowed = anchorTimestamp - this.maxHours * 60 * 60;

    let candidates = this.entries.filter((entry) => entry.timestamp >= oldestAllowed);

    if (this.lastTriggerMessageId !== null) {
      candidates = candidates.filter((entry) => entry.messageId > this.lastTriggerMessageId);
    }
    if (currentMessageId !== null) {
      candidates = candidates.filter((entry) => entry.messageId < currentMessageId);
    }

    if (candidates.length > this.maxMessages) {
      candidates = candidates.slice(candidates.length - this.maxMessages);
    }

    return candidates;
  }

  markTriggered(message) {
    const id = messageId(message);
    if (id !== null) {
      this.lastTriggerMessageId = id;
    }
    this.prune(messageTimestamp(message));
  }
}

export function buildGroupPrompt({
  contextMessages,
  triggerMessage,
  attachmentMessages = [],
  referenceMessage = null
}) {
  const lines = ["Context:"];
  if (contextMessages.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of contextMessages) {
      lines.push(formatEntryLine(entry));
    }
  }

  lines.push("");
  lines.push("Message to you:");
  lines.push(formatMessage(triggerMessage));
  lines.push("");
  lines.push(formatAttachmentSection("attachments:", attachmentMessages));
  lines.push("");
  lines.push("reference:");
  if (referenceMessage) {
    lines.push(formatMessage(referenceMessage));
    lines.push(formatAttachmentSection("reference attachments:", [referenceMessage]));
  } else {
    lines.push("(none)");
  }

  return lines.join("\n");
}
