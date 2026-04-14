import path from "node:path";

import { readJsonFile, writeJsonFileAtomic } from "./utils.js";

function assertConfigShape(rawConfig, configPath) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new Error(`Config root must be a JSON object: ${configPath}`);
  }

  if (!Array.isArray(rawConfig.bots)) {
    throw new Error(`Config must include a bots array: ${configPath}`);
  }
}

export class ConfigStore {
  constructor(configPath) {
    this.configPath = path.resolve(configPath);
    this.writeChain = Promise.resolve();
  }

  async patchBotConfig(botName, patch) {
    const task = this.writeChain.then(async () => {
      const rawConfig = await readJsonFile(this.configPath, null);
      assertConfigShape(rawConfig, this.configPath);

      const botIndex = rawConfig.bots.findIndex((bot) => {
        if (!bot || typeof bot !== "object" || Array.isArray(bot)) {
          return false;
        }
        if (typeof bot.name !== "string") {
          return false;
        }
        return bot.name.trim() === botName;
      });

      if (botIndex < 0) {
        throw new Error(`Bot "${botName}" not found in config ${this.configPath}`);
      }

      const existingBot = rawConfig.bots[botIndex];
      const nextBot = {
        ...existingBot,
        ...patch
      };

      rawConfig.bots[botIndex] = nextBot;
      await writeJsonFileAtomic(this.configPath, rawConfig);
    });

    this.writeChain = task.catch(() => {});
    await task;
  }
}
