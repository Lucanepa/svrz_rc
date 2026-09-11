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
- Public API domain: `https://svrz-rc-api.openvolley.app` (Cloudflare Tunnel → API container on `127.0.0.1:8787`). The former `rc-api.lucanepa.com` hostname stays routed to the same container during the migration; see `docs/cloudflare-migration.md` for when to remove it.
- PocketBase is **not** publicly exposed: it listens only on the internal Docker network and is reached by the API container at `http://pocketbase:8090`. Admin UI (`/_/`) is private — access it via an SSH/port-forward to the host, never over the internet.

Important: set `POCKETBASE_URL` to the internal service URL (e.g. `http://pocketbase:8090`), without `/_/`.

## Runtime Services

Both services run via Docker Compose (`deploy/hetzner/docker-compose.yml`):

- `pocketbase` — built from `Dockerfile.pocketbase`, data persisted in `./pb_data`, reachable only on the internal `svrz` Docker network as `pocketbase:8090`.
- `svrz-api` — built from `Dockerfile.api`, published on `127.0.0.1:8787` for the Cloudflare Tunnel to route. Reads secrets from `deploy/hetzner/svrz-api.env` (gitignored).

Public ingress is the external Cloudflare Tunnel (`svrz-rc-api.openvolley.app` → `http://localhost:8787`); there is no Nginx/Certbot on the host. The tunnel is **dashboard-managed** (Zero Trust → Networks → Tunnels → Public Hostnames) — editing `/etc/cloudflared/config.yml` on the host changes nothing.

Useful commands (run from `deploy/hetzner/` on the host).

**Always pass `-p svrz-rc`.** Compose otherwise names the project after the
directory — `hetzner` — and builds a SECOND, parallel stack: a duplicate
PocketBase bound to the same `./pb_data`, and an API that cannot start because
the real one already holds `127.0.0.1:8787`. That happened on 28.08.2026; the
port clash is the only reason two PocketBase processes did not stay up on one
SQLite directory.

```bash
docker compose -p svrz-rc ps
docker compose -p svrz-rc up -d --build
docker compose -p svrz-rc logs -f svrz-api
docker compose -p svrz-rc logs -f pocketbase
docker compose -p svrz-rc restart svrz-api
```

**`localhost:8787` on lenovoserver is PRODUCTION.** The Vite dev proxy forwards
`/api` there, so a dev page or an e2e run on this host talks to the live API and
files into the live log. `playwright.config.ts` points the proxy at a closed port
(`DEV_API_TARGET`) so an unstubbed call in a test fails loudly instead; set the
same variable when running `npm run dev` here.

Deploying the API means copying this repo over `/home/lucanepa/svrz_rc` on
lenovoserver and rebuilding there — never `git pull` in that directory, which is
not a checkout. Copy source only: `deploy/hetzner/pb_data`,
`deploy/hetzner/logs`, `deploy/hetzner/svrz-api.env*` and every `.env*` are host
state and must be excluded, and `--delete` must NOT be used (the host keeps
timestamped secret backups that are not in git).

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

# The shared team login (the everyday way into the app). There is NO fallback
# in the code any more — the old default was live in production while sitting
# in a public repo. Unset means the door is shut. Rotating logs nobody out:
# session cookies are signed with ADMIN_SESSION_SECRET, so they stay valid for
# their 30 days and only new sign-ins need the new password.
SHARED_LOGIN_USERNAME="Referee-Coaching"
SHARED_LOGIN_PASSWORD="<set in the env, or change it in the admin console>"

# The RC chair's own login, typed on the same form as the admin one at #/admin.
PRESIDENT_UI_USERNAME="praesidium"
PRESIDENT_UI_PASSWORD="<set to open the chair's tabs; unset keeps them shut>"

VM_BASE=""  # game sync base URL
VM_SYNC_CRON="0 1 * * *"
VM_SYNC_TIMEZONE="Europe/Zurich"
VM_SYNC_MAX_RETRIES="10"
VM_SYNC_RETRY_DELAY_MS="15000"

# SR-Börse poller. Off with VM_BOERSE_ENABLED=0 — a kill switch that needs no
# deploy if VolleyManager ever starts rate-limiting the shared login.
VM_BOERSE_ENABLED="1"
VM_BOERSE_POLL_MINUTES="60"
# How far back to read. The whole board is ~3600 rows and one unbounded pass
# outran the request deadline; an offer on a game already played cannot threaten
# an observation anyway.
VM_BOERSE_LOOKBACK_DAYS="2"
# This endpoint is SLOW: a 200-row page with the convocation array took ~40 s.
VM_BOERSE_TIMEOUT_MS="120000"
# The role the poller claims. ⚠ An ATTRIBUTE VALUE id, not a role name — the
# account holds two different `RefAdmin:Referee` attributes and the other one
# answers the börse 200 with ZERO rows.
VM_ROLE_ATTRIBUTE_BOERSE="b87653c7-…"

# Every VolleyManager request gets a deadline; Node's fetch has none, and a
# connection dropped mid-response never resolves and never rejects.
VM_REQUEST_TIMEOUT_MS="45000"
# How long one job may hold the shared-account lock before another may take over.
VM_JOB_TIMEOUT_MS="900000"

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
# Hetzner blocks outbound 25/465, so implicit TLS on 465 just hangs until the
# connect timeout and every mail silently fails. 587 (STARTTLS) is the one that
# works — note the code default is still 465, so this must be set.
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASS="..."
SMTP_FROM="coaching-feedback@svrz.ch"

# Who gets the coaching report (PDF) in BCC. Comma-separated for more than one.
# NOT the survey address — the survey goes to SURVEY_NOTIFY_EMAIL below, and
# that mailbox is deliberately not on this list: this one carries every
# referee's full written assessment.
FEEDBACK_CC="rc_coaching@openvolley.app"
FEEDBACK_EMAIL_TEST="1"              # 1 => redirect all emails to test recipient
FEEDBACK_TEST_RECIPIENT="you@..."

