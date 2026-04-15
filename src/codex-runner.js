import { spawn } from "node:child_process";

import { parseJsonlLine } from "./codex-events.js";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT
} from "./runtime-settings.js";
import { YOLO_DEFAULT } from "./yolo.js";

function buildConfigOverrideArg(key, rawValue) {
  return `${key}=${JSON.stringify(String(rawValue))}`;
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function buildCodexArgs({
  workdir,
  threadId,
  message,
  imagePaths = [],
  yolo = YOLO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT
}) {
  const modeArgs = yolo
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "read-only"];
  const modelArgs = model === DEFAULT_MODEL ? [] : ["--model", model];
  const reasoningArgs =
    reasoningEffort === DEFAULT_REASONING_EFFORT
      ? []
      : ["-c", buildConfigOverrideArg("model_reasoning_effort", reasoningEffort)];

  const baseArgs = [
    "-C",
    workdir,
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...modeArgs,
    ...modelArgs,
    ...reasoningArgs,
    ...imagePaths.flatMap((imagePath) => [`--image=${imagePath}`])
  ];

  if (threadId) {
    return [...baseArgs, "resume", threadId, message];
  }

  return [...baseArgs, message];
}

export function startCodexRun({
  workdir,
  threadId,
  message,
  imagePaths = [],
  yolo = YOLO_DEFAULT,
  model = DEFAULT_MODEL,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  forceKillDelayMs = 3000,
  onEvent = async () => {},
  onStdErr = () => {}
}) {
  const args = buildCodexArgs({
    workdir,
    threadId,
    message,
    imagePaths,
    yolo,
    model,
    reasoningEffort
  });
  const child = spawn("codex", args, {
    // `codex -C <dir>` already selects the agent workdir. Spawning the child process
    // with `cwd` set to protected locations such as iCloud-managed folders can fail
    // on macOS with EPERM before Codex even starts.
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdoutBuffer = "";
  let pending = Promise.resolve();
  let aborted = false;
  let sawTerminalEvent = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (!event) {
        continue;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
        sawTerminalEvent = true;
      }
      pending = pending.then(() => onEvent(event));
    }
  });

  child.stderr.on("data", (chunk) => {
    onStdErr(String(chunk));
  });

  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      if (stdoutBuffer.trim()) {
        const event = parseJsonlLine(stdoutBuffer);
        if (event) {
          if (
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "error"
          ) {
            sawTerminalEvent = true;
          }
          pending = pending.then(() => onEvent(event));
        }
      }

      try {
        await pending;
      } catch (error) {
        reject(error);
        return;
      }

      if (aborted) {
        resolve({ code, signal, aborted: true, sawTerminalEvent });
        return;
      }

      if (code === 0) {
        resolve({ code, signal, aborted: false, sawTerminalEvent });
        return;
      }

      reject(new Error(`codex exited with code ${code}${signal ? ` (signal ${signal})` : ""}`));
    });
  });

  return {
    child,
    done,
    abort() {
      if (aborted || hasChildExited(child)) {
        return;
      }
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!hasChildExited(child)) {
          child.kill("SIGKILL");
        }
      }, forceKillDelayMs).unref();
    }
  };
}
