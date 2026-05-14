/**
 * @typedef {object} Turn
 * @property {string} promptText
 * @property {any[]} attachments
 */

function escapeXmlAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildAttachmentPrompt(promptText, attachments) {
  const normalizedPrompt = String(promptText ?? "").trim();
  const localAttachments = attachments.filter((attachment) => attachment?.localPath);

  if (localAttachments.length === 0) {
    return normalizedPrompt;
  }

  const attachmentLines = ["<attachments>"];
  for (const attachment of localAttachments) {
    attachmentLines.push(
      `<attachment path="${escapeXmlAttribute(attachment.localPath)}" kind="${escapeXmlAttribute(attachment.kind)}" />`
    );
  }
  attachmentLines.push("</attachments>");

  const attachmentBlock = attachmentLines.join("\n");
  return normalizedPrompt ? `${normalizedPrompt}\n\n${attachmentBlock}` : attachmentBlock;
}

/**
 * @param {Turn} turn
 */
export function buildTurnInputMessage(turn) {
  return buildAttachmentPrompt(turn?.promptText ?? "", turn?.attachments ?? []);
}