# Where each submitted survey is mailed as it arrives. Unset => stored only.
# (Who may READ them in the tool is the chair's console password below, not this
#  address and not the is_rc_president flag — receiving each answer as it arrives
#  and reading the collected set are different jobs.)
# The real address belongs in the gitignored private file, not here.
SURVEY_NOTIFY_EMAIL="__see_infrastructure.private.md__"
```

`FEEDBACK_SURVEY_URL` is gone: the post-visit survey is now a page in this app
(`#/survey/<token>`), not a Google Form, so the link is minted per feedback mail
instead of configured.

## PocketBase Collections (Current Model)

### `games`

Stores synced matches from Swiss Volley public data.

Common fields: `match_no`, `league`, `match_date`, `location`, `home_team`, `away_team`, `first_referee`, `second_referee`, `first_line_judge`, `second_line_judge`, `assigned_rc`, `feedback_closed_roles`, `source_payload`.

### `boerse_offers`

One row per **offer** in VolleyManager's SR-Börse — not one per game. A game can
appear twice (once per head slot), and a slot offered, withdrawn and offered
again is two rows, keyed by `vm_offer_id`.

Common fields: `vm_offer_id`, `match_no`, `game_starts_at`, `referee_position`,
`slot`, `status`, `slot_person_name`, `slot_person_sv`, `slot_person_vm_id`,
`submitted_by_*`, `applied_by_*`, `join_via`, `first_seen`, `last_seen`,
`withdrawn_at`, `raw`.

Deliberately a sibling of `games`, not columns on it: `mapIncomingGame` returns
the full update payload, so a börse column on `games` would be blanked by the
next 05:00 import unless that function were taught about it too.

⚠ **`status` is spelled `not_applied`** with an underscore, where every other VM
enum in this app uses a hyphen.

⚠ **Only head-one and head-two are stored.** Line judges are out of scope, and
the two VM endpoints disagree about the word anyway — the börse search says
`Linesman`, the games search says `LineJudge`, and asking the börse for a
`LineJudge` property is a hard 500.

See "VolleyManager roles" under Upstream Sync Troubleshooting: the börse needs a
different role from the games sync, and three roles answer it `200` with the
wrong row count.

### `coachees`

Master list of referees/coachees.

Common fields: `full_name`, `first_name`, `last_name`, `email`, `phone`, `referee_level`, `stage`, `groups`, `feedback_entries`, `last_feedback_at`.

### `referee_coaches` (people directory)

Directory of RC persons.

Common fields: `first_name`, `last_name`, `email`, `phone`, `active`, `is_rc_president`.
`is_admin` and `pin_hash` are no longer read by anything — the columns may still
hold data from before the per-person login was removed.

`is_rc_president` no longer opens anything. It used to be the sole key to the
post-visit survey responses; when the per-person login went, that gate moved to
the chair's own console password (`PRESIDENT_UI_PASSWORD` — see Credentials),
and the flag was left behind as a label on her row.

Since 2026-09-07 it has one job again: it is the address the 4.4.10 SR-Spiel
Rückmeldung is **mailed** to as it is filed. Flag nobody and the notes are still
stored and still readable in her tab, but no mail goes out — the API logs
`rc_note.no_recipient` when that happens. Set it directly in PocketBase: it is
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
Created by `deploy/hetzner/seed/setup-schema.mjs`, which is tracked in this
repo. It is additive and safe to re-run against the live DB — that is how a
column the app has started writing gets added.

### `parked_drafts` (the server copy of unfinished work)

A backup of an observation the coach has not finished, written **always, not on
request**. Every other copy of a draft is device-local (`src/lib/formDraft.ts`,
IndexedDB), which is right until the phone is lost, stolen, wiped or simply dead
— and then the work goes with it, along with two signatures nobody can collect a
second time. That failure gives no warning, so it is not something a coach can
usefully be asked about in advance.

**What this means for the data at rest:** every in-progress observation in the
association — ratings, written remarks, and both signature images — is on this
server while it is being written, and not only on the coach's phone. Reads are
scoped to the session's own RC, so no colleague and no admin console password
opens another coach's unfinished work. Rows are pruned to 45 days or the newest
12 per coach, and a draft is deleted outright the moment its report is filed,
reset or discarded — so the table holds work in progress and nothing else.

The frontend shows this rather than asking about it: the form's save line reads
"Auf dem Server gesichert" once a park has succeeded, with the signatures called
out in its tooltip.

Common fields: `owner_id`, `game_id`, `role`, `updated_at`, `schema`, `payload`.

`owner_id` is the RC's id **from the session**, never from a request body. Every
read and every write filters on it, so a coach cannot fetch, overwrite or delete
a colleague's unfinished observation — the rule is spelled out in full over
`/api/drafts/parked` in `server/index.ts`. An admin console session gets 403
here for the same reason it does on `/api/ical/me`: a parked draft belongs to a
person, and a console session is not one.

`payload` is one role's `DraftRecord` minus its identity fields (`id`,
`ownerId`, `submissionKey`) and always status `editing`. Both signature images
travel — they are the reason the feature exists — because a parked draft only
ever comes back to the coach who parked it. The server stores it opaquely: it
files nothing, mails nothing and creates no observation from it. `updated_at` is
the device's clock (it decides which of two copies is newer); the autodate
`updated` column is the server's own, which is the one to trust when a tablet
boots in 1970. Rows are pruned per owner after 45 days, and beyond the newest 12.

Created by `deploy/hetzner/seed/setup-schema.mjs` like the collections above.
**After deploying the code, apply it on the API host** — the container has both
node and the script, and its own env resolves `http://pocketbase:8090`:

```bash
docker exec svrz-rc-svrz-api-1 node deploy/hetzner/seed/setup-schema.mjs
```

