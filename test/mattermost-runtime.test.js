import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { BotRuntime } from "../src/chat_adapter/mattermost/bot-runtime.js";
import { isBotAddressed } from "../src/chat_adapter/mattermost/group-history.js";
import { flush } from "./support/async.js";
import { createControlledRunnerFactory, FakeConfigStore } from "./support/fakes.js";

class FakeMattermostApi {
  constructor() {
    this.posts = [];
    this.updates = [];
    this.deletions = [];
    this.typing = [];
    this.channels = new Map();
    this.users = new Map();
    this.nextPostId = 1;
  }

  async getMe() {
    return { id: "bot-user", username: "relaybot" };
  }

  async getChannel(channelId) {
    return this.channels.get(channelId) ?? { id: channelId, type: "O" };
  }

  async getUser(userId) {
    return this.users.get(userId) ?? { id: userId, username: userId };
  }

  async getPost(postId) {
    return {
      id: postId,
      channel_id: "channel1",
      user_id: "u1",
      message: "root post",
      create_at: 1000,
      file_ids: []
    };
  }

  async createPost(payload) {
    this.posts.push(payload);
    return { id: `bot-post-${this.nextPostId++}` };
  }

  async updatePost(payload) {
    this.updates.push(payload);
    return { id: payload.postId };
  }

  async deletePost(payload) {
    this.deletions.push(payload);
    return { status: "OK" };
  }

  async downloadFile(fileId) {
    return Buffer.from(`file:${fileId}`);
  }

  async getFileInfo(fileId) {
    return {
      id: fileId,
      name: `${fileId}.txt`,
      mime_type: "text/plain",
      size: 12
    };
  }

  async uploadFile() {
    return { file_infos: [{ id: "uploaded-file" }] };
  }
}

async function createRuntime(options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-runtime-"));
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
    groupHistory: { hours: 24, messages: 1000 },
    agent: {
      id: "primary-agent",
      cli: "codex",
      workdir: "/tmp/project",
      auto: "medium",
      model: "default",
      reasoningEffort: "default"
    },
    ...options.botConfig
  };
  const configStore = new FakeConfigStore({ loadedBotConfig: botConfig });
  const runtime = new BotRuntime({
    botConfig,
    botApi,
    configStore,
    createAgentRun: (params) => runnerFactory.createRun(params),
    cacheRootDir
  });
  await runtime.initialize();
  runtime.websocket = {
    sendTyping(payload) {
      botApi.typing.push(payload);
      return true;
    }
  };
  return { runtime, botApi, runnerFactory, cacheRootDir };
}

function postedEvent(post) {
  return {
    event: "posted",
    data: {
      post: JSON.stringify(post)
    }
  };
}

test("Mattermost group mention matching requires the full username", () => {
  assert.equal(isBotAddressed({ message: "@relay please answer" }, "relay"), true);
  assert.equal(isBotAddressed({ message: "(@relay) please answer" }, "relay"), true);
  assert.equal(isBotAddressed({ message: "@relay-helper please answer" }, "relay"), false);
  assert.equal(isBotAddressed({ message: "@relay.foo please answer" }, "relay"), false);
});

test("Mattermost runtime retries user lookup after transient failures", async () => {
  class FlakyMattermostApi extends FakeMattermostApi {
    constructor() {
      super();
      this.getUserCalls = 0;
    }

    async getUser(userId) {
      this.getUserCalls += 1;
      if (this.getUserCalls === 1) {
        throw new Error("temporary user lookup failure");
      }
      return { id: userId, username: "alice" };
    }
  }

  const botApi = new FlakyMattermostApi();
  const { runtime } = await createRuntime({ botApi });

  assert.equal(await runtime.userFor("u1"), null);
  assert.deepEqual(await runtime.userFor("u1"), { id: "u1", username: "alice" });
  assert.equal(botApi.getUserCalls, 2);
});

test("Mattermost runtime closes a pending websocket when stopped during connection setup", async () => {
  class SlowConnectMattermostApi extends FakeMattermostApi {
    constructor() {
      super();
      this.client = {
        socket: { readyState: 0 },
        closeCalls: 0,
        close() {
          this.closeCalls += 1;
          this.socket.readyState = 3;
        }
      };
    }

    connectWebSocket(options = {}) {
      options.onClient?.(this.client);
      return new Promise((resolve, reject) => {
        this.client.close = () => {
          this.client.closeCalls += 1;
          this.client.socket.readyState = 3;
          reject(new Error("closed"));
        };
        setTimeout(() => resolve(this.client), 0);
      });
    }
  }

  const botApi = new SlowConnectMattermostApi();
  const { runtime } = await createRuntime({ botApi });

  await runtime.start();
  await runtime.stop();

  assert.equal(botApi.client.closeCalls, 1);
  assert.equal(runtime.websocket, null);
  assert.equal(runtime.pendingWebSocket, null);
});

