# Plan: Per-RC authentication and row-based access

Status: **implemented** (2026-07-20) — with these decisions by Luca:
- The shared `APP_PASSWORD` gate is removed **completely** (no dual mode).
- Login is a personal **6-digit PIN per RC** (not the email one-time code
  proposed in §2): the PIN alone identifies the RC (unique across RCs), is
  generated/rotated by the admin in the admin console (`POST
  /api/admin/rc-people/:id/pin`, cleartext returned exactly once), and stored
  as a scrypt hash (`pin_hash` on the people collection, app-wide salt derived
  from `ADMIN_SESSION_SECRET` — rotating that secret invalidates all PINs).
- Access matrix of §3 as written. RC session cookie `svrz_rc_session`
  (30 days, HMAC-signed `{purpose:'rc', rcId}`), revoked by deactivating the
  RC. Admin bootstrap path: `#/admin` with `ADMIN_UI_PASSWORD`.
- CSRF: covered by the existing CORS origin allowlist (requests with a
  disallowed `Origin` header are rejected outright); no extra middleware.

### Known residual risks (reviewed, accepted as low-impact)

- **assign-rc is name-keyed, not id-keyed.** `games.assigned_rc` stores the RC's
  display name; take/give-back ownership compares normalized names. Two active
  RCs whose names collide under `normalizeName` could act on each other's game
  assignments. Mitigation: the admin controls the RC roster and can avoid
  colliding names. A full fix needs an id-backed `assigned_rc` relation (larger
  data-model change). The **read** path (`rc-overview/:rcName/coachees`) was
  hardened to ignore the URL name and pin to the session's own identity.
- **assign-rc take has a TOCTOU window.** Read-check-write without a
  compare-and-swap: two RCs taking the same free game concurrently → last write
  wins, no privilege escalation. Pre-existing accepted risk.
- **Admin submit with an unknown RC name → generic 500.** `resolveRefereeCoachPersonId`
  now throws instead of auto-creating a phantom RC. Only reachable by an admin
  crafting a name outside the dropdown; the message is swallowed to a generic
  500. Acceptable.
- **Old service-worker clients** briefly see the removed gate endpoints (404)
  until the SW updates (~15 s poll, `skipWaiting`), then get the PIN screen.

The sections below are the original proposal, kept for the rationale.

## 1. Current state

- One shared `APP_PASSWORD` gate. The cookie (`svrz_gate_session`) is anonymous —
  it proves "knows the app password", not *who* the user is.
- Every gate-authenticated user can act as **any** RC: take/release any game
  (`PUT /api/games/:id/assign-rc` accepts an arbitrary `assignedRc`), open any
  RC's detail view, and submit observations under any `rc_name`.
- PocketBase is reached **only** from the Express server as superuser, so
  PB API rules cannot provide row-level security here. Enforcement must live in
  the Express layer (`server/index.ts`).
- Useful building blocks already exist:
  - `referee_coaches` (people) records have `email`, `phone`, `active`.
  - HMAC-signed cookie tokens (`signAdminSessionPayload`) for gate + admin sessions.
  - `checkRateLimit` in-memory limiter, `clientIp()` (Cloudflare-aware).
  - Nodemailer/Migadu SMTP (used for feedback PDFs) — reusable for login mails.

## 2. Recommended design

### Identity & login: email one-time code (magic code), no passwords

RCs are a small group (~10–30), occasional users, often on mobile. Passwords
mean set-password + reset-password flows and forgotten-password support. A
6-digit one-time code sent to the RC's **existing** `email` field needs no new
schema for credentials and reuses the SMTP infra:

1. `POST /api/auth/rc/request-code { email }` — if the email matches an
   `active = true` RC person, generate a 6-digit code, store **scrypt hash** +
   expiry (10 min) + attempt counter in memory, send it by mail. Always answer
   `{ ok: true }` (no account enumeration). Rate-limit per IP *and* per email
   via `checkRateLimit`.
2. `POST /api/auth/rc/verify { email, code }` — constant-time compare, max 5
   attempts per code. On success set cookie `svrz_rc_session` with claims
   `{ purpose: 'rc', rcId, name, exp }`, signed exactly like the existing
   gate/admin tokens (same secret, same helper). TTL: **30 days** (low-risk
   app, avoid weekly re-login friction; `active = false` kills access at once,
   see below).
