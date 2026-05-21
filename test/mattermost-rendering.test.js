import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ChatSession } from "../src/chat_adapter/mattermost/chat-session.js";
import { createControlledRunnerFactory, FakeConfigStore } from "./support/fakes.js";
import { flush } from "./support/async.js";

class FakeMattermostApi {
  constructor({ failEditOnce = false } = {}) {
    this.failEditOnce = failEditOnce;
    this.posts = [];
    this.updates = [];
    this.deletions = [];
    this.uploads = [];
    this.downloads = [];
    this.nextPostId = 1;
  }

  async createPost(payload) {
    this.posts.push(payload);
    return { id: `post-${this.nextPostId++}` };
  }

  async updatePost(payload) {
    if (this.failEditOnce) {
      this.failEditOnce = false;
      throw new Error("edit denied");
    }
    this.updates.push(payload);
    return { id: payload.postId };
  }

  async deletePost(payload) {
    this.deletions.push(payload);
    return { status: "OK" };
  }

  async uploadFile(payload) {
    this.uploads.push(payload);
    return { file_infos: [{ id: `file-${this.uploads.length}` }] };
  }

  async downloadFile(fileId) {
    this.downloads.push(fileId);
    return Buffer.from(`file:${fileId}`);
  }

  async getFileInfo(fileId) {
    return {
      id: fileId,
      name: `${fileId}.txt`,
      mime_type: "text/plain",
      size: 8
    };
  }
}

async function createMattermostSession(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-session-"));
  const cacheRootDir = path.join(tempDir, "cache");
  const botApi = options.botApi ?? new FakeMattermostApi();
  const runnerFactory = options.runnerFactory ?? createControlledRunnerFactory();
  const botConfig = {
    platform: "mattermost",
    bindingId: "localhost:relaybot",
    serverUrl: "http://localhost:8065",
    username: "relaybot",
    token: "token",
    allowedUsernames: ["alice"],
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    }
  };
  const configStore = new FakeConfigStore({ loadedBotConfig: botConfig });
  const session = new ChatSession({
    botConfig,
    botApi,
    configStore,
    logger: () => {},
    channelId: "channel1",
    cacheRootDir,
    createAgentRun: (params) => runnerFactory.createRun(params),
    resolveContextLength: async () => 21300
  });
  session.startTyping = () => {};
  session.stopTyping = () => {};
  return { session, botApi, runnerFactory, tempDir };
}

test("Mattermost renderer sends raw Markdown and edits progress into final text", async () => {
  const { session, botApi, runnerFactory } = await createMattermostSession();

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];
  await run.emit({
    type: "item.started",
    item: {
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "| a | b |\n| - | - |\n| 1 | 2 |"
    }
  });
  run.finish();
  await flush();
  await flush();

  assert.deepEqual(botApi.posts, [
    {
      channelId: "channel1",
      message: ":hourglass_flowing_sand: **Running:** reasoning",
      rootId: null
    }
  ]);
  assert.deepEqual(botApi.updates, [
    {
      postId: "post-1",
      message: "| a | b |\n| - | - |\n| 1 | 2 |"
    }
  ]);
});

test("Mattermost renderer degrades to a new post if final edit fails", async () => {
  const botApi = new FakeMattermostApi({ failEditOnce: true });
  const { session, runnerFactory } = await createMattermostSession({ botApi });

  await session.enqueueMessage("first");
  const run = runnerFactory.runs[0];
  await run.emit({
    type: "item.started",
    item: {
      type: "reasoning",
      status: "in_progress"
    }
  });
  await run.emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "done"
    }
  });
  run.finish();
  await flush();
  await flush();

  assert.equal(botApi.posts.length, 2);
  assert.equal(botApi.posts[1].message, "done");
});

test("Mattermost renderer uploads outbound attachment blocks", async () => {
  const { session, botApi } = await createMattermostSession();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-output-"));
  const filePath = path.join(tempDir, "report.txt");
  await fs.writeFile(filePath, "report", "utf8");

  await session.renderFinalMessage(`<attachments>\n<attachment path="${filePath}" kind="document" />\n</attachments>`, {
    workdir: tempDir,
    replyTarget: { rootId: "root1" }
  });

  assert.equal(botApi.uploads.length, 1);
  assert.equal(botApi.uploads[0].channelId, "channel1");
  assert.equal(botApi.uploads[0].filePath, filePath);
  assert.deepEqual(botApi.posts, [
    {
      channelId: "channel1",
      message: "",
      rootId: "root1",
      fileIds: ["file-1"]
    }
  ]);
});

test("Mattermost session stages inbound file attachments", async () => {
  const { session, botApi } = await createMattermostSession();

  const attachments = await session.stageAttachmentsFromPosts([
    {
      id: "post1",
      channel_id: "channel1",
      message: "see file",
      file_ids: ["file1"]
    }
  ]);

  assert.equal(botApi.downloads[0], "file1");
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].kind, "document");
  assert.equal(attachments[0].fileName, "file1--mpost1.txt");
  assert.match(await fs.readFile(attachments[0].localPath, "utf8"), /file:file1/);
});
