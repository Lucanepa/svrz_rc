# Infrastructure

## Current Architecture

This repository runs as a mixed frontend + backend app:

- `src/*`: PWA (feedback + admin UI).
- `server/index.ts`: Node API used by the PWA (`/api/*`).
- PocketBase: remote database on Infomaniak VPS.
- VolleyManager sync: executed by the Node API, not by PocketBase itself.

Local development runs both services with:

```bash
npm run dev
```

This starts:
- web on Vite (usually `http://localhost:3000` or `3001`)
- API on `http://localhost:8787`

## VPS + PocketBase

- Provider: Infomaniak VPS
- OS: Ubuntu 24.04 LTS
- Public IPv4: `83.228.220.158`
- Tailscale IPv4: `100.69.245.37`
- Tailscale DNS: `ov-c45f75.taile148bf.ts.net`

PocketBase admin UI is confirmed reachable through Tailscale:

- `http://100.69.245.37/_/`

PocketBase API base URL (for app config) should be:

- `http://100.69.245.37`

Do not use `/_/` in env URLs.

## Runtime Data Flow

1. PWA calls local Node API (`/api/*`).
2. Node API authenticates to PocketBase with admin credentials.
3. Games sync endpoint logs in to VolleyManager, fetches games, transforms data, and upserts to `games`.
4. Eligible games are filtered by referee names in `coachees`.
5. Feedback submission writes to `referee_coaches` and appends metadata to `coachees.feedback_entries`.

## Sync Scheduling

Daily sync is executed by `node-cron` inside `server/index.ts`.

Default schedule:
- cron: `0 5 * * *`
- timezone: `Europe/Zurich`

Because scheduler lives in the Node API process:
- the API process must stay running 24/7 in production (PM2/systemd/container).

## Required Environment Variables

Use `.env.local` locally (never commit secrets):

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
```

## Health + Troubleshooting

### Quick checks

```bash
curl "http://100.69.245.37/api/health"
curl "http://localhost:8787/api/health"
```

Expected:
- first command confirms PocketBase reachability
- second confirms Node API can auth and talk to PocketBase

### If `localhost:8787/api/health` fails

Check in this order:

1. `.env.local` is saved and API restarted.
2. `POCKETBASE_URL` has no `/_/` suffix.
3. `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD` are valid superuser credentials.
4. Tailscale connectivity is up on the machine running Node API.

### Useful VPS commands

```bash
sudo systemctl status pocketbase --no-pager
sudo journalctl -u pocketbase -f
sudo tailscale status
sudo tailscale ip -4
```

## Security Notes

- Keep PocketBase admin UI behind Tailscale/private access.
- Keep credentials in `.env.local` / secret manager only.
- Use strong PocketBase admin password.
- Prefer HTTPS termination for public API traffic where possible.