3. `GET /api/auth/me` — returns `{ role: 'rc'|'admin'|'gate'|'none', rcId?, name? }`
   so the client knows who is logged in.
4. `POST /api/auth/rc/logout` — clears the cookie.

In-memory code store is fine for the single-container Hetzner deploy; a restart
during the 10-minute code window only means "request a new code".

### Session middleware

```
requireRcSession   → 401 unless valid rc session or admin session.
                     Sets req.rcAuth = { rcId, name, isAdmin }.
```

On each authenticated request, resolve the RC person via the existing
`rcPeopleCache` and reject if the record is gone or `active = false` — that is
the revocation mechanism (no token versioning needed).

Admin session (existing `ADMIN_UI_PASSWORD` flow) implies full access everywhere.

## 3. Endpoint access matrix

| Endpoint | Today | Target |
|---|---|---|
| `GET /api/eligible-games` | gate | any RC (shared pool — every RC needs to see open games) |
| `GET /api/coachees` + observation summaries | gate | any RC; **decision:** hide `notes` from non-admins? |
| `PUT /api/games/:id/assign-rc` | gate, arbitrary name | **self only**: body name must equal session RC name; unassign (`''`) only if the game is currently assigned to self. Admin: anyone. |
| `GET /api/rc-overview` | gate | any RC (counts are useful for coordination); detail links only for self |
| `GET /api/rc-overview/:rcName/coachees` | gate | **self or admin only** (contains coachee-identifying history) |
| observation submit | gate, client-supplied `rc_name` | `rc_name` **forced from session**, client value ignored |
| `/api/admin/*` | admin | unchanged |
| signature capability-token endpoints | own token scheme | unchanged |

This also fixes the accepted-risk finding from the code review (assign-rc
last-write-wins): with self-only assignment, add the cheap guard "reject taking
a game that is already assigned to someone else" in the same change.

## 4. Client changes (`src/`)

- Extend `AuthGate` → two-step login: email field → code field. Keep the shared
  password path alive during migration (see rollout).
- Auth context from `/api/auth/me`; header shows "Angemeldet als {name}" + logout.
- Referee Coaches tab: auto-open own detail; other RCs show counts without a
  clickable detail (unless admin).
- "Take game" / "Abgeben" buttons no longer ask which RC — they act as the
  logged-in RC.

## 5. Rollout (each phase deployable alone, feature-flagged)

1. **Infra** — auth endpoints + middleware behind `RC_AUTH_MODE=off|dual|strict`
   (default `off`, nothing changes). Deploy, test by hand.
2. **Dual mode** — endpoints accept gate *or* RC session; client gets the login
   UI as an *option* ("Login mit E-Mail"). Admin fills in missing RC emails in
   the admin console (UI already exists).
3. **Strict mode** — RC-scoped endpoints require the RC session; write
   endpoints enforce the matrix above. Shared password keeps working only for
   read-only, non-RC pages if still wanted — otherwise retire `APP_PASSWORD`.
4. **Cleanup** — remove dual-mode branches.

## 6. Security notes

- Rate-limit `request-code` (per IP and per email) and `verify` (per code) with
  the existing limiter; hash stored codes (scrypt, like the gate password).
- Cookies: `httpOnly`, `secure`, `SameSite=None` (required: app on
  `lucanepa.github.io`, API on `rc-api.lucanepa.com`). Because SameSite=None,
  add a cheap CSRF guard on state-changing routes: reject unless `Origin` is
  the app origin (Cloudflare already fronts the API).
- Log assign/unassign/submit with `rcAuth.name` (audit trail).
- No secrets in the client bundle; nothing changes for PB credentials.

## 7. Open decisions (owner: Luca)

1. Hide coachee `notes` from non-admin RCs? (They may contain sensitive remarks.)
2. Should RCs see each other's planned/outstanding counts (recommended: yes,
   detail no)?
3. Session length 30 days OK, or shorter?
4. After strict mode: does anyone still need the shared password (e.g. RSK
   members who only *read*), or is the app RC+admin only?

## 8. Effort estimate

- Server (endpoints, middleware, matrix enforcement, mails): ~1 day.
- Client (login UI, auth context, self-scoped RC tab): ~1 day.
- Rollout/testing across dual→strict: ~half a day, spread over a week of
  real-world use.