It is additive and safe to re-run. Until it has run, parking answers
`Die Sammlung „parked_drafts" fehlt in PocketBase` on a write — said out loud
rather than silently succeeding, because a coach told their work is safe when it
is nowhere is the one failure this feature must not have. Reads stay quiet and
answer "nothing parked", which is true.

## API Authentication Model

Three layers, plus capability tokens:

1. **PocketBase admin auth** (server-side, via env creds) for every DB
   operation. The browser never talks to PocketBase.
2. **App session cookie** `svrz_rc_session` — who the app is acting as. Signed
   (HMAC, `ADMIN_SESSION_SECRET`), `httpOnly`, 30 days. There is exactly one way
   to open it: `POST /api/auth/shared/login` with the team credential. It starts
   with **no identity** — every `requireRcSession` route answers 401 until
   `POST /api/auth/rc/identify` names an RC (the list comes from
   `GET /api/auth/rc/roster`). That name is a **claim, not a proof**, so the
   session gets coach-level access and nothing more. Re-callable, which is how
   "switch RC" works.

   There used to be a second kind (`mode: 'personal'`, a per-RC e-mail and
   password) and it was the only thing that could prove identity, which is why
   `is_admin` and `is_rc_president` hung off it. It is gone; both privileges now
   have their own password on the admin page. Tokens issued before this carry a
   `mode` and a PIN fingerprint, and both are simply ignored — which keeps
   everyone signed in across the deploy and can only lose privileges, never
   grant them.
3. **Console cookie** `svrz_admin_session` — opened by `POST /api/admin/ui-login`
   only. One form, two credentials, and which username was typed decides the
   `role` stamped into the token:
   - `admin` (`ADMIN_UI_USERNAME` / `ADMIN_UI_PASSWORD`) — implies admin
     everywhere. Does **not** open the chair's tabs.
   - `president` (`PRESIDENT_UI_USERNAME` / `PRESIDENT_UI_PASSWORD`) — opens the
     survey answers and the private notes, and nothing else. Every admin route
     answers 401 to it.
   A token with no role is read as `admin` (that is what pre-deploy cookies are).
   Usernames are compared case-insensitively (a phone keyboard capitalises the
   first letter of a name field); the passwords are the secrets. Both credentials
   are always checked before the answer, and a rejection says only "Invalid
   credentials" — which half was wrong is recorded in the activity log
   (`userMatched`) for the admin, not returned to the caller.

   **Storage:** all three passwords (team, admin, chair) live in `app_settings`
   as a scrypt hash over a per-record random salt, and are changed from
   Admin → Einstellungen → Passwörter. The env vars above are the bootstrap: a
   slot never written in the console falls back to its variable. Hashes never
   leave the server, and a password that has been set cannot be read back —
   only replaced.

   **Changing one takes a second factor.** `POST /api/admin/credentials/challenge`
   mails a 6-digit code to `CREDENTIAL_2FA_EMAIL_<SLOT>` if set, else
   `CREDENTIAL_2FA_EMAIL`. There is deliberately no fallback to
   `POCKETBASE_ADMIN_EMAIL`: that address is incidental to how the database
   account was named, and while it was `rc-admin@svrz.local` the old fallback
   silently mailed codes into a mailbox that did not exist — reporting success
   the whole time. The chair's slot points at a different mailbox
   from the two operational ones on purpose; `PUT /api/admin/credentials` refuses without it.
   The code is bound to the console cookie that asked for it **and** to the one
   slot it was issued for, is single-use, expires in 10 minutes and dies after 5
   wrong guesses. Reading which usernames are live needs only the admin session;
   changing one does not. Under `TEST_MODE` the code is printed to the server
   console instead of mailed, so a test deployment can still rotate a password.
   If mail is down, the env vars remain the escape hatch.
4. **Capability tokens** in the URL for the two pages that have no session at
   all: `#/sign/<slug>` (signature capture) and `#/survey/<token>` (post-visit
   survey, sent to referees who are not app users) — plus the calendar feed
   token, which is the credential in a subscription URL a calendar app cannot
   log in with.

   The feed token used to be derived from the RC's id alone, which made it
   **unrevocable**: anyone holding the team password could pick any name, call
   `/api/ical/me`, and keep that coach's feed forever — through every later
   rotation of the password they obtained it with. It now hangs off a per-person
   random secret in `app_settings` (`ical_secrets`), minted on demand and never
   by the public lookup. Rotating the team password drops the whole map, so
   every feed handed out under the old password dies with it; a coach can also
   rotate only their own from the calendar dialog. Both cost every subscribed
   calendar a re-subscribe, which is the price of being able to take a leaked
   link back at all.

`GET /api/auth/me` reports the state the client needs to route on:
`{ rc, admin, surveyReader, shared, needsIdentity }` — where `needsIdentity`
means "signed in, but nobody yet: show the picker, not the login screen".

Middleware:

- `requireAdminSession` — a console cookie with `role: 'admin'`, and nothing
  else.
- `requireRcSession` — any identified app session, **or** an admin console
  cookie. Every app session gets its identity attached and is scoped to it;
  enforcement sites read "no identity attached" as full access, which is safe
  precisely because only an admin console session can reach a handler without
  one.
- `requireSurveyReader` — a console cookie with `role: 'president'`, and nothing
  else. Admin rights deliberately do not open it.

Nothing outside the four capability-token routes and `/api/client-logs` is
reachable without a session.

## API Endpoints (What They Do)

