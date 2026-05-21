import { truncateText } from "../../utils.js";
import {
  DEFAULT_GROUP_HISTORY_HOURS,
  DEFAULT_GROUP_HISTORY_MESSAGES
} from "../common/group-history-defaults.js";
import { attachmentDescriptorsFromPost } from "./attachments.js";
import { parseCommand } from "./command-router.js";

export { DEFAULT_GROUP_HISTORY_HOURS, DEFAULT_GROUP_HISTORY_MESSAGES };

const TEXT_PREVIEW_LIMIT = 4000;
const USERNAME_CHARS = "A-Za-z0-9._-";

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function parseMattermostTimestamp(value) {
  const normalized = parseFiniteNumber(value);
  if (!normalized || normalized <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(normalized / 1000);
}

function postTimestamp(post) {
  return parseMattermostTimestamp(post?.create_at);
}

function postText(post) {
  return String(post?.message ?? "");
}

function userLabel(post) {
  const username = String(post?.user?.username ?? post?.props?.from_webhook ?? "").trim();
  if (username) {
    return `@${username}`;
  }
  const userId = String(post?.user_id ?? "").trim();
  return userId ? `id ${userId}` : "unknown";
}

function formatTime(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function attachmentMetaFromPost(post) {
  return attachmentDescriptorsFromPost(post).map((descriptor) => ({
    kind: descriptor.kind,
    fileName: descriptor.fileName,
    mimeType: descriptor.mimeType,
    fileSize: descriptor.fileSize
  }));
}

function entryFromPost(post) {
  const id = String(post?.id ?? "").trim();
  if (!id) {
    return null;
  }

  const text = postText(post).trim();
  const attachments = attachmentMetaFromPost(post);
  if (!text && attachments.length === 0) {
    return null;
  }

  return {
    messageId: id,
    timestamp: postTimestamp(post),
    user: userLabel(post),
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

function formatPost(post) {
  const entry = entryFromPost(post);
  if (!entry) {
    return "[unknown time] [user unknown]: (unsupported message)";
  }
  return formatEntryLine(entry);
}

function formatAttachmentSection(title, posts) {
  const lines = [title];
  let count = 0;

  for (const post of posts) {
    for (const descriptor of attachmentDescriptorsFromPost(post)) {
      count += 1;
      lines.push(`- ${formatAttachmentMeta({
        kind: descriptor.kind,
        fileName: descriptor.fileName,
        mimeType: descriptor.mimeType,
        fileSize: descriptor.fileSize
      })}`);
    }
  }

  if (count === 0) {
    lines.push("(none)");
  }

  return lines.join("\n");
}

function mentionsUsername(text, username) {
  const normalizedUsername = String(username ?? "").trim().replace(/^@+/, "");
  if (!normalizedUsername) {
    return false;
  }
  const escaped = normalizedUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^${USERNAME_CHARS}])@${escaped}(?=$|[^${USERNAME_CHARS}])`, "i").test(String(text ?? ""));
}

function commandTokenTargetsBot(text, botUsername) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
    return false;
  }

  const [token] = trimmed.split(/\s+/, 1);
  if (!token.includes("@")) {
    return false;
  }

  const parsed = parseCommand(trimmed, botUsername);
  return Boolean(parsed && !parsed.ignored);
}

export function isBotAddressed(post, botUsername) {
  const text = postText(post);
  return commandTokenTargetsBot(text, botUsername) || mentionsUsername(text, botUsername);
}

export class GroupHistory {
  constructor({ maxHours = DEFAULT_GROUP_HISTORY_HOURS, maxMessages = DEFAULT_GROUP_HISTORY_MESSAGES } = {}) {
    this.maxHours = maxHours;
    this.maxMessages = maxMessages;
    this.entries = [];
    this.lastTriggerMessageId = null;
  }

  remember(post) {
    const entry = entryFromPost(post);
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

  contextBefore(post) {
    const currentId = String(post?.id ?? "");
    const anchorTimestamp = postTimestamp(post);
    const oldestAllowed = anchorTimestamp - this.maxHours * 60 * 60;
    let candidates = this.entries.filter((entry) => entry.timestamp >= oldestAllowed);

    if (this.lastTriggerMessageId !== null) {
      const triggerIndex = candidates.findIndex((entry) => entry.messageId === this.lastTriggerMessageId);
      if (triggerIndex >= 0) {
        candidates = candidates.slice(triggerIndex + 1);
      }
    }
    if (currentId) {
      candidates = candidates.filter((entry) => entry.messageId !== currentId);
    }
    if (candidates.length > this.maxMessages) {
      candidates = candidates.slice(candidates.length - this.maxMessages);
    }
    return candidates;
  }

  markTriggered(post) {
    const id = String(post?.id ?? "").trim();
    if (id) {
      this.lastTriggerMessageId = id;
    }
    this.prune(postTimestamp(post));
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
  lines.push(formatPost(triggerMessage));
  lines.push("");
  lines.push(formatAttachmentSection("attachments:", attachmentMessages));
  lines.push("");
  lines.push("reference:");
  if (referenceMessage) {
    lines.push(formatPost(referenceMessage));
    lines.push(formatAttachmentSection("reference attachments:", [referenceMessage]));
  } else {
    lines.push("(none)");
  }

  return lines.join("\n");
}
