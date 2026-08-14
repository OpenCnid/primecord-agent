# Discord gateway

Prime Agent can run as a persistent Discord bot backed by the same resident daemon and harness used by the local CLI. Direct messages are private sessions. Server channels and threads use a separate session per user by default, and the mapping survives gateway restarts.

> **Security:** an authorized Discord user can ask Prime Agent to use tools with the permissions of the operating-system user running the gateway. The worker and kernel lifecycle are not a security sandbox. Use a dedicated host account, a fixed working directory, and the narrowest possible Discord allowlists.

## Create the Discord bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
2. On **Bot**, enable the **Message Content Intent**. Enable **Server Members Intent** too if you authorize users by role.
3. On **OAuth2 > URL Generator**, select the `bot` and `applications.commands` scopes.
4. Grant **View Channels**, **Send Messages**, **Read Message History**, **Send Messages in Threads**, **Create Public Threads**, and **Add Reactions**. **Embed Links** and **Attach Files** are recommended.
5. Open the generated URL to add the bot to the server. Copy the bot token, but never commit it or place it in a Prime Agent prompt.

The gateway responds to every authorized DM. In servers it requires an explicit mention by default. With auto-threading enabled, every admitted message in a normal parent channel starts a fresh daughter thread: this includes eligible mentions, free-response channels, and ordinary channels when mentions are disabled. The agent's progress and terminal response stay in that daughter thread. Later messages in the daughter thread continue its session without creating nested threads. If Discord cannot create the daughter thread, the gateway does not run the task or post a fallback response in the parent channel. Use `/thread` with a title to explicitly create a fresh Prime Agent conversation thread without sending an initial prompt.

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

Discord identifiers are strings of decimal digits. Turn on Developer Mode in Discord, then use **Copy User ID**, **Copy Role ID**, **Copy Server ID**, or **Copy Channel ID**.

## Environment reference