- `GET /api/health`: checks PocketBase reachability + admin auth.
- `GET /api/eligible-games`: games filtered to coachees by name matching.
- `GET /api/referee-coach-people`: active RC people list for assignment/selectors.
- `PUT /api/games/:id/assign-rc`: assign RC to a game.
- `GET /api/rc-overview`: per-RC done/outstanding/planned summary.
- `GET /api/rc-overview/:rcName/coachees`: per-RC coachee breakdown.
- `POST /api/games/sync`: run game sync from Swiss Volley data. Records its outcome under the `games_sync_status` setting exactly as the cron does, so a run started by hand shows up in the admin console's readout. On failure it answers the upstream reason, not `Internal server error` — the admin clicking it is the one who has to go fix the VolleyManager account.
- `POST /api/games/sync/debug`: run sync with debug trace payload.
- `POST /api/vm/auth-check`: validate upstream auth/session.
- `GET /api/survey/:token`: **public** — prefill data for the post-visit survey page. No login; the token is the capability, so no name or match number rides in the URL.
- `POST /api/survey/:token`: **public** — submit the survey. Write-once (409 if already answered), own per-IP rate-limit bucket.
- `GET /api/survey-responses`: read the responses. Gated on `requireSurveyReader` — the chair's own console password, **not** admin rights (an admin session gets 403) and **not** the `is_rc_president` flag, which grants nothing. Not under `/api/admin/` for that reason, and not `/api/survey/responses`, which the `:token` route above would swallow.
- `GET /api/rc-game-notes`: read every filed 4.4.10 Rückmeldung. Same `requireSurveyReader` gate as the survey answers and `/api/president-notes`. A coach reads their own note back through `/api/rc-games`, never this.
- `POST /api/rc-game-notes`: file (or rewrite) one Rückmeldung. RC session; the game, the role and the coachee are re-derived server-side, so a coach who was not on that whistle gets 403. Body is redacted in the activity log.
- `GET /api/docs/:id`: **public** — the rulebooks, proxied. volleyball.ch and fivb.com serve their PDFs with no `Access-Control-Allow-Origin`, so the browser may link to them but not read them, and the in-app reader needs the bytes. Four allowlisted ids (`rules-de`, `rules-en`, `rule-changes`, `niveau`) — not a URL parameter, which would be an SSRF hole. Each is held in memory and revalidated against its upstream ETag every 6 h; if upstream is down the last good copy is served rather than an error.
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
- `GET /api/drafts/parked`: this coach's parked (unfinished) drafts — metadata and payload, newest first. Owner comes from the session; nothing parked is an empty list, never a 404.
- `PUT|POST /api/drafts/parked/:gameId`: park (upsert) the draft set for one game, both roles in one call. POST is accepted as well as PUT because the send that survives a page going away (`sendBeacon` / `fetch` with `keepalive`) can only POST — it caps the body near 64 KiB, so it fits a draft with no signatures yet. Own rate-limit bucket keyed by RC id, and its own 2 MB body limit — checked ahead of the JSON parser, since a draft carries up to four signature PNGs as data URLs.
- `DELETE /api/drafts/parked/:gameId`: unpark one game, both roles. Removing nothing is a success.
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

Automatic sync runs inside `server/index.ts`:

- cron default: `0 1 * * *` — the hour is load-bearing, see "The shared
  VolleyManager account": it keeps us clear of wiedisync, which shares the one VM
  login from another host and cannot be locked against
- timezone default: `Europe/Zurich`
- retries (cron path): configurable via env vars

### SR-Börse poller

Hourly, round the clock, **skipping 04:00 UTC** — that hour belongs to wiedisync.
Hourly rather than "waking hours plus 8 h and 4 h before kick-off" because hourly
satisfies both for every game without anyone maintaining a table of kick-offs.

- `server/boerse.ts` reads VolleyManager; `runBoerseSync` in `server/index.ts`
  writes `boerse_offers` and the `boerse_sync_status` setting.
- `scheduleEvery`, **not** a cron — see the node-cron note below; anything
  sub-daily would answer "1 January next year" across a DST switch.
- Takes `tryVmLock`, so it SKIPS when another VM job holds the account rather
  than queueing in front of the nightly import.
- Claims `RefAdmin:Referee`, asserts the **attribute value id**, and restores
  whatever role it found — the account is shared and cannot be locked across
  hosts.
- Also corrects `games.first_referee/second_referee` from the convocation array
  on any game it sees. That is not a bonus: `runGamesSync` refreshes only
  `league` on a game whose coachee has been swapped off, so those names were
  stale for good. The first run corrected 91.

```bash
# status, including matchedGames / unmatchedOffers / joinVia / consecutiveFailures
curl -s -b cookies http://127.0.0.1:8787/api/admin/boerse/status
# run it by hand (~80 s)
curl -s -b cookies -X POST http://127.0.0.1:8787/api/admin/boerse/sync
```

⚠ **`unmatchedOffers` is the day-one alarm** for whether VM's `game.number` is
formatted like our `match_no`. It sits around 55, and every one of those is a
game with no coachee — `runGamesSync` only persists games that carry one — so it
is expected, not a fault. A jump means the join broke.

**Not node-cron.** Measured against the installed 4.2.1: ask its matcher for the
next run after the last one before a DST switch and it answers **1 January of
the next year** — for the March switch and the October one alike (a control walk
in June steps day by day, so it is the switch that breaks it). In production
that means the reminder, the sync and the log prune stop on 25.10.2026 and come
back on 01.01.2027, mid-season, with nothing in the log to say why; only a
redeploy brings them back, which is probably why it was never noticed.

The three daily jobs therefore run on `scheduleDaily()` — a self-rescheduling
timer over `zonedParts` + `wallClockToInstant`, the pair the iCal feed already
trusts. Each run computes the next wall-clock instant from scratch, so a switch
can only make one interval an hour longer or shorter. Each arming is logged
(`scheduler.armed`, with the next instant), so "is the reminder still scheduled"
is answerable from the log. A pattern that is not `m h * * *` still goes to
node-cron, with a warning naming this trap — keep the daily jobs on the plain
pattern.

Production note: the API container runs with `restart: unless-stopped` so the
schedule stays alive; if the container is stopped, nothing runs.

