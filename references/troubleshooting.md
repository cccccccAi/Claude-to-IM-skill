# Troubleshooting

## Bridge won't start

**Symptoms**: `/claude-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/claude-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists: `ls -la ~/.claude-to-im/config.env`
5. Check logs for startup errors: `/claude-to-im logs`

**Common causes**:

- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/claude-to-im status`

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/claude-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/claude-to-im logs 200`

## Permission timeout

**Symptoms**: Claude Code responds but tool calls (file edits, shell commands) time out after 5 minutes.

**How it works**: When Claude wants to use a tool, the bridge sends **Allow / Deny** buttons to your IM chat (Telegram/Discord) or a text `/perm` prompt (Feishu/QQ). If you don't respond within 5 minutes, the tool call is automatically denied.

**Steps**:

1. Check your IM app — there should be a permission prompt waiting for your response
2. If you see frequent timeouts you missed, consider setting `CTI_AUTO_APPROVE=true` in `~/.claude-to-im/config.env` (only recommended in trusted, access-controlled environments)
3. For Feishu long-connection mode (no webhook), auto-approve may be needed since inline buttons are not supported
4. If the permission prompt never appears in your chat, check logs (`/claude-to-im logs`) for `permission_request` events — the bridge may have failed to send the message

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/claude-to-im status`
2. Restart the daemon to reset memory:
   ```
   /claude-to-im stop
   /claude-to-im start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
