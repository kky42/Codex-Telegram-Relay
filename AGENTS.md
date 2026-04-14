# AGENTS

## Shell Environment

- In this repo, `node`, `npm`, and `npx` come from the `nvm` toolchain.
- In the current Codex terminal environment, these commands are available directly without prepending `source ~/.zshrc`.
- If a future shell session fails to resolve them, use the following fallback:

```bash
source ~/.zshrc >/dev/null 2>&1 && <command>
```

Examples:

```bash
npm test
node --version
npx tsc --noEmit
```

## Telegram Network Notes

- This project calls the Telegram Bot API through Node's `fetch`, so Telegram reachability in the Telegram app does not guarantee reachability from the terminal.
- If `npm start` fails with `TypeError: fetch failed` and the underlying cause is `ECONNRESET` before the TLS handshake to `api.telegram.org`, treat it as a local network or proxy-path issue first, not a bot logic regression.
- In environments that use a local HTTP proxy such as `127.0.0.1:7890`, start the relay with explicit proxy variables when Node is not automatically inheriting the proxy path:

```bash
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm start
```

- This is especially relevant when `api.telegram.org` resolves to a proxy fake-IP range such as `198.18.0.0/15`; in that case, Node may fail unless the proxy variables are set explicitly.

## Secrets And Local Config

- Never commit Telegram bot tokens, local usernames, or any real user identifiers.
- Never commit files from `~/.codex-telegram-relay/`; that directory is local runtime state and config only.
- Keep examples and tests generic. Use placeholders such as `YOUR_TELEGRAM_BOT_TOKEN` and `your-telegram-username`.
- Before committing, scan staged changes for secrets or personal paths and remove them.
