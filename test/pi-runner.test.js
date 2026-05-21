import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildPiArgs } from "../src/cli_adapter/pi/args.js";
import {
  detectPiSandboxFlagSupport,
  resetPiFeatureDetectionCache,
  startPiRun
} from "../src/cli_adapter/pi/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/common/output-instructions.js";
import { createFakeCliCommand } from "./support/fakes.js";

test("buildPiArgs uses print json mode for a fresh session", () => {
  assert.deepEqual(buildPiArgs({
    message: "hello"
  }), [
    "-p",
    "--mode",
    "json",
    "hello"
  ]);
});

test("buildPiArgs resumes an existing session", () => {
  assert.deepEqual(buildPiArgs({
    sessionId: "019e227d-4508-74ed-acd1-9d990c98b99d",
    message: "continue"
  }), [
    "-p",
    "--mode",
    "json",
    "--session",
    "019e227d-4508-74ed-acd1-9d990c98b99d",
    "continue"
  ]);
});

test("buildPiArgs maps auto modes to pi-sandbox flags only when supported", () => {
  assert.deepEqual(buildPiArgs({
    message: "hello",
    autoMode: "low",
    supportsSandboxFlag: true
  }), [
    "-p",
    "--mode",
    "json",
    "--sandbox",
    "read-only",
    "hello"
  ]);

  assert.deepEqual(buildPiArgs({
    message: "hello",
    autoMode: "medium",
    supportsSandboxFlag: true
  }), [
    "-p",
    "--mode",
    "json",
    "--sandbox",
    "workspace-write",
    "hello"
  ]);

  assert.deepEqual(buildPiArgs({
    message: "hello",
    autoMode: "high",
    supportsSandboxFlag: true
  }), [
    "-p",
    "--mode",
    "json",
    "--sandbox",
    "danger-full-access",
    "hello"
  ]);

  assert.deepEqual(buildPiArgs({
    message: "hello",
    autoMode: "high",
    supportsSandboxFlag: false
  }), [
    "-p",
    "--mode",
    "json",
    "hello"
  ]);
});

test("buildPiArgs appends model, thinking, and attachment contract", () => {
  const freshArgs = buildPiArgs({
    message: "hello",
    model: "deepseek/deepseek-v4-flash",
    reasoningEffort: "high",
    developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
  });
  const resumedArgs = buildPiArgs({
    sessionId: "session-123",
    message: "hello",
    developerInstructions: ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS
  });

  assert.deepEqual(freshArgs, [
    "-p",
    "--mode",
    "json",
    "--model",
    "deepseek/deepseek-v4-flash",
    "--thinking",
    "high",
    "--append-system-prompt",
    ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS,
    "hello"
  ]);
  assert.deepEqual(resumedArgs, [
    "-p",
    "--mode",
    "json",
    "--append-system-prompt",
    ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS,
    "--session",
    "session-123",
    "hello"
  ]);
});

test("startPiRun invokes pi from the requested workdir and detects sandbox support", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-args-"));
  const workdir = path.join(tempDir, "workspace");
  await fs.mkdir(workdir);
  await fs.writeFile(path.join(workdir, "cwd-marker.txt"), "ok", "utf8");
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("-h")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  args: process.argv.slice(2),
  cwdBasename: path.basename(process.cwd()),
  hasCwdMarker: fs.existsSync("cwd-marker.txt")
}) + "\\n");
`
  );

  resetPiFeatureDetectionCache();

  try {
    const run = startPiRun({
      workdir,
      message: "hello",
      autoMode: "low"
    });

    const chunks = [];
    run.child.stdout.setEncoding("utf8");
    run.child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
    });

    await run.done;

    const output = JSON.parse(chunks.join("").trim());
    assert.deepEqual(output.args, [
      "-p",
      "--mode",
      "json",
      "--sandbox",
      "read-only",
      "hello"
    ]);
    assert.equal(output.cwdBasename, "workspace");
    assert.equal(output.hasCwdMarker, true);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport returns false when pi help does not expose the extension flag", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-detect-"));
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `process.stdout.write("Options:\\n  --mode <mode>\\n");
`
  );

  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport(), false);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport caches sandbox support per workdir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-detect-cwd-"));
  const workdirWithoutFlag = path.join(tempDir, "without-flag");
  const workdirWithFlag = path.join(tempDir, "with-flag");
  await fs.mkdir(workdirWithoutFlag);
  await fs.mkdir(workdirWithFlag);
  const fakeCommand = await createFakeCliCommand(
    tempDir,
    "pi",
    `if (process.cwd().endsWith("with-flag")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
} else {
  process.stdout.write("Options:\\n  --mode <mode>\\n");
}
`
  );

  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithFlag }), true);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
  } finally {
    fakeCommand.restorePath();
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
