import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { ChatSession } from "../src/chat_adapter/common/chat-session.js";
import { routeCommandOrTurn } from "../src/chat_adapter/common/command-router.js";
import { createControlledRunnerFactory } from "./support/fakes.js";
import { waitFor } from "./support/async.js";

class FakeChatOutput {
  constructor() {
    this.texts = [];
    this.progress = [];
    this.finals = [];
    this.errors = [];
    this.typing = [];
    this.stopTypingCount = 0;
    this.resetCount = 0;
    this.clearProgressCount = 0;
  }

  resetTransientState() {
    this.resetCount += 1;
  }

  async sendText(text, options = {}) {
    this.texts.push({ text, options });
  }

  async sendMessageChunk(rawChunk, options = {}) {
    this.texts.push({ text: rawChunk, options });
    return { id: this.texts.length };
  }

  async editMessageChunk(messageId, rawChunk, options = {}) {
    this.texts.push({ messageId, text: rawChunk, options });
  }

  async sendSplitText(rawText, options = {}) {
    this.texts.push({ text: rawText, options });
    return this.texts.length;
  }

  async renderProgressText(text, options = {}) {
    this.progress.push({ text, options });
  }

  async clearProgressMessage() {
    this.clearProgressCount += 1;
  }

  async renderFinalMessage(text, options = {}) {
    this.finals.push({ text, options });
  }

  async renderErrorText(text, options = {}) {
    this.errors.push({ text, options });
  }

  async sendCodexOutput(text, options = {}) {
    this.texts.push({ text, options });
  }

  startTyping(replyTarget = null) {
    this.typing.push(replyTarget);
  }

  stopTyping() {
    this.stopTypingCount += 1;
  }
}

function buildBindingConfig(overrides = {}) {
  return {
    platform: "testchat",
    bindingId: "workspace-main",
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    ...overrides
  };
}

async function createCommonSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-common-session-"));
  const output = options.output ?? new FakeChatOutput();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const logs = [];
  const session = new ChatSession({
    bindingConfig: options.bindingConfig ?? buildBindingConfig(),
    output,
    configStore: options.configStore,
    logger: (message) => logs.push(message),
    conversationId: options.conversationId ?? "conversation-1",
    cacheRootDir: path.join(tempDir, "cache"),
    createAgentRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: options.resolveContextLength ?? (async () => 3456),
    resolveHomeDir: options.resolveHomeDir
  });

  return { session, output, runnerFactory, logs, tempDir };
}

test("common ChatSession owns queueing, run orchestration, and opaque reply targets", async () => {
  const { session, output, runnerFactory, logs } = await createCommonSession();
  const replyTarget = { channelId: "channel-1", rootId: "post-root" };

  await session.enqueueMessage("first", { replyTarget });

  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.cli, "codex");
  assert.equal(runnerFactory.runs[0].params.workdir, "/tmp/project");
  assert.equal(runnerFactory.runs[0].params.sessionId, null);
  assert.equal(runnerFactory.runs[0].params.autoMode, "medium");
  assert.deepEqual(output.typing, [replyTarget]);

  await session.enqueueMessage("second", { replyTarget });
  assert.equal(session.queue.length, 1);
  assert.deepEqual(output.texts.at(-1), {
    text: "Queued message 1.",
    options: { replyTarget }
  });

  await runnerFactory.runs[0].emit({
    type: "thread.started",
    thread_id: "session-1"
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "tool_call"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "done"
    }
  });
  await runnerFactory.runs[0].emit({
    type: "turn.completed"
  });
  runnerFactory.runs[0].finish();

  await waitFor(() => runnerFactory.runs.length === 2);

  assert.equal(session.sessionId, "session-1");
  assert.equal(session.contextLength, 3456);
  assert.deepEqual(output.progress, [
    {
      text: "tool_call",
      options: { replyTarget }
    }
  ]);
  assert.deepEqual(output.finals, [
    {
      text: "done",
      options: { replyTarget, workdir: "/tmp/project" }
    }
  ]);
  assert.equal(output.clearProgressCount, 1);
  assert.equal(output.stopTypingCount, 1);
  assert.match(logs[0], /starting codex run/);
  assert.equal(runnerFactory.runs[1].params.sessionId, "session-1");
});

test("common ChatSession cache scopes use generic platform and binding ids", async () => {
  const { session } = await createCommonSession({
    bindingConfig: buildBindingConfig({
      platform: "futurechat",
      bindingId: "workspace-a"
    }),
    conversationId: "channel:abc"
  });

  const scope = session.cacheScope();

  assert.equal(scope.agentId, "primary-agent");
  assert.equal(scope.platform, "futurechat");
  assert.equal(scope.bindingId, "workspace-a");
  assert.equal(scope.conversationId, "channel:abc");
  assert.equal(scope.scopeKey, "primary-agent:futurechat:workspace-a:channel:abc");
});

test("common ChatSession reset reloads through generic chat binding config", async () => {
  const nextWorkdir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-common-reset-"));
  const calls = [];
  const configStore = {
    async loadChatBindingConfig(args) {
      calls.push(args);
      return buildBindingConfig({
        agent: {
          id: "primary-agent",
          cli: "claude",
          workdir: nextWorkdir,
          auto: "high",
          model: "gpt-5.4-mini",
          reasoningEffort: "high"
        }
      });
    }
  };
  const { session, output } = await createCommonSession({ configStore });
  await session.handleAuto("low");
  await session.handleModel("default");
  await session.updateSessionId("session-old");
  await session.updateContextLength(1200);

  await session.handleReset({ replyTarget: { channelId: "channel-1" } });

  assert.deepEqual(calls, [
    {
      platform: "testchat",
      agentId: "primary-agent",
      bindingId: "workspace-main"
    }
  ]);
  assert.equal(session.cliAdapter.id, "claude");
  assert.equal(session.workdir, nextWorkdir);
  assert.equal(session.auto, "high");
  assert.equal(session.model, "gpt-5.4-mini");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(session.sessionId, null);
  assert.equal(session.contextLength, null);
  assert.match(output.texts.at(-1).text, /Reset current chat to config defaults/);
  assert.deepEqual(output.texts.at(-1).options, { replyTarget: { channelId: "channel-1" } });
});

test("common command router maps shared commands and treats unknown commands as turns", async () => {
  const calls = [];
  const session = {
    async handleStatus(options) {
      calls.push(["status", options]);
    },
    async handleAuto(args, options) {
      calls.push(["auto", args, options]);
    },
    async enqueueMessage(text, options) {
      calls.push(["turn", text, options]);
    }
  };
  const runtime = {
    async handleClearCache(currentSession, options) {
      calls.push(["clear_cache", currentSession === session, options]);
    }
  };
  const replyTarget = { channelId: "channel-1" };

  await routeCommandOrTurn({ command: "status", session, runtime, replyTarget });
  await routeCommandOrTurn({ command: "auto", args: "high", session, runtime, replyTarget });
  await routeCommandOrTurn({ command: "clear_cache", session, runtime, replyTarget });
  await routeCommandOrTurn({
    command: "unknown",
    text: "/unknown keep as prompt",
    session,
    runtime,
    replyTarget
  });

  assert.deepEqual(calls, [
    ["status", { replyTarget }],
    ["auto", "high", { replyTarget }],
    ["clear_cache", true, { replyTarget }],
    ["turn", "/unknown keep as prompt", { replyTarget }]
  ]);
});
