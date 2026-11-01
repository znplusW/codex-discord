# Codex Discord — Channel-per-Conversation Edition

**English** | [简体中文](README.zh-CN.md)

A self-hosted Discord controller for local Codex conversations. This fork turns the Discord channel list into a mobile conversation list: every managed text channel maps permanently to one Codex conversation and its original working directory.

> Modified from [chadingTV/codex-discord](https://github.com/chadingTV/codex-discord). This is an independent community fork and is not an official OpenAI product.

## How it works

On first start, the bot creates a private `CodeX` category and an `#助理` conversation channel. Send a normal message in that channel to continue the same Codex conversation—no mention and no `/sessions` command are required.

- One Discord text channel = one Codex conversation ID.
- Switching Discord channels switches Codex conversations.
- `/sessions` creates a named conversation or imports an existing desktop conversation into a same-name channel.
- A first import mirrors the latest 20 visible conversation rounds. `/sync history` loads up to 20 earlier rounds per request.
- `/model` and `/reasoning` expose model and reasoning-effort menus before sending, with post-send menus retained.
- `/exit` releases only the bot's writer for the current conversation so another local client can take over.
- `/archive`, `/restore`, and `/delete` verify the Codex-side result before moving or deleting a Discord channel.
- `/multi-archive` and `/multi-delete` operate only on currently existing, bound Discord channels and require preview plus confirmation.
- Categories automatically roll over to `CodeX-2`, `CodeX-3`, and so on after Discord's 50-channel category limit.

The bot registers these 16 commands: `/sessions`, `/model`, `/reasoning`, `/sync`, `/exit`, `/archive`, `/restore`, `/delete`, `/multi-archive`, `/multi-delete`, `/status`, `/last`, `/stop`, `/queue`, `/usage`, and `/auto-approve`.

## Differences from upstream

| Upstream `chadingTV/codex-discord` | This fork |
|---|---|
| Register a project channel, then switch the active session inside it | Each managed Discord channel is permanently bound to one Codex conversation |
| `/register` and `/unregister` manage project channels | Private `CodeX` categories and conversation channels are created automatically |
| `/sessions` changes the current session in a shared channel | `/sessions` creates or opens a dedicated conversation channel |
| `/clear-sessions` clears stored sessions | `/multi-delete` and `/multi-archive` provide selectable, confirmed lifecycle operations |
| Basic session controls | Model/reasoning menus, history pagination, `/exit`, verified archive/delete/restore, and desktop-first state reconciliation |

`/register`, `/unregister`, `/switch`, and `/clear-sessions` are intentionally not registered by this fork.

## Requirements

- macOS or Linux for the tested background launchers; Windows launcher files are retained from upstream but this fork's channel lifecycle has not been device-tested on Windows.
- Node.js 20 or newer.
- Codex CLI installed and signed in with `codex login`.
- A Discord application with **Message Content Intent** enabled.
- Bot permissions: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Use Application Commands, Manage Channels, and Manage Threads. Administrator is not required.

## Install from a release

1. Download the `.zip` or `.tar.gz` asset from [Releases](https://github.com/znplusW/codex-discord/releases).
2. Extract it and enter the directory.
3. Run:

```bash
./install-release.sh
```

4. Fill in the generated `.env`:

```env
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id
ALLOWED_USER_IDS=your_discord_user_id
BASE_PROJECT_DIR=/absolute/path/for/new_conversations
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=false
```

5. Start the bot:

```bash
npm start
```

For macOS background service and menu bar setup, run `./mac-start.sh`. Linux users can run `./linux-start.sh`. The release assets include prebuilt JavaScript; installation only installs production dependencies.

## Install from source

```bash
git clone https://github.com/znplusW/codex-discord.git
cd codex-discord
./install.sh
```

Or build manually:

```bash
npm ci
npm test
npm run build
```

See [SETUP.md](SETUP.md) for Discord application setup and operating details.

## Conversation lifecycle and limitations

Codex conversation state is authoritative. The bot checks bound conversations on startup, about every 10 seconds, and before accepting a new task. Desktop-first archive, restore, and confirmed deletion update the matching Discord channel without silently creating a replacement conversation.

An active writer held by another Codex application is a current limitation. If Codex Desktop still owns a conversation, this independent bot process cannot archive or delete it. The confirmed request remains pending and retries after the writer is released; the Discord channel is not moved or deleted before the Codex operation is verified. `/exit` releases the bot's own writer only. Finishing a desktop turn or closing a tab may not release the desktop writer immediately.

History import mirrors visible user/assistant messages. It does not expose internal reasoning or tool logs. Continuous mirroring of messages later added from Codex Desktop is not implemented; resuming the original conversation still uses its complete Codex context.

## Security

- Keep `.env`, the Discord bot token, databases, and logs private. They are excluded from source and release archives.
- Restrict `ALLOWED_USER_IDS` to trusted Discord accounts.
- Use a private Discord category and keep automatic approval off unless you understand the impact.
- The bot uses the local Codex login and does not require an OpenAI API key in `.env`.

## Verification

The initial release passes 270 automated tests, TypeScript type checking, production build, and release-package inspection. Real local app-server tests cover bot-owned archive/delete, external-writer rejection, and successful retry after release. Real Discord API tests covered channel creation, category moves, restoration, and deletion during development.

## License and attribution

Distributed under the repository's [MIT License with Attribution Requirement](LICENSE). The original project is [chadingTV/codex-discord](https://github.com/chadingTV/codex-discord); see [NOTICE.md](NOTICE.md) for modification attribution.
