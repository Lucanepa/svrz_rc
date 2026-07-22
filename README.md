# SVRZ Referee Coaching

Progressive web app for Swiss Volley Region Zürich referee coaches: pick a game,
fill the observation form at the venue (offline if need be), collect the
referee's and the coach's signature, and file it — the coachee receives the
report as a PDF by e-mail.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`: type check → Playwright
suite → production build → GitHub Pages at
<https://lucanepa.github.io/svrz_rc/>. The build bakes in
`VITE_API_BASE_URL=https://rc-api.lucanepa.com`.

The backend (Express + PocketBase, behind a Cloudflare Tunnel) runs on Hetzner
from `deploy/hetzner/docker-compose.yml`. See `infrastructure.md` for the host
setup and `infrastructure.private.md` (gitignored) for the actual secrets.

## Architecture

- `server/index.ts` — the whole API: auth, games sync, feedback submit, e-mail,
  iCal, activity log. The frontend never talks to PocketBase directly.
- `src/App.tsx` — the coach's app: games, coachees, the observation form.
- `src/components/AdminConsole.tsx` — `#/admin`: coachees, RCs, e-mail
  templates, surveys, president's notes, activity log, settings.
- `src/lib/offlineQueue.ts` — IndexedDB outbox for submissions made offline.
- `deploy/hetzner/seed/setup-schema.mjs` — the PocketBase schema. Additive and
  safe to re-run; this is how a new column gets added.

## Run locally

```bash
npm install
npm run dev      # web on :3000, API on :8787
npm run lint     # tsc --noEmit
npm test         # Playwright
```

`npm run dev:remote` points the local frontend at the production API instead of
a local one.

Backend configuration lives in `.env.local`; `deploy/hetzner/svrz-api.env.example`
documents every variable the server reads.

## Data model

Collections, fields and the reasoning behind them are in
`deploy/hetzner/seed/setup-schema.mjs` and `infrastructure.md` — that script is
the contract, not this file.
