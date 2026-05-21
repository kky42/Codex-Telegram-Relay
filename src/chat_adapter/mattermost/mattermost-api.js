import fs from "node:fs/promises";
import path from "node:path";

import WebSocket from "ws";

import { toErrorMessage } from "../../utils.js";

export class MattermostApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MattermostApiError";
    this.status = options.status ?? null;
    this.id = options.id ?? null;
    this.requestId = options.requestId ?? null;
  }
}

function normalizeServerUrl(serverUrl) {
  const normalized = String(serverUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("Mattermost serverUrl must be a non-empty URL.");
  }
  return normalized;
}

function normalizeWebSocketUrl(serverUrl) {
  const url = new URL(normalizeServerUrl(serverUrl));
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported Mattermost server protocol: ${url.protocol}`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v4/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requestHeaders(token, headers = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...headers
  };
}

function websocketOpen(socket) {
  return new Promise((resolve, reject) => {
    const addListener = (name, handler) => {
      if (typeof socket.addEventListener === "function") {
        socket.addEventListener(name, handler, { once: true });
      } else if (typeof socket.once === "function") {
        socket.once(name, handler);
      } else if (typeof socket.on === "function") {
        socket.on(name, handler);
      }
    };
    const removeListener = (name, handler) => {
      if (typeof socket.removeEventListener === "function") {
        socket.removeEventListener(name, handler);
      } else if (typeof socket.off === "function") {
        socket.off(name, handler);
      } else if (typeof socket.removeListener === "function") {
        socket.removeListener(name, handler);
      }
    };
    const cleanup = () => {
      removeListener("open", handleOpen);
      removeListener("error", handleError);
      removeListener("close", handleClose);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (event) => {
      cleanup();
      reject(new MattermostApiError(`Mattermost WebSocket failed to open: ${event?.message ?? "connection error"}`));
    };
    const handleClose = () => {
      cleanup();
      reject(new MattermostApiError("Mattermost WebSocket closed before opening"));
    };

    addListener("open", handleOpen);
    addListener("error", handleError);
    addListener("close", handleClose);
    if (socket.readyState === 1) {
      cleanup();
      resolve();
    } else if (socket.readyState === 2 || socket.readyState === 3) {
      cleanup();
      reject(new MattermostApiError("Mattermost WebSocket closed before opening"));
    }
  });
}

export class MattermostWebSocketClient {
  constructor({
    serverUrl,
    token,
    WebSocketImpl = globalThis.WebSocket ?? WebSocket,
    logger = () => {}
  }) {
    if (!WebSocketImpl) {
      throw new Error("Global WebSocket is not available. Use Node.js 22+ or provide WebSocketImpl.");
    }

    this.url = normalizeWebSocketUrl(serverUrl);
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.socket = null;
    this.sequence = 1;
    this.onEvent = null;
    this.eventQueue = Promise.resolve();
    this.closed = false;
  }

  async connect({ onEvent, onClient } = {}) {
    this.onEvent = onEvent ?? null;
    this.closed = false;
    this.socket = new this.WebSocketImpl(this.url);
    this.addSocketListener("message", (event) => this.handleMessage(event));
    this.addSocketListener("error", (event) => {
      this.logger(`websocket error: ${event?.message ?? "connection error"}`);
    });
    onClient?.(this);
    if (this.closed) {
      throw new MattermostApiError("Mattermost WebSocket closed before opening");
    }
    await websocketOpen(this.socket);
    if (this.closed) {
      throw new MattermostApiError("Mattermost WebSocket closed before opening");
    }
    this.authenticate();
    return this;
  }

  addSocketListener(name, handler) {
    if (typeof this.socket?.addEventListener === "function") {
      this.socket.addEventListener(name, handler);
      return;
    }
    if (typeof this.socket?.on === "function") {
      this.socket.on(name, handler);
    }
  }

  authenticate() {
    this.sendAction("authentication_challenge", {
      token: this.token
    });
  }

  handleMessage(event) {
    const raw =
      typeof event?.data === "string"
        ? event.data
        : Buffer.isBuffer(event)
          ? event.toString("utf8")
          : typeof event === "string"
            ? event
            : "";
    if (!raw) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      this.logger(`invalid websocket JSON: ${toErrorMessage(error)}`);
      return;
    }

    if (payload.event && this.onEvent) {
      this.eventQueue = this.eventQueue
        .then(() => this.onEvent(payload))
        .catch((error) => {
          this.logger(`websocket event handler failed: ${toErrorMessage(error)}`);
        });
    }
  }

  sendAction(action, data = {}) {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }

    this.socket.send(JSON.stringify({
      seq: this.sequence++,
      action,
      data
    }));
    return true;
  }

  sendTyping({ channelId, rootId = null }) {
    return this.sendAction("user_typing", {
      channel_id: channelId,
      parent_id: rootId ?? ""
    });
  }

  close() {
    this.closed = true;
    this.socket?.close?.();
    this.socket = null;
  }
}

export class MattermostApi {
  constructor({
    serverUrl,
    token,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket ?? WebSocket,
    logger = () => {}
  }) {
    if (!fetchImpl) {
      throw new Error("Global fetch is not available. Node.js 20+ is required.");
    }

    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
    this.apiBaseUrl = `${this.serverUrl}/api/v4`;
  }

  requestUrl(apiPath) {
    const normalizedPath = String(apiPath ?? "").startsWith("/")
      ? apiPath
      : `/${apiPath}`;
    return `${this.apiBaseUrl}${normalizedPath}`;
  }

  async request(method, apiPath, options = {}) {
    const headers = requestHeaders(this.token, options.headers);
    let body = options.body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== "string") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }

    const response = await this.fetch(this.requestUrl(apiPath), {
      method,
      headers,
      body,
      signal: options.signal
    });

    return this.parseResponse(method, apiPath, response, options);
  }

  async parseResponse(method, apiPath, response, options = {}) {
    if (options.raw) {
      if (!response.ok) {
        throw new MattermostApiError(
          `Mattermost ${method} ${apiPath} failed with status ${response.status}`,
          { status: response.status }
        );
      }
      return response;
    }

    let body = null;
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    } else {
      const text = await response.text();
      body = text ? { message: text } : null;
    }

    if (!response.ok) {
      throw new MattermostApiError(
        body?.message || `Mattermost ${method} ${apiPath} failed with status ${response.status}`,
        {
          status: response.status,
          id: body?.id ?? null,
          requestId: body?.request_id ?? null
        }
      );
    }

    return body;
  }

  getMe(options = {}) {
    return this.request("GET", "/users/me", options);
  }

  getUser(userId, options = {}) {
    return this.request("GET", `/users/${userId}`, options);
  }

  createPost({ channelId, message, rootId = null, fileIds = [] }, options = {}) {
    const payload = {
      channel_id: channelId
    };
    const normalizedMessage = String(message ?? "");
    if (normalizedMessage) {
      payload.message = normalizedMessage;
    }
    if (rootId) {
      payload.root_id = rootId;
    }
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      payload.file_ids = fileIds;
    }
    return this.request("POST", "/posts", { ...options, body: payload });
  }

  updatePost({ postId, message }, options = {}) {
    return this.request("PUT", `/posts/${postId}`, {
      ...options,
      body: {
        id: postId,
        message: String(message ?? "")
      }
    });
  }

  deletePost({ postId }, options = {}) {
    return this.request("DELETE", `/posts/${postId}`, options);
  }

  getPost(postId, options = {}) {
    return this.request("GET", `/posts/${postId}`, options);
  }

  getChannel(channelId, options = {}) {
    return this.request("GET", `/channels/${channelId}`, options);
  }

  getThread(postId, options = {}) {
    return this.request("GET", `/posts/${postId}/thread`, options);
  }

  getFileInfo(fileId, options = {}) {
    return this.request("GET", `/files/${fileId}/info`, options);
  }

  async uploadFile({ channelId, filePath, fileName = null }, options = {}) {
    const body = await fs.readFile(filePath);
    const formData = new FormData();
    formData.append("channel_id", channelId);
    formData.append(
      "files",
      new Blob([body]),
      fileName || path.basename(String(filePath ?? "")) || "attachment"
    );
    return this.request("POST", "/files", { ...options, body: formData });
  }

  async downloadFile(fileId, options = {}) {
    const response = await this.request("GET", `/files/${fileId}`, { ...options, raw: true });

    if (!response.body || typeof response.body.getReader !== "function") {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (Number.isFinite(options.maxBytes) && buffer.length > options.maxBytes) {
        throw new MattermostApiError(`Mattermost file exceeds ${options.maxBytes} bytes`, {
          status: 413
        });
      }
      return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (Number.isFinite(options.maxBytes) && totalBytes > options.maxBytes) {
        throw new MattermostApiError(`Mattermost file exceeds ${options.maxBytes} bytes`, {
          status: 413
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  connectWebSocket({ onEvent, onClient } = {}) {
    const client = new MattermostWebSocketClient({
      serverUrl: this.serverUrl,
      token: this.token,
      WebSocketImpl: this.WebSocketImpl,
      logger: this.logger
    });
    return client.connect({ onEvent, onClient });
  }
}

export function postFromWebSocketEvent(event) {
  const rawPost = event?.data?.post;
  if (isObject(rawPost)) {
    return rawPost;
  }
  if (typeof rawPost === "string" && rawPost.trim()) {
    try {
      const parsed = JSON.parse(rawPost);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
