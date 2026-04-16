import path from "node:path";

import { SUPPORTED_ATTACHMENT_KINDS } from "./attachments.js";

export const TELEGRAM_ATTACHMENTS_BLOCK_OPEN = "<telegram-attachments>";
export const TELEGRAM_ATTACHMENTS_BLOCK_CLOSE = "</telegram-attachments>";

const OUTBOUND_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const OUTBOUND_ANIMATION_EXTENSIONS = new Set([".gif"]);
const OUTBOUND_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const OUTBOUND_AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac"]);
const OUTBOUND_VOICE_EXTENSIONS = new Set([".ogg", ".opus"]);

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function inferAttachmentKind(filePath) {
  const extension = path.extname(String(filePath ?? "")).toLowerCase();

  if (OUTBOUND_IMAGE_EXTENSIONS.has(extension)) {
    return "photo";
  }

  if (OUTBOUND_ANIMATION_EXTENSIONS.has(extension)) {
    return "animation";
  }

  if (OUTBOUND_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }

  if (OUTBOUND_AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }

  if (OUTBOUND_VOICE_EXTENSIONS.has(extension)) {
    return "voice";
  }

  return "document";
}

function normalizeAttachmentKind(rawKind, filePath) {
  if (!rawKind) {
    return filePath ? inferAttachmentKind(filePath) : null;
  }

  const normalizedKind = rawKind.toLowerCase();
  return SUPPORTED_ATTACHMENT_KINDS.includes(normalizedKind) ? normalizedKind : null;
}

function normalizeOutboundEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      path: null,
      kind: null,
      rawKind: null,
      fileName: null,
      error: "entry must be an object"
    };
  }

  const filePath = normalizeOptionalString(entry.path);
  const rawKind = normalizeOptionalString(entry.kind ?? entry.type);
  const normalizedKind = normalizeAttachmentKind(rawKind, filePath);
  const fileName = normalizeOptionalString(entry.fileName ?? entry.filename);

  if (!filePath) {
    return {
      path: null,
      kind: normalizedKind,
      rawKind,
      fileName,
      error: "path is required"
    };
  }

  if (rawKind && !normalizedKind) {
    return {
      path: filePath,
      kind: null,
      rawKind,
      fileName,
      error: `unsupported kind "${rawKind}"`
    };
  }

  return {
    path: filePath,
    kind: normalizedKind,
    rawKind,
    fileName,
    error: null
  };
}

function parseAttachmentBlock(rawBlock) {
  const innerText = rawBlock
    .slice(TELEGRAM_ATTACHMENTS_BLOCK_OPEN.length, rawBlock.length - TELEGRAM_ATTACHMENTS_BLOCK_CLOSE.length)
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(innerText);
  } catch {
    return null;
  }

  const isObjectRecord =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!Array.isArray(parsed) && !isObjectRecord) {
    return null;
  }

  const entries = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) =>
    normalizeOutboundEntry(entry)
  );

  return {
    kind: "attachment_block",
    rawText: rawBlock,
    entries
  };
}

function pushTextSegment(segments, text) {
  if (!text) {
    return;
  }

  segments.push({
    kind: "text",
    text
  });
}

export function parseTelegramOutputSegments(text) {
  const rawText = String(text ?? "");
  const segments = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const blockStart = rawText.indexOf(TELEGRAM_ATTACHMENTS_BLOCK_OPEN, cursor);
    if (blockStart < 0) {
      pushTextSegment(segments, rawText.slice(cursor));
      break;
    }

    const blockClose = rawText.indexOf(
      TELEGRAM_ATTACHMENTS_BLOCK_CLOSE,
      blockStart + TELEGRAM_ATTACHMENTS_BLOCK_OPEN.length
    );
    if (blockClose < 0) {
      pushTextSegment(segments, rawText.slice(cursor));
      break;
    }

    pushTextSegment(segments, rawText.slice(cursor, blockStart));

    const blockEnd = blockClose + TELEGRAM_ATTACHMENTS_BLOCK_CLOSE.length;
    const rawBlock = rawText.slice(blockStart, blockEnd);
    const parsedBlock = parseAttachmentBlock(rawBlock);
    if (parsedBlock) {
      segments.push(parsedBlock);
    } else {
      pushTextSegment(segments, rawBlock);
    }

    cursor = blockEnd;
  }

  return segments;
}

export function parseTelegramOutput(text) {
  const segments = parseTelegramOutputSegments(text);

  return {
    text: segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => segment.text)
      .join(""),
    attachments: segments
      .filter((segment) => segment.kind === "attachment_block")
      .flatMap((segment) =>
        segment.entries.filter((entry) => !entry.error).map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          fileName: entry.fileName
        }))
      )
  };
}
