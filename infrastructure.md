# Infrastructure

## What This Repo Contains

This project is a React PWA + Node/Express API + PocketBase backend:

- Frontend app: `src/*` (main UI in `src/App.tsx`, API client in `src/lib/pocketbase.ts`)
- Backend API: `server/index.ts`
- Database/storage/auth backend: PocketBase on VPS
- External upstream data source: VolleyManager (login + CSRF + paginated games sync)

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
4. Games can be synced from VolleyManager manually and on schedule.
5. Feedback submit endpoint saves DB records + uploads PDF + sends email + closes role when applicable.

## VPS + Network Context

- Provider: Infomaniak
- Host: `ubuntu@83.228.220.158`
- SSH: `ssh -i ~/.ssh/id_ed25519 ubuntu@83.228.220.158`
- Tailscale IP: `100.69.245.37`
- OS: Ubuntu 24.04.3 LTS
- Hostname: `ov-c45f75`

Public API domain:

- API base URL (public): `https://rc-api.volleyball.lucanepa.com`
- DNS: Cloudflare A record `rc-api.volleyball -> 83.228.220.158`
- TLS: Let's Encrypt certificate installed via Certbot on VPS Nginx
- Cloudflare proxy note: keep record as DNS-only unless edge certificate coverage is configured for this hostname

PocketBase endpoints:

- API base URL: `http://100.69.245.37`
- Admin UI: `http://100.69.245.37/_/` (Tailscale-only)

Important: use `POCKETBASE_URL` without `/_/`.

## Runtime Services

PocketBase:

- Binary: `/opt/pocketbase/pocketbase`
- Systemd service: `pocketbase.service`
- Internal bind: `127.0.0.1:8090`
- Public entry: Nginx reverse proxy

Nginx:

- Config: `/etc/nginx/sites-available/pocketbase`
- Proxies port 80 -> `127.0.0.1:8090`
- Restricts `/_/` to localhost + Tailscale (`100.64.0.0/10`)
- Keeps API routes public
- `client_max_body_size 50m`

PM2:

- Existing process noted on VPS: `openvolley`
- API process: `svrz-api` (runs `npm run start:api` with `PORT=8787`)

Useful commands:

```bash
sudo systemctl status pocketbase
sudo systemctl restart pocketbase
journalctl -u pocketbase -f
pm2 list
pm2 logs openvolley
pm2 logs svrz-api
```

API process lifecycle (VPS):

```bash
cd ~/apps/svrz_rc
pm2 delete svrz-api
PORT=8787 pm2 start npm --name svrz-api -- run start:api
pm2 save
pm2 restart svrz-api --update-env
```

Nginx API site:

- Config: `/etc/nginx/sites-available/svrz-api`
- Enabled: `/etc/nginx/sites-enabled/svrz-api`
- Server name: `rc-api.volleyball.lucanepa.com`
- Upstream: `http://127.0.0.1:8787`

## Environment Variables

Use `.env.local` for local/prod runtime values (never commit secrets).
Store actual secret values in `infrastructure.private.md` (gitignored), not in this tracked file.

### Frontend vars

```env
VITE_POCKETBASE_URL="http://100.69.245.37"
VITE_API_BASE_URL="" # optional; set for static hosting that needs absolute API origin
```

### Backend vars (required)

```env
POCKETBASE_URL="http://100.69.245.37"
POCKETBASE_ADMIN_EMAIL="..."
POCKETBASE_ADMIN_PASSWORD="..."
VM_USERNAME="..."
VM_PASSWORD="..."
```

### Backend vars (admin session / scheduling / collections)

```env
ADMIN_SESSION_SECRET="long-random-secret" # recommended
ADMIN_SESSION_TTL_MS="28800000"           # default 8h

VM_BASE="https://volleymanager.volleyball.ch"
VM_SYNC_CRON="0 5 * * *"
VM_SYNC_TIMEZONE="Europe/Zurich"
VM_SYNC_MAX_RETRIES="10"
VM_SYNC_RETRY_DELAY_MS="15000"

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

FEEDBACK_CC="rc_coaching@volleyball.lucanepa.com"
FEEDBACK_SURVEY_URL="https://docs.google.com/forms/..."
FEEDBACK_EMAIL_TEST="1"              # 1 => redirect all emails to test recipient
FEEDBACK_TEST_RECIPIENT="you@..."
```

## PocketBase Collections (Current Model)

### `games`

Stores synced matches from VolleyManager.

Common fields: `match_no`, `league`, `match_date`, `location`, `home_team`, `away_team`, `first_referee`, `second_referee`, `first_line_judge`, `second_line_judge`, `assigned_rc`, `feedback_closed_roles`, `source_payload`.

### `coachees`

Master list of referees/coachees.

Common fields: `full_name`, `first_name`, `last_name`, `email`, `phone`, `referee_level`, `stage`, `groups`, `feedback_entries`, `last_feedback_at`.

### `referee_coaches` (people directory)

Directory of RC persons.

Common fields: `first_name`, `last_name`, `email`, `phone`, `active`.

### `referee_coach_feedbacks` (feedback records)

Submitted coaching feedbacks.

Common fields: `game` (relation), `coachee` (relation), `rc_name`, `role_assessed`, `feedback_json`, `submitted_at`, `pdf_file`.

### `observations`

Normalized reporting records derived from feedback.

Common fields: `coachee`, `referee_coach`, `game`, `coachee_function`, `grades`, `game_level`, `promotion`, `motivation`, `sr_goal`, `game_result`, `remarks`, `second_observation`.

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
- `POST /api/games/sync`: run VolleyManager sync.
- `POST /api/games/sync/debug`: run sync with debug trace payload.
- `POST /api/vm/auth-check`: validate VolleyManager login/session.
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

### 5) Debug VolleyManager auth/sync

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
- retries (cron path): `VM_SYNC_MAX_RETRIES`, `VM_SYNC_RETRY_DELAY_MS`

Production note: keep API process continuously running (PM2/systemd/container), otherwise scheduled sync will not run.

## Frontend Hosting / API Routing Notes

- Local dev: frontend uses relative `/api/*` and Vite proxy.
- Static hosting (e.g., Codeberg Pages): set `VITE_API_BASE_URL` to absolute API origin.
- Current production API origin: `https://rc-api.volleyball.lucanepa.com`
- Vite base in production is `/svrz_rc/`, so assets are generated for that subpath.

Woodpecker CI requirement for static production builds:

- Secret name: `vite_api_base_url`
- Secret value: `https://rc-api.volleyball.lucanepa.com`
- `.woodpecker.yml` injects this into `VITE_API_BASE_URL` during `npm run build`

## Data Import Status (Current Snapshot)

- Coachees seeded: `83`
- Referee coaches seeded: `12`
- Coachees matched from contacts: `70` direct + manual completion
- Remaining dependency: games availability depends on successful VolleyManager auth/session during sync

## Troubleshooting Checklist

If `/api/health` fails:

1. check `.env.local` exists and values are loaded
2. verify `POCKETBASE_URL` is reachable from API host
3. verify PocketBase admin email/password
4. verify Tailscale connectivity for private PB endpoint
5. restart API process and retest

Quick checks:

```bash
curl "http://localhost:8787/api/health"
curl "http://100.69.245.37/api/health"
```

## VPS Memory Baseline

This VPS had previous OOM kills. Keep swap enabled as safety buffer.

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

- Never commit secrets from `.env*`.
- Keep PocketBase admin UI private (Tailscale-only).
- Set `ADMIN_SESSION_SECRET` to a strong random value.
- Rotate credentials immediately if exposed.
- Use HTTPS for all public API/frontend routes where available.