To run the import without waiting for the cron: admin console → Settings →
"Game import (VolleyManager)" → **Import now**. Same window and same code path
as the nightly run, and it records the same status note.

There is a second job: the match reminder, `REMINDER_CRON` (default
`0 10 * * *`, same timezone), which mails each coachee the day before a game an
RC has taken.

### A scheduled job must authenticate PocketBase itself

Every route handler calls `ensureAdminAuth()` before it touches PocketBase, so
under HTTP traffic the shared client is always somebody's authenticated session
and a helper that forgets to authenticate still works. A cron firing at 10:00
into a quiet process has no such session, and PocketBase answers
`403: Only superusers can perform this action`.

That is not hypothetical: the reminder failed **every day from 2026-07-25 to
2026-08-23** — 19 recorded runs, nothing sent, nothing visible outside
`reminder.run` lines in the activity log. `runMatchReminders()` reads
`reminder_enabled` first, `getSettingRecord()` was the one data helper without
an `ensureAdminAuth()` call, and the job died on its opening line. The 05:00
games sync was spared only because it reaches PocketBase through
`listCoacheesWithFallbackSort()`, which does authenticate.

Fixed at the helper. When adding an unattended path, check that its **first**
PocketBase call goes through something that authenticates — a passing test under
an HTTP request proves nothing about a cron.

## Activity Log (Debugging What Users Actually Did)

`server/logstore.ts` collects everything the system does, from both sides:

- **Server** — one `req.in` / `req.out` pair per request (method, path, status,
  duration, IP, identity, correlation id), every auth decision with its *reason*,
  every rate-limit denial with the bucket that tripped, every unhandled error.
- **Browser** — the app (`src/lib/logger.ts`) records clicks, form submits, all
  fetches with their status, JS errors, React crashes, online/offline, and ships
  them to `POST /api/client-logs` (also on `pagehide`, via `sendBeacon`).
- **Every `console.*` call, on both sides.** `captureConsole()` runs before
  anything else in `server/index.ts`, and the browser patches its console at
  install time. A library's stack trace or a leftover debug line is no longer a
  thing only `docker compose logs` ever saw — and that stdout is thrown away by
  the next redeploy. `console.log`/`info`/`debug` land at debug level, so they
  are there when you replay a session and out of the way when you are not.
- **The reason a request failed.** `req.out` carries the JSON body a 4xx/5xx
  actually sent the caller. `safeError()` already logged the cause behind a 500;
  a 400/403/409 is produced by a plain `res.status(...).json({ error })` in a
  handler, and that reason used to live only in the response nobody kept.

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
`LOG_RETENTION_DAYS` (30), `LOG_TO_FILE=0` to disable the file sink,
`LOG_READ_TOKEN` (see below).

Files are named by the **local** date (`TZ=Europe/Zurich` in the container), not
by UTC — otherwise "today's log" started at 02:00 and every evening after 22:00
was filed under tomorrow.

### Errors come to you (`ERROR_ALERT_EMAIL`)

Nobody opens a log without a reason to, and the failures that cost the most are
the ones nobody reports — a cron that died at 05:00, a 500 on a submit somebody
quietly gave up on. `server/erroralerts.ts` subscribes to the store and mails
error-level entries (both sides — a React crash on a phone included) to
`ERROR_ALERT_EMAIL`.

It is built not to become noise, because an alert channel that cries wolf is
worse than none:

- one digest per burst (`ERROR_ALERT_DEBOUNCE_MS`, default 2 min), never one
  mail per line;
- an hour's cooldown per failure CLASS (`ERROR_ALERT_COOLDOWN_MS`) — the same
  failure repeating 400 times mails once, and the count rides along;
- at most `ERROR_ALERT_MAX_PER_HOUR` (6) mails an hour; the rest waits;
- a class muted in Admin → Protokoll sends no mail — silencing the noise in the
  console silences the alert about it, which is what a reader expects;
- `TEST_MODE=1` suppresses the send and logs `alert.suppressed` with the subject
  it would have used;
- alerting never alerts about itself (`alert.*` is excluded), so a broken SMTP
  cannot loop.

**Only real failures should be error level.** A rejected CORS origin and a
malformed body are the API working as designed and are logged at `warn` for
exactly this reason. When adding a `log.error`, ask whether it should wake
somebody up.

### Reading it from a terminal (`/api/admin/error-logs`)

The Protokoll tab reads the in-memory ring: live, and empty again after every
redeploy. The forensic half — the daily JSONL files, 30 days back — is served by
`server/logquery.ts` behind a **bearer token** (`LOG_READ_TOKEN`, ≥24 random
characters; an admin console session is also accepted). Set it in
`deploy/hetzner/svrz-api.env`. Unset, the routes answer only a browser session.

```bash
API=https://svrz-rc-api.openvolley.app
T="Authorization: Bearer $LOG_READ_TOKEN"

curl -s -H "$T" "$API/api/admin/error-logs"                       # today, warn+
curl -s -H "$T" "$API/api/admin/error-logs?group=1"               # one row per distinct failure, biggest first
curl -s -H "$T" "$API/api/admin/error-logs?date=2026-09-08&level=error"
curl -s -H "$T" "$API/api/admin/error-logs?level=debug&sid=<sid>" # replay one browser session, everything
curl -s -H "$T" "$API/api/admin/error-logs/dates"                 # which days exist
```

Filters: `date`, `level` (default `warn`), `src` (`server`/`client`), `evt`
(prefix), `sid`, `did`, `user`, `reqId`, `status`, `q` (substring over the whole
entry), `limit`, `group`, `show_solved`, `show_muted`.

Triage, so a log that records every click stays readable — both stored in
`LOG_DIR/log-notes.json`, beside the logs they describe:

- `POST /api/admin/error-logs/annotate` — mark ONE occurrence (`hash`, or
  `hashes` for a batch) `solved` / `important` / `open`, with a note and the
  commit that fixed it. Solved is hidden unless `show_solved=1`.
