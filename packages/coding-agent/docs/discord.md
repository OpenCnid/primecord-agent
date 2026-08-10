# Discord gateway

Prime Agent can run as a persistent Discord bot backed by the same resident daemon and harness used by the local CLI. Direct messages are private sessions. Server channels and threads use a separate session per user by default, and the mapping survives gateway restarts.

> **Security:** an authorized Discord user can ask Prime Agent to use tools with the permissions of the operating-system user running the gateway. The worker and kernel lifecycle are not a security sandbox. Use a dedicated host account, a fixed working directory, and the narrowest possible Discord allowlists.

## Create the Discord bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
2. On **Bot**, enable the **Message Content Intent**. Enable **Server Members Intent** too if you authorize users by role.
3. On **OAuth2 > URL Generator**, select the `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Send Messages**, **Read Message History**, **Send Messages in Threads**, **Create Public Threads**, and **Add Reactions**. **Embed Links** and **Attach Files** are recommended.
5. Open the generated URL to add the bot to the server. Copy the bot token, but never commit it or place it in a Prime Agent prompt.

The gateway responds to every authorized DM. In servers it requires an explicit mention by default. An eligible mention in a normal text channel starts a thread; later messages in that thread do not need another mention.

## Configure access

The bot fails closed: a token alone does not authorize anyone. Set at least one allowed user, role, or server channel, or explicitly opt into allowing every user.

PowerShell:

```powershell
$env:PRIME_DISCORD_BOT_TOKEN = "your-bot-token"
$env:PRIME_DISCORD_ALLOWED_USERS = "123456789012345678,234567890123456789"
prime-agent gateway discord --cwd D:\work\my-project
```

Bash:

```bash
export PRIME_DISCORD_BOT_TOKEN='your-bot-token'
export PRIME_DISCORD_ALLOWED_USERS='123456789012345678,234567890123456789'
prime-agent gateway discord --cwd /srv/prime-workspace
```

`DISCORD_BOT_TOKEN` is accepted as a CLI compatibility fallback. `PRIME_DISCORD_BOT_TOKEN` takes precedence.

Discord identifiers are strings of decimal digits. Turn on Developer Mode in Discord, then use **Copy User ID**, **Copy Role ID**, or **Copy Channel ID**.

## Environment reference

Lists are comma-separated Discord IDs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIME_DISCORD_BOT_TOKEN` | required | Discord bot token. Removed from the process environment after startup. |
| `PRIME_DISCORD_ALLOWED_USERS` | empty | Users allowed to use messages and commands. |
| `PRIME_DISCORD_ALLOWED_ROLES` | empty | Server roles allowed to use the bot. In DMs, mutual guild memberships are checked. |
| `PRIME_DISCORD_ALLOW_ALL_USERS` | `false` | Explicitly authorize every user. Use with care. |
| `PRIME_DISCORD_ALLOWED_CHANNELS` | empty | Restrict use to these server channels. Threads inherit their parent channel policy. |
| `PRIME_DISCORD_IGNORED_CHANNELS` | empty | Deny these channels; this takes precedence over all allows. |
| `PRIME_DISCORD_FREE_RESPONSE_CHANNELS` | empty | Respond without a bot mention in these channels and their threads. |
| `PRIME_DISCORD_NO_THREAD_CHANNELS` | empty | Reply in place instead of creating a thread. |
| `PRIME_DISCORD_REQUIRE_MENTION` | `true` | Require the bot mention in ordinary server channels. |
| `PRIME_DISCORD_THREAD_REQUIRE_MENTION` | `false` | Require a mention for follow-ups inside bot-owned threads. |
| `PRIME_DISCORD_IGNORE_NO_MENTION` | `true` | Ignore messages that mention another user but not the bot. |
| `PRIME_DISCORD_AUTO_THREAD` | `true` | Create a thread for a qualifying channel mention. |
| `PRIME_DISCORD_REACTIONS` | `true` | Add working, success, and failure reactions when permitted. |
| `PRIME_DISCORD_ALLOW_BOTS` | `none` | Other-bot policy: `none`, `mentions`, or `all`. `none` prevents bot loops. |
| `PRIME_DISCORD_GROUP_SESSIONS_PER_USER` | `true` | Isolate users in shared channels. Set `false` only when a shared transcript is intentional. |
| `PRIME_DISCORD_HISTORY_BACKFILL` | `true` | Include recent pre-mention channel messages as bounded prompt context. |
| `PRIME_DISCORD_HISTORY_BACKFILL_LIMIT` | `50` | Maximum recent messages inspected for initial context; `0` disables it. |
| `PRIME_DISCORD_MAX_ATTACHMENT_BYTES` | `33554432` | Per-file download limit; `0` means unlimited. |
| `PRIME_DISCORD_MAX_ATTACHMENTS` | `5` | Maximum files on one message; `0` disables attachments. |
| `PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS` | `30000` | Attachment download timeout. |
| `PRIME_DISCORD_STREAM_UPDATE_INTERVAL_MS` | `1000` | Minimum delay between streamed Discord edits. |
| `PRIME_DISCORD_REGISTER_COMMANDS` | `true` | Register the gateway's global slash commands at startup. |
| `PRIME_DISCORD_TOOL_PROGRESS` | `true` | Show tool names while work is in progress. Tool arguments and reasoning remain hidden. |
| `PRIME_DISCORD_CWD` | process directory | Fixed working directory for all sessions. `--cwd` takes precedence. |
| `PRIME_DISCORD_SESSION_DIR` | `~/.prime/agent/discord/sessions` | Discord-to-Prime session mapping and transcript root. |
| `PRIME_DISCORD_CACHE_DIR` | `~/.prime/agent/discord/cache` | Temporary inbound attachment cache. |

