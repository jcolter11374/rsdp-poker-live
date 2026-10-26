# Deploying RSDP Poker Live!

The whole site is one container: the game server plus the built web app, built from the `Dockerfile` at the repo root. CI builds that same image and runs the browser smoke test against it on every pull request.

## What the host must provide

- **Exactly one instance, always on.** Live tables and tournaments run in that one process on a server clock. A scheduled tournament has to start on time even when nobody has the site open, so turn off any "sleep when idle", "scale to zero" or auto-stop setting, and never run two copies at once.
- **WebSockets** (Socket.IO). Every mainstream host supports them.
- **Data that survives deploys.** Either:
  - set `DATABASE_URL` to a managed Postgres (14 or later), or
  - leave it unset and mount a persistent volume at `/data`. The server keeps an embedded PGlite database in `/data/pglite`.
  The container starts as root only to take ownership of `/data`, then runs the server as the unprivileged `node` user.
- **About 1 GB of memory.** With PGlite, the process peaks near 600 MB at boot, so 512 MB plans are too small. With Postgres it needs less.
- **HTTPS** in front of port `8080` (or whatever `PORT` says).

## Settings

| Variable | Default in the image | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the server listens on. |
| `DATABASE_URL` | unset | Postgres connection string. When set, PGlite is not used. |
| `PGLITE_DIR` | `/data/pglite` | Where the embedded database lives when `DATABASE_URL` is unset. |
| `NODE_ENV` | `production` | Turns off development CORS. |

The schema migrates itself at startup. Concurrent starts are serialised with an advisory lock.

- **Health check:** `GET /api/health` returns `{"ok":true,...}`.
- **Shutdown:** on `SIGTERM` the server saves every table and tournament and then exits, within 10 seconds. Give the host's stop timeout at least that long.

## Restarts and deploys

A deploy restarts the process:
- Tables reload from their last saved state.
- A hand in progress resumes with the same cards.
- Tournaments keep their clocks, and scheduled ones still start on time.
- Players' browsers reconnect by themselves.

## Backups

The live site is backed up every night, off Fly, by GitHub Actions (`.github/workflows/backup.yml`, about 09:41 UTC):

1. It reads the site's leaderboard and newest public record entry, then downloads the whole database from `GET /api/admin/backup` (needs the `X-Admin-Key` header). The server reads every table in one transaction, so the copy is one moment in time; on PGlite, table saves wait for it (about a second per 25 MB). Each download goes in the public record as an admin action, because a copy holds any hand being played at that moment.
2. **Restore drill:** it restores the copy into a fresh PGlite folder (`apps/server/src/restore.ts`), starts a real server on it (`scripts/backup/drill.sh`), and checks that the restored server gives the same all-time leaderboard and has the site's newest public record entry with the same hash. CI runs the same drill on every pull request, after the browser smoke test.
3. It locks the copy with AES-256 (`openssl enc`, PBKDF2 with 600,000 rounds) using the `BACKUP_KEY` repository secret, or `ADMIN_KEY` when that isn't set, and keeps it as a workflow artifact for 90 days. The repo is public and anyone signed in to GitHub can download artifacts, so the password is what keeps the copy private: use a long random one, and keep a copy of it outside GitHub (a password manager), or the backups can't be opened.
4. A failure opens the issue "Nightly backup failed", mentioning John; the next good run closes it.

Fly's own daily volume snapshots carry on as a second copy (same company, same region).

**Format:** gzipped JSON lines: a header (format version, time, number of migrations, tables), one line per row (`row_to_json`, so jsonb, timestamps and big numbers come back exactly), and an end line with each table's row count, which is how a restore knows the copy wasn't cut short. A backup restores into a fresh database of the same or a newer schema, PGlite or Postgres.

**Restoring:**

```bash
# 1. Download the artifact (Actions → Nightly backup → a run → Artifacts), unzip it, and unlock it (asks for the password):
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in rsdp-backup-….jsonl.gz.enc -out backup.jsonl.gz
# 2. Test it on your own machine: restores into memory and prints the rows per table.
npx tsx apps/server/src/restore.ts backup.jsonl.gz --check
# 3. Into a new PGlite folder (or a postgres:// URL of an empty database). Nothing is written unless all of it restores.
npx tsx apps/server/src/restore.ts backup.jsonl.gz /data/pglite-restored
```

On Fly: copy the file up (`fly ssh sftp shell`, `put backup.jsonl.gz /data/backup.jsonl.gz`), then in `fly ssh console` run step 3 from `/app/apps/server` (`node --import tsx src/restore.ts /data/backup.jsonl.gz /data/pglite-restored`), swap the folders (`mv /data/pglite /data/pglite-old && mv /data/pglite-restored /data/pglite`) and restart the machine (`fly machine restart`). The server opens the restored data on start; delete `/data/pglite-old` once all is well. If the volume is gone, deploy first so a new one exists. Restoring takes the site back to the night of the backup: tell players, and expect the public record on GitHub to show where the site's record went back (that is the record working as intended).

- **Managed Postgres:** use the provider's backups or point-in-time restore as well.

## Site-down alert

`.github/workflows/uptime.yml` asks `/api/health` every 5 minutes (GitHub sometimes runs it later). If the site doesn't answer for about 3 minutes and no deploy is running, it opens the issue "The site is down", mentioning John so GitHub emails him, and closes it when the site answers again. GitHub turns off scheduled workflows in a public repo after 60 days without a commit; re-enable them under Actions if that happens.

## Local check of the production image

```bash
docker build -t rsdp-poker .
docker run --rm -p 3001:8080 -v rsdp-data:/data rsdp-poker
BASE_URL=http://localhost:3001 npm run smoke
```

## Fly.io (production)

The live site is the Fly app `rsdp-poker-live`, at https://rsdp-poker-live.fly.dev. `fly.toml` holds its settings: one `shared-cpu-1x` machine with 1 GB of memory in `iad`, never auto-stopped, with a 1 GB volume `rsdp_data` mounted at `/data` and a 30 s stop timeout. Fly takes a daily snapshot of the volume and keeps it for 5 days.

- **Deploys are automatic.** Every push to `main` runs CI, and when CI passes `.github/workflows/deploy.yml` deploys that commit with `flyctl`. Because the machine has a volume, Fly stops the old copy before it starts the new one. You can also run the Deploy workflow by hand from the Actions tab.
- **Setup.** The deploy uses the GitHub Actions secret `FLY_API_TOKEN`, a Fly access token. `scripts/fly-provision.sh` creates the app and the volume if they are missing. The Fly setup workflow runs it whenever the Fly files change, so the app exists before the first deploy.
- **Keep it at one machine.** Don't run `fly scale count 2` and don't add a second volume. Two copies would each run their own tables.
- **Useful commands** (with `flyctl` signed in): `fly logs -a rsdp-poker-live`, `fly status -a rsdp-poker-live`, `fly volumes snapshots list <volume-id>`.
- **Never point test traffic at the live site.** `e2e/smoke.mjs` creates tables and a tournament with made-up players, so it refuses a `fly.dev` URL. After a release, only read-only checks (health, pages loading) run against the live site.
- **Removing a test tournament.** From a shell on the machine (`fly ssh console -a rsdp-poker-live`), `GET http://127.0.0.1:8080/api/admin/tournaments` lists every event the server holds, and `POST http://127.0.0.1:8080/api/admin/tournaments/<id>/archive` ends it the way its host would and hides it from every list (results are kept). These endpoints answer 404 to anything that comes through Fly's proxy.