- `/api/admin/error-logs/mute-rules` (GET/POST/PATCH/DELETE) — hide a whole
  CLASS: an `evt` prefix and/or a case-insensitive `match` on the message. A
  rule with neither is refused; `important` outranks any rule; nothing is
  deleted from the files (`show_muted=1` brings it back).

Each entry carries a `hash` (this occurrence — the handle for an annotation) and
a `group` (the class: level + event + message with ids, numbers and timings
blanked, so 400 copies of one failure collapse into a single row).

## Upstream Sync Troubleshooting

### ⚠ The shared VolleyManager account — read before touching ANY VM job

There is **one** VolleyManager login (`luca_canepa`), and every entry point lives
inside it. Two codebases use it:

| project | what runs | where |
|---|---|---|
| **svrz_rc** (this repo) | games sync, contact sync, auth check | API container, lenovoserver |
| **wiedisync** | `vm_sync`, `svrz_sync`, game/nomination pushes | Directus, hetzner |
| kscw-website | **nothing** — it only *links* to volleyball.ch, holds no credentials. Keep it that way. |

VM keeps the active role **per account, not per session**, and it persists across
logins. Every job switches into the role it needs before it starts, so two jobs
overlapping means the loser reads under the winner's role — and for the
club-scoped resources that is not a 403 but a **200 with the wrong rows**.

**Neither project can lock the other.** wiedisync's `claimVmAccount` is a
`globalThis` flag inside its Directus process; this repo's `withVmLock`
(`server/vmlock.ts`) is in the API process on a different host. Each stops its
*own* jobs colliding and is blind to the other's. The only cross-project
protection is disjoint windows and the table below.

| UTC | job | project | role it claims |
|---|---|---|---|
| **Mon 04:00** | `vm_sync` (`vm-sync-check.mjs`) | wiedisync | `VM_ROLE_CLUB` `4cdade68…`, + `SPIELPLANER` `ed24d37c…` for contacts |
| **daily 04:30** | `svrz_sync` (`svrz-scheduling-sync.mjs`) | wiedisync | same |
| **every 30 min** | `vm_sync` watchdog retry | wiedisync | same |
| **every 5 min** | Einsatzliste push, for a game ~60 min out | wiedisync | club — ⚠ takes NO claim |
| **daily 23:00 / 00:00 UTC** | games sync (`0 1 * * *` Europe/Zurich) | svrz_rc | `RefereeDelegate` `e693b8cf…` |
| on demand | game push (booking confirmed) | wiedisync | club |
| on demand | manual import, contact sync, auth check | svrz_rc | RefereeDelegate / club |

**Why 01:00 Zürich (fixed 2026-09-10).** The hour has to clear two unrelated
things. wiedisync: 05:00 Zürich — where this used to sit — is 03:00 UTC in summer
but **04:00 UTC in winter**, exactly their Monday `vm_sync`, so for half of every
year the two fired at the same minute and whichever lost read under the other's
role. And **this host's own backup chain**: `svrz-rc-backup.timer` writes a
coherent PocketBase zip at **02:45** specifically so `borg-backup.timer` (~03:00)
archives that rather than the live files — so 03:00, briefly considered, would
have put a live writer inside a window someone deliberately made quiet. 01:00
Zürich is 23:00/00:00 UTC: clear of wiedisync's 04:00 and 04:30, clear of the
backup chain, clear of `dpkg-db-backup` at 00:00 and of our own log prune at
03:30 — and still an hour with no game kicking off, so their every-5-minutes
Einsatzliste push has nothing to fire for either. wiedisync's crons carry no
timezone argument and its code comments state UTC.

⚠ **The residual risk, and why it is accepted.** wiedisync's Einsatzliste push
(`*/5 * * * *` → `vm-push-nomination.mjs`) logs into this account and does **not**
take their own `claimVmAccount`, so it can collide with anything — including
their own `vm_sync`. Windows cannot fence an event-driven job. A cross-host lease
was considered and rejected: everything KSCW is on hetzner, this is on
lenovoserver, and coupling the two at runtime buys less than it costs. The
mitigations instead are: pick dead hours (above), keep every role hold as short
as possible, and never leave the account resting in a role we chose.

**If you add or move a VM job:** read this table first, then update **both**
`svrz_rc/infrastructure.md` and `wiedisync/INFRA.md` in the same change. A window
written down in only one repo is not a window — the other project cannot see your
scheduler, and the failure it causes there is silent.

### VolleyManager roles: each sync claims the one it needs

One VM account, and **no single role can do both jobs**. Measured 2026-08-12
against the production account:

| active role | `refadmin/refereegame` (games sync) | `refereeaddressviewer` (contact sync) |
|---|---|---|
| `Indoorvolleyball.RefAdmin:RefereeDelegate` | **200** | 403 |
| `SportManager.Indoorvolleyball:PlayingScheduleResponsible` | 403 | **200** |
| `SportManager.Indoorvolleyball:ClubAdministrator` / `TeamResponsible` | 403 | **200** |
| every other role the account holds | 403 | 403 |

**Three jobs now, not two.** Re-measured 2026-09-10 by switching the live account
through all 9 of its roles and restoring it, this time including the SR-Börse
(`refadmin/refereegameexchange`). `200:n` = allowed, n rows:

| attribute value id | role | börse | games | contacts |
|---|---|---|---|---|
| `b87653c7-…` | `RefAdmin:Referee` (SVRZ) | **200:3629** | 403 | 403 |
| `e693b8cf-…` | `RefAdmin:RefereeDelegate` | **403** | **200** | 403 |
| `cfd8a602-…` | `RefAdmin:Referee` (other assoc.) | 200:**0** | 403 | 403 |
| `4cdade68-…` | `ClubAdministrator` | 200:**5** | 403 | 200 |
| `ed24d37c-…` | `PlayingScheduleResponsible` | 200:**5** | 403 | 200 |
| `02e6fa7a-…` | `TeamResponsible` | 403 | 403 | 200 |
| `a02498b2-…` | `IndoorPlayer` | 403 | 403 | 403 |
| `5453d0c6-…` | `CoachAdmin:IndoorCoach` | 403 | 403 | 403 |
| `925ce0aa-…` | `Beachvolleyball:Player` | 403 | 403 | 403 |

