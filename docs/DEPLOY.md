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

- **Managed Postgres:** use the provider's backups or point-in-time restore.
- **Volume:** use the host's volume snapshots. Alternatively, stop the app and copy `/data/pglite`.

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
