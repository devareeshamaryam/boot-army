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
| `GOOGLE_SHEET_ID` | Spreadsheet the bots read and write | (empty) |
| `GOOGLE_CREDS_JSON` | Service-account key: path to the .json file, or the JSON itself | `./secrets/google-key.json` |

## Run a bot

Run a bot's `start` script from the repository root:

```sh
npm run start -w bots/<bot-name>
```

Each bot workspace should define its own `start` script in its `package.json`.

## Add a bot

Create a directory at `bots/<bot-name>/` and add a `package.json` with a unique package name and a `start` script. Add the bot's implementation in that directory, then run `npm install` from the repository root so npm can link the new workspace. Bots can import shared utilities from `@botarmy/core`.

## Data storage

All data lives in Google Sheets. Bots keep nothing on local disk: no SQLite files and no `data/` folder. The service account in `GOOGLE_CREDS_JSON` needs edit access to the spreadsheet.

## Folder layout

```text
.
|-- bots/
|   `-- sponsor-licence-scout/   # Daily sponsor register -> Google Sheet + Slack
|       |-- index.js             # Entry point (npm start / npm run dry-run)
|       |-- harvest.js           # Finds and downloads the GOV.UK register CSV
|       |-- sheets.js            # Google Sheets read/write and the diff
|       |-- logs/                # Scheduled-run log (git-ignored)
|       `-- test/
|-- packages/
|   `-- core/                   # Shared @botarmy/core package
|-- secrets/                     # Google service-account key (git-ignored)
|-- .env.example                 # Environment variable template
|-- .gitignore
|-- package.json                 # Root npm workspace configuration
`-- README.md
```

This repository uses npm only; do not use pnpm or yarn.