⚠⚠ **The börse and the games sync can never share a role** — RefereeDelegate,
which `VM_ROLE_FOR_GAMES` claims, is 403 on the börse.

⚠⚠ **Three roles answer the börse `200` with the WRONG row count**, which is far
more dangerous than a 403: `cfd8a602` is a *second* `RefAdmin:Referee` attribute
for a different association and returns **zero rows**; the club roles return
five. A role drift therefore reads as "nothing is in the börse". The role
*identifier* cannot detect this — `b87653c7` and `cfd8a602` are both
`Indoorvolleyball.RefAdmin:Referee`. Assert the **attribute value id** and a
row-count floor, never the role name.

The active role is **per account and persists** — a fresh login keeps whatever
was last chosen, in the VM UI or by us. So whichever role a human last picked
decided whether the games import worked, and it silently imported nothing for
three weeks after someone selected a club role.

Both jobs now switch the session into the role they need before starting
(`vmSwitchRole`), including on the cached-session path, since the role lives on
the account rather than on the cache. **Nothing needs to be kept selected by
hand any more** — pick whatever role you like in VolleyManager.

```
PUT /api/sportmanager.security/api%5cparty/switchRoleAndAttribute
    attributeValueAsArray[0]=<attribute value id>&__csrfToken=<token from the dashboard>
```

The id is an *attribute value*, not a role name: the
`persistenceObjectIdentifier` of an entry in
`party.groupedEligibleAttributeValues`, which
`GET /api/sportmanager.security/api%5cparty?party[__identity]=<partyId>` returns
(the account menu calls it). They are per-account, so if `VM_USERNAME` changes,
re-read them there and set `VM_ROLE_ATTRIBUTE_GAMES` /
`VM_ROLE_ATTRIBUTE_CONTACTS`; the code carries the current account's as
defaults.

**The contact sync's games fallback is off, and cannot be made to work.** It
scraped referee contacts off game convocations for people missing from the
address list. Two findings, 2026-08-13:

1. It used to fail with `Upstream search failed: 500` — a **date-format bug on
   our side**, not permissions. It built `2025-09-01T00:00:00` by hand while the
   games sync sends a full ISO timestamp, and VolleyManager's search answers 500
   (not 400, not an empty result) for a date without the timezone suffix. Fixed.
2. With that fixed the search returns 1401 games with convocations attached —
   and the convocation's `person` object carries **41 properties, none of them
   contact details**: `displayName` is there, email and phone are simply absent.
   VolleyManager strips them for the referee-delegate role, and the club roles
   that do expose contacts cannot open the game list at all (see the table
   above). No role this account holds can do both.

So the pass could only ever spend a 1401-game scrape, several minutes and eight
upstream calls, to find nothing. It is now **skipped by default** and reports
why; pass `{"useGames": true}` to `POST /api/admin/coachees/sync-contacts` to run
it anyway, which is worth doing only if the account gains a new role.

Consequence: coachees who are not on VolleyManager's referee address list have
no e-mail, and feedback cannot be submitted for them. As of 2026-08-13 that is
32 of 83 for season 2025. They have to be filled in by hand in the admin console
(or added to the referee list upstream).

The failure used to be **silent to users**: the cron logged an error and
stopped, and nothing surfaced it, which is how three weeks passed unnoticed.
The admin console's Settings tab now carries both halves of the answer — the
last-run readout and the button that runs it again — and the contact sync
reports the upstream error itself rather than `Internal server error`.


Game sync uses Swiss Volley public data with authenticated access. For detailed implementation notes (auth flow, headers, API properties, troubleshooting runbook), see `infrastructure.private.md`.

## Frontend Hosting / API Routing Notes

- Local dev: frontend uses relative `/api/*` and Vite proxy.
- Static hosting: set `VITE_API_BASE_URL` to the absolute API origin.
- Production app origin: `https://svrz-rc.openvolley.app` (Cloudflare Pages).
- Production API origin: `https://svrz-rc-api.openvolley.app` (Cloudflare Tunnel).
- Vite base is `/` in every mode — the app owns the root of its own domain, so
  dev and prod no longer disagree about where assets live.

Deployment is GitHub Actions → Cloudflare Pages (`.github/workflows/deploy.yml`);
GitHub Pages was retired in July 2026 and Codeberg/Woodpecker before it in June.
The workflow type-checks and runs the Playwright suite before it builds, then
publishes with `npx wrangler pages deploy` (project and output dir come from
`wrangler.jsonc`; auth from the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
repo secrets). `public/_headers` and `public/_redirects` ship with the build.

Both hostnames are exactly one label under `openvolley.app` on purpose.
Cloudflare's Universal SSL wildcard covers `*.openvolley.app` and nothing
deeper, so a two-level name like `api.svrz-rc.openvolley.app` would have no edge
certificate — the same trap that killed `rc-api.volleyball.lucanepa.com`. And
because `.app` is HSTS-preloaded, there is no HTTP fallback to limp along on.
For the same reason the hostname uses a hyphen: underscores are forbidden in
certificate SANs, so `svrz_rc.openvolley.app` could never have been issued one.

The retired `lucanepa.github.io/svrz_rc/` still publishes `legacy/` via
`.github/workflows/legacy-pages.yml` — a redirect page and a replacement
service worker that clears the old precache and unregisters itself. See
`legacy/README.md`.

## Session cookies

