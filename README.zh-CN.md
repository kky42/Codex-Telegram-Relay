# AnyAgent

[English](./README.md) | [简体中文](./README.zh-CN.md)

把 Codex、Claude 或 Pi 直接带到 Telegram 里用。

AnyAgent in Telegram

![AnyAgent in Telegram](./assets/example.png)

## 为什么选 AnyAgent

- 直接复用你本地已经配好的 CLI agent 和配置，在 Telegram 私聊里继续用，无需迁移。
- 支持 streaming events 实时输出，agent 当前状态随时可见。
- 完整的 slash commands，让聊天里的体验接近本地 CLI。
- 只注入 7 行附件协议，低侵入，尽量保留原生 agent 的行为和性能。

## 快速开始

全局安装 AnyAgent：

```bash
npm install -g @kky42/anyagent
```

先用 [BotFather](https://t.me/BotFather) 创建一个 Telegram bot，然后创建 AnyAgent profile：

```bash
anyagent add main codex
```

编辑生成的配置文件：

```bash
~/.anyagent/agents/main/config.json
```

填入 Telegram bot username、bot token、允许访问的 Telegram username，以及本地 workdir。

启动 relay：

```bash
anyagent
```

打开你的 Telegram bot，发送：

```text
/status
```

## 配置

每个 profile 都位于 `~/.anyagent/agents/<profile-name>/`。

最小配置示例：

```json
{
  "profile": {
    "cli": "codex",
    "workdir": "/Users/you/projects",
    "auto": "medium",
    "model": "default",
    "reasoningEffort": "default"
  },
  "bindings": {
    "telegram": {
      "allowedUsernames": ["your-telegram-username"],
      "bots": [
        {
          "username": "your_bot_username",
          "token": "YOUR_TELEGRAM_BOT_TOKEN"
        }
      ]
    }
  }
}
```

重要字段：

| 字段 | 含义 |
| --- | --- |
| `profile.cli` | 要运行的本地 agent CLI：`codex`、`claude` 或 `pi`。 |
| `profile.workdir` | agent 使用的本地工作目录。必须是已存在的绝对路径或 `~/...`。 |
| `profile.auto` | agent 执行动作时的权限等级：`low`、`medium` 或 `high`。 |
| `profile.model` | 可选的模型覆盖配置。使用 `default` 表示沿用 CLI 默认值。 |
| `profile.reasoningEffort` | 可选的 reasoning 覆盖配置。使用 `default` 表示沿用 CLI 默认值。 |
| `allowedUsernames` | 允许使用这个 bot 的 Telegram username。 |
| `bots[].token` | BotFather 提供的 Telegram bot token。 |

如果你不知道自己的 Telegram username，先给 bot 发送任意消息。未授权回复里会显示需要加入配置的标准化 username。

## Telegram 命令

| 命令 | 用途 |
| --- | --- |
| `/status` | 查看当前状态、CLI、workdir、配置、context length 和排队消息。 |
| `/cli` | 查看或切换当前 CLI。 |
| `/workdir` | 查看或切换当前工作目录。 |
| `/auto` | 查看或切换权限等级。 |
| `/model` | 查看或切换模型覆盖配置。 |
| `/reasoning` | 查看或切换 reasoning effort。 |
| `/abort` | 停止当前运行，并清空排队消息。 |
| `/new` | 为当前聊天启动一个新的 agent session。 |
| `/reset` | 从磁盘重新加载配置，并清除当前聊天的覆盖配置。 |
| `/clear_cache` | 删除当前聊天的附件缓存。 |

示例：

```text
/cli claude
/workdir ~/projects/my-app
/auto high
/model default
/reasoning high
```

## 使用 PM2 持久部署

如果希望 AnyAgent 常驻后台运行，可以全局安装 AnyAgent 并用 PM2 管理：

```bash
npm install -g @kky42/anyagent pm2
pm2 start anyagent --name anyagent
pm2 save
```

常用 PM2 命令：

```bash
pm2 status
pm2 logs anyagent
pm2 restart anyagent
pm2 stop anyagent
```

更新 AnyAgent 并重启 relay：

```bash
npm install -g @kky42/anyagent@latest
pm2 restart anyagent
pm2 save
```

## 说明和限制

- 仅支持 Telegram 私聊。
- relay 启动时会丢弃停止期间收到的消息。
- 支持的附件类型：照片、文档、视频、音频、语音消息和动画。
- 超过 20 MB 的附件会被拒绝。
- 通过 slash command 修改的配置只影响当前 Telegram chat。
- 本地配置和运行时文件位于 `~/.anyagent/`。

## 从 codex-telegram-relay 迁移

包名和本地运行目录已经变更。

如果需要保留旧配置，请移动到：

```bash
~/.anyagent/agents/<profile-name>/config.json
```
