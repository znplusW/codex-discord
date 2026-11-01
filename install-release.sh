#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required: https://nodejs.org"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required; found $(node --version)."
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is required. Install it with: npm install -g @openai/codex"
  exit 1
fi

if [ ! -f dist/index.js ]; then
  echo "This archive does not contain prebuilt dist/index.js. Download a release asset or run npm ci && npm run build."
  exit 1
fi

echo "Installing production dependencies..."
NPM_CONFIG_CACHE="${TMPDIR:-/tmp}/codex-discord-npm-cache" npm ci --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill in Discord IDs and the bot token before starting."
else
  echo "Existing .env preserved."
fi

echo "Installation complete."
echo "Start with: npm start"
echo "macOS background launcher: ./mac-start.sh"
echo "Linux background launcher: ./linux-start.sh"
