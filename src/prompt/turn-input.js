import { buildAttachmentPrompt } from "../attachments.js";

/**
 * @typedef {object} Turn
 * @property {string} promptText
 * @property {any[]} attachments
 */

/**
 * @param {Turn} turn
 */
export function buildTurnInputMessage(turn) {
  return buildAttachmentPrompt(turn?.promptText ?? "", turn?.attachments ?? []);
}
