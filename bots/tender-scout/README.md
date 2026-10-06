# TenderScout

Daily UK public-sector tender digest for the four group entities (Ateca, Osbrooks, AMC/BME, Trading Co).

1. **Harvest** new tender and award notices from Contracts Finder and Find a Tender (both OCDS APIs, no login).
2. **Score** every open tender 0-100 for winnability, per entity, with reasons and honest gaps.
3. **Post** a ranked Slack digest per entity. A tender is never posted to the same entity twice.

Award notices (who won what) are stored separately for Hiring-Signal Scout. TenderScout does no outreach and no people lookup.

## Setup

```sh
npm install                                   # from the repo root (workspaces)
cp bots/tender-scout/profiles.example.json bots/tender-scout/profiles.json
# edit profiles.json: replace every PLACEHOLDER value
# add the Slack webhook env vars to the ROOT .env (see below)
npm test -w bots/tender-scout
```

`profiles.json` is gitignored. The bot refuses to post for a profile that still contains the word `PLACEHOLDER`.

### Profile fields

| Field | Meaning |
|---|---|
| `entity`, `name` | slug (`ateca`) and display name |
| `keywords.include` / `keywords.exclude` | whole-word, case-insensitive; an exclude hit drops the tender |
| `cpvPrefixes` | e.g. `"796"` matches CPV `79620000` |
| `value.min` / `value.max` | £; `null` = no limit |
| `regions` | region names: the 12 ITL1 regions (`North East`, `North West`, `Yorkshire and The Humber`, `East Midlands`, `West Midlands`, `East of England`, `London`, `South East`, `South West`, `Wales`, `Scotland`, `Northern Ireland`), `England` or `United Kingdom`; validated; empty = anywhere |
| `excludedBuyers` | buyer names to drop (case-insensitive exact match) |
| `slackWebhookEnv` | the NAME of the env var holding the webhook, never the URL |
| `maxDigestSize` | 1-20 tenders per digest (default 10) |
| `weights` (optional) | `relevance`, `value`, `deadline`, `buyer`, `recency`; must add up to 100 (default 40/20/20/15/5) |
| `runway` (optional) | `minDays` (default 5): fewer days left scores 0; `fullDays` (default 14): full marks |

## Environment (root `.env`)

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_WEBHOOK_URL_TENDERS_*` | for `--send` | one per profile, named in `slackWebhookEnv` |
| `HEALTHCHECKS_BASE_URL`, `HC_UUID_TENDER_SCOUT` | no | healthchecks.io start/success/fail pings (live runs only) |
| `BOTARMY_CONTACT` | no | added to the User-Agent |
| `LOG_FORMAT=text` | no | readable logs instead of JSON lines |

## Running

```sh
node index.js                          # DRY RUN (default): fetches live data, in-memory DB, prints digests
node index.js --send                   # live: writes data/tender-scout-v2.sqlite, posts to Slack
node index.js --since 2026-09-01       # fetch from a date instead of the watermark
node index.js --stages award           # Contracts Finder stages (tender, award)
node index.js --sources find-a-tender  # only some sources (contracts-finder, find-a-tender)
node index.js --cache                  # dry run that keeps its own scratch DB: repeat runs fetch only what is new
node index.js --cache --offline        # dry run with NO API calls: re-score and print what the scratch DB holds
```

- A dry run writes nothing to disk and posts nothing; it prints each digest's exact Slack payload. `--dry-run` overrides `--send`.
- With `--send`, a profile whose webhook env var is unset is printed instead of posted, and not recorded as sent.
- The database is `data/tender-scout-v2.sqlite` (repo root). The old bot's `data/tender-scout.sqlite` is never opened.
- `--cache` uses `data/tender-scout-v2-dryrun.sqlite` instead of the in-memory copy, so dry runs don't keep hitting the APIs' rate limits. Delete the file to start fresh. `--cache` and `--offline` refuse to combine with `--send`.

### Rate limits

`core.http` holds a shared per-host policy: Contracts Finder 5s between requests, Find a Tender 1s. It is shared across processes through `data/.http-throttle/<host>.next`, so TenderScout, award-analytics and hiring-signal-scout running at the same time take turns instead of tripping the limit for each other. A 429 pushes the slot back for everyone.

### Regions

`regions.js` maps notice regions to profile names. Find a Tender gives NUTS codes (`UKM75`), Contracts Finder gives names. Codes map by their ITL1 letter (`UKM…`/`TLM…` = Scotland). A UK-wide or England-wide notice matches the regions inside it. A notice with no region, or a code we can't map (e.g. `UKZ`), is a **gap** (half points), never a mismatch.

### Notice and award status

A tender whose status is `cancelled`, `withdrawn` or `complete` (or a `tenderCancellation` notice) is no longer scored or posted. Awards keep `status`; `newAwardsSince()` leaves out `cancelled` and `unsuccessful` unless called with `{ includeNotWon: true }`.

### Watermark

Each stage remembers the last successful `publishedTo`. The next run starts **1 hour before** it (overlap; dedupe makes it safe). The first run looks back 7 days. The watermark only moves after the whole window has been fetched and stored.

### For other bots: new awards

```js
import { openDb, newAwardsSince } from '../tender-scout/db.js';
const db = openDb();
const rows = newAwardsSince(db, lastProcessedFirstSeenAt); // oldest first; keep your own watermark
```

One row per ocid + award + supplier: supplier name, `status`, `supplier_scheme`/`supplier_identifier` (Companies House `GB-COH` preferred wherever it appears, else e.g. `GB-PPON`), value, award date, buyer, CPV, link. An update changes the row in place; `first_seen_at` never changes. Notices keep only the latest release per ocid, but awards are kept per award id: Find a Tender publishes several award notices under one ocid (6 in one evening on 1 Oct).

## Scheduling on a VPS

Run once a day, **staggered** rather than on the hour, so we don't hit the API with everyone else at 06:00. A run takes a few minutes because of the API's rate limit.

cron (`crontab -e`, as the bot user):

```cron
37 6 * * 1-5  cd /opt/bot-army/bots/tender-scout && /usr/bin/node index.js --send >> /var/log/bot-army/tender-scout.log 2>&1
```

or a systemd timer with jitter:

```ini
# /etc/systemd/system/tender-scout.service
[Service]
Type=oneshot
WorkingDirectory=/opt/bot-army/bots/tender-scout
ExecStart=/usr/bin/node index.js --send
User=botarmy

