import process from "node:process";

import { BotRuntime } from "./chat_adapter/telegram/bot-runtime.js";
import { ConfigStore } from "./config-store.js";
import { addAgentConfig } from "./config-scaffold.js";
import { loadConfig } from "./config.js";
import { DEFAULT_CONFIG_PATH, toErrorMessage } from "./utils.js";

function printHelp() {
  process.stdout.write(`Usage:
  anyagent [--config /path/to/agents]
  anyagent [--config /path/to/agents] add <agent-name> <cli-name>

Options:
  --config <path>  Use a custom agent config directory
  --help           Show this help

Commands:
  add              Create an agent config under the config directory
`);
}

function parseArgs(argv) {
  let configPath = DEFAULT_CONFIG_PATH;
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { command: "help", configPath };
    }
    if (arg === "--config") {
      configPath = argv[index + 1];
      index += 1;
      if (!configPath) {
        throw new Error("Missing value after --config");
      }
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    return { command: "run", configPath };
  }

  const [command, ...args] = positionals;
  if (command === "add") {
    if (args.length !== 2) {
      throw new Error("Usage: anyagent add <agent-name> <cli-name>");
    }
    return {
      command,
      configPath,
      agentId: args[0],
      cli: args[1]
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runServer(configPath) {
  const config = await loadConfig(configPath);
  const configStore = new ConfigStore(config.configPath);
  const telegramBindings = config.chatBindings.filter((binding) => binding.platform === "telegram");

  if (telegramBindings.length === 0) {
    throw new Error(`No Telegram bots configured under ${config.configPath}.`);
  }

  const runtimes = telegramBindings.map(
    (botConfig) =>
      new BotRuntime({
        botConfig,
        configStore
      })
  );

  const shutdown = async (signal) => {
    process.stderr.write(`Shutting down on ${signal}\n`);
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const results = await Promise.allSettled(runtimes.map((runtime) => runtime.start()));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    throw rejected.reason;
  }

  process.stderr.write(
    `Running ${runtimes.length} Telegram bot${runtimes.length === 1 ? "" : "s"} using ${config.configPath}\n`
  );

  await Promise.all(
    runtimes.map((runtime) =>
      runtime.pollPromise?.catch((error) => {
        throw new Error(`Bot runtime failed: ${toErrorMessage(error)}`);
      })
    )
  );
}

async function addAgent(args) {
  const result = await addAgentConfig({
    agentId: args.agentId,
    cli: args.cli,
    configPath: args.configPath
  });

  process.stdout.write(`Created agent "${result.agentId}" at ${result.configFilePath}\n`);
  process.stdout.write("Edit the Telegram username, token, and allowed usernames before running anyagent.\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "help") {
    printHelp();
    return;
  }

  if (args.command === "add") {
    await addAgent(args);
    return;
  }

  await runServer(args.configPath);
}
