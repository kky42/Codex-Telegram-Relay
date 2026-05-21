import path from "node:path";

import { truncateText } from "../../utils.js";

export const ATTACHMENT_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_SIZE_LIMIT_MB = 20;
export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
export const OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB = 50;

const DEFAULT_ATTACHMENT_EXTENSIONS = {
  photo: ".jpg",
  document: "",
  video: ".mp4",
  audio: "",
  voice: ".ogg",
  animation: ".mp4"
};
const MAX_ATTACHMENT_FILE_NAME_LENGTH = 160;

export function attachmentLimitText() {
  return `${ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

export function outboundAttachmentLimitText() {
  return `${OUTBOUND_ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

function sanitizeSegment(value, fallback = "attachment") {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : fallback;
}

function sanitizeExtension(value) {
  const extension = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  if (!extension || extension.length > 16) {
    return "";
  }

  return `.${extension}`;
}

function basenameFromAnyPath(value) {
  return path.posix.basename(String(value ?? "").replace(/\\/g, "/"));
}

function extensionFromName(value) {
  return sanitizeExtension(path.extname(basenameFromAnyPath(value)).replace(/^\./, ""));
}

function stemFromName(value, fallback) {
  const baseName = basenameFromAnyPath(value);
  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return sanitizeSegment(stem, fallback);
}

function truncateStemForFileName(stem, marker, collisionSuffix, extension) {
  const maxStemLength = Math.max(
    1,
    MAX_ATTACHMENT_FILE_NAME_LENGTH - marker.length - collisionSuffix.length - extension.length
  );
  if (stem.length <= maxStemLength) {
    return stem;
  }

  return stem.slice(0, maxStemLength).replace(/[._-]+$/g, "") || stem.slice(0, maxStemLength);
}

export function buildAttachmentFileName({
  kind,
  fileName,
  filePath,
  sourceMessageId,
  collisionIndex = 1
}) {
  const fallbackStem = sanitizeSegment(kind, "attachment");
  const originalName = typeof fileName === "string" && fileName.trim() ? fileName : "";
  const stem = originalName ? stemFromName(originalName, fallbackStem) : fallbackStem;
  const candidateExtension = extensionFromName(originalName || filePath);
  const defaultExtension = DEFAULT_ATTACHMENT_EXTENSIONS[kind] ?? "";
  const extension = candidateExtension || defaultExtension;
  const messageId = sanitizeSegment(sourceMessageId, "unknown");
  const marker = `--m${messageId}`;
  const normalizedCollisionIndex = Number(collisionIndex);
  const collisionSuffix =
    Number.isSafeInteger(normalizedCollisionIndex) && normalizedCollisionIndex > 1
      ? `-${normalizedCollisionIndex}`
      : "";
  const cappedStem = truncateStemForFileName(stem, marker, collisionSuffix, extension);

  return `${cappedStem}${marker}${collisionSuffix}${extension}`;
}

export function summarizeTurn(turn) {
  if (typeof turn === "string") {
    return truncateText(turn.replace(/\s+/g, " ").trim(), 160);
  }

  const promptPreview = truncateText(String(turn?.promptText ?? "").replace(/\s+/g, " ").trim(), 160);
  const attachments = Array.isArray(turn?.attachments) ? turn.attachments : [];

  if (attachments.length === 0) {
    return promptPreview;
  }

  const prefix = `[${attachments.length} attachment${attachments.length === 1 ? "" : "s"}]`;
  return promptPreview ? `${prefix} ${promptPreview}` : `${prefix} (no caption)`;
}
