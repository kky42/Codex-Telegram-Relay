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

function kindFromMimeType(mimeType) {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.startsWith("image/gif")) {
    return "animation";
  }
  if (normalized.startsWith("image/")) {
    return "photo";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return "document";
}

export function attachmentSupportText() {
  return "files";
}

export function unsupportedAttachmentMessage() {
  return `Unsupported message type. Supported attachments: ${attachmentSupportText()}.`;
}

export function attachmentDescriptorsFromPost(post) {
  const fileIds = Array.isArray(post?.file_ids) ? post.file_ids : [];
  const metadataFiles = Array.isArray(post?.metadata?.files) ? post.metadata.files : [];
  const fileMetaById = new Map(metadataFiles.filter((file) => file?.id).map((file) => [file.id, file]));

  return fileIds
    .map((fileId) => {
      const meta = fileMetaById.get(fileId) ?? {};
      return {
        kind: kindFromMimeType(meta.mime_type),
        mattermostFileId: fileId,
        fileName: typeof meta.name === "string" ? meta.name : null,
        mimeType: typeof meta.mime_type === "string" ? meta.mime_type : null,
        fileSize: parseFiniteNumber(meta.size),
        sourceMessageId: post?.id ?? null
      };
    })
    .filter((descriptor) => descriptor.mattermostFileId);
}

export function hasSupportedAttachment(post) {
  return attachmentDescriptorsFromPost(post).length > 0;
}