Lists are comma-separated Discord IDs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRIME_DISCORD_BOT_TOKEN` | required | Discord bot token. Removed from the process environment after startup. |
| `PRIME_DISCORD_ALLOWED_USERS` | empty | Users allowed to use messages and commands. |
| `PRIME_DISCORD_ALLOWED_ROLES` | empty | Server roles allowed to use the bot. In DMs, mutual guild memberships are checked. |
| `PRIME_DISCORD_ALLOW_ALL_USERS` | `false` | Explicitly authorize every user. Use with care. |
| `PRIME_DISCORD_ALLOWED_GUILDS` | empty | Restrict server traffic to these guilds before evaluating channel policy. DMs are unaffected; this setting does not authorize users by itself. |
| `PRIME_DISCORD_ALLOWED_CHANNELS` | empty | Restrict use to these server channels after the guild filter. Threads inherit their parent channel policy. |
| `PRIME_DISCORD_IGNORED_CHANNELS` | empty | Deny these channels; this takes precedence over all allows. |
| `PRIME_DISCORD_FREE_RESPONSE_CHANNELS` | empty | Respond without a bot mention in these channels and their threads; admitted parent messages start daughter threads when auto-threading is enabled. |
| `PRIME_DISCORD_NO_THREAD_CHANNELS` | empty | Reply in place instead of creating a thread. This explicitly opts those parent channels out of daughter-thread isolation. |
| `PRIME_DISCORD_REQUIRE_MENTION` | `true` | Require the bot mention in ordinary server channels. |
| `PRIME_DISCORD_THREAD_REQUIRE_MENTION` | `false` | Require a mention for follow-ups inside bot-owned threads. |
| `PRIME_DISCORD_IGNORE_NO_MENTION` | `true` | Ignore messages that mention another user but not the bot. |
| `PRIME_DISCORD_AUTO_THREAD` | `true` | Create a fresh daughter thread for every admitted ordinary parent-channel message. |
| `PRIME_DISCORD_REACTIONS` | `true` | Add working, success, and failure reactions when permitted. |
| `PRIME_DISCORD_ALLOW_BOTS` | `none` | Other-bot policy: `none`, `mentions`, or `all`. `none` prevents bot loops. |
| `PRIME_DISCORD_GROUP_SESSIONS_PER_USER` | `true` | Isolate users in shared channels. Set `false` only when a shared transcript is intentional. |
| `PRIME_DISCORD_HISTORY_BACKFILL` | `true` | Include recent pre-mention channel messages as bounded prompt context. |
| `PRIME_DISCORD_HISTORY_BACKFILL_LIMIT` | `50` | Maximum recent messages inspected for initial context; `0` disables it. |
| `PRIME_DISCORD_READ_MAX_MESSAGES` | `50` | Maximum messages returned by one `discord_read` history request; capped at 100. |
| `PRIME_DISCORD_READ_MAX_CONTENT_CHARS` | `4000` | Maximum normalized content characters from one message; capped at 10000. |
| `PRIME_DISCORD_READ_MAX_TOTAL_CONTENT_CHARS` | `12000` | Maximum normalized content characters across one history result; capped at 50000. |
| `PRIME_DISCORD_READ_MAX_ATTACHMENTS` | `10` | Maximum attachment metadata entries returned from one message; capped at 25. |
| `PRIME_DISCORD_MAX_ATTACHMENT_BYTES` | `33554432` | Per-file download limit; `0` means unlimited. |
| `PRIME_DISCORD_MAX_ATTACHMENTS` | `5` | Maximum files on one message; `0` disables attachments. |
| `PRIME_DISCORD_MAX_OUTBOUND_ATTACHMENT_BYTES` | `26214400` | Per-file `MEDIA:` upload limit; `0` means unlimited. |
| `PRIME_DISCORD_MAX_OUTBOUND_ATTACHMENTS` | `5` | Maximum agent-generated `MEDIA:` uploads in one response; `0` disables uploads. |
| `PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS` | `30000` | Attachment download timeout. |
| `PRIME_DISCORD_STREAM_UPDATE_INTERVAL_MS` | `1000` | Minimum delay between streamed Discord edits. |
| `PRIME_DISCORD_PROGRESS_UPDATE_INTERVAL_MS` | `30000` | Interval between general working-status updates during a long-running turn; `0` disables them. |
| `PRIME_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS` | `30000` | Periodic Discord Gateway WebSocket health sample; `0` disables the watchdog. |
| `PRIME_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD` | `3` | Consecutive unhealthy WebSocket samples before a clean supervised restart. |
| `PRIME_DISCORD_GATEWAY_MAX_PING_MS` | `30000` | Maximum accepted Discord Gateway heartbeat latency; `0` disables only the latency threshold. |
| `PRIME_DISCORD_REGISTER_COMMANDS` | `true` | Register the gateway's global slash commands at startup. |
| `PRIME_DISCORD_TOOL_PROGRESS` | `true` | Show general tool-progress updates while work is in progress. IPython calls are described only as workspace steps; arguments and reasoning remain hidden. |
| `PRIME_DISCORD_EXTENSION_UI_TIMEOUT_MS` | `300000` | Maximum time to wait for a Discord response to an extension dialog. |
| `PRIME_DISCORD_CWD` | process directory | Fixed working directory for all sessions. `--cwd` takes precedence. |
| `PRIME_DISCORD_SESSION_DIR` | `~/.prime/agent/discord/sessions` | Discord-to-Prime session mapping and transcript root. |
| `PRIME_DISCORD_CACHE_DIR` | `~/.prime/agent/discord/cache` | Temporary inbound attachment cache. |

When configured, the guild allowlist is checked before channel and identity policy. When both identity and channel allowlists are configured, both checks must pass. An ignored channel always wins after the guild check. Authorization happens before attachment downloads, thread creation, or Prime session creation.

## Sessions and concurrency

- A DM is isolated by Discord user and DM channel.
- A server channel or thread is isolated by guild, channel, and user unless `PRIME_DISCORD_GROUP_SESSIONS_PER_USER=false`.
- Each auto-created daughter thread receives its own session key. Follow-up messages in that daughter reuse its session; the next admitted parent-channel message receives a new daughter and a new session.
- Messages for one session run in order. Different sessions can run concurrently.
- Prime sessions use resident daemon workers. Stopping the gateway detaches from them; restarting the gateway reattaches to active workers or restores their saved transcript. A transient daemon disconnection is retried for up to 24 hours so a long-running Discord turn is not abandoned after the standard one-minute reconnect window.
- `/new` replaces only the current Discord session mapping. `/abort` aborts that session and clears its queued Discord messages.

Use `prime-agent shutdown` only when you intend to stop the resident Prime workers too.

## Permission-scoped Discord reads

Discord-created agent turns expose a `discord_read` tool. It is a gateway capability, not a bot token or a general Discord REST client. It can inspect one canonical message link or read one bounded recent-history page:

- “Inspect `https://discord.com/channels/...`” lets the agent use `action: "message"` with that exact Discord message URL.
- “Read the last 20 messages in this thread” lets the agent use `action: "history", limit: 20` with the current channel or thread.

