import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseAutoArgument } from "../auto-mode.js";
import { buildTurnInputMessage } from "../prompt/turn-input.js";
import { TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS } from "../prompt/telegram-output.js";
import {
  cronMatchesDate,
  formatScheduleMinuteKey,
  normalizeSchedule,
  normalizeScheduleName,
  scheduleLookupKey
} from "../schedules.js";
import { toErrorMessage } from "../utils.js";

const SCHEDULE_TICK_INTERVAL_MS = 30_000;

function scheduleUsageText() {
  return [
    "Usage:",
    "/schedule list",
    "/schedule add <name> <auto>",
    "<cron>",
    "",
    "<prompt>",
    "/schedule pause <name>",
    "/schedule resume <name>",
    "/schedule delete <name>",
    "/schedule run <name>",
    "",
    "Auto levels: low, medium, high"
  ].join("\n");
}

function parseScheduleCommandArgs(args) {
  const trimmed = String(args ?? "").trim();
  if (!trimmed) {
    return { subcommand: null };
  }

  const [subcommand] = trimmed.split(/\s+/, 1);
  const remainder = trimmed.slice(subcommand.length).trimStart();
  return {
    subcommand: subcommand.toLowerCase(),
    remainder
  };
}

function formatScheduleOutput(name, text) {
  return `[schedule: ${name}]\n\n${text}`;
}

export class ScheduleService {
  constructor({
    botConfig,
    configStore,
    createCodexRun,
    sessionFor,
    sendCodexOutput,
    log
  }) {
    this.botConfig = botConfig;
    this.configStore = configStore;
    this.createCodexRun = createCodexRun;
    this.sessionFor = sessionFor;
    this.sendCodexOutput = sendCodexOutput;
    this.log = log;
    this.scheduleTriggerHistory = new Map();
    this.scheduleTimer = null;
  }

  schedulesForChat(chatId) {
    return (this.botConfig.schedules ?? []).filter((schedule) => schedule.chatId === Number(chatId));
  }

  findSchedule(chatId, name) {
    const targetKey = scheduleLookupKey(chatId, name);
    return (this.botConfig.schedules ?? []).find(
      (schedule) => scheduleLookupKey(schedule.chatId, schedule.name) === targetKey
    );
  }

  async persistSchedules(nextSchedules) {
    await this.configStore.patchBotConfig(this.botConfig.name, { schedules: nextSchedules });
    this.botConfig.schedules = nextSchedules;
  }

  scheduleHistoryKey(schedule) {
    return scheduleLookupKey(schedule.chatId, schedule.name);
  }

  markScheduleCreated(schedule) {
    this.scheduleTriggerHistory.set(
      this.scheduleHistoryKey(schedule),
      formatScheduleMinuteKey(new Date())
    );
  }

  formatScheduleList(chatId) {
    const schedules = this.schedulesForChat(chatId)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    if (schedules.length === 0) {
      return "No schedules for this chat.";
    }

    return [
      "Schedules for this chat:",
      ...schedules.map(
        (schedule) =>
          `- ${schedule.name}: ${schedule.enabled ? "on" : "paused"}, ${schedule.auto}, ${schedule.cron}`
      )
    ].join("\n");
  }

  async handleList(session) {
    await session.sendText(this.formatScheduleList(session.chatId));
  }

  parseScheduleAddPayload(remainder) {
    const normalizedRemainder = String(remainder ?? "").trimStart();
    if (!normalizedRemainder) {
      throw new Error(scheduleUsageText());
    }

    const headerNewlineIndex = normalizedRemainder.indexOf("\n");
    if (headerNewlineIndex < 0) {
      throw new Error(scheduleUsageText());
    }

    const header = normalizedRemainder.slice(0, headerNewlineIndex).trim();
    const headerParts = header.split(/\s+/).filter(Boolean);
    if (headerParts.length !== 2) {
      throw new Error(scheduleUsageText());
    }

    const [nameToken, autoToken] = headerParts;
    const name = normalizeScheduleName(nameToken);
    const auto = parseAutoArgument(autoToken);
    if (auto === null) {
      throw new Error("Unknown auto level. Use low, medium, or high.");
    }

    const body = normalizedRemainder.slice(headerNewlineIndex + 1).trimStart();
    const firstNewlineIndex = body.indexOf("\n");
    if (firstNewlineIndex < 0) {
      throw new Error(scheduleUsageText());
    }

    const cron = body.slice(0, firstNewlineIndex).trim();
    const prompt = body.slice(firstNewlineIndex + 1).trim();
    if (!cron || !prompt) {
      throw new Error(scheduleUsageText());
    }

    return { name, auto, cron, prompt };
  }

  async handleAdd(session, remainder) {
    let schedule;
    try {
      const payload = this.parseScheduleAddPayload(remainder);
      schedule = normalizeSchedule(
        {
          ...payload,
          chatId: session.chatId,
          enabled: true
        },
        "schedule"
      );
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    if (this.findSchedule(session.chatId, schedule.name)) {
      await session.sendText(`Schedule ${schedule.name} already exists for this chat.`);
      return;
    }

    const nextSchedules = [...(this.botConfig.schedules ?? []), schedule];
    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return;
    }

    this.markScheduleCreated(schedule);
    await session.sendText(
      `Schedule ${schedule.name} added with auto ${schedule.auto} and cron ${schedule.cron}.`
    );
  }

