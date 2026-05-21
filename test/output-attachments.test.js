import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOutput,
  parseOutputSegments
} from "../src/chat_adapter/common/output-attachments.js";

test("parseOutputSegments returns a single text segment when no control block exists", () => {
  assert.deepEqual(parseOutputSegments("plain text"), [
    {
      kind: "text",
      text: "plain text"
    }
  ]);
});

test("parseOutputSegments parses a valid XML block in the middle of text", () => {
  assert.deepEqual(
    parseOutputSegments(
      [
        "Before",
        "<attachments>",
        '<attachment path="./artifacts/chart.png" />',
        "</attachments>",
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
          "<attachments>",
          '<attachment path="./artifacts/chart.png" />',
          "</attachments>"
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

test("parseOutputSegments parses multiple XML blocks in source order", () => {
  const segments = parseOutputSegments(
    [
      "Start",
      "<attachments>",
      '<attachment path="./one.png" />',
      "</attachments>",
      "Middle",
      "<attachments>",
      '<attachment path="./two.pdf" kind="document" />',
      "</attachments>",
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

test("parseOutputSegments decodes XML attributes and accepts filename aliases", () => {
  const parsed = parseOutputSegments(
    [
      "<attachments>",
      '<attachment path="./reports/a&amp;b.pdf" kind="document" filename="A &quot;B&quot;.pdf" />',
      '<attachment path=\'./images/cat&apos;s.png\' fileName=\'Cat&apos;s.png\' />',
      "</attachments>"
    ].join("\n")
  );

  assert.equal(parsed[0].kind, "attachment_block");
  assert.deepEqual(parsed[0].entries, [
    {
      path: "./reports/a&b.pdf",
      kind: "document",
      rawKind: "document",
      fileName: 'A "B".pdf',
      error: null
    },
    {
      path: "./images/cat's.png",
      kind: "photo",
      rawKind: null,
      fileName: "Cat's.png",
      error: null
    }
  ]);
});

test("parseOutputSegments leaves malformed XML blocks visible as text", () => {
  const rawText = [
    "<attachments>",
    '<attachment path="./report.pdf">',
    "</attachments>"
  ].join("\n");

  assert.deepEqual(parseOutputSegments(rawText), [
    {
      kind: "text",
      text: rawText
    }
  ]);
});

test("parseOutputSegments records entry errors inside valid XML blocks", () => {
  const parsed = parseOutputSegments(
    [
      "<attachments>",
      '<attachment kind="document" />',
      '<attachment path="./bad.bin" kind="bad" />',
      "</attachments>"
    ].join("\n")
  );

  assert.equal(parsed[0].kind, "attachment_block");
  assert.deepEqual(parsed[0].entries, [
    {
      path: null,
      kind: "document",
      rawKind: "document",
      fileName: null,
      error: "path is required"
    },
    {
      path: "./bad.bin",
      kind: null,
      rawKind: "bad",
      fileName: null,
      error: 'unsupported kind "bad"'
    }
  ]);
});

test("parseOutput normalizes valid entries and keeps block text out of the plain-text result", () => {
  const parsed = parseOutput(
    [
      "Before",
      "<attachments>",
      '<attachment path="./chart.png" />',
      '<attachment kind="bad" path="./bad.bin" />',
      "</attachments>",
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
