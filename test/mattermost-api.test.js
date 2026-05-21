import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { MattermostApi, MattermostWebSocketClient } from "../src/chat_adapter/mattermost/mattermost-api.js";
import { flush, waitFor } from "./support/async.js";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

test("MattermostApi creates thread posts with Markdown message and file ids", async () => {
  const calls = [];
  const api = new MattermostApi({
    serverUrl: "https://mattermost.example.com/",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body)
      });
      return jsonResponse({ id: "post1" });
    }
  });

  const result = await api.createPost({
    channelId: "channel1",
    message: "| a | b |\n| - | - |",
    rootId: "root1",
    fileIds: ["file1"]
  });

  assert.equal(result.id, "post1");
  assert.deepEqual(calls, [
    {
      url: "https://mattermost.example.com/api/v4/posts",
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json"
      },
      body: {
        channel_id: "channel1",
        message: "| a | b |\n| - | - |",
        root_id: "root1",
        file_ids: ["file1"]
      }
    }
  ]);
});

test("MattermostApi omits empty message when creating attachment-only posts", async () => {
  const calls = [];
  const api = new MattermostApi({
    serverUrl: "https://mattermost.example.com/",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return jsonResponse({ id: "post1" });
    }
  });

  await api.createPost({
    channelId: "channel1",
    message: "",
    rootId: "root1",
    fileIds: ["file1"]
  });

  assert.deepEqual(calls[0], {
    channel_id: "channel1",
    root_id: "root1",
    file_ids: ["file1"]
  });
});

test("MattermostApi updates and deletes posts", async () => {
  const calls = [];
  const api = new MattermostApi({
    serverUrl: "http://localhost:8065",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null
      });
      return jsonResponse({ status: "OK" });
    }
  });

  await api.updatePost({ postId: "post1", message: "final" });
  await api.deletePost({ postId: "post1" });

  assert.deepEqual(calls, [
    {
      url: "http://localhost:8065/api/v4/posts/post1",
      method: "PUT",
      body: {
        id: "post1",
        message: "final"
      }
    },
    {
      url: "http://localhost:8065/api/v4/posts/post1",
      method: "DELETE",
      body: null
    }
  ]);
});

test("MattermostApi uploads local files through multipart form data", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-mm-api-"));
  const filePath = path.join(tempDir, "report.txt");
  await fs.writeFile(filePath, "hello", "utf8");
  const calls = [];
  const api = new MattermostApi({
    serverUrl: "http://localhost:8065",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      return jsonResponse({ file_infos: [{ id: "file1" }] });
    }
  });

  const result = await api.uploadFile({
    channelId: "channel1",
    filePath
  });

  assert.equal(result.file_infos[0].id, "file1");
  assert.equal(calls[0].url, "http://localhost:8065/api/v4/files");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.get("channel_id"), "channel1");
  assert.equal(calls[0].body.getAll("files").length, 1);
});

test("MattermostWebSocketClient authenticates and sends typing actions", async () => {
  const sent = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    removeEventListener(name) {
      this.listeners.delete(name);
    }

    send(raw) {
      sent.push(JSON.parse(raw));
    }
  }

  const client = await new MattermostWebSocketClient({
    serverUrl: "https://mattermost.example.com",
    token: "token",
    WebSocketImpl: FakeWebSocket
  }).connect();

  client.sendTyping({ channelId: "channel1", rootId: "root1" });

  assert.equal(client.url, "wss://mattermost.example.com/api/v4/websocket");
  assert.deepEqual(sent, [
    {
      seq: 1,
      action: "authentication_challenge",
      data: {
        token: "token"
      }
    },
    {
      seq: 2,
      action: "user_typing",
      data: {
        channel_id: "channel1",
        parent_id: "root1"
      }
    }
  ]);
});

test("MattermostWebSocketClient logs rejected event handlers", async () => {
  const logs = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    removeEventListener(name) {
      this.listeners.delete(name);
    }

    send() {}

    emit(name, event) {
      this.listeners.get(name)?.(event);
    }
  }

  const client = await new MattermostWebSocketClient({
    serverUrl: "https://mattermost.example.com",
    token: "token",
    WebSocketImpl: FakeWebSocket,
    logger: (message) => logs.push(message)
  }).connect({
    onEvent: async () => {
      throw new Error("post failed");
    }
  });

  client.socket.emit("message", {
    data: JSON.stringify({
      event: "posted",
      data: {
        post: "{}"
      }
    })
  });
  await flush();

  assert.match(logs.join("\n"), /websocket event handler failed: post failed/);
});

test("MattermostWebSocketClient processes event handlers in arrival order", async () => {
  const handled = [];
  let releaseFirst;
  const firstEventCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  class FakeWebSocket {
    constructor() {
      this.readyState = 1;
      this.listeners = new Map();
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    removeEventListener(name) {
      this.listeners.delete(name);
    }

    send() {}

    emit(name, event) {
      this.listeners.get(name)?.(event);
    }
  }

  const client = await new MattermostWebSocketClient({
    serverUrl: "https://mattermost.example.com",
    token: "token",
    WebSocketImpl: FakeWebSocket
  }).connect({
    onEvent: async (event) => {
      const eventId = event.data.id;
      handled.push(`start:${eventId}`);
      if (eventId === "first") {
        await firstEventCanFinish;
      }
      handled.push(`end:${eventId}`);
    }
  });

  client.socket.emit("message", {
    data: JSON.stringify({
      event: "posted",
      data: { id: "first" }
    })
  });
  client.socket.emit("message", {
    data: JSON.stringify({
      event: "posted",
      data: { id: "second" }
    })
  });

  await flush();
  assert.deepEqual(handled, ["start:first"]);

  releaseFirst();
  await waitFor(() => handled.length === 4);
  assert.deepEqual(handled, ["start:first", "end:first", "start:second", "end:second"]);
});
