# AGENTS.md

Codex Discord controller workspace notes.

## Overview

This project runs a Discord bot that controls local Codex threads through the Codex app-server and local `~/.codex` storage. Each managed Discord text channel under CodeX maps permanently to one Codex thread ID and its original working directory.

## Commands

```bash
npm run dev
npm run build
npm start
npm test
./install.sh
./mac-start.sh
./linux-start.sh
win-start.bat
```

## Key Paths

- `src/index.ts`: entrypoint
- `src/bot/`: Discord client, commands, handlers
- `src/codex/`: Codex app-server client, session manager, thread storage helpers
- `src/db/`: SQLite persistence
- `src/security/`: auth and rate limiting
- `src/utils/`: config and i18n

## Notes

- Attachment downloads are stored under `.codex-uploads/` inside the registered project.
- Existing Codex threads are discovered from local `~/.codex` state.
- Slash commands and Discord UI are the primary control surface; do not reintroduce Claude SDK dependencies.
- Bootstrap the private CodeX category and assistant once; never recreate intentionally archived/deleted assistant chats on restart.
- /sessions creates named chats or imports existing desktop chats. Fixed channels cannot be rebound; /register, /unregister, /switch and /clear-sessions are not registered.
- Lifecycle changes must be verified in Codex before moving/deleting Discord channels. Desktop-first deletion retains history; uncertain reads never prove deletion.
- /multi-delete and /multi-archive only offer live Discord channels with stored bindings, and require selection plus confirmation.
