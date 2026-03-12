# Automatic deploy to Codeberg Pages

This repository includes a Woodpecker CI pipeline in `.woodpecker.yml` that:

1. installs dependencies with `npm ci`
2. builds the app with `npm run build`
3. deploys `dist/` to the `pages` branch on each push to `main`

## One-time setup on Codeberg

1. Generate a dedicated SSH key pair for CI:
   - `ssh-keygen -t ed25519 -f codeberg-pages-key -N ""`
2. In your Codeberg repo settings, add `codeberg-pages-key.pub` as a **Deploy Key** with **Write access**.
3. In Woodpecker/CI secrets, add a secret named `codeberg_pages_ssh_key` containing the private key (`codeberg-pages-key` file content).
4. Ensure your repository (or pages target repository) is public so Pages can serve it.

## Notes

- By default, deployment targets the current repo and `pages` branch.
- If you want to deploy to another repo (for example `username/username.codeberg.page`), set `repository_name` in `.woodpecker.yml`.

## PocketBase backend (RC feedback workflow)

This PWA can auto-load games from PocketBase, filter them by coachees, and save completed coaching feedback.

### Architecture in this repo

- `server/index.ts` provides API endpoints for PocketBase operations.
- `src/App.tsx` keeps the feedback workflow.
- `src/components/AdminPanel.tsx` provides CRUD/import UI for admin.
- Frontend calls only `/api/*`; direct PocketBase admin access stays server-side.

### Required collections

Create these collections in PocketBase:

- `games`
  - `match_no` (text)
  - `league` (text)
  - `match_date` (date or text)
  - `location` (text)
  - `home_team` (text)
  - `away_team` (text)
  - `first_referee` (text)
  - `second_referee` (text)
- `coachees`
  - `full_name` (text)
  - `feedback_entries` (json)
  - `last_feedback_at` (date)
- `referee_coaches`
  - `game` (relation -> `games`)
  - `coachee` (relation -> `coachees`)
  - `rc_name` (text)
  - `role_assessed` (text)
  - `feedback_json` (json)
  - `submitted_at` (date)

### Frontend env

Set in `.env`:

- `VITE_POCKETBASE_URL`
- optional `VITE_PB_GAMES_COLLECTION`
- optional `VITE_PB_COACHEES_COLLECTION`
- optional `VITE_PB_REFEREE_COACHES_COLLECTION`

### Backend env

Set in `.env` (used by `server/index.ts`):

- `POCKETBASE_URL`
- `POCKETBASE_ADMIN_EMAIL`
- `POCKETBASE_ADMIN_PASSWORD`
- optional `PB_GAMES_COLLECTION`
- optional `PB_COACHEES_COLLECTION`
- optional `PB_REFEREE_COACHES_COLLECTION`
- `VM_USERNAME`
- `VM_PASSWORD`
- optional `VM_BASE` (defaults to `https://volleymanager.volleyball.ch`)
- optional `VM_SYNC_CRON` (defaults to `0 5 * * *`)
- optional `VM_SYNC_TIMEZONE` (defaults to `Europe/Zurich`)

### Run locally

```bash
npm install
npm run dev
```

- Web app: `http://localhost:3000`
- API: `http://localhost:8787`

### Runtime behavior

- On app load, the PWA reads `games` and `coachees`.
- It keeps only games where 1st or 2nd referee matches a coachee.
- Selecting a game auto-populates match metadata.
- Saving creates a `referee_coaches` record and appends an entry to `coachees.feedback_entries`.
- PDF export supports download/share, and print is still available.

### New API endpoints

- `GET /api/health`
- `GET /api/eligible-games`
- `POST /api/feedback/submit`
- `GET/POST/PUT/DELETE /api/coachees`
- `GET/POST/PUT/DELETE /api/referee-coaches`
- `POST /api/games/sync` (automatic VolleyManager login + fetch + transform + upsert)
- `GET /api/observations` (supports filters + expand)
- `GET /api/observations/summary` (aggregated reporting metrics)

### Scheduled sync

- The API automatically runs game sync every day at **05:00**.
- Defaults:
  - cron: `0 5 * * *`
  - timezone: `Europe/Zurich`
- Override with `VM_SYNC_CRON` and `VM_SYNC_TIMEZONE` in `.env.local`.

### Admin UI features

- Create / edit / delete coachees
- List and delete referee coaching records
- Trigger automatic games sync from VolleyManager
