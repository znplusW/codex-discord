# Setup guide

**English** | [简体中文](SETUP.zh-CN.md) | [Project overview](README.md)

This guide installs the channel-per-conversation fork on a machine that already has access to the working directories you want Codex to use.

## 1. Prepare Codex and Node.js

Install Node.js 20 or newer and the Codex CLI, then sign in:

```bash
node --version
codex --version
codex login
codex login status
```

The bot uses this local Codex login. Do not add an OpenAI API key to `.env` for the normal setup.

## 2. Create a Discord application

1. Open <https://discord.com/developers/applications> and create an application.
2. Open **Bot**, create the bot user, and copy its token.
3. Enable **Message Content Intent** and save.
4. Open **OAuth2 → URL Generator**.
5. Select the scopes `bot` and `applications.commands`.
6. Grant: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Use Application Commands, Manage Channels, and Manage Threads.
7. Open the generated URL and add the bot to your server.

Administrator and Manage Roles are not required. The bot creates private conversation categories and preserves each channel's permission overwrites when moving it between active, archived, and deleted categories.

## 3. Copy Discord IDs

Enable **Discord Settings → Advanced → Developer Mode**. Copy:

- the server ID for `DISCORD_GUILD_ID`;
- your user ID for `ALLOWED_USER_IDS`.

Multiple allowed users can be separated with commas. Everyone who is not in this list is rejected even if Discord permissions let them see a channel.

## 4. Install

### Release asset

Download and extract a `.zip` or `.tar.gz` from [Releases](https://github.com/znplusW/codex-discord/releases), then run:

```bash
./install-release.sh
```

The release contains prebuilt JavaScript. The installer verifies Node/Codex, installs production dependencies, and creates `.env` from the example without overwriting an existing `.env`.

### Source checkout

```bash
git clone https://github.com/znplusW/codex-discord.git
cd codex-discord
./install.sh
```

## 5. Configure `.env`

```env
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=123456789012345678
ALLOWED_USER_IDS=111111111111111111
BASE_PROJECT_DIR=/absolute/path/for/new_conversations
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=false
```

`BASE_PROJECT_DIR` is the working directory used for conversations created from Discord. Conversations imported with `/sessions` keep their original working directory. Use an absolute path that the local account running the bot can access.

Never commit `.env`. The repository and release builder exclude tokens, databases, logs, uploads, and local runtime files.

## 6. Start

For a foreground check:

```bash
npm start
```

On macOS:

```bash
./mac-start.sh
./mac-start.sh --status
```

On Linux:

```bash
./linux-start.sh
./linux-start.sh --status
```

The first successful startup registers 16 commands and creates a private `CodeX` category plus the default `#助理` channel. Send a normal message in the channel to test the connection.

## 7. Recommended first checks

1. Run `/status` and confirm the default conversation appears.
2. Send `Reply only: connected` in `#助理`.
3. Run `/sessions`, create a named conversation, and confirm a same-name channel appears.
4. Run `/model` without parameters and confirm the model and reasoning menus appear.
5. Run `/exit` in a finished test conversation before opening the same conversation in another local client.

## 8. Updating

Back up `.env` and `data.db` before replacing an installation. A release upgrade should preserve those two local files while replacing source/build files and reinstalling dependencies:

```bash
npm ci --omit=dev
```

Restart the platform service after the replacement. Database migrations run automatically on startup.

## 9. Troubleshooting

### Slash commands do not appear

- Confirm the bot was invited with `applications.commands`.
- Confirm `DISCORD_GUILD_ID` is the intended server.
- Restart the bot and check for `Registered 16 slash commands` in the log.
- Fully restart the Discord mobile app if it still caches an old command list.

### Normal messages get no response

- Enable Message Content Intent in the Discord developer portal.
- Check that your user ID is in `ALLOWED_USER_IDS`.
- Use a managed conversation channel under `CodeX`.
- Confirm the machine remains logged in, awake, online, and signed in to Codex.

### Channel creation or moves fail

Grant Manage Channels. The bot does not need Administrator or Manage Roles. Manage Threads is used for migration and retained thread flows.

### Archive/delete reports an active writer

Another Codex application still owns that conversation. `/exit` releases only this bot's writer. Exit the application that owns the conversation; the confirmed lifecycle request remains pending and retries in the background. Discord state is changed only after Codex state is verified.

### Imported history is incomplete

The first import includes up to 20 recent visible rounds. Run `/sync history` for each earlier page. Internal reasoning and tool logs are intentionally excluded.