# /etc/systemd/system/tender-scout.timer
[Timer]
OnCalendar=Mon..Fri 06:30
RandomizedDelaySec=20min
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl enable --now tender-scout.timer`. Logs: `journalctl -u tender-scout`.

## Verified against the real API vs assumptions

### Contracts Finder

Checked live on 2026-10-06 (`/Published/Notices/OCDS/Search`, no auth).

**Verified**
- The response is an OCDS release package (`uri, version, publishedDate, releases, links`). There is **no `hitsCount` or `maxPage`**.
- `page` and `size` are ignored. Pages hold 100 releases and are chained by `links.next` (a cursor URL). The last page has no `links`.
- `links.next` is **sometimes missing even though more releases exist**. 5 Oct awards: 88 (am) + 31 (pm) = 119, but a whole-day query returned 100 with no next link. The harvester splits such windows in half (a 7-day window went from 100 to 675 awards).
- `order=ASC` is ignored; results are newest first.
- Rate limit: about 12 requests in a short time, then "Rate limit of 12 exceeded. Please retry after 120 seconds." The bot spaces requests 5s apart and waits it out.
- `publishedFrom`/`publishedTo` accept `YYYY-MM-DDTHH:MM:SSZ`.
- The tender stage also returns `tenderAmendment`; the award stage also returns `awardUpdate`. The same ocid appears several times within one window.
- CPV is in `tender.classification`; `items[].classification` was empty in every sample.
- Value is often missing (12 of 28 tenders) and sometimes a **placeholder** (£1 tenders, £0 awards). Both are reported as "not published", never as a value.
- Region is only in `tender.items[].deliveryAddresses[].region`, often `""`.
- Timestamps mix `+01:00` and `Z`; everything is stored as UTC.
- `awards[].suppliers[]` has only `{id, name}`. The Companies House number is on the matching `parties[]` entry (`identifier.scheme = GB-COH`), present for 94 of 184 suppliers (51%) on 1 Oct.
- One ocid can carry several award notices (award ids `…-1`, `…-2`). Multi-supplier awards exist in live data (675 award releases gave 741 rows).
- Some tenders are published with a deadline already passed (a 1 Oct notice closing 25 Sep). These are dropped as "deadline has passed".

### Find a Tender

Checked live on 2026-10-06 (`/api/1.0/ocdsReleasePackages`, no auth). 1 Oct 2026 = 452 releases in 5 pages; a live run on 5-6 Oct fetched 481.

**Verified**
- Same OCDS package shape. Pages of 100 chained by `links.next` (cursor); the full day paged cleanly.
- It filters by **update** time (`updatedFrom`/`updatedTo`); `...Z` datetimes are accepted.
- `stages=tender` returned 7 releases for 1 Oct while the unfiltered feed had 66 `tender` + 41 `tenderUpdate`, so we fetch unfiltered and sort by tag.
- Tags seen: `award,contract` 276, `tender` 66, `tenderUpdate` 41, `planning` 33, `planningUpdate` 11, `tenderCancellation` 9, `awardUpdate,contractUpdate` 8, `contractAmendment` 4, `contractTermination` 4.
- Release ids are `NNNNNN-YYYY` (notice number - year) and increase with time; notice link `https://www.find-tender.service.gov.uk/Notice/<id>` (also in `documents[].url`).
- CPV is on `tender.classification` or `items[].additionalClassifications`; **224 of 276 award releases carry no CPV at all**.
- Regions are NUTS codes (`UKM75`, `UKH17`, `UK`); every code on 1 Oct is an official NUTS 2016 code except `UKK24` (NUTS 2021).
- Tender value present on 75 of 116 tender releases; deadline on 89. Two had a £1/£0 placeholder.
- Award value is on `awards[].value` (113) or the linked `contracts[].value` (314 of 317); date on `award.date` (93) or `contracts[].dateSigned` (317).
- Supplier identifiers (771 supplier refs): `GB-PPON` 370, `GB-COH` 275, none 112, `GB-NHS` 3, `GB-CHC` 2, `GB-UKPRN` 1, an id without a scheme 8. Companies House also appears in `additionalIdentifiers`.
- Award status: active 362, pending 68, cancelled 9, unsuccessful 4, blank 217. On 1 Oct no cancelled or unsuccessful award named a supplier.
- Tender status: active 97, cancelled 2, complete 4, withdrawn 2, blank 11; `tenderCancellation` notices may have no status.
- 31 multi-supplier awards (one framework lot named 61 suppliers).

