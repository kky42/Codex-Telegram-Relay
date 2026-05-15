import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { cliAdapterFor } from "../src/cli_adapter/index.js";

const AGENTS = ["codex", "claude", "pi"];
const FIRST_MARKER = "ANYAGENT_SMOKE_OK";
const RESUME_MARKER = "ANYAGENT_RESUME_OK";
const DEFAULT_TIMEOUT_MS = 180_000;

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(value);
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

function requireEnv(...names) {
  const value = firstEnv(...names);
  if (!value) {
    throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
  }
  return value;
}

function parseTargets(raw) {
  const value = String(raw || "all").trim().toLowerCase();
  if (!value || value === "all") {
    return AGENTS;
  }
  if (value === "none" || value === "skip") {
    return [];
  }

  const targets = value.split(/[,\s]+/).filter(Boolean);
  for (const target of targets) {
    if (!AGENTS.includes(target)) {
      throw new Error(`Unknown real-agent smoke target: ${target}`);
    }
  }
  return targets;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlKeySegment(value) {
  const text = String(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : tomlString(text);
}

function sanitizeEnvName(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function providerModel(provider, model) {
  return model.includes("/") ? model : `${provider}/${model}`;
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function redactText(text, sensitiveValues) {
  let redacted = String(text);
  for (const value of uniqueValues(sensitiveValues).sort((a, b) => b.length - a.length)) {
    if (value.length < 4) {
      continue;
    }
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

function tail(text, maxLength = 4000) {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(`${filePath}.tmp`, filePath);
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(`${filePath}.tmp`, value, "utf8");
  await fs.rename(`${filePath}.tmp`, filePath);
}

function isolatedHomeEnv(homeDir) {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homeDir, "AppData", "Local")
  };
}

async function prepareCodex(rootDir) {
  const provider = firstEnv("CODEX_PROVIDER_NAME") || "ci";
  const model = requireEnv("CODEX_MODEL", "REAL_AGENT_SMOKE_MODEL");
  const baseUrl = requireEnv("CODEX_PROVIDER_BASE_URL");
  const apiKey = requireEnv("CODEX_PROVIDER_API_KEY");
  const envKey = firstEnv("CODEX_PROVIDER_ENV_KEY") || "CODEX_PROVIDER_API_KEY";
  const wireApi = firstEnv("CODEX_PROVIDER_WIRE_API") || "responses";
  const codexHome = path.join(rootDir, "codex-home");

  await writeText(
    path.join(codexHome, "config.toml"),
    [
      `model = ${tomlString(model)}`,
      `model_provider = ${tomlString(provider)}`,
      'model_reasoning_effort = "low"',
      'disable_response_storage = true',
      "",
      `[model_providers.${tomlKeySegment(provider)}]`,
      `name = ${tomlString(provider)}`,
      `base_url = ${tomlString(baseUrl)}`,
      `wire_api = ${tomlString(wireApi)}`,
      `env_key = ${tomlString(envKey)}`,
      ""
    ].join("\n")
  );

  return {
    model,
    env: {
      CODEX_HOME: codexHome,
      [envKey]: apiKey
    },
    sensitiveValues: [apiKey, baseUrl]
  };
}

async function prepareClaude(rootDir) {
  const homeDir = path.join(rootDir, "claude-home");
  const model = firstEnv("CLAUDE_MODEL", "ANTHROPIC_MODEL", "REAL_AGENT_SMOKE_MODEL");
  const baseUrl = firstEnv("CLAUDE_BASE_URL", "ANTHROPIC_BASE_URL");
  const authToken = firstEnv("CLAUDE_AUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN");
  const apiKey = firstEnv("CLAUDE_API_KEY", "ANTHROPIC_API_KEY");
  const effortLevel = firstEnv("CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT_LEVEL");

  if (!authToken && !apiKey) {
    throw new Error(
      "Missing required environment variable: CLAUDE_AUTH_TOKEN/ANTHROPIC_AUTH_TOKEN or CLAUDE_API_KEY/ANTHROPIC_API_KEY"
    );
  }

  const claudeEnv = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  if (effortLevel) {
    claudeEnv.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
  }
  if (baseUrl) {
    claudeEnv.ANTHROPIC_BASE_URL = baseUrl;
  }
  if (authToken) {
    claudeEnv.ANTHROPIC_AUTH_TOKEN = authToken;
  }
  if (apiKey) {
    claudeEnv.ANTHROPIC_API_KEY = apiKey;
  }
  if (model) {
    claudeEnv.ANTHROPIC_MODEL = model;
    claudeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    claudeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  }

  await writeJson(path.join(homeDir, ".claude", "settings.json"), {
    env: claudeEnv,
    verbose: false
  });

  return {
    model: model || "default",
    env: {
      ...isolatedHomeEnv(homeDir),
      ...claudeEnv
    },
    sensitiveValues: [apiKey, authToken, baseUrl]
  };
}

async function preparePi(rootDir) {
  const provider = requireEnv("PI_PROVIDER");
  const modelId = requireEnv("PI_MODEL", "REAL_AGENT_SMOKE_MODEL");
  const providerEnvKey = `${sanitizeEnvName(provider)}_API_KEY`;
  const apiKey = requireEnv("PI_PROVIDER_API_KEY", providerEnvKey);
  const baseUrl = firstEnv("PI_PROVIDER_BASE_URL");
  const providerApi = firstEnv("PI_PROVIDER_API") || "openai-completions";
  const agentDir = path.join(rootDir, "pi-agent");
  const sessionDir = path.join(rootDir, "pi-sessions");

  await writeJson(path.join(agentDir, "settings.json"), {
    defaultProvider: provider,
    defaultModel: modelId,
    defaultThinkingLevel: "off",
    hideThinkingBlock: true,
    transport: "sse",
    packages: [],
    skills: []
  });

  await writeJson(path.join(agentDir, "auth.json"), {
    [provider]: {
      type: "api_key",
      key: apiKey
    }
  });

  if (baseUrl) {
    await writeJson(path.join(agentDir, "models.json"), {
      providers: {
        [provider]: {
          name: provider,
          baseUrl,
          apiKey: "PI_PROVIDER_API_KEY",
          authHeader: true,
          api: providerApi,
          models: [
            {
              id: modelId,
              name: modelId,
              api: providerApi,
              baseUrl,
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 4096,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0
              }
            }
          ]
        }
      }
    });
  }

  return {
    model: providerModel(provider, modelId),
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_PROVIDER_API_KEY: apiKey,
      [providerEnvKey]: apiKey,
      PI_TELEMETRY: "0"
    },
    sensitiveValues: [apiKey, baseUrl]
  };
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const key of Object.keys(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = overrides[key];
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForRun(run, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      run.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([run.done, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function runTurn({
  agent,
  adapter,
  workdir,
  message,
  marker,
  sessionId,
  model,
  timeoutMs,
  sensitiveValues
}) {
  const state = {
    sessionId: null,
    messages: [],
    errors: [],
    stderr: ""
  };

  const run = adapter.startRun({
    workdir,
    sessionId,
    message,
    autoMode: "low",
    model,
    reasoningEffort: "default",
    forceKillDelayMs: 1000,
    onStdErr: (chunk) => {
      state.stderr += redactText(chunk, sensitiveValues);
    },
    onEvent: async (event) => {
      for (const action of adapter.eventToActions(event)) {
        if (action.kind === "session_started" && action.sessionId) {
          state.sessionId = action.sessionId;
        } else if (action.kind === "message") {
          state.messages.push(action.text);
        } else if (action.kind === "error") {
          state.errors.push(action.text);
        }
      }
    }
  });

  let result;
  try {
    result = await waitForRun(run, timeoutMs, `${agent} smoke`);
  } catch (error) {
    const message = error?.message || String(error);
    throw new Error(`${message}\nstderr:\n${tail(state.stderr)}`);
  }
  const text = state.messages.join("\n");

  if (!result.sawTerminalEvent) {
    throw new Error(`${agent} did not emit a terminal JSON event. stderr:\n${tail(state.stderr)}`);
  }
  if (state.errors.length > 0) {
    throw new Error(`${agent} emitted error actions:\n${state.errors.join("\n")}\nstderr:\n${tail(state.stderr)}`);
  }
  if (!text.includes(marker)) {
    throw new Error(
      `${agent} did not produce expected marker ${marker}. Messages:\n${tail(text)}\nstderr:\n${tail(state.stderr)}`
    );
  }

  return {
    sessionId: state.sessionId,
    text
  };
}

async function runAgentSmoke(agent, rootDir) {
  const prepare =
    agent === "codex" ? prepareCodex : agent === "claude" ? prepareClaude : preparePi;
  const config = await prepare(path.join(rootDir, agent));
  const adapter = cliAdapterFor(agent);
  const workdir = path.join(rootDir, agent, "workspace");
  const timeoutMs = Number(process.env.REAL_AGENT_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const testResume = boolEnv("REAL_AGENT_SMOKE_RESUME", false);

  await fs.mkdir(workdir, { recursive: true });

  await withEnv(config.env, async () => {
    console.log(`[${agent}] starting first turn`);
    const first = await runTurn({
      agent,
      adapter,
      workdir,
      message: `Reply with exactly ${FIRST_MARKER} and nothing else.`,
      marker: FIRST_MARKER,
      sessionId: null,
      model: config.model,
      timeoutMs,
      sensitiveValues: config.sensitiveValues
    });
    console.log(`[${agent}] first turn ok; session=${first.sessionId ? "yes" : "no"}`);

    if (!testResume) {
      return;
    }
    if (!first.sessionId) {
      throw new Error(`${agent} did not emit a session id, so resume could not be tested`);
    }

    console.log(`[${agent}] starting resume turn`);
    await runTurn({
      agent,
      adapter,
      workdir,
      message: `Reply with exactly ${RESUME_MARKER} and nothing else.`,
      marker: RESUME_MARKER,
      sessionId: first.sessionId,
      model: config.model,
      timeoutMs,
      sensitiveValues: config.sensitiveValues
    });
    console.log(`[${agent}] resume turn ok`);
  });
}

async function main() {
  const targets = parseTargets(process.env.REAL_AGENT_SMOKE_TARGETS);
  if (targets.length === 0) {
    console.log("No real-agent smoke targets selected.");
    return;
  }

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "anyagent-real-smoke-"));
  try {
    for (const agent of targets) {
      await runAgentSmoke(agent, rootDir);
    }
  } finally {
    if (!boolEnv("REAL_AGENT_SMOKE_KEEP_TEMP", false)) {
      await fs.rm(rootDir, { recursive: true, force: true });
    } else {
      console.log(`Keeping smoke temp directory: ${rootDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
