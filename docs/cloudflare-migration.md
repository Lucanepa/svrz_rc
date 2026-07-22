# Migration to Cloudflare Pages — cutover runbook

Moving the app from `https://lucanepa.github.io/svrz_rc/` to
**`https://svrz-rc.openvolley.app`**, and the API from
`https://rc-api.lucanepa.com` to **`https://svrz-rc-api.openvolley.app`**.

Every command below is labelled with the machine it runs on.

## Why these exact hostnames

- **Hyphen, not underscore.** `svrz_rc.openvolley.app` cannot be served. DNS
  accepts underscores, but the CA/Browser Forum baseline requirements forbid
  them in certificate SANs, so no CA — including Cloudflare's Universal SSL —
  will issue for that name. `.app` is on the HSTS preload list, so browsers
  refuse plain HTTP and there is no degraded mode to fall back to.
- **One label deep, both of them.** Universal SSL covers `openvolley.app` and
  `*.openvolley.app`, and nothing below that. `api.svrz-rc.openvolley.app` would
  have no edge certificate. This already happened once, to
  `rc-api.volleyball.lucanepa.com`.
- **Same registrable domain for app and API.** That is what makes the session
  cookie first-party and fixes login in Safari. See "Phase 3".

## What is already done in the repo

- `vite.config.ts` — `base: '/'` in all modes (the `/svrz_rc/` subpath is gone).
- `.github/workflows/deploy.yml` — still gates on `tsc --noEmit` + Playwright,
  then publishes with `npx wrangler pages deploy`.
- `wrangler.jsonc` — Pages project `svrz-rc`, output `dist`.
- `public/_headers`, `public/_redirects` — cache/security headers, and a 301
  from the old `/svrz_rc/*` subpath.
- `server/index.ts` — new default origins, plus `SESSION_COOKIE_SAMESITE`.
- `legacy/` + `.github/workflows/legacy-pages.yml` — the retirement notice and
  service-worker kill switch for the old GitHub Pages URL.

Nothing here has taken effect yet: the phases below are what makes it live.

---

## Phase 0 — Cloudflare project and CI credentials

`openvolley.app` is already on Cloudflare nameservers, so no registrar change is
needed.

1. Create the Pages project (**lenovoserver**, one time, interactive login):

   ```bash
   npx wrangler login
   npx wrangler pages project create svrz-rc --production-branch=main
   ```

2. Create an API token at <https://dash.cloudflare.com/profile/api-tokens> with
   the **Cloudflare Pages → Edit** permission, scoped to this account. Copy the
   Account ID from the Workers & Pages overview page.

3. Add both as repository secrets (**lenovoserver**). `gh secret set` prompts
   for the value, so the token never lands in shell history:

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN
   gh secret set CLOUDFLARE_ACCOUNT_ID
   ```

## Phase 1 — the API hostname (must come first)

The production build bakes in `VITE_API_BASE_URL=https://svrz-rc-api.openvolley.app`,
so that hostname has to answer before the frontend ships.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels** → the existing
   tunnel (ID in `infrastructure.private.md`) → **Public Hostnames → Add**:

   - Subdomain `svrz-rc-api`, domain `openvolley.app`
   - Service `HTTP` → `localhost:8787`

   This creates the proxied DNS record for you. **Leave the existing
   `rc-api.lucanepa.com` hostname in place** — see "Do not delete" below.

2. Verify the new hostname resolves and serves (**lenovoserver**):

   ```bash
   curl -sS https://svrz-rc-api.openvolley.app/api/health
   ```

   Expect `{"ok":true}`.

3. Update the API environment (**hetzner**). Edit
   `/root/svrz_rc/deploy/hetzner/svrz-api.env` and set — note that
   `CORS_ALLOWED_ORIGINS` lists **both** origins for the duration of the
   migration, so the old site keeps working while the new one comes up:

   ```
   CORS_ALLOWED_ORIGINS=https://svrz-rc.openvolley.app,https://lucanepa.github.io
   APP_PUBLIC_URL=https://svrz-rc.openvolley.app/
   SESSION_COOKIE_SAMESITE=none
   ```

4. Ship the server change (**lenovoserver**, then **hetzner**). The host copy of
   the repo is a plain file copy, not a git checkout — `git pull` there fails,
   and `docker compose up -d --build` will happily rebuild the *stale* files and
   print a completely normal success. Always copy first:

   ```bash
   # lenovoserver
   scp ~/repos/svrz_rc/server/index.ts hetzner:/root/svrz_rc/server/index.ts
   ssh hetzner 'cd /root/svrz_rc/deploy/hetzner && docker compose up -d --build svrz-api'
   ```

