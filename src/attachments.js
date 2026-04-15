import path from "node:path";

import { truncateText } from "./utils.js";

export const ATTACHMENT_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_SIZE_LIMIT_MB = 20;
export const ALBUM_QUIET_PERIOD_MS = 1500;
export const SUPPORTED_ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "animation"
];

const DEFAULT_ATTACHMENT_EXTENSIONS = {
  photo: ".jpg",
  document: "",
  video: ".mp4",
  audio: "",
  voice: ".ogg",
  animation: ".mp4"
};

export function attachmentSupportText() {
  return SUPPORTED_ATTACHMENT_KINDS.join(", ");
}

export function unsupportedAttachmentMessage() {
  return `Unsupported message type. Supported attachments: ${attachmentSupportText()}.`;
}

export function attachmentLimitText() {
  return `${ATTACHMENT_SIZE_LIMIT_MB} MB`;
}

function parseFiniteNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function preferredPhotoSize(photoSizes) {
  let best = null;
  let bestScore = -1;

  for (const candidate of photoSizes) {
    if (!candidate?.file_id) {
      continue;
    }
    const score =
      parseFiniteNumber(candidate.file_size) ??
      (parseFiniteNumber(candidate.width) ?? 0) * (parseFiniteNumber(candidate.height) ?? 0);

    if (!best || score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export function attachmentDescriptorFromMessage(message) {
  const bestPhoto = preferredPhotoSize(message?.photo ?? []);
  if (bestPhoto) {
    return {
      kind: "photo",
      mode: "native-image",
      telegramFileId: bestPhoto.file_id,
      telegramFileUniqueId: bestPhoto.file_unique_id ?? null,
      fileName: null,
      mimeType: null,
      fileSize: parseFiniteNumber(bestPhoto.file_size),
      sourceMessageId: parseFiniteNumber(message?.message_id),
      mediaGroupId: message?.media_group_id ?? null
    };
  }

  for (const kind of ["document", "video", "audio", "voice", "animation"]) {
    const payload = message?.[kind];
    if (!payload?.file_id) {
      continue;
    }

    return {
      kind,
      mode: "path-reference",
      telegramFileId: payload.file_id,
      telegramFileUniqueId: payload.file_unique_id ?? null,
      fileName: typeof payload.file_name === "string" ? payload.file_name : null,
      mimeType: typeof payload.mime_type === "string" ? payload.mime_type : null,
      fileSize: parseFiniteNumber(payload.file_size),
      sourceMessageId: parseFiniteNumber(message?.message_id),
      mediaGroupId: message?.media_group_id ?? null
    };
  }

  return null;
}

export function hasSupportedAttachment(message) {
  return Boolean(attachmentDescriptorFromMessage(message));
}

function sanitizeSegment(value, fallback = "attachment") {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || fallback;
}

function sanitizeExtension(value) {
  const extension = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "");

  if (!extension.startsWith(".") || extension === ".") {
    return "";
  }

  return extension;
}

export function buildAttachmentFileName({
  kind,
  fileName,
  filePath,
  sourceMessageId
}) {
  const candidateName =
    (typeof fileName === "string" && fileName.trim()) ||
    (typeof filePath === "string" && path.basename(filePath)) ||
    "";
  const candidateExtension = sanitizeExtension(path.extname(candidateName || filePath || ""));
  const defaultExtension = DEFAULT_ATTACHMENT_EXTENSIONS[kind] ?? "";
  const extension = candidateExtension || defaultExtension;
  const fallbackId = sourceMessageId ?? Date.now();

  return `msg${sanitizeSegment(fallbackId, kind)}${extension}`;
}

export function buildAttachmentPrompt(promptText, attachments) {
  const normalizedPrompt = String(promptText ?? "").trim();
  const pathReferences = attachments.filter((attachment) => attachment.mode === "path-reference");

  if (pathReferences.length === 0) {
    return normalizedPrompt;
  }

  const attachmentLines = ["<attachments>"];
  for (const [index, attachment] of pathReferences.entries()) {
    attachmentLines.push(
      `${index + 1}. kind=${attachment.kind} path=${attachment.localPath}`
    );
  }
  attachmentLines.push("</attachments>");

  const attachmentBlock = attachmentLines.join("\n");
  return normalizedPrompt ? `${normalizedPrompt}\n\n${attachmentBlock}` : attachmentBlock;
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
