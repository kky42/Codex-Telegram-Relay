import path from "node:path";

export const ATTACHMENTS_BLOCK_OPEN = "<attachments>";
export const ATTACHMENTS_BLOCK_CLOSE = "</attachments>";

export const SUPPORTED_OUTBOUND_ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "audio",
  "voice",
  "animation"
];

const OUTBOUND_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const OUTBOUND_ANIMATION_EXTENSIONS = new Set([".gif"]);
const OUTBOUND_VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const OUTBOUND_AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac"]);
const OUTBOUND_VOICE_EXTENSIONS = new Set([".ogg", ".opus"]);
const ATTACHMENT_TAG_PATTERN = /<attachment\b([^<>]*?)\/>/g;
const ATTRIBUTE_PATTERN = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function decodeXmlAttribute(text) {
  const named = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"]
  ]);

  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const key = String(body ?? "").toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      } catch {
        return entity;
      }
    }
    return named.get(key) ?? entity;
  });
}

function parseXmlAttributes(rawAttributes) {
  const attributes = {};
  const raw = String(rawAttributes ?? "");
  let cursor = 0;

  while (cursor < raw.length) {
    if (!raw.slice(cursor).trim()) {
      return attributes;
    }

    ATTRIBUTE_PATTERN.lastIndex = cursor;
    const match = ATTRIBUTE_PATTERN.exec(raw);
    if (!match) {
      return null;
    }

    attributes[match[1]] = decodeXmlAttribute(match[2] ?? match[3] ?? "");
    cursor = ATTRIBUTE_PATTERN.lastIndex;
  }

  return attributes;
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
  return SUPPORTED_OUTBOUND_ATTACHMENT_KINDS.includes(normalizedKind) ? normalizedKind : null;
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
    .slice(ATTACHMENTS_BLOCK_OPEN.length, rawBlock.length - ATTACHMENTS_BLOCK_CLOSE.length);
  const entries = [];
  let cursor = 0;

  ATTACHMENT_TAG_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTACHMENT_TAG_PATTERN.exec(innerText)) !== null) {
    if (innerText.slice(cursor, match.index).trim()) {
      return null;
    }

    const attributes = parseXmlAttributes(match[1]);
    if (!attributes) {
      return null;
    }

    entries.push(normalizeOutboundEntry(attributes));
    cursor = ATTACHMENT_TAG_PATTERN.lastIndex;
  }

  if (innerText.slice(cursor).trim()) {
    return null;
  }

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

export function parseOutputSegments(text) {
  const rawText = String(text ?? "");
  const segments = [];
  let cursor = 0;

  while (cursor < rawText.length) {
    const blockStart = rawText.indexOf(ATTACHMENTS_BLOCK_OPEN, cursor);
    if (blockStart < 0) {
      pushTextSegment(segments, rawText.slice(cursor));
      break;
    }

    const blockClose = rawText.indexOf(
      ATTACHMENTS_BLOCK_CLOSE,
      blockStart + ATTACHMENTS_BLOCK_OPEN.length
    );
    if (blockClose < 0) {
      pushTextSegment(segments, rawText.slice(cursor));
      break;
    }

    pushTextSegment(segments, rawText.slice(cursor, blockStart));

    const blockEnd = blockClose + ATTACHMENTS_BLOCK_CLOSE.length;
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

export function parseOutput(text) {
  const segments = parseOutputSegments(text);

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