When both identity and channel allowlists are configured, both checks must pass. An ignored channel always wins. Authorization happens before attachment downloads, thread creation, or Prime session creation.

## Sessions and concurrency

- A DM is isolated by Discord user and DM channel.
- A server channel or thread is isolated by guild, channel, and user unless `PRIME_DISCORD_GROUP_SESSIONS_PER_USER=false`.
- Messages for one session run in order. Different sessions can run concurrently.
- Prime sessions use resident daemon workers. Stopping the gateway detaches from them; restarting the gateway reattaches to active workers or restores their saved transcript.
- `/new` replaces only the current Discord session mapping. `/abort` aborts that session and clears its queued Discord messages.

Use `prime-agent shutdown` only when you intend to stop the resident Prime workers too.

## Commands

The gateway registers these global slash commands:

- `/help` — show the command list.
- `/new` — begin a clean Prime session for this Discord scope.
- `/abort` — abort current work and clear queued messages.
- `/status` — show the session, run state, model, and effort.
- `/compact` — compact the Prime session context.
- `/effort` — change reasoning effort.
- `/model` — select a provider and model ID.

Command authorization uses the same user, role, and channel policy as ordinary messages. Discord may take several minutes to propagate newly registered global commands.

## Attachments and output safety

The gateway accepts only Discord CDN attachment URLs, checks count and byte limits while streaming, detects the actual file type, and stores files under a generated cache name. Images are passed to Prime Agent as image input. Small text files are included inline; other files are exposed to the session as a controlled local cache path and removed after the turn.

Responses are split at Discord's 2,000-character limit with Markdown fences balanced across messages. Generated output cannot create `@everyone`, role, or user notifications because outgoing allowed mentions are disabled.

The bridge handles text, images, and arbitrary inbound files. Discord voice channels and proactive scheduled delivery are not currently bridged.

## Shutdown and diagnostics

Press `Ctrl+C` or send `SIGTERM` for a graceful shutdown. The gateway stops accepting messages, drains active dispatches (aborting after the shutdown timeout), persists mappings, detaches resident sessions, and closes Discord.

If startup fails:

- `Used disallowed intents` means Message Content or the optional Server Members intent is not enabled in the Developer Portal.
- `Missing Access` or `Missing Permissions` means the bot lacks a channel or thread permission listed above.
- No response with no error usually means the message did not meet the allowlist or mention policy.
- Slash-command registration can be disabled with `PRIME_DISCORD_REGISTER_COMMANDS=false` when the bot application cannot manage commands.
