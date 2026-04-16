import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTelegramOutput,
  parseTelegramOutputSegments
} from "../src/output-attachments.js";

test("parseTelegramOutputSegments returns a single text segment when no control block exists", () => {
  assert.deepEqual(parseTelegramOutputSegments("plain text"), [
    {
      kind: "text",
      text: "plain text"
    }
  ]);
});

test("parseTelegramOutputSegments parses a valid block in the middle of text", () => {
  assert.deepEqual(
    parseTelegramOutputSegments(
      [
        "Before",
        "<telegram-attachments>",
        '[{"path":"./artifacts/chart.png"}]',
        "</telegram-attachments>",
        "After"
      ].join("\n")
    ),
    [
      {
        kind: "text",
        text: "Before\n"
      },
      {
        kind: "attachment_block",
        rawText: [
          "<telegram-attachments>",
          '[{"path":"./artifacts/chart.png"}]',
          "</telegram-attachments>"
        ].join("\n"),
        entries: [
          {
            path: "./artifacts/chart.png",
            kind: "photo",
            rawKind: null,
            fileName: null,
            error: null
          }
        ]
      },
      {
        kind: "text",
        text: "\nAfter"
      }
    ]
  );
});

test("parseTelegramOutputSegments parses multiple valid blocks in source order", () => {
  const segments = parseTelegramOutputSegments(
    [
      "Start",
      "<telegram-attachments>",
      '[{"path":"./one.png"}]',
      "</telegram-attachments>",
      "Middle",
      "<telegram-attachments>",
      '[{"path":"./two.pdf","kind":"document"}]',
      "</telegram-attachments>",
      "End"
    ].join("\n")
  );

  assert.equal(segments.length, 5);
  assert.equal(segments[0].kind, "text");
  assert.equal(segments[1].kind, "attachment_block");
  assert.equal(segments[2].kind, "text");
  assert.equal(segments[3].kind, "attachment_block");
  assert.equal(segments[4].kind, "text");
});

test("parseTelegramOutputSegments leaves malformed JSON blocks visible as text", () => {
  const rawText = [
    "<telegram-attachments>",
    '{"path":"./report.pdf"',
    "</telegram-attachments>"
  ].join("\n");

  assert.deepEqual(parseTelegramOutputSegments(rawText), [
    {
      kind: "text",
      text: rawText
    }
  ]);
});

test("parseTelegramOutputSegments leaves invalid top-level shapes visible as text", () => {
  const rawText = [
    "<telegram-attachments>",
    '"not-an-object"',
    "</telegram-attachments>"
  ].join("\n");

  assert.deepEqual(parseTelegramOutputSegments(rawText), [
    {
      kind: "text",
      text: rawText
    }
  ]);
});

test("parseTelegramOutput normalizes valid entries and keeps block text out of the plain-text result", () => {
  const parsed = parseTelegramOutput(
    [
      "Before",
      "<telegram-attachments>",
      '[{"path":"./chart.png"},{"kind":"bad","path":"./bad.bin"}]',
      "</telegram-attachments>",
      "After"
    ].join("\n")
  );

  assert.equal(parsed.text, "Before\n\nAfter");
  assert.deepEqual(parsed.attachments, [
    {
      path: "./chart.png",
      kind: "photo",
      fileName: null
    }
  ]);
});
