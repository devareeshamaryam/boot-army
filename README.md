# Sponsor Licence Scout

Each run downloads the Home Office register of licensed sponsors (Worker and Temporary Worker) from GOV.UK. It updates the `Sponsors` tab in a Google Sheet: new sponsors are appended, and sponsors that have disappeared are marked Revoked. It then posts one summary message to Slack.

The bot runs **once and exits**: code `0` on success, code `1` on failure. Scheduling is external. In production, Cloud Scheduler triggers it as a Google Cloud Run Job.

## Requirements

- Node.js 22 or newer (`googleapis` requires Node 22)
- npm (do not use pnpm or yarn)

## Setup

```sh
npm ci
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Fill in `.env`, then put the Google service-account key at `credentials/service-account.json`, or set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to its path. The service account needs edit access to the spreadsheet. `.env`, `credentials/` and `service-account*.json` are git-ignored and docker-ignored. Never commit them.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | One full run: update the Sheet, post to Slack, then exit (`node src/index.js --once`) |
| `npm run dry-run` | Download the register and compute the diff, then print what would change and the Slack message. **Nothing is written to the Sheet and nothing is sent to Slack.** |
| `npm run harvest` | Only find and download the register CSV, then print its source and row count |
| `npm test` | Unit tests (no network, no Google) |

## Behaviour

- **Safety check:** if today's CSV has fewer than 50% of the sponsors marked Active in the Sheet, the download is treated as broken. The Sheet is left unchanged and a `WARNING` message goes to Slack.
- **Failure alert:** any error posts `FAILED - Sponsor Licence Scout: <reason>` to Slack and exits with code 1.
- **Healthchecks.io:** if `HEALTHCHECKS_BASE_URL` and a check UUID are set, the run pings start, success and fail.

## Environment variables

See `.env.example` for the full list, with a comment on each variable. Required: `GOOGLE_SHEET_ID`, plus a Slack webhook (`SLACK_WEBHOOK_URL` or `SLACK_WEBHOOK_URL_SPONSORS`). `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` defaults to `./credentials/service-account.json`. Relative paths are resolved from the project root.

## Docker / Cloud Run Job

```sh
docker build -t sponsor-licence-scout .
docker run --rm --env-file .env \
  -v "$PWD/credentials:/app/credentials:ro" sponsor-licence-scout
```

The image never contains `.env` or the key. On Cloud Run:

- Pass the other variables as env vars, or as Secret Manager secrets exposed as env vars.
- Mount the key as a Secret Manager volume, for example at `/secrets/sa/key.json`.
- Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to the mounted path.

## Folder layout

```text
.
|-- src/
|   |-- index.js        # Entry point: one run, then exit
|   |-- harvest.js      # Finds and downloads the GOV.UK register CSV
|   |-- sheets.js       # Google Sheets read/write and the diff
|   |-- companies.js    # Companies House links for the Slack message
|   `-- core/           # Shared helpers: http, logger, match, slack, health
|-- test/               # node:test unit tests
|-- credentials/        # Service-account key (git-ignored)
|-- Dockerfile
|-- .dockerignore
|-- .env.example
`-- package.json
```

All data lives in the Google Sheet. The bot keeps nothing on local disk.
