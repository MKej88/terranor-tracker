# Terranor Tracker

Private earnings nowcast and contract/weather tracker for Terranor Group.

## Current phase

The project is in the setup phase ahead of Terranor Q2 2026. The first live target is Q3 2026.

Architecture:

- **Cloudflare Worker** – API and scheduled data collection
- **Workers Static Assets** – private dashboard frontend
- **Cloudflare D1** – contracts, weather observations, signals and immutable forecast history
- **Cron Trigger** – hourly collection hook

## Repository structure

```text
public/             Static dashboard
src/index.js        Worker API + scheduled handler
db/schema.sql       Initial D1 schema
wrangler.jsonc      Cloudflare configuration
package.json        Wrangler scripts
```

## API endpoints

- `GET /api/health`
- `GET /api/status`
- `GET /api/forecast`

## Cloudflare setup

1. Connect this private GitHub repository to a Cloudflare Worker.
2. Deploy the Worker using the repository root.
3. Create a D1 database named `terranor-tracker-db`.
4. Add the D1 binding to `wrangler.jsonc` after Cloudflare returns the database ID.
5. Apply `db/schema.sql` to the D1 database.
6. Protect the application with Cloudflare Access before real forecast data is exposed.

The current hourly cron is `15 * * * *` (UTC). It only logs a placeholder event until live collectors are enabled.

## Q3 workflow

After Q2 2026 is reported:

1. Score the locked Q2 model against actual and benchmark.
2. Calibrate once and document all changes.
3. Lock Q3 methodology.
4. Start live weather/contract collection.
5. Save every forecast snapshot instead of overwriting history.
6. Compare the locked Q3 forecast with market estimates and actual Q3 results.

## Local commands

```bash
npm install
npm run dev
npm run check
npm run deploy
```
