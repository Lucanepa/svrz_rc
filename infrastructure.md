# Infrastructure

## What This Repo Contains

This project is a React PWA + Node/Express API + PocketBase backend:

- Frontend app: `src/*` (main UI in `src/App.tsx`, API client in `src/lib/pocketbase.ts`)
- Backend API: `server/index.ts`
- Database/storage/auth backend: PocketBase (Docker container)
- External upstream data source: Swiss Volley public data (authenticated sync)

Local dev command:

```bash
npm run dev
```

This runs:

- Frontend (Vite): `http://localhost:3000`
- Backend API: `http://localhost:8787`

Vite proxy forwards `/api/*` to `http://localhost:8787` in local development.

## Architecture (Frontend + Backend + Data)

1. Frontend calls only `/api/*` (no direct PocketBase admin calls in browser).
2. Backend authenticates against PocketBase admin API.
3. Backend reads/writes PocketBase collections (`games`, `coachees`, `referee_coaches`, `referee_coach_feedbacks`, `observations`).
4. Games can be synced from Swiss Volley public data manually and on schedule.
5. Feedback submit endpoint saves DB records + uploads PDF + sends email + closes role when applicable.

## Host + Network Context

The backend runs in Docker on a single host, fronted by a Cloudflare Tunnel —
there is no public ingress IP, reverse proxy, or open port to document here.

- Host / SSH target, tunnel name, and any private IPs: see `infrastructure.private.md` (gitignored).
- Deployment manifests: `deploy/hetzner/` (`docker-compose.yml`, Dockerfiles, env example).
- Public API domain: `https://rc-api.lucanepa.com` (Cloudflare Tunnel → API container on `127.0.0.1:8787`).
- PocketBase is **not** publicly exposed: it listens only on the internal Docker network and is reached by the API container at `http://pocketbase:8090`. Admin UI (`/_/`) is private — access it via an SSH/port-forward to the host, never over the internet.

Important: set `POCKETBASE_URL` to the internal service URL (e.g. `http://pocketbase:8090`), without `/_/`.

## Runtime Services

Both services run via Docker Compose (`deploy/hetzner/docker-compose.yml`):

- `pocketbase` — built from `Dockerfile.pocketbase`, data persisted in `./pb_data`, reachable only on the internal `svrz` Docker network as `pocketbase:8090`.
- `svrz-api` — built from `Dockerfile.api`, published on `127.0.0.1:8787` for the Cloudflare Tunnel to route. Reads secrets from `deploy/hetzner/svrz-api.env` (gitignored).

Public ingress is the external Cloudflare Tunnel (`rc-api.lucanepa.com` → `http://localhost:8787`); there is no Nginx/Certbot on the host.

Useful commands (run from `deploy/hetzner/` on the host):

```bash
docker compose ps
docker compose up -d --build
docker compose logs -f svrz-api
docker compose logs -f pocketbase
docker compose restart svrz-api
```

## Environment Variables

Use `.env.local` for local dev runtime values; production secrets live in `deploy/hetzner/svrz-api.env` on the host (never commit either).
Store actual secret values in `infrastructure.private.md` (gitignored), not in this tracked file.

### Frontend vars

```env
VITE_POCKETBASE_URL="" # not used by the browser; app talks to /api/* only
VITE_API_BASE_URL="" # optional; set for static hosting that needs absolute API origin
```

### Backend vars (required)

```env
POCKETBASE_URL="http://pocketbase:8090"  # internal Docker service URL
POCKETBASE_ADMIN_EMAIL="..."
POCKETBASE_ADMIN_PASSWORD="..."
VM_USERNAME="..."   # game sync credentials
VM_PASSWORD="..."   # game sync credentials
```

### Backend vars (admin session / scheduling / collections)

```env
ADMIN_SESSION_SECRET="long-random-secret" # recommended
ADMIN_SESSION_TTL_MS="28800000"           # default 8h

VM_BASE=""  # game sync base URL
VM_SYNC_CRON="0 5 * * *"
VM_SYNC_TIMEZONE="Europe/Zurich"
VM_SYNC_MAX_RETRIES="10"
VM_SYNC_RETRY_DELAY_MS="15000"

# Absolute base the calendar subscription links are built from. Unset => derived
# from the request (X-Forwarded-Proto/Host through the tunnel), which is right
# in this setup; set it only if a client ever receives a wrong host.
API_PUBLIC_URL="https://rc-api.lucanepa.com"
# Change this string to invalidate every existing calendar subscription at once
# (everyone then has to re-subscribe). Normally left alone.
ICAL_TOKEN_VERSION="1"

PB_GAMES_COLLECTION="games"
PB_COACHEES_COLLECTION="coachees"
PB_OBSERVATIONS_COLLECTION="observations"
PB_REFEREE_COACH_PEOPLE_COLLECTION="referee_coaches"
PB_REFEREE_COACH_FEEDBACK_COLLECTION="referee_coach_feedbacks"
PB_REFEREE_COACHES_COLLECTION="referee_coach_feedbacks" # legacy alias fallback
```