The app (`svrz-rc.openvolley.app`) and the API (`svrz-rc-api.openvolley.app`)
share the registrable domain `openvolley.app`, so they are **same-site** even
though they are different origins. The session cookies are therefore first-party
and can be `SameSite=Lax; Secure`, which is what makes login work in Safari and
other WebKit browsers — they block third-party cookies by default, and under the
old split (`lucanepa.github.io` app + `rc-api.lucanepa.com` API) that silently
bounced a correct PIN back to the login screen.

`SESSION_COOKIE_SAMESITE` in `svrz-api.env` selects the mode (`none` by default,
`lax` after cutover). It is an env knob because the code ships before the DNS and
Tunnel change: `lax` against a cross-site API logs everyone out. Cross-origin
still means CORS applies — `CORS_ALLOWED_ORIGINS` must list the app origin.

## Deploy trap: a 404 fallback cached under an asset URL

`_headers` marks `/assets/*` `immutable, max-age=31536000`, and the Pages
project answers unknown paths with `index.html` at status **200** (SPA
handling). Those two combine badly during the minute or so after a deploy while
the new files propagate: a request for a hashed asset that has not landed yet
gets the fallback HTML, and the edge caches that HTML **under the asset's URL,
for a year**. Clients whose requests land on that cache shard then load an
`index.html` where the JS should be, and the app is a blank page. Seen for real
on 2026-08-12; `cf-cache-status: HIT` with `content-type: text/html` on
`/assets/index-*.js` is the fingerprint.

**Fixed 2026-08-12** by adding `public/404.html`. Cloudflare Pages serves that
with a real **404** for unmatched paths instead of falling back to `index.html`
at 200, and a 404 does not get cached in an asset's place. Nothing needed the
fallback: every route in this app lives in the URL hash (`#/admin`,
`#/sign/<slug>`, `#/survey/<token>`), so no path other than `/` is ever
requested from the server. Verify after any change to Pages' not-found handling:

```bash
curl -so /dev/null -w '%{http_code} %{content_type}\n' \
  https://svrz-rc.openvolley.app/assets/nope-abc123.js
# must be 404 — a 200 text/html here means the trap is back
```

Two consequences worth knowing:

- **Do not fetch canonical asset URLs immediately after a deploy.** That is how
  the bad response gets cached in the first place — a verification script can
  poison the very build it is checking. Probe with a throwaway query
  (`/assets/index-x.js?cb=123`) so anything wrong is cached under a URL nothing
  references, and leave the real one alone until the deploy has settled.
- **Recovering needs a new URL, not a new deploy.** The JS hash changes on
  every build (the bundle carries a build timestamp), so a redeploy fixes the
  script by accident. The CSS hash does not — it only changes when the CSS
  changes — so a poisoned stylesheet survives any number of redeploys and the
  app comes back up unstyled. Either purge the Cloudflare cache (zone-level
  Cache Purge token, which CI does not have) or make a real change to
  `src/index.css` so it hashes differently.

## Backups

`deploy/hetzner/pb_data` is a bind mount and the only live copy of every
feedback, PDF, president's note and credential hash. Two things protect it, and
they do different jobs.

**1. A consistent nightly snapshot — `deploy/hetzner/backup-pb.sh`**, scheduled
by `svrz-rc-backup.timer` at 02:45 (units tracked in `deploy/hetzner/systemd/`).
It asks PocketBase itself for the snapshot through `POST /api/backups`, driven
from inside the API container so no superuser credential is ever read out onto
the host. That matters: borg copies `data.db` at the filesystem level while
PocketBase is writing, and SQLite in WAL mode is mid-transaction at arbitrary
moments — a file-level copy of a live database is a copy that *usually* restores.
The zip is moved out of `pb_data` (a backup inside the directory it backs up is
not a second copy), verified by opening it and checking `data.db` is present and
plausibly sized, and rotated at 14 local copies. Logs to
`~/svrz-rc-backup.log`; on failure it also appends to `~/BACKUP-FAILED-svrz-rc`,
because the failure mode that actually hurts is the silent one.

Note PocketBase validates the backup NAME: lowercase, digits and hyphens only.
An ISO timestamp's `T` is rejected with a 400 "Must be in a valid format".

**2. Offsite — the host's `borg-backup.timer`** (~03:05, to a Synology over
Tailscale, 30 daily / 4 weekly / 6 monthly). It archives `/` with no exclusion
covering this project, so `pb_data` and the snapshot zips both travel. Ordering
is deliberate: the 02:45 snapshot exists before borg runs, so the offsite archive
of any given night contains a known-restorable artifact and not only the live
files.

**Verify a restore, don't assume one.** Rehearsed 2026-08-28:

```bash
python3 - <<'PY'
import zipfile, sqlite3, glob
src = sorted(glob.glob('/home/lucanepa/svrz_rc/backups/svrz-rc-*.zip'))[-1]
zipfile.ZipFile(src).extractall('/tmp/restore-check')
con = sqlite3.connect('file:/tmp/restore-check/data.db?mode=ro', uri=True)
print(con.execute('PRAGMA integrity_check').fetchone()[0])
print(con.execute('SELECT count(*) FROM coachees').fetchone()[0], 'coachees')
PY
```

**The failure that has actually happened:** borg failed on 27 and 28.08.2026
(`rc=2`, the NAS unreachable over Tailscale) and nothing said so — the last good
offsite archive was 26.08. Nothing alerts on a failed timer, so the snapshot
script prints how old the newest successful borg run is and warns past 48h. If
that warning appears, check the NAS is up (`ping` its Tailscale IP) before
assuming the backup is fine.

Superseded copies of `svrz-api.env` are consolidated into
`svrz-api.env-history-<date>.tar.gz` (0600) rather than left as loose `.bak-*`
files. They are still plaintext secrets on disk; `gpg` is available on the host
if that is ever worth hardening properly.

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
