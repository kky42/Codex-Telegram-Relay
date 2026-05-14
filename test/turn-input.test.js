import test from "node:test";
import assert from "node:assert/strict";

import { buildTurnInputMessage } from "../src/cli_adapter/turn-input.js";

test("buildTurnInputMessage returns plain prompt when there are no attachments", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "  inspect this  ",
      attachments: []
    }),
    "inspect this"
  );
});

test("buildTurnInputMessage renders all local attachments as XML entries", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "inspect",
      attachments: [
        { kind: "photo", localPath: "/tmp/input.jpg" },
        { kind: "document", localPath: "/tmp/spec.pdf" }
      ]
    }),
    [
      "inspect",
      "",
      "<attachments>",
      '<attachment path="/tmp/input.jpg" kind="photo" />',
      '<attachment path="/tmp/spec.pdf" kind="document" />',
      "</attachments>"
    ].join("\n")
  );
});

test("buildTurnInputMessage escapes attachment XML attributes", () => {
  assert.equal(
    buildTurnInputMessage({
      promptText: "",
      attachments: [
        { kind: 'doc"ument', localPath: '/tmp/a&b/"quoted"<file>.pdf' }
      ]
    }),
    [
      "<attachments>",
      '<attachment path="/tmp/a&amp;b/&quot;quoted&quot;&lt;file&gt;.pdf" kind="doc&quot;ument" />',
      "</attachments>"
    ].join("\n")
  );
});