### Backend vars (feedback email)

```env
SMTP_HOST="smtp.migadu.com"
SMTP_PORT="465"
SMTP_USER="..."
SMTP_PASS="..."
SMTP_FROM="coaching-feedback@svrz.ch"

# Who gets the feedback report (PDF) in BCC. Comma-separated for more than one.
FEEDBACK_CC="rc_coaching@volleyball.lucanepa.com,rekom.zuerich@gmail.com"
FEEDBACK_EMAIL_TEST="1"              # 1 => redirect all emails to test recipient
FEEDBACK_TEST_RECIPIENT="you@..."

# Where each submitted survey is mailed as it arrives. Unset => stored only.
# (Who may READ them in the tool is NOT an env var — see is_rc_president below.)
SURVEY_NOTIFY_EMAIL="rekom.zuerich@gmail.com"
```

`FEEDBACK_SURVEY_URL` is gone: the post-visit survey is now a page in this app
(`#/survey/<token>`), not a Google Form, so the link is minted per feedback mail
instead of configured.

## PocketBase Collections (Current Model)

### `games`

Stores synced matches from Swiss Volley public data.

Common fields: `match_no`, `league`, `match_date`, `location`, `home_team`, `away_team`, `first_referee`, `second_referee`, `first_line_judge`, `second_line_judge`, `assigned_rc`, `feedback_closed_roles`, `source_payload`.

### `coachees`

Master list of referees/coachees.

Common fields: `full_name`, `first_name`, `last_name`, `email`, `phone`, `referee_level`, `stage`, `groups`, `feedback_entries`, `last_feedback_at`.

### `referee_coaches` (people directory)

Directory of RC persons.

Common fields: `first_name`, `last_name`, `email`, `phone`, `active`, `is_admin`, `is_rc_president`.