**Assumptions / not yet verified (Find a Tender)**
- The rate limit is not published and was never hit; 1s spacing is a guess.
- Whether `links.next` can go missing on a full page (as on Contracts Finder) is unknown; the same window splitter runs anyway.
- Lot-level values and deadlines were not seen on 1 Oct; the lot fallbacks are tested on synthetic data only.
- A supplier id without a scheme (e.g. `00928555`) looks like a company number but is stored with scheme NULL, not guessed.
- Procurement Act notice types (`documents[].noticeType`, e.g. `UK15`) are not used yet.

### Regions table

- Verified against the ONS ITL1 January 2025 list (12 regions, `TLC`-`TLN`) and Eurostat NUTS 2016/2021 level 1 (`UKC`-`UKN`, `UK`).
- **Not verified / our own choices:** codes below ITL1 changed in ITL 2025, but we only use the first letter, so this doesn't affect matching. `UKZ`/`TLZ` (extra-regio) is treated as unrecognised. Short aliases (`East`, `UK`, `Great Britain`) are our convenience, not official names.

### General assumptions

- Contracts Finder carries mainly **below-threshold** notices since the Procurement Act regime; most large tenders are on Find a Tender.
- Buyer familiarity only knows awards harvested since the bot started, so early on most buyers show "no award history" (flagged as a gap, half points).
- Buyers are matched by lower-cased name; the same buyer under two spellings counts as two.
- The rate-limit reply's exact status code was not captured (core.http retries 429 with Retry-After; the bot also waits on the plain-text message).
- Raw JSON of every release is kept in the `releases` table (~5 KB each, roughly 1-2 MB a day). No pruning yet.

## Tests

`npm test -w bots/tender-scout`. No network and no real Slack: `core.http.setFetch` serves pages built from the real fixtures in `test/fixtures` (trimmed live responses: Contracts Finder 28 tenders + 23 awards, Find a Tender 28 releases). Tests that use synthetic data say so.

Fixtures are **anonymised** with `test/fixtures/anonymise.mjs` before committing: every contact person, email and phone number is replaced, and any supplier that may be an individual or sole trader (no company/charity/NHS/education register number and no organisation word in its name, plus a short hand-reviewed list stored as hashes) becomes `Sole Trader N (anonymised)` with its ids, address and website removed. Run it on any new fixture: `node test/fixtures/anonymise.mjs test/fixtures/<file>.json`.