5. Confirm the container is running the new code (**lenovoserver**):

   ```bash
   curl -sS https://svrz-rc-api.openvolley.app/api/health
   curl -sS -o /dev/null -w '%{http_code}\n' \
     -H 'Origin: https://svrz-rc.openvolley.app' \
     https://svrz-rc-api.openvolley.app/api/health
   ```

   The second must be `200`, not `403`. A `403` means `CORS_ALLOWED_ORIGINS` did
   not take — in the browser this shows up only as a bare "Failed to fetch" with
   no status, so check it here where it is diagnosable.

## Phase 2 — the frontend

1. Push `main`. The workflow type-checks, runs Playwright, builds, and publishes
   to the `svrz-rc` Pages project. It will also publish `legacy/` to the old
   GitHub Pages URL (separate workflow, triggered by the new `legacy/` files).

2. Attach the custom domain: Pages project **svrz-rc → Custom domains → Set up a
   custom domain** → `svrz-rc.openvolley.app`. Cloudflare creates the CNAME and
   issues the certificate; it is usually live in under a minute.

3. Verify in a **fresh private window** (the old origin's service worker must not
   be involved):

   - <https://svrz-rc.openvolley.app> loads and shows the login screen.
   - Login works, and the games list populates (proves cookies + CORS).
   - The SR-Technik PDF link opens the PDF, not the app shell.
   - `https://svrz-rc.openvolley.app/svrz_rc/` 301s to the root.
   - DevTools → Application → Service Workers shows the worker registered at
     scope `/`.

## Phase 3 — the Safari fix (only after Phase 2 is verified)

Now that app and API share `openvolley.app`, the session cookie stops being
third-party. Flip it (**hetzner**), in `svrz-api.env`:

```
SESSION_COOKIE_SAMESITE=lax
```

```bash
# lenovoserver
ssh hetzner 'cd /root/svrz_rc/deploy/hetzner && docker compose up -d --force-recreate svrz-api'
```

`--force-recreate` on purpose: Compose does not reliably notice that the
*contents* of an `env_file` changed, and a no-op "up" here looks identical to a
successful one.

Then test login **on an iPhone or desktop Safari** with default privacy settings
— that is the case this whole change exists for. If it regresses, set the value
back to `none` and force-recreate again; nothing else needs reverting.

Once confirmed, `src/components/AuthGate.tsx:126` should be revisited: its error
text tells the user to disable "Cross-Site-Tracking verhindern", which stops
being the explanation once the cookie is first-party. Leave it until the flip is
proven, then reword it to a generic "session was not stored" message.

## Phase 4 — retire the old URL

1. Confirm <https://lucanepa.github.io/svrz_rc/> now shows the "umgezogen" page
   and forwards, and that `https://lucanepa.github.io/svrz_rc/sw.js` serves the
   kill switch rather than the old Workbox bundle.

2. On a device with the **old PWA installed**, open it while online. It should
   pick up the replacement worker, drop its caches and land on the new domain.
   This is the step that cannot be tested any other way — do it on a real phone.

3. Tell the coaches: new URL, and they must **re-install** the PWA (a redirect
   cannot move an installed app's icon).

4. Once traffic from `https://lucanepa.github.io` has stopped in the activity
   log, drop it from `CORS_ALLOWED_ORIGINS` (**hetzner**) and force-recreate.

## Do not delete: `rc-api.lucanepa.com`

Calendar subscriptions are absolute URLs, resolved once and then stored by the
subscriber's calendar app (`publicApiBase()` in `server/index.ts`). Every RC who
already subscribed holds a `https://rc-api.lucanepa.com/api/ical/<token>.ics`
URL inside iOS Calendar, Google Calendar or Outlook. Removing that tunnel
hostname silently breaks their feed — no error reaches the app, the calendar
just stops updating.

Keep the old public hostname routed to the same container. `API_PUBLIC_URL` is
unset, so the base is derived per request and **new** subscriptions minted
through the new hostname already use it; the old ones age out only as people
re-subscribe. Revisit no earlier than the end of the season, and announce it.

## Rollback

Nothing here is destructive, and each phase reverses on its own:

| Phase | Reverse it by |
| --- | --- |
| 3 (cookie) | `SESSION_COOKIE_SAMESITE=none` + force-recreate (**hetzner**) |
| 2 (frontend) | Re-point the old GitHub Pages workflow at `dist`; the old origin is still in `CORS_ALLOWED_ORIGINS` until Phase 4 |
| 1 (API) | Old tunnel hostname was never removed, so nothing to restore |

The one-way door is coaches' installed PWAs: once the kill switch has run on a
device, that install is gone and has to be re-added from the new URL.