`is_rc_president` is the sole key to the post-visit survey responses
(`GET /api/survey-responses` and the console's RC-feedback tab). An admin
session does **not** open that view — admin rights open every other one, so this
is the deliberate exception. Set the flag directly in PocketBase: it is
intentionally absent from the admin console's RC editor, because a flag an admin
can tick is a flag an admin can tick for themselves.

### `referee_coach_feedbacks` (feedback records)

Submitted coaching feedbacks.

Common fields: `game` (relation), `coachee` (relation), `rc_name`, `role_assessed`, `feedback_json`, `submitted_at`, `pdf_file`.

### `observations`

Normalized reporting records derived from feedback.

Common fields: `coachee`, `referee_coach`, `game`, `coachee_function`, `grades`, `game_level`, `promotion`, `motivation`, `sr_goal`, `game_result`, `remarks`, `second_observation`.

### `rc_visit_feedback` (post-visit survey)

The coachee's feedback **on the RC** — the mirror of `referee_coach_feedbacks`.
Filled in on the public `#/survey/<token>` page linked from the feedback mail.

Common fields: `token`, `referee_name`, `match_date`, `match_no`, `rc_name`, `lang`, `anonymous`, `answers`, `submitted`, `submitted_at`.

Deliberately has **no relation to `coachees`**: "anonym absenden" has to mean the
row cannot point back at a person. On an anonymous submit `referee_name` is
cleared before it is stored, not merely hidden in the UI. Match, date and RC
always stay — a response nobody can place is a response nobody can act on.
Created by `deploy/hetzner/seed/setup-schema.mjs` (gitignored, lives on the host).

## API Authentication Model

Two auth layers are in use:

1. PocketBase admin auth (server-side, via env creds) for DB operations.
2. App admin session cookie (`svrz_admin_session`) for protected admin endpoints.

Admin cookie endpoints:

- `GET /api/admin/auth/status`
- `POST /api/admin/auth/login`
- `POST /api/admin/auth/logout`

Protected endpoints requiring admin cookie:

- `POST /api/games/sync`
- `POST /api/games/sync/debug`
- `POST /api/vm/auth-check`
- `POST|PUT|DELETE /api/coachees`
- `GET|POST|PUT|DELETE /api/referee-coaches`
- `POST /api/admin/migrate-source-payload`

Read endpoints used by app are generally open, but still depend on valid server-side PocketBase credentials.

## API Endpoints (What They Do)

- `GET /api/health`: checks PocketBase reachability + admin auth.
- `GET /api/eligible-games`: games filtered to coachees by name matching.
- `GET /api/referee-coach-people`: active RC people list for assignment/selectors.
- `PUT /api/games/:id/assign-rc`: assign RC to a game.
- `GET /api/rc-overview`: per-RC done/outstanding/planned summary.
- `GET /api/rc-overview/:rcName/coachees`: per-RC coachee breakdown.
- `POST /api/games/sync`: run game sync from Swiss Volley data.
- `POST /api/games/sync/debug`: run sync with debug trace payload.
- `POST /api/vm/auth-check`: validate upstream auth/session.
- `GET /api/survey/:token`: **public** — prefill data for the post-visit survey page. No login; the token is the capability, so no name or match number rides in the URL.
- `POST /api/survey/:token`: **public** — submit the survey. Write-once (409 if already answered), own per-IP rate-limit bucket.
- `GET /api/survey-responses`: read the responses. Gated on the `is_rc_president` flag, **not** on admin rights — an admin session gets 403. Not under `/api/admin/` for that reason, and not `/api/survey/responses`, which the `:token` route above would swallow.
- `GET /api/coachees`: list coachees + observation status summary.
- `POST /api/coachees`: create coachee.
- `PUT /api/coachees/:id`: update coachee.
- `DELETE /api/coachees/:id`: delete coachee.
- `GET /api/coachees/:id/games`: get coachee-related games (SR/LJ roles).
- `GET /api/coachees/:id/feedbacks`: feedback records for one coachee.
- `GET /api/referee-coaches`: feedback records list (expanded game/coachee).
- `POST /api/referee-coaches`: create feedback record (admin tool path).
- `PUT /api/referee-coaches/:id`: update feedback record.
- `DELETE /api/referee-coaches/:id`: delete feedback record.
- `GET /api/observations`: paginated observations list with filters.
- `GET /api/observations/summary`: aggregated KPIs.
- `GET /api/games/calendar-status`: game statuses (`outstanding|completed|none`).
- `GET /api/ical/me`: the calling RC's subscription links (`url`, `webcalUrl`, `downloadUrl`). RC session required; an admin-only session gets 403, because the feed belongs to a person and an admin console session is not one.
- `GET /api/ical/:token.ics`: **public** — the RC's assigned games as iCalendar, past and future. No login is possible for a calendar client, so the token in the path is the whole credential: an HMAC of the RC's id under `ADMIN_SESSION_SECRET`, stable per person, and only honoured for RCs that are still active. `?lang=de|en` picks the event language, `?download=1` flips the response to an attachment. The request log redacts the token. Rendered per request but memoised for 5 min, so a badly-behaved poller cannot pull the games collection repeatedly.
- `POST /api/feedback/submit`: main workflow submit (save + PDF + email + closure).
- `POST /api/admin/migrate-source-payload`: one-time migration utility.

## How To Do Common Operations

### 1) Start everything locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

### 2) Validate backend health

```bash
curl "http://localhost:8787/api/health"
```

Expect `{ "ok": true }` when PocketBase URL + credentials are correct.

### 3) Login as admin (needed for protected endpoints)

```bash
curl -i -X POST "http://localhost:8787/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<admin-email>","password":"<admin-password>"}'
```

Use returned cookie for protected API calls (or login via UI admin panel).

### 4) Get games for the app

Option A: pre-existing DB games:

```bash
curl "http://localhost:8787/api/eligible-games"
```

Option B: import latest games first:

```bash
curl -X POST "http://localhost:8787/api/games/sync" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Then call `/api/eligible-games` again.

### 5) Debug upstream auth/sync

```bash
curl -X POST "http://localhost:8787/api/vm/auth-check" \
  -H "Content-Type: application/json" \
  -d '{"debug":true}'
```

```bash
curl -X POST "http://localhost:8787/api/games/sync/debug" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 6) Submit feedback (app flow)

Frontend calls:

- `POST /api/feedback/submit` with `gameId`, `role`, `formData`, `pdfBase64`, `pdfFilename`, `tipsAndTricks`

