export const ALBUM_QUIET_PERIOD_MS = 1500;
export const SUPPORTED_ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "animation"
];

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

export function attachmentSupportText() {
  return SUPPORTED_ATTACHMENT_KINDS.join(", ");
}

export function unsupportedAttachmentMessage() {
  return `Unsupported message type. Supported attachments: ${attachmentSupportText()}.`;
}

export function attachmentDescriptorFromMessage(message) {
  const bestPhoto = preferredPhotoSize(message?.photo ?? []);
  if (bestPhoto) {
    return {
      kind: "photo",
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
