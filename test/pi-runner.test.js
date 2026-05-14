import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { buildPiArgs } from "../src/cli_adapter/pi/args.js";
import {
  detectPiSandboxFlagSupport,
  resetPiFeatureDetectionCache,
  startPiRun
} from "../src/cli_adapter/pi/runner.js";
import { ATTACHMENT_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../src/chat_adapter/output-instructions.js";

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
    "readonly",
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
    "on",
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
    "off",
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
  const fakePiPath = path.join(tempDir, "pi");
  await fs.mkdir(workdir);
  await fs.writeFile(
    fakePiPath,
    `#!/usr/bin/env node
if (process.argv.includes("-h")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
`,
    "utf8"
  );
  await fs.chmod(fakePiPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
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

    assert.deepEqual(JSON.parse(chunks.join("").trim()), {
      args: [
        "-p",
        "--mode",
        "json",
        "--sandbox",
        "readonly",
        "hello"
      ],
      cwd: await fs.realpath(workdir)
    });
  } finally {
    process.env.PATH = originalPath;
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport returns false when pi help does not expose the extension flag", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-detect-"));
  const fakePiPath = path.join(tempDir, "pi");
  await fs.writeFile(
    fakePiPath,
    `#!/usr/bin/env node
process.stdout.write("Options:\\n  --mode <mode>\\n");
`,
    "utf8"
  );
  await fs.chmod(fakePiPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport(), false);
  } finally {
    process.env.PATH = originalPath;
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPiSandboxFlagSupport caches sandbox support per workdir", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-pi-detect-cwd-"));
  const fakePiPath = path.join(tempDir, "pi");
  const workdirWithoutFlag = path.join(tempDir, "without-flag");
  const workdirWithFlag = path.join(tempDir, "with-flag");
  await fs.mkdir(workdirWithoutFlag);
  await fs.mkdir(workdirWithFlag);
  await fs.writeFile(
    fakePiPath,
    `#!/usr/bin/env node
if (process.cwd().endsWith("with-flag")) {
  process.stdout.write("Options:\\n  --sandbox <value>\\n");
} else {
  process.stdout.write("Options:\\n  --mode <mode>\\n");
}
`,
    "utf8"
  );
  await fs.chmod(fakePiPath, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ""}`;
  resetPiFeatureDetectionCache();

  try {
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithFlag }), true);
    assert.equal(detectPiSandboxFlagSupport({ cwd: workdirWithoutFlag }), false);
  } finally {
    process.env.PATH = originalPath;
    resetPiFeatureDetectionCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