Backend does:

1. validation + PDF size check (max 3 MB)
2. resolve game + coachee
3. create feedback record
4. append coachee `feedback_entries`
5. create normalized `observations` row
6. upload PDF to feedback record
7. send feedback email (with test mode support)
8. close role in `games.feedback_closed_roles` (unless second observation)

## Scheduler

Automatic sync runs inside `server/index.ts` using `node-cron`:

- cron default: `0 5 * * *`
- timezone default: `Europe/Zurich`
- retries (cron path): configurable via env vars

Production note: the API container runs with `restart: unless-stopped` so the cron stays alive; if the container is stopped, scheduled sync will not run.

## Activity Log (Debugging What Users Actually Did)

`server/logstore.ts` collects everything the system does, from both sides:

- **Server** — one `req.in` / `req.out` pair per request (method, path, status,
  duration, IP, identity, correlation id), every auth decision with its *reason*,
  every rate-limit denial with the bucket that tripped, every unhandled error.
- **Browser** — the app (`src/lib/logger.ts`) records clicks, form submits, all
  fetches with their status, JS errors, React crashes, online/offline, and ships
  them to `POST /api/client-logs` (also on `pagehide`, via `sendBeacon`).

Three sinks: stdout (`docker compose logs -f svrz-api`), a 20k-entry in-memory
ring (what the admin console reads), and daily JSONL files.

Read it in **Admin → Protokoll** (`#/admin/logs`): live tail, filter by
level/source/session, click a line for the full record. Or on the host:

```bash
cd deploy/hetzner
docker compose logs -f svrz-api                      # live
tail -f logs/svrz-$(date +%F).jsonl                  # structured, survives restarts
grep '"evt":"auth' logs/svrz-*.jsonl | tail -50      # every login / reset decision
```

Passwords, PINs, OTP codes, tokens and cookies are redacted at the log-store
boundary (`redact()`), on both sides — boolean flags under those key names are
kept, since they carry no secret and are usually the diagnostic bit.

Env: `LOG_DIR` (default `./logs`, `/app/logs` in the container via a bind
mount), `LOG_LEVEL` (default `debug`), `LOG_RING_MAX` (20000),
`LOG_RETENTION_DAYS` (30), `LOG_TO_FILE=0` to disable the file sink.

## Upstream Sync Troubleshooting

Game sync uses Swiss Volley public data with authenticated access. For detailed implementation notes (auth flow, headers, API properties, troubleshooting runbook), see `infrastructure.private.md`.

## Frontend Hosting / API Routing Notes

- Local dev: frontend uses relative `/api/*` and Vite proxy.
- Static hosting (e.g., Codeberg Pages): set `VITE_API_BASE_URL` to absolute API origin.
- Current production API origin: `https://rc-api.lucanepa.com`
- Vite base in production is `/svrz_rc/`, so assets are generated for that subpath.

Woodpecker CI requirement for static production builds:

- Secret name: `vite_api_base_url`
- Secret value: `https://rc-api.lucanepa.com`
- `.woodpecker/build.yml` injects this into `VITE_API_BASE_URL` during `npm run build`

## Data Import Status (Current Snapshot)

- Coachees seeded: `83`
- Referee coaches seeded: `12`
- Coachees matched from contacts: `70` direct + manual completion
- Remaining dependency: games availability depends on successful upstream auth/session during sync

## Troubleshooting Checklist

If `/api/health` fails:

1. check the API container's env file is present and values are loaded
2. verify `POCKETBASE_URL` (`http://pocketbase:8090`) is reachable from the API container
3. verify PocketBase admin email/password
4. confirm both containers are healthy on the `svrz` network (`docker compose ps`)
5. restart the API container and retest

Quick checks:

```bash
curl "http://localhost:8787/api/health"
docker compose exec svrz-api wget -qO- http://pocketbase:8090/api/health
```

## Host Memory Baseline

On small hosts, keep swap enabled as a safety buffer against OOM kills.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf
free -h
swapon --show
```

## Security Rules

- Never commit secrets from `.env*` or `deploy/hetzner/svrz-api.env`.
- Keep PocketBase off public ingress (internal Docker network only); reach the admin UI via SSH/port-forward.
- Set `ADMIN_SESSION_SECRET` to a strong random value (the API now refuses to sign sessions with an empty key).
- Rotate credentials immediately if exposed.
- Use HTTPS for all public API/frontend routes where available.