Every tool call rechecks the initiating user, current guild allowlist, channel policy, thread parent policy, and the user's view permission before Discord message data is fetched. A DM can read only its current DM. A server request can read its current channel or thread; another channel must be in the same guild and have its **parent channel** explicitly listed in `PRIME_DISCORD_ALLOWED_CHANNELS`. Ignored parents always win, and a direct thread allowlist entry never bypasses its parent policy. With no channel allowlist, cross-channel reads are disabled even for otherwise authorized identities.

The tool accepts only `https://discord.com/channels/<guild-or-@me>/<channel>/<message>` URLs with decimal Discord IDs. It rejects query strings, fragments, credentials, ports, malformed links, other guilds, deleted targets, missing permissions, and forbidden targets with stable user-facing errors. History has no cursor or pagination, so it cannot enumerate unrestricted server history.

Returned data is normalized and marked untrusted: IDs, timestamp, basic author fields, truncated text, and bounded attachment metadata only. It never returns raw Discord objects, bot credentials, attachment URLs, embeds, or attachment bytes. The daemon asks the gateway only while an active Discord-originated turn owns the request; background jobs and RLM subagents cannot retain or reuse a caller scope. Existing response paths continue to disable Discord mentions.

## Permission-scoped thread creation

Discord-created agent turns also expose `discord_create_thread` when a user explicitly asks to create a thread in natural language. It accepts only a short title and can create one public thread in the current authorized server text or announcement channel. When invoked from an existing thread, it can create only a sibling under that thread's canonical parent. It cannot select another guild or channel, create nested threads, create threads from DMs, add members, or manage existing channels.

Every call rechecks the initiating user's gateway policy, guild allowlist, parent-channel policy, and Discord permissions to view the channel, send messages, and create public threads. The daemon never receives the bot token; it gets only a bounded request and normalized thread ID, name, and URL. Background jobs and RLM subagents cannot create threads through this capability.

## Commands

The gateway registers these global slash commands:

- `/help` — show the command list.
- `/new` — begin a clean Prime session for this Discord scope.
- `/thread <title>` — create a new Discord thread with a clean Prime Agent session. It is available only in server text and announcement channels.
- `/abort` — abort current work and clear queued messages.
- `/steer <instruction>` — add guidance to the active task at its next safe boundary. Only the user who started the live bridge receipt can steer it, and it never revives an idle session. It does not cancel an in-flight tool call; use `/abort` to stop work.
- `/status` — show the session, run state, model, and effort.
- `/capabilities` — list active tools plus discovered context files, extensions, prompts, skills, themes, and invocable commands.
- `/run` — invoke a discovered extension, prompt-template, or skill command with optional arguments.
- `/compact` — compact the Prime session context.
- `/effort` — change reasoning effort.
- `/model` — select a provider and model ID.

