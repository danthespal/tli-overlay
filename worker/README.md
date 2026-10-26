# Collector

Where the overlay's shared data goes: a Cloudflare Worker with a D1 database. The overlay asks the player once at first start. Nothing is sent until they say yes, and they can turn it off or delete what they shared from the tray icon.

- `POST /v1/records` takes up to 50 records (`../src/share/schema.ts`). Each record is rebuilt from the fields it should have; one with an unknown kind, an odd id or more than 16 KB of data is rejected. A retried upload can't make duplicates (`uid` is unique).
- `POST /v1/reports` takes one "that was wrong" report: the player's note (up to 2,000 characters), what the overlay read, and the frame. The frame must really be a JPEG or PNG (checked by its bytes) under 200 KB. The overlay shrinks it to 1,600 px wide, usually around 100 KB.
- `POST /v1/forget` deletes every record and report of one install id (tray menu: Delete my shared data).
- `GET /v1/export?after=ID` and `GET /v1/reports?after=ID` hand the rows to the repo. Both need the export token.

No accounts, no addresses stored. Each address may upload 60 times a minute, 5,000 records and 20 reports a day, counted against a salted hash of the address that changes daily. Cloudflare's free plan covers this.

## Where the data goes

- `.github/workflows/collect.yml` runs every 6 hours: `npm run pull` pulls every record, refits the advisor on all of them (`data/collected/advisor-config.json`) and writes `data/collected/summary.md`, then commits only those two files. The raw records are never committed (the repo is public): locally they go to `data/collected/raw/`, which git ignores. The shipped config is never changed by it.
- Reports are never committed. Read them with `npm run reports` (same `COLLECT_URL` / `COLLECT_TOKEN`), which downloads them into `data/reports/`, ignored by git. Both values are in `tool/.env.collect` (ignored by git); load them first, e.g. in Git Bash `set -a; . ./.env.collect; set +a`.

## Setup (once)

From this folder:

```
npm install
npx wrangler login
npx wrangler d1 create tli-overlay                       # put its id in wrangler.jsonc
npx wrangler d1 execute tli-overlay --remote --file schema.sql
npx wrangler deploy                                      # prints the Worker's address
npx wrangler secret put EXPORT_TOKEN                     # a long random string
npx wrangler secret put IP_SALT                          # another long random string
gh secret set COLLECT_URL                                # the Worker's address
gh secret set COLLECT_TOKEN                              # the same value as EXPORT_TOKEN
```

Then put the Worker's address in `../src/share/endpoint.ts` (`LIVE`), so the exe sends there. The secrets live only in Cloudflare and GitHub's encrypted repo secrets, never in the repo.

## Try it locally

1. Put `EXPORT_TOKEN=...` and `IP_SALT=...` in `.dev.vars` (git ignores it).
2. `npx wrangler d1 execute tli-overlay --local --file schema.sql`
3. `npx wrangler dev`
4. Run the overlay with `TLI_SHARE_URL=http://127.0.0.1:8787`. Running from source never shares without it.
