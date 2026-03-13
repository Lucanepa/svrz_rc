# Infrastructure

## Overview

This project is a React PWA + Node API + PocketBase setup:

- Frontend: `src/*`
- Backend API: `server/index.ts`
- Database: PocketBase on VPS (Tailscale reachable)
- External source: VolleyManager (login + CSRF + paginated API sync)

Run locally:

```bash
npm run dev
```

This starts:
- web (Vite) on `http://localhost:3000` (or `3001` if port busy)
- API on `http://localhost:8787`

## Infrastructure Endpoints

- PocketBase API base URL: `http://100.69.245.37`
- PocketBase admin UI: `http://100.69.245.37/_/`

Important: use API base URL **without** `/_/` in env variables.

## Environment Variables

Use `.env.local` (not committed):

```env
VITE_POCKETBASE_URL="http://100.69.245.37"
POCKETBASE_URL="http://100.69.245.37"

POCKETBASE_ADMIN_EMAIL="..."
POCKETBASE_ADMIN_PASSWORD="..."

VM_USERNAME="..."
VM_PASSWORD="..."

# optional
VM_BASE="https://volleymanager.volleyball.ch"
VM_SYNC_CRON="0 5 * * *"
VM_SYNC_TIMEZONE="Europe/Zurich"
VM_SYNC_MAX_RETRIES="10"
VM_SYNC_RETRY_DELAY_MS="15000"

# optional collection overrides
PB_GAMES_COLLECTION="games"
PB_COACHEES_COLLECTION="coachees"
PB_REFEREE_COACH_PEOPLE_COLLECTION="referee_coaches"
PB_REFEREE_COACH_FEEDBACK_COLLECTION="referee_coach_feedbacks"
PB_OBSERVATIONS_COLLECTION="observations"
```

## PocketBase Collections (Current)

### `games`
Stores synced VolleyManager games.

Core fields:
- `match_no`, `match_date`, `league`
- `home_team`, `away_team`
- `first_referee`, `second_referee`
- `external_id`, `source_payload`

### `coachees`
Master list of coachees (seeded for season 2025/26).

Fields:
- identity: `full_name`, `first_name`, `last_name`
- alt/de legacy: `vorname`, `nachname`
- level: `referee_level`, `stage`
- alt/de legacy: `niveau`, `stufe`
- groups: `groups` (json array)
- alt/de legacy: `gruppe` (json array), `group` (text)
- contacts: `email`, `phone`
- feedback linkage: `feedback_entries`, `last_feedback_at`

### `referee_coaches`
People directory for referee coaches.

Fields:
- `full_name`, `first_name`, `last_name`
- legacy: `vorname`, `nachname`
- `email`, `phone`, `active`

### `referee_coach_feedbacks`
Feedback submission records (formerly named `referee_coaches` before rename).

Fields:
- relations: `game`, `coachee`
- payload: `feedback_json`
- metadata: `rc_name`, `email`, `role_assessed`, `submitted_at`

### `observations`
Normalized observation records from each feedback save.

Relations:
- `coachee` -> `coachees`
- `referee_coach` -> `referee_coaches`
- `game` -> `games`

Fields:
- `game_level` (`easy|medium|hard`)
- `game_result`
- `coachee_function` (`1SR|2SR`)
- `grades` (json; includes per-item mapped numeric grades)
- `promotion` (`promotion|relegation|same_level`)
- `motivation` (`high_motivated|not_motivated|in_order`)
- `sr_goal` (`same_level|4L|3L|2L|1L|NL|International`)
- `remarks`

## Runtime Data Flow

1. PWA calls local API (`/api/*`).
2. API authenticates to PocketBase (admin or `_superusers` fallback).
3. `POST /api/games/sync` logs into VolleyManager, fetches games, transforms rows, upserts into `games`.
4. `GET /api/eligible-games` filters games by coachee match on referee names.
5. `POST /api/feedback/submit` writes:
   - `referee_coach_feedbacks` record
   - updates `coachees.feedback_entries`
   - creates `observations` record
6. Grade mapping in `observations.grades`:
   - `E- = 1 ... A+ = 15`

## Scheduler

Daily sync is internal (`node-cron`) in API process:

- default cron: `0 5 * * *`
- default timezone: `Europe/Zurich`
- retries on scheduler path controlled by:
  - `VM_SYNC_MAX_RETRIES`
  - `VM_SYNC_RETRY_DELAY_MS`

API process must run continuously in production (PM2/systemd/container).

## API Endpoints (Current)

- `GET /api/health`
- `GET /api/eligible-games`
- `POST /api/games/sync`
- `POST /api/games/sync/debug`
- `POST /api/vm/auth-check`
- `GET /api/coachees`
- `POST /api/coachees`
- `PUT /api/coachees/:id`
- `DELETE /api/coachees/:id`
- `GET /api/coachees/:id/games`
- `GET /api/coachees/:id/feedbacks`
- `GET /api/referee-coaches` (list feedback records from `referee_coach_feedbacks`)
- `POST /api/referee-coaches`
- `PUT /api/referee-coaches/:id`
- `DELETE /api/referee-coaches/:id`
- `GET /api/observations`
- `GET /api/observations/summary`
- `GET /api/games/calendar-status`
- `POST /api/feedback/submit`

## Data Import Status

- Coachees seeded: `83`
- Referee coaches seeded: `12`
- Coachees matched from XLS contacts: `70` direct + manual best-match completion applied
- Referee coach contacts completed including manual updates:
  - `Baumgartner Daniela`
  - `Schöni Jennifer`
  - `Dominik Schläpfer`
  - `Alexandra Périsset`
  - `Andrea Berckemeyer`

Remaining known gap: games table population depends on successful VolleyManager auth/session at sync time.

## Troubleshooting Quick Checks

```bash
curl "http://100.69.245.37/api/health"
curl "http://localhost:8787/api/health"
curl -X POST "http://localhost:8787/api/vm/auth-check" -H "Content-Type: application/json" -d '{"debug":true}'
```

If local API health fails:
1. verify `.env.local` is saved
2. restart API (`npm run dev:api`)
3. verify `POCKETBASE_URL` (no `/_/`)
4. verify admin credentials
5. verify Tailscale connectivity

## VPS Memory Baseline

The current VPS has experienced OOM kills (`pocketbase` killed by kernel). Keep a small swap file enabled as a safety buffer, even after RAM upgrades.

Recommended baseline:

```bash
# create 2GB swap (run once)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# tune swap behavior
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl -p /etc/sysctl.d/99-swappiness.conf

# verify
free -h
swapon --show
```

## Security Notes

- Keep PocketBase admin UI private (Tailscale-only).
- Never commit secrets.
- Rotate credentials immediately if exposed.
- Prefer HTTPS for public-facing paths when available.
