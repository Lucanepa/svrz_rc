# From PocketBase to PostgreSQL + Prisma — plan (2026-10-10)

Luca, 10.10.2026: "let's also migrate … plan prisma + postgres" — not Supabase,
not Directus, "keep it as simple as it is". PocketBase was updated to 0.40.5 the
same day and stays in production until the cutover below.

## Versions

| Piece | Version | Notes |
|---|---|---|
| PostgreSQL | **18** (18.6, Aug 2026; supported to Nov 2030) | official `postgres:18-alpine` image, pinned to a minor |
| Prisma ORM | **7.x** (`@prisma/client` 7.10) | pin `prisma` and `@prisma/client` to `~7.10` — npm's `prisma` "latest" tag pointed at an 8.0 release candidate on 10.10 |
| Admin view | Prisma Studio (`npx prisma studio`) | over an SSH tunnel to lenovoserver, never public — replaces the PocketBase dashboard |

## Why (short)

Transactions instead of in-process locks; typed queries instead of string
filters (`` `id = "${escapeFilterValue(x)}"` ``); constraints the database
enforces (unique match number per real fixture, foreign keys); no hidden text
caps (10.10: the president notes outgrew PocketBase's 5000-character default);
real timestamps instead of ISO text (the space-vs-`T` filter trap goes away);
versioned migrations instead of the additive-only `setup-schema.mjs`; sums and
joins in SQL for Statistik and the overview, which today read whole tables.

## What does NOT change

- The Express API, every URL and every response shape. **No frontend change.**
- Record ids: PocketBase's 15-character ids are kept as text primary keys, and
  new rows get the same format, so `/form/<id>`, iCal feeds, signature and
  survey tokens, and filed links keep working.
- PDFs and other files keep their URLs (served by the API, as today).

## Target schema

One Prisma model per collection in use, like for like:

| Collection | API call sites | Notes |
|---|---|---|
| games | 56 | `match_date` → `timestamptz`; `feedback_closed_roles`, `handed_over` → `jsonb`; index on `match_no`, `match_date`, `assigned_rc_id` |
| referee_coach_feedbacks | 28 | `feedback_json` `jsonb`; FK game/coachee `ON DELETE SET NULL` (forms are detached, not deleted); `pdf_file` → files volume |
| coachees | 24 | `season`, `referee_id`; `notes` unlimited `text` |
| referee_coaches (people) | 14 | |
| observations | 11 | |
| push_subscriptions | 10 | unique `endpoint` |
| boerse_offers | 8 | unique `vm_offer_id`; `raw` `jsonb` |
| rc_switch_requests | 6 | FK to games |
| rc_game_notes | 6 | |
| referees | 5 | unique `sv_number` |
| rc_visit_feedback, signatures, parked_drafts, rc_notebook | ~15 | `jsonb` payloads |
| app_settings | ~25 keys | `key` unique, `value` `jsonb` |

**Phase 1 keeps the settings maps as they are** (`app_settings` rows with a
`jsonb` value) so the cutover is like-for-like. **Phase 2 promotes the ones
that grow** into tables: `president_notes_<season>` → `president_notes` (one row
per form: the design that hit the cap), `starred_games`/`manual_games` → columns
on games, `reminder_sent` → `reminder_log`, `rc_meetings` → a table,
`vm_missing_games` → columns on games.

## Files

PocketBase keeps the filed PDFs in `pb_data/storage`. They move to a volume
(`/app/files/<collection>/<id>/<name>`), served by the API under the same
URLs, included in the nightly backup and borg like `pb_data` is today.

## Data layer

`server/db/` — the Prisma client and one module per area. The 183
`withCollection(...)` calls are rewritten area by area, not shimmed: a
PocketBase-style string-filter layer on top of Prisma would keep exactly what
we are leaving. Where two writes belong together (accepting a switch, closing a
form role, a crew change that releases a booking) they become one
`prisma.$transaction`; the in-process locks stay until every writer is moved.

Semantics to keep exactly: PocketBase `~` is a case-insensitive LIKE →
Prisma `contains` + `mode: 'insensitive'`; empty string vs null (PocketBase
stores `''`; the readers treat both as "none" — the migration writes `null` and
the readers keep `asText()`); date-only values on manual games; Zürich wall
time stays in `src/lib/appTime.ts` at the API boundary.

## Tests

Today's e2e suite mostly stubs the API, so it would not catch a broken data
layer. New: integration tests that run the API against a real Postgres (a
Docker service locally and in CI), per area — the endpoints' main paths and the
rules (one booking per coachee, switch accept, release on crew change, president
notes, the PDF round trip). Plus the migration check below.

## Data migration

`deploy/postgres/migrate-from-pb.mjs`: reads every PocketBase collection (SDK,
superuser), writes Postgres in foreign-key order, converts ISO text dates to
`timestamptz` (empty → null), copies JSON as is, copies files to the volume.
Truncate-and-reload, so it can be rehearsed any number of times. Verified like
the PocketBase upgrade dry run: per-record, per-field fingerprints on both
sides (normalised for the type changes), counts and changed field paths only —
never a value.

## Cutover

1. Rehearse on the newest nightly snapshot until the fingerprints match.
2. Evening window, ~15 minutes, announced to the coaches.
3. API to maintenance (writes answer 503 with a message; reads keep working).
4. Final PocketBase snapshot (`backup-pb.sh`), migrate, verify fingerprints.
5. Deploy the API on Postgres (`prisma migrate deploy` at start), smoke tests,
   open writes.
6. PocketBase stopped but `pb_data` untouched for one week: the way back is the
   previous API image plus `docker compose start pocketbase`.

Backups: `backup-pb.sh` becomes `backup-db.sh` — `pg_dump -Fc` plus the files
volume, same 02:45 timer, same FAILED marker, borg picks it up.

## Phases

| Phase | Work | Estimate |
|---|---|---|
| 0 | Postgres in compose (local, CI), Prisma schema like for like, migration script + fingerprint check against a snapshot | ½ day |
| 1 | Data layer by area with integration tests: settings & people → coachees & referees → games, sync & Börse → feedbacks, observations, files & PDF → surveys, signatures, notebook, drafts → switch & push | 2–3 days |
| 2 | End-to-end rehearsal on a fresh snapshot, cutover runbook | ½ day |
| 3 | Cutover (15-minute window), PocketBase kept a week for rollback | — |
| later | Promote the growing settings maps to tables (president notes first), transactions replacing the locks, SQL aggregates for Statistik | as wanted |

Work happens on a branch in its own worktree: a second Claude session commits
in the main checkout (memory: shared checkout).

## Open points for Luca

- Go-ahead, and an evening for the cutover.
- Promote the president notes to their own table already in phase 1? Small,
  and it removes the one-row-per-season design that failed on 10.10.
