# bot-army

bot-army is an npm workspaces monorepo for a fleet of Node.js bots that share common code in `@botarmy/core`.

## Requirements

- Node.js 20 or newer
- npm 9 or newer

## Install

From the repository root, install dependencies with npm:

```sh
npm install
```

Copy `.env.example` to `.env` and fill in any credentials you need.

Mac/Linux:

```sh
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

The `.env` file is local configuration. Never commit `.env` or secrets to the repository.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL for notifications | (empty) |
| `ANTHROPIC_API_KEY` | API key for Anthropic services | (empty) |
| `HEALTHCHECKS_BASE_URL` | Base URL for health check pings | `https://hc-ping.com` |
| `NODE_ENV` | Node.js runtime environment | `development` |

## Run a bot

Run a bot's `start` script from the repository root:

```sh
npm run start -w bots/<bot-name>
```

Each bot workspace should define its own `start` script in its `package.json`.

## Add a bot

Create a directory at `bots/<bot-name>/` and add a `package.json` with a unique package name and a `start` script. Add the bot's implementation in that directory, then run `npm install` from the repository root so npm can link the new workspace. Bots can import shared utilities from `@botarmy/core`.

## Folder layout

```text
.
|-- bots/                 # Individual bot workspaces
|-- packages/
|   `-- core/             # Shared @botarmy/core package
|-- .env.example          # Environment variable template
|-- .gitignore
|-- package.json          # Root npm workspace configuration
`-- README.md
```

This repository uses npm only; do not use pnpm or yarn.