test("Mattermost runtime closes a websocket that connects after stop is requested", async () => {
  class DelayedConnectMattermostApi extends FakeMattermostApi {
    connectWebSocket() {
      return new Promise((resolve) => {
        this.resolveConnect = resolve;
      });
    }
  }

  const botApi = new DelayedConnectMattermostApi();
  const client = {
    socket: { readyState: 1 },
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
      this.socket.readyState = 3;
    }
  };
  const { runtime } = await createRuntime({ botApi });

  await runtime.start();
  const stopPromise = runtime.stop();
  botApi.resolveConnect(client);
  await stopPromise;

  assert.equal(client.closeCalls, 1);
  assert.equal(runtime.websocket, null);
});

test("Mattermost runtime treats each direct channel as one session and replies to source thread", async () => {
  const { runtime, botApi, runnerFactory } = await createRuntime();
  botApi.channels.set("dm1", { id: "dm1", type: "D" });
  botApi.users.set("u1", { id: "u1", username: "alice" });

  await runtime.handleEvent(postedEvent({
    id: "post1",
    channel_id: "dm1",
    user_id: "u1",
    message: "hello",
    create_at: 1000,
    file_ids: []
  }));
  await flush();

  assert.equal(runtime.sessions.size, 1);
  assert.equal(runnerFactory.runs.length, 1);
  assert.equal(runnerFactory.runs[0].params.message, "hello");
  runnerFactory.runs[0].finish();
  await flush();

  await runtime.handleEvent(postedEvent({
    id: "post2",
    channel_id: "dm1",
    user_id: "u1",
    root_id: "root1",
    message: "thread hello",
    create_at: 2000,
    file_ids: []
  }));
  await flush();

  assert.deepEqual([...runtime.sessions.keys()], ["dm1"]);
  assert.equal(runnerFactory.runs.length, 2);
  await runnerFactory.runs[1].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "done"
    }
  });
  runnerFactory.runs[1].finish();
  await flush();

  assert.equal(botApi.posts[0].rootId, "root1");
  assert.equal(botApi.posts[0].message, "done");
});

test("Mattermost group channels only trigger on mentions and keep channel session for threads", async () => {
  const { runtime, botApi, runnerFactory } = await createRuntime();
  botApi.channels.set("channel1", { id: "channel1", type: "O" });
  botApi.users.set("u1", { id: "u1", username: "alice" });

  await runtime.handleEvent(postedEvent({
    id: "post1",
    channel_id: "channel1",
    user_id: "u1",
    message: "unaddressed",
    create_at: 1000,
    file_ids: []
  }));
  await flush();
  assert.equal(runnerFactory.runs.length, 0);

  await runtime.handleEvent(postedEvent({
    id: "post2",
    channel_id: "channel1",
    user_id: "u1",
    root_id: "root1",
    message: "@relaybot please answer",
    create_at: 2000,
    file_ids: []
  }));
  await flush();

  assert.deepEqual([...runtime.sessions.keys()], ["channel1"]);
  assert.equal(runnerFactory.runs.length, 1);
  assert.match(runnerFactory.runs[0].params.message, /Context:/);
  assert.match(runnerFactory.runs[0].params.message, /unaddressed/);
  assert.match(runnerFactory.runs[0].params.message, /@relaybot please answer/);
  await runnerFactory.runs[0].emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "group done"
    }
  });
  runnerFactory.runs[0].finish();
  await flush();

  assert.equal(botApi.posts[0].rootId, "root1");
  assert.equal(botApi.posts[0].message, "group done");
});

test("Mattermost group addressed commands use the common command router", async () => {
  const { runtime, botApi, runnerFactory } = await createRuntime();
  botApi.channels.set("channel1", { id: "channel1", type: "O" });
  botApi.users.set("u1", { id: "u1", username: "alice" });

  await runtime.handleEvent(postedEvent({
    id: "post1",
    channel_id: "channel1",
    user_id: "u1",
    message: "@relaybot !status",
    create_at: 1000,
    file_ids: []
  }));
  await flush();

  assert.equal(runnerFactory.runs.length, 0);
  assert.match(botApi.posts[0].message, /running: no/);
});