  async updateSchedule(session, name, patch) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return null;
    }

    const existing = this.findSchedule(session.chatId, normalizedName);
    if (!existing) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return null;
    }

    const nextSchedule = normalizeSchedule(
      {
        ...existing,
        ...patch
      },
      "schedule"
    );
    const nextSchedules = (this.botConfig.schedules ?? []).map((candidate) =>
      this.scheduleHistoryKey(candidate) === this.scheduleHistoryKey(existing) ? nextSchedule : candidate
    );

    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return null;
    }

    return nextSchedule;
  }

  async handlePause(session, name) {
    const schedule = await this.updateSchedule(session, name, { enabled: false });
    if (!schedule) {
      return;
    }

    await session.sendText(`Schedule ${schedule.name} paused.`);
  }

  async handleResume(session, name) {
    const schedule = await this.updateSchedule(session, name, { enabled: true });
    if (!schedule) {
      return;
    }

    await session.sendText(`Schedule ${schedule.name} resumed.`);
  }

  async handleDelete(session, name) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    const existing = this.findSchedule(session.chatId, normalizedName);
    if (!existing) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return;
    }

    const nextSchedules = (this.botConfig.schedules ?? []).filter(
      (candidate) =>
        this.scheduleHistoryKey(candidate) !== this.scheduleHistoryKey(existing)
    );
    try {
      await this.persistSchedules(nextSchedules);
    } catch (error) {
      await session.sendText(`Failed to persist schedule: ${toErrorMessage(error)}`);
      return;
    }

    this.scheduleTriggerHistory.delete(this.scheduleHistoryKey(existing));
    await session.sendText(`Schedule ${existing.name} deleted.`);
  }

  async runSchedule(schedule) {
    const session = this.sessionFor(schedule.chatId);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-relay-schedule-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const run = this.createCodexRun({
      workdir: session.botConfig.workdir,
      threadId: null,
      message: buildTurnInputMessage({ promptText: schedule.prompt, attachments: [] }),
      outputLastMessagePath: outputPath,
      ephemeral: true,
      autoMode: schedule.auto,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      developerInstructions: TELEGRAM_OUTPUT_DEVELOPER_INSTRUCTIONS,
      onEvent: async () => {},
      onStdErr: (chunk) => {
        const message = chunk.trim();
        if (message) {
          this.log(`${schedule.chatId}: schedule ${schedule.name} stderr: ${message}`);
        }
      }
    });

    try {
      await run.done;
      const lastMessage = (await fs.readFile(outputPath, "utf8")).trim();
      if (!lastMessage) {
        throw new Error("No final agent message returned.");
      }
      await this.sendCodexOutput(
        schedule.chatId,
        formatScheduleOutput(schedule.name, lastMessage)
      );
    } catch (error) {
      await this.sendCodexOutput(
        schedule.chatId,
        formatScheduleOutput(schedule.name, `failed: ${toErrorMessage(error)}`)
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  launchScheduleRun(schedule) {
    void this.runSchedule(schedule).catch((error) => {
      this.log(
        `${schedule.chatId}: schedule ${schedule.name} failed unexpectedly: ${toErrorMessage(error)}`
      );
    });
  }

  async handleRun(session, name) {
    let normalizedName;
    try {
      normalizedName = normalizeScheduleName(name, "schedule name");
    } catch (error) {
      await session.sendText(toErrorMessage(error));
      return;
    }

    const schedule = this.findSchedule(session.chatId, normalizedName);
    if (!schedule) {
      await session.sendText(`Schedule ${normalizedName} was not found for this chat.`);
      return;
    }

    this.launchScheduleRun(schedule);
    await session.sendText(`Schedule ${schedule.name} started.`);
  }

  async handleCommand(session, args) {
    const parsed = parseScheduleCommandArgs(args);
    switch (parsed.subcommand) {
      case "list":
        await this.handleList(session);
        return;
      case "add":
        await this.handleAdd(session, parsed.remainder);
        return;
      case "pause":
        await this.handlePause(session, parsed.remainder);
        return;
      case "resume":
        await this.handleResume(session, parsed.remainder);
        return;
      case "delete":
        await this.handleDelete(session, parsed.remainder);
        return;
      case "run":
        await this.handleRun(session, parsed.remainder);
        return;
      default:
        await session.sendText(scheduleUsageText());
    }
  }

  startLoop() {
    if (this.scheduleTimer) {
      return;
    }

    const tick = async () => {
      try {
        await this.tickSchedules();
      } catch (error) {
        this.log(`schedule tick failed: ${toErrorMessage(error)}`);
      }
    };

    this.scheduleTimer = setInterval(() => {
      void tick();
    }, SCHEDULE_TICK_INTERVAL_MS);
    void tick();
  }

  stopLoop() {
    if (!this.scheduleTimer) {
      return;
    }

    clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async tickSchedules(now = new Date()) {
    const minuteKey = formatScheduleMinuteKey(now);
    for (const schedule of this.botConfig.schedules ?? []) {
      if (!schedule.enabled || !cronMatchesDate(schedule.cron, now)) {
        continue;
      }

      const historyKey = this.scheduleHistoryKey(schedule);
      if (this.scheduleTriggerHistory.get(historyKey) === minuteKey) {
        continue;
      }

      this.scheduleTriggerHistory.set(historyKey, minuteKey);
      this.launchScheduleRun(schedule);
    }
  }
}