Command authorization uses the same user, role, and channel policy as ordinary messages. Discord may take several minutes to propagate newly registered global commands.

Authorized messages can also use `!prime capabilities` and `!prime run <command> [args]`. The gateway passes discovered commands to Prime Agent without a metadata prefix so extension commands, prompt templates, and skills expand normally. To protect extension UI contents and answers, extension UI is rendered only in bot DMs; server-channel notifications and state are hidden, while a server-channel dialog is cancelled with a prompt to retry privately. In a DM, answer with `!prime respond <value>` or cancel with `!prime cancel`/`!prime abort` so unrelated messages cannot be consumed as dialog input.

Resource discovery uses Prime Agent's normal scopes relative to the fixed gateway working directory. Resources in unrelated repositories are not discovered unless the gateway is started with that repository as `PRIME_DISCORD_CWD`/`--cwd` or the resource is installed in a broader supported scope.

## Attachments and output safety

The gateway accepts only Discord CDN attachment URLs, checks count and byte limits while streaming, detects the actual file type, and stores files under a generated cache name. Images are passed to Prime Agent as image input. Small text files are included inline; other files are exposed to the session as a controlled local cache path and removed after the turn.

Responses are split at Discord's 2,000-character limit with Markdown fences balanced across messages. During each admitted turn, the bridge owns one editable working receipt and refreshes it with a sanitized activity label and measured elapsed duration; it stops that heartbeat before rendering the terminal response. An `ipython` call is shown only as a general workspace step; its code, arguments, output, results, and reasoning remain private. Discord-created sessions receive a bridge/worker contract: the bridge owns lifecycle edits and the delivery attempt, while the worker must finish with one self-contained user-facing terminal report and cannot claim delivery success. If a terminal receipt edit fails, the bridge attempts a standalone terminal-message fallback. Generated output cannot create `@everyone`, role, or user notifications because outgoing allowed mentions are disabled.

Agent responses can upload workspace artifacts using Hermes-compatible `MEDIA:/path/to/file` tags. The tag is removed from the text and the file is uploaded natively; relative paths resolve from `PRIME_DISCORD_CWD`. For safety, resolved files must remain inside that fixed workspace, including after symlink resolution. Uploads use the outbound count and byte limits above; rejected tags leave the text response intact with a delivery notice.

The bridge handles text, images, arbitrary inbound files, and agent-generated media uploads. Discord voice channels and proactive scheduled delivery are not currently bridged.

## Hermes follow-up roadmap

Planned parity work is deliberately separate from the scoped-read capability:

- Native skill commands.
- Interactive clarify UI and proactive home-channel delivery.
- Forum support and reconnect recovery.
- Voice remains explicitly out of scope.

## Shutdown and diagnostics

Press `Ctrl+C` or send `SIGTERM` for a graceful shutdown. The gateway stops accepting messages, drains active dispatches (aborting after the shutdown timeout), persists mappings, detaches resident sessions, and closes Discord.

The bridge samples Discord's actual Gateway WebSocket manager, shard readiness, and heartbeat latency rather than treating REST availability as proof of inbound event delivery. Discord.js handles transient reconnects. After the configured number of unhealthy samples, the bridge drains and exits so its service supervisor can create one fresh client instead of leaving a stale client able to duplicate dispatch.

If startup fails:

- `Used disallowed intents` means Message Content or the optional Server Members intent is not enabled in the Developer Portal.
- `Missing Access` or `Missing Permissions` means the bot lacks a channel or thread permission listed above.
- No response with no error usually means the message did not meet the allowlist or mention policy.
- Slash-command registration can be disabled with `PRIME_DISCORD_REGISTER_COMMANDS=false` when the bot application cannot manage commands.
