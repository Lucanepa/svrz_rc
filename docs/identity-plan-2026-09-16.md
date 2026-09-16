# svrz_rc identity plan — final (HEAD 2d0a9c6, tree clean at planning time)

SV number for referees, RC record id for coaches, match number for games. Nine shippable slices plus one optional follow-up; every id-first rule keeps the folded name as its fallback, and a Playwright ratchet fails the build on any new name-only match. This is the "incremental" plan with the judges' grafts merged in and every flaw they found corrected; each correction was re-checked against the code at HEAD before it was written down.

## 1. Overview

- **What is wrong today.** Three identity systems coexist. Referee/coachee matching is name-only in one shared index (`getCoacheeNameIndex`, server/index.ts:2740) and in every client index (`coacheeByName`, App.tsx:4931), although `games.first/second_referee_id` and `coachees.referee_id` exist since 2026-08-27. The submit/reminder fallback is an exact PocketBase filter that cannot fold accents (`buildCoacheeNameFilter`, 10170) — the "León" failure. RC matching is id-first through `rcRefMatches` (2462) with eight name-only stragglers. Games reach the client as PocketBase record ids and the record id is what the URL bar, the draft banner and the admin toast show.
- **Principle.** One helper per side (`src/lib/identity.ts`, imported by server and client — server already imports `../src/lib/*.ts`, see server/statistics.ts:19-23), one rule: identity first (SV / RC id / match number), folded name only when either side has no id, and a known-different id is a NO for coaches only (the referee register links came partly from a word-subset heuristic and are accept-and-warned until the audit shows them clean).
- **Nothing is required.** Every wire field is optional, every URL keeps its record-id shape as a permanent second form, no IndexedDB key, PWA cache key or iCal UID changes. Pages ships the client on push while the API is copied by hand to lenovoserver, so each slice must work with either side ahead.
- **Schema.** No PocketBase change is needed for the five asks. Two optional columns (`rc_visit_feedback.rc_id/game_id`, step 5c) need `setup-schema.mjs` on **lenovoserver** before the API build.

## 2. Identity rules

### Referee / Coachee (`buildCoacheeIndex(rows, register)` in `server/coacheeIndex.ts`, client mirror confined to `src/lib/identity.ts`)

`find(season, {sv, name}) → {row, via: 'sv' | 'register' | 'name' | 'none'}`

1. **sv** — `sv` non-empty and a row of the game's season has `referee_id === sv`; else a seasonless row; a `null` game season means *every* season (today's `forSeason(null) === everyone`, 2778-2780, kept — undated fixtures must not lose their coachees).
2. **register** — `sv` empty: fold the slot name against the register's three variants (`full_name`, `first last`, `last first`); exactly one hit → its `sv_number` → tier 1. This is what lets VolleyManager's "Kevin León Peña de los Santos" (no SV on the slot) reach the linked row "Kevin Peña": the register spells the licence name. No word-subset rule at runtime — that heuristic stays inside `linkCoacheesToReferees` (5587-5595), coachee-name ⊆ register-name, once, at link time, with a report.
3. **name** — `nameKeys(name)` (folded, both orders — today's `nameKeyVariants`, 2204) against the six row variants of `getCoacheeNameIndex`, season row → seasonless (null season → everyone).
4. A tier-3 hit whose `referee_id` is set and differs from a non-empty slot `sv` is **accepted** and logged `log.warn('identity.sv-mismatch', {matchNo, name, gameSv, rowSv})`; the audit (step 6) lists it as "SV-Nr. widerspricht Spiel". Flipping this to a veto is open question 4.
5. Rows of another season never match; two same-season rows with one SV: first in roster order (sorted `full_name`), and step 3 refuses to create that state.

### Referee coach (`samePerson(rec, person, knownIds?)` in `src/lib/identity.ts`)

```
rec.id set:  rec.id === person.id            → true
             knownIds?.has(rec.id)            → false   (a live coach's id is authoritative)
             otherwise                        → fall through (deleted/inactive RC, pre-backfill row, no roster loaded)
foldName(rec.name) !== '' && foldName(rec.name) === foldName(person.name)
```

This is `rcRefMatches` byte-for-byte; `rcRefMatches` becomes a one-line wrapper passing `rcKnownIds`. On the client `knownIds` is `new Set(rcPeople.map(p => p.id))` once `rcPeople` (App.tsx:1405) has loaded and `undefined` before, so the client never vetoes an unknown id the server would let through (judge 1's flaw on the original `samePerson`). Name→id resolution (`resolveRcName`) tries `fullName` and `name_aliases`, both orders, and answers `''` on ambiguity — never the first hit.

### Game

- Storage, relations, drafts, outbox, notebook `PageUse.g`, parked drafts, `starred_games`/`manual_games`, iCal UIDs: **record id, unchanged.**
- Humans: `match_no`, with teams + date (never the record id) when it is blank.
- Lookups by number: one `findGameByMatchNo(matchNo, {excludeIds?})` with `sort: '-match_date'` (newest wins, the rule `surveyGameHadTwoReferees` 6062 already applies). `upsertGame` keeps `external_id` first (manual games never carry one, 6646-6660, so the synced row wins by construction) and then `match_no` **excluding the ids in `manual_games`** (loaded once per sync run) with the same sort — this resolves the judge 1 / judge 2 disagreement: the sync never adopts a hand-typed game, and the four lookups agree on which row a number means.
- Uniqueness: enforced in code on `POST /api/admin/games` (409 on a typed duplicate, `TEST-<yyyymmdd>-<4 base36>` re-rolled on collision) and reported by the audit; a DB index only after the audit reads zero duplicates (step 11).

## 3. URL scheme

| Route | Token | Emitted | Resolved (client-side, against the loaded roster / eligible list) |
|---|---|---|---|
| `/games/<coachee>`, `/feedbacks/<coachee>[/<feedbackRecordId>]` | `referee_id` (SV, digits) when the row is linked, else the record id | `coacheeUrlToken(c) = (c.referee_id||'').trim() \|\| c.id` from `currentRoute` (App.tsx:1850) | `referee_id === token && isInSeason` → `id === token && isInSeason` → `id === token` in ANY season → notice. The any-season hit gets its own wording ("Coachee gehört zu einer anderen Saison" / "…belongs to another season") instead of "nicht gefunden". |
| `/form/<game>[/1sr\|2sr]` | `match_no` for a non-manual game whose number is unique among `eligibleGames`, else the record id | `gameUrlToken(g, eligibleGames)` | hits = `eligibleGames.filter(matchNo === token)`; `hits.find(inSeasonOrManual) ?? hits[0]` (the list is sorted `-match_date`, so newest) → `eligibleGames.find(id === token)` → existing `inSeasonOrManual` guard → "Spiel nicht gefunden — vielleicht eine andere Saison." |
| `/feedbacks/<coachee>/<fb>` | coachee half as above; the feedback half stays the record id (a filed observation has no natural key: an unlocked game can carry two records per game+role, register-only records have no coachee) | | fetched through `/api/coachees/<recordId>/feedbacks`, person-scoped by `forms.ts folderKeys` (sv-first), so last season's record opens through this season's SV token |

- **Tokens are opaque strings compared trimmed; no regex shape test** (a 15-char PocketBase id may be all digits; the repo never states the SV length — the fixture uses 5 digits). `routeToPath` (routes.ts:213-224) gains `encodeURIComponent` on the emitted tokens; `parsePath` already decodes.
- **Uniqueness at emit time is a server-data property**, not a per-device one: `/api/eligible-games` returns the same list to every coach (6583-6595, no season cut). Two phones only disagree while one holds a stale list, and `historyKeyOf` resolves both shapes to the record id so a flip never pushes a junk Back entry. Once the audit shows zero duplicate numbers the fallback effectively never fires.
- **Legacy.** `parsePath`, `routeToPath` grammar and `canonicalizeLegacyHash` (routes.ts:120-137) untouched; `#/games/<recordId>`, `/games/<recordId>`, `/feedbacks/<recordId>/<fb>`, `/form/<recordId>/<half>` resolve forever through the record-id branch. The record-id shape is also still EMITTED (unlinked coachees, manual games, duplicate numbers), so it is a first-class shape, not a transition. After a legacy token resolves the existing URL-sync effect (App.tsx:1873-1892) writes the canonical shape with `replaceState` (first sync and popstate both already replace) — open question 1. `public/_redirects` wildcards and `e2e/redirects-config.spec.ts` need no change.
- **API paths stay `/api/coachees/<recordId>/*`** — the PWA `svrz-api-get` cache and offline resolution via the cached `/api/coachees` roster (which carries `referee_id`) keep working.
- **Ambiguity.** Match number reused across seasons: season on screen, then newest (open question 3 says whether a season qualifier is needed at all). One SV in two season rows: the season on screen wins; only-last-season → the distinct notice. Manual games: record-id URLs, permanently; a typed `/form/TEST-…` still resolves by number when unique.

## 4. Audit table — every match site (HEAD 2d0a9c6; `~` = within a few lines)

Subject: **ref** = referee/coachee, **rc** = referee coach, **game**. Today: what decides identity now. Target: after this plan. "keep" = already right.

### server/index.ts

| file:line | what | subject | today | target |
|---|---|---|---|---|
| 1139 | `normalizeName` — the fold | mixed | name fold, 86 call sites | moves to `src/lib/identity.ts` (`foldName`, one definition); display/search/import-key uses carry `// identity:display` |
| 1849-1888 | `upsertGame` lookup + write | game | `external_id` → `match_no`, unsorted; whole payload written (only `game_result` kept) | `findGameByMatchNo` (external_id first, match_no excluding `manual_games`, `-match_date`); `mergeIncomingGame` (step 2) |
| 2204 | `nameKeyVariants` | ref | name, both orders | `identity.nameKeys` |
| 2462 | `rcRefMatches` | rc | id-first, known-id veto, name fallback | wrapper over `samePerson(rec, person, rcKnownIds)` — semantics unchanged |
| 2485 | `rcRefPresent` | rc | id OR name present | keep |
| 2489 | `rcIdForName` | rc | exact fullName, first hit | `resolveRcName`: aliases + both orders, unique or `''` |
| 2497 | `resolveRefereeCoachPersonId` (admin submit) | rc | exact/reversed name | admin body `rcId` first, then `resolveRcName` |
| 2550 | `extractRefereeId` | ref | VM `person.associationId` → slot SV | keep (source of the slot SV) |
| 2740-2790 | `getCoacheeNameIndex` | ref | name only, 6 variants, per season | `buildCoacheeIndex(rows, register)` in `server/coacheeIndex.ts` (rules §2); `forSeason(season).has(name)` kept for untouched callers |
| 2861/2870 | `makeBoerseVerdict.isCoachee` | ref | name | `index.find(season, {sv: slot id, name})` |
| 2878 | `makeBoerseVerdict.isMe` | rc-as-ref | sv-first, names+aliases | keep |
| 2914/2924 | `makeRcGameTest.isCoachee` | ref | name | sv-first with the slot id already in hand |
| 2930 | `makeRcGameTest.isRc` | rc-as-ref | sv-first | keep |
| 2948/2986-2988 | `getEligibleGames.matchesCoachee` | ref | name (ids fetched at 2964, unused) | `index.find(season, {sv, name})` |
| 2991-3020 | eligible-games projection | mixed | drops `*_referee_id`, `assigned_rc_id` | + `firstRefereeId, secondRefereeId, assignedRcId, firstCoacheeId, secondCoacheeId, firstCoacheeVia, secondCoacheeVia` |
| 3190-3194 | `runGamesSync.hasCoacheeOnRow` | ref | name (row ids computed at 2637, unused) | sv-first — **widens the import** (see step 2 data note) |
| 3208-3210 | matched rows → `upsertGame` | game | whole payload | `mergeIncomingGame(existing, incoming)` |
| 3224 | sync refresh lookup | game | `match_no`, unsorted | `findGameByMatchNo`; `vmFactsPatch` also fills a blank slot id when the names fold equal |
| 3431 | Börse crew fix lookup | game | `match_no`, unsorted | `findGameByMatchNo` |
| 3511 | Börse alert lookup | game | `match_no`, unsorted | `findGameByMatchNo` |
| 3518 | `alertBoerseOffers` holder | rc | `id \|\| name` (no known-id rule) | `rcRefMatches` over `getActiveRcPeople()` |
| 3696-3708 | sync debug `hasCoacheeOnRow` | ref | name | same index (diagnostic mirror) |
| 5002-5040 | `renameRcReferences` | rc | games + feedbacks, id-first | also re-stamps `rc_game_notes.rc_name` and president-note `rcName` |
| 5097/5126 | coachee import upsert key | ref | `normalizeName(full_name)\|season` | keep as the import key (`identity:display`); + inherit `referee_id` from the previous season's row with the same `personKey`; + optional `referee_id` from the sheet |
| 5151/5186 | sync-contacts contact lookup | ref | name, ambiguity refused; `associationId` not requested (2091-2107) | keep; step 11 adds `person.associationId` behind an env flag |
| 5440/5494 | register import | ref | upsert on `sv_number`, then link | keep; + `backfill-referee-ids` at the end |
| 5523 | `refereeRegisterContact` | ref | sv-first, folded unique name | keep |
| 5556-5625 | `linkCoacheesToReferees` | ref | name → sv, byWords subset, register-import only | callable standalone; run after every coachee import/sync; direction unchanged |
| 6015/6019 | `createSurveyToken` → `rc_visit_feedback` | mixed | names + `match_no` | + `rc_id`, `game_id` (step 5c, schema) |
| 6058/6062 | `surveyGameHadTwoReferees` | game | `match_no`, `-match_date` | `game_id` first, `findGameByMatchNo` fallback |
| 6246/6254 | president-note read/write ownership | rc | `rcRefMatches` | keep |
| 6295-6312 | president-note entry | mixed | `gameId` (record), `rcName`, teams/date | + `matchNo`, `rcId`, `refereeId` (JSON in app_settings, no schema) |
| 6526 | `/api/feedback/:id/file` | rc | `rcRefMatches` | keep |
| 6621-6624 | `POST /api/admin/games` `assigned_rc` → id | rc | exact name among active | accepts `assigned_rc_id` from the picker; `resolveRcName` fallback |
| 6631-6644 | `POST /api/admin/games` `refereeId()` | ref | claimed sv validated, else unique name | keep |
| 6646 | manual `match_no` default | game | `TEST-<last 6 ms digits>` (wraps every 16.7 min), typed duplicates unchecked | `TEST-<yyyymmdd>-<4 base36>` re-rolled; typed duplicate → 409 naming the game |
| 6684 | manual games search | game | free text | keep (`identity:display`) |
| 6770-6825 | `PUT /api/games/:id/assign-rc` | rc | `heldByMe` via `rcRefMatches`; body name compared to session name (6796); admin `rcIdForName` (6808) | body `{assignedRc, assignedRcId}`; RC session: `assignedRcId` must equal `rcAuth.rcId` (403) when present, legacy name compare when absent; admin: id first, `resolveRcName` fallback. **Name stays in the body** — the old API reads `assignedRc ''` as give-back (6790) |
| 6816-6821 | `publishLive game.assignment` | rc | name only | + `assignedRcId` |
| 6911/6929 | `collectExpenseVisits` | rc | `rcRefMatches` with cold `rcKnownIds` | `await getActiveRcPeople()` first |
| 7107/7123 | `workloadByRc` | rc | `rc_id \|\| name` buckets; games via `rcRefMatches` | `samePerson`; buckets keep |
| 7152 | `/api/rc-overview` own row | rc | `rcRefMatches` | keep |
| 7263 | statistics owner | rc | `rcRefMatches` | keep |
| 7307-7325 | `/api/rc-overview/:rcName/coachees` subject | rc | URL is a NAME; `rcIdForName`; pure name equality when unresolved | segment treated as an RC id when it matches the roster, else a name (aliases); client passes the id |
| 7373-7379 | `getOrCreate` group key | ref | `normalizeName(name)`; `coacheeId ''` for game-only rows | key `sv:<referee_id>` when the slot resolves, else `name:<fold>`; `coacheeId` filled from the resolved row |
| 7380-7392 | done feedback rows | game | no ids | + `feedbackId`, `gameId`, `matchNo` |
| 7418-7430 | crew coachee flag | ref | `season.has(normalizeName)` (ids fetched at 7333, unused) | sv-first; crew entries + `svNumber`, `coacheeId` |
| 7550-7564/7604 | `listMyRcGames coacheeByName` | ref | name, first row of ANY season | `index.find(season, {sv: otherId, name})` |
| ~7600 | `listMyRcGames mineIsMe` | rc-as-ref | sv-first | keep |
| 7742/7803 | rc-games notes ownership | rc | `rcRefMatches` | keep |
| 7973/7998-8012 | `POST/PUT /api/coachees` | ref | drop `referee_id` | accept `referee_id`: `''` unlinks; must exist in `referees.sv_number` (400); not linked on another same-season row (409 naming it) |
| 8059/8102/8118 | `/api/coachees/:id/games` | ref | folded names; `gameFields` omits the id columns | add `first_referee_id,second_referee_id`; `coachee.referee_id === slot id` first, name variants fallback; `assignedRoles` the same way |
| 8171/8180 | `feedbacksAboutCoachee` | ref | sv-first via `folderKeys` | keep |
| 8202/8210 | feedback redaction | rc | `rcRefMatches` | keep |
| 8392/8404/8447 | `/api/games/calendar-status` | ref | folded names; field list omits ids | add the id columns; `buildCoacheeIndex` per season |
| 8740 | `getGamesAssignedToRc` (iCal) | rc | `rcRefMatches` | keep |
| 8806 | iCal `UID:game-<recordId>` | game | record id | keep on purpose (calendars dedupe on UID) |
| 8841/~8856 | `getOwnSrGames` | mixed | RC sv-first; coachee by name | coachee half sv-first |
| 9041/9058 | `POST/PUT /api/referee-coaches` (admin raw) | rc | `rc_name` only, no `rc_id` | accept `rc_id`; resolve from `rc_name` when absent; refuse (422) a name that resolves to nobody |
| 9287/9379 | submit ownership | rc | `rcRefMatches` | keep |
| 9438 | submit `srName` guard | ref | `nameKeyVariants` | also passes when body `refereeId` equals the slot id |
| 9458 | submit `findCoacheeRecord` | ref | sv → exact PB name filter | see 10200 |
| 9483 | submit register fallback | ref | sv-first | keep |
| 9512-9526 | feedback `rc_id`/`rc_name` | rc | session id / admin name | admin body may carry `rcId` |
| 9671-9680 | survey token call | mixed | names + `matchNo` | + `rcId`, `gameId` (step 5c) |
| 10015-10035 | `migrate-rc-ids` | rc | active names only, no aliases | `resolveRcName` over ALL people (aliases, both orders); also `rc_game_notes`; `rcKnownIds` stays active-only by design, so a stamped inactive id still falls to the name in `rcRefMatches` |
| 10170-10181 | `buildCoacheeNameFilter` | ref | exact SQLite `=`, no fold — the León break | deleted |
| 10200-10248 | `findCoacheeRecord` | ref | `referee_id` filter (season → newest) → exact name filter → throw | `referee_id` filter kept; then in-memory `buildCoacheeIndex.find` over `listCoacheesWithFallbackSort()` (register tier, `nameKeys`, season row → newest); **the final throwing `getFirstListItem` stays** (callers test `isRecordNotFound` at 9487/10282) |
| 10311-10324 | `buildRemindersFor` holder | rc | id, else name; no known-id rule | `rcRefMatches` over `getActiveRcPeople()` |
| 10334 | reminder dedupe key | ref | `refereeId \|\| name` | keep |
| 10337 | `findCoacheeByRefereeName` | ref | via `findCoacheeRecord` | inherits the fix |
| 10484 | reminder route | rc | `rcRefMatches` | keep |
| 10968/11137 | parked drafts `:gameId` | game | record id | keep |
| 11253/11350 | notebook `usedIn[].g` | game | record id (free text) | keep; the label gets the match number (client) |

### Other server modules

| file:line | what | subject | today | target |
|---|---|---|---|---|
| server/gamesSync.ts:19-21 | `isRowWanted` | ref | pure, pinned by `games-sync-rules.spec` | keep; its `hasCoachee` input becomes sv-first |
| server/gamesSync.ts:37-46 | `vmFactsPatch` | game | league + marks only | + fills a blank `first/second_referee_id` from the incoming row when the slot name folds equal; never blanks one |
| server/gamesSync.ts (new) | `mergeIncomingGame(existing, incoming)` | ref/game | — | keeps a stored slot id ONLY when `incoming` id is `''` AND `foldName(slot name)` is unchanged; otherwise the incoming value; `game_result` rule folded in |
| server/boerse.ts:111/117 | `slotHolder` / `toOfferRow` | ref | SV off the convocation | keep |
| server/boerse.ts:393 | `planReconcile` | game | `vm_offer_id` | keep |
| server/forms.ts:33 | `personKey` | ref | sorted folded parts | keep; reused by the import inheritance |
| server/forms.ts:104-115 | `formsRowOf` | ref | sv-first | keep |
| server/forms.ts:139-160 | `folderKeys` | ref | sv-first | keep |
| server/forms.ts:122-134 | `formsEntryName` | game | `match_no` | keep |
| server/statistics.ts:154/458-463 | RC bucket | rc | `rcId \|\| name:<name>` | keep (name bucket only for unresolved rows) |
| server/expenses.ts:83 | `planExpenseRows` key | game | `gameId \|\| date\|matchNo` | keep |
| deploy/hetzner/seed/setup-schema.mjs:45-64, 149, 226 | schema | — | no indexes; coachees.season NUM; survey row name-only | optional `rc_visit_feedback.rc_id/game_id` (step 5c); optional index step (step 11) |

### src/App.tsx

| file:line | what | subject | today | target |
|---|---|---|---|---|
| 538 | `downloadIcal` UID | game | record id | keep |
| 1850-1864 | `currentRoute` | mixed | `selectedCoacheeId` / `selectedGameId` | `coacheeUrlToken` / `gameUrlToken` |
| 1866 | `historyKeyOf` | mixed | path compare | resolves both tokens to record ids before comparing |
| 1990-2040 | form meta-fill (Niveau/Gruppe/srName) | ref | private sorted-words normaliser, then `selectedCoacheeId` | `coacheeIdOnSlot(game, role)` → (legacy index when the field is undefined) → `selectedCoacheeId` unless it is the other slot; the private normaliser is deleted |
| 2146 | `autoResumeRef` | game | URL token = draft key | resolved record id |
| 2271/2290 | `loadHome myRow` | rc | trim+lowercase name | `r.id === rcAuth.rcId` |
| 2283/2375 | `loadrcCoachSummary(name)` | rc | name in the URL | `rcAuth.rcId` |
| 2429-2431 | `refreshAfterAssignment` | rc | folded names | ids / `isMyGame` |
| 2458 | `applyRcAssignment` → `assignRcToGame(gameId, name)` | rc | name | `{assignedRc, assignedRcId: rcAuth.rcId}` |
| 2477/2482 | `observedCoacheesOnGame` | ref | `coacheeByName` | `coacheeIdOnSlot` |
| 2528 | `requestRcAssignment` / `takeNotice` | mixed | name; label = teams | + `rcId`; label `#<matchNo> · teams` |
| 2617-2622 | SSE `game.assignment` mine | rc | folded name | `isMyGame` on `event.assignedRcId` |
| 2751/2785-2786 | `handleSelectGame` | ref | `coacheeNames`; `preferredRef` as a name | slot coachee ids; `preferredRef` accepts `{id \| sv \| name}` |
| 2945/2956 | `openFeedbackMine` | rc | id-first | `samePerson` (unchanged) |
| 3010 | `openDoneObservation` | game | coachee + calendar day | by `feedbackId` when the row carries one |
| 3063-3067 | `openDeepLink` | ref | `id === token && isInSeason` | sv in season → id in season → id any season (distinct notice) |
| 3117 | `selectCoachee` | ref | record id | keep |
| 3368 | submit game by `spielNr` | game | `match_no` | keep |
| 3500/3514 | outbox label | game | teams · role | `#<matchNo> · teams · role` |
| 4124 | `resumeDraft` | game | record id | keep |
| 4236-4241 | `openGameRoute` | game | `id === token`; early return on `selectedGameId` | `resolveGameToken`; early return compares the RESOLVED id |
| 4262-4266 | `openUrlGame` | game | `id === token` | `resolveGameToken` |
| 4313-4324 | draft boot compare | game | token vs `d.gameId` | resolved id (the URL's own draft still resumes silently) |
| 4379 | draft banner label | game | `label \|\| matchNo \|\| gameId` | `list[0].label \|\| list[0].matchNo \|\| teams+date` |
| 4464 | draft-file binding | game | id, then matchNo | keep (precedent) |
| 4503 | `draftRecordFromFilePart` | ref | coacheeId dropped | keep (form re-derives) |
| 4550-4551 | notebook `markUsed` label | game | teams | `#<matchNo> · teams`; `g` stays the record id |
| 4599/8749 | `selectedCoacheeInfo` → single-mode confirm recipient | ref | `selectedCoacheeId` (navigated-from) | `observedCoacheeId` |
| 4786 | `coacheeNames` | ref | folded name set | replaced by slot ids; legacy path inside identity.ts |
| 4834/4904/5035/7027 | `upcomingGamesByReferee` | ref | keyed `normName(referee)` | keyed by coachee record id |
| 4931 | `coacheeByName` | ref | `coacheeIndex` | confined to the legacy path in `src/lib/identity.ts` |
| 4946 | `outOfNiveauFocus` | ref | name | slot coachee id |
| 4975/4979 | `gameCoacheeOptions` | ref | names | id-valued, name-labelled |
| 4996 | `filterAvailability` | ref | name | id |
| 5028 | `coacheeQuickFilters` | ref | name | id |
| 5046/5050, 6611-6617 | `coacheeLevelOf/GroupOf(name)`; Home done rows | ref | name; `f.coacheeId` unused | by-id variants; done rows use `f.coacheeId` |
| 5059 | `plannedObsByCoachee` | ref | name key | record-id key |
| 5092-5197 | `filteredGames` | ref | `pickedCoachees` names, `coveredRefs` names | ids (search box stays folded, `identity:display`) |
| 5310-5311 | `refChip` | ref | `coacheeNames` | slot coachee id |
| 5625 | observation-target buttons | ref | `coacheeNames` | slot coachee id |
| 5720 | form header chips | ref | `coacheeNames` | slot coachee id |
| 5850 | foreign outbox banner | rc | `rcPeople.find(id)` | keep |
| 6113-6114 | Home `startFromSummary` | game | `e.id === g.gameId` (ordinary record lookup, not a route token) | keep; fallback search by `matchNo` |
| 6128 | Home `crewChips` | ref | `coacheeGroupOf(name)` | `crew[].coacheeId` |
| 7024/7027 | Coachees tab row | ref | name | id |
| 7163 | inline coachee-row game mine | rc | folded name | `isMyGame` |
| 7413/7442 | Games tab Abgeben / `canObserve` | rc | RAW `===` | `isMyGame` |
| 7854/7856 | coachee games list | game/rc | `e.id === game.id` (fine); mine by folded name | `isMyGame` |
| 8730 | dual-mode recipients | ref | `coacheeByName` | `coacheeIdOnSlot` per role |
| 9198 | `takeNotice` self | rc | folded name | id |
| 9341/9359 | feedback picker rows | game | `submitted_at \| RC \| role` | + `#<match_no>` |
| 9649 | `ManualUploadModal` RC select | rc | `fullName` | keep the name in `meta.rc`, send `rcId` beside |

### src/lib, src/components, src/types

| file:line | what | subject | today | target |
|---|---|---|---|---|
| coacheeName.ts:62 | `foldName` | ref | fold | keep (re-exported from identity.ts) |
| coacheeName.ts:81 | `coacheeIndex` | ref | name index | legacy path only (older API / PWA cache) |
| pocketbase.ts:31 | `Coachee.referee_id` | ref | shipped, unused by App | URL token + hand-link field |
| pocketbase.ts:54 | `CoacheeGame` | mixed | names only | + ids |
| pocketbase.ts:716-717 | `assignRcToGame(gameId, name)` | rc | name | `(gameId, {assignedRc, assignedRcId})`; demo branch forwards both |
| pocketbase.ts:780-781 | `loadrcCoachSummary(rcName)` | rc | name | `(rcRef)` = id; demo branch accepts the id |
| types.ts:57 / 334 / 345 | `EligibleGame`, `rcCoachSummaryFeedback`, `rcCoachSummaryGame` | mixed | no ids | optional `firstRefereeId, secondRefereeId, assignedRcId, firstCoacheeId, secondCoacheeId`; `feedbackId, gameId, matchNo`; crew `svNumber, coacheeId` |
| liveEvents.ts:15 | `game.assignment` | rc | name | + `assignedRcId?` |
| routes.ts:40/46/172-198 | `AppRoute` tokens, `parsePath` | mixed | opaque record ids | unchanged grammar; comments updated |
| routes.ts:213-224 | `routeToPath` | mixed | raw tokens | `encodeURIComponent` |
| routes.ts:120-137 | `canonicalizeLegacyHash` | mixed | string op | unchanged |
| formDraft.ts:241/472/602/987 | draft key, resume hint, export file, claim | game | record id | keep |
| offlineQueue.ts:23/36 | payload `gameId`, item `label` | game | record id / teams | key keep; label with match number |
| notebook.ts:39 | `PageUse.g` | game | record id | keep |
| logger.ts:184 | `scrubTokens` | ref | masks survey/sign/ical only | optional digit-segment mask under `/games/`, `/feedbacks/` (open question 2) |
| demo.ts:63 | `RC` | rc | id + name | games gain `assignedRcId`, `firstRefereeId`, `firstCoacheeId`; records gain `rc_id` |
| demo.ts:293-298 | `mkRecord` | rc | `rc_name`, no `rc_id` | + `rc_id: RC.id` |
| demo.ts:446-449 | `getAuthMe` | rc | `rcId 'demo-rc-1'` | keep |
| demo.ts:606 | crew coachee flag | ref | lowercase name (no fold) | `g.coacheeId === c.id` |
| demo.ts:640-642 | `loadrcCoachSummary(rcName)` | rc | returns `[]` unless the NAME matches | accepts `RC.id` or `RC.name` |
| demo.ts:693-696 | `assignRcToGame` | rc | stores the argument as the name | stores `{assignedRc, assignedRcId}`; summary compares by id or name |
| AdminConsole.tsx:652 | `parseRefereeXlsx` | ref | SV column required | keep |
| AdminConsole.tsx:705 | `parseXlsx` (coachee sheet) | ref | no SV column | optional `SV-Nr.` column (same header list) → `referee_id` |
| AdminConsole.tsx:~1472/1527-1529 | coachee add/edit | ref | no SV field | `SV-Nr.` field via register `PersonPicker`; "ohne SV-Nr." filter + count badge |
| AdminConsole.tsx:2851 | forms folder search | ref | fold + refereeId | keep (`identity:display`) |
| AdminConsole.tsx:3449/3457 | `PickPerson` / `PersonPicker` | mixed | `onChange(name)` only | emits `{name, id, svNumber}` |
| AdminConsole.tsx:3581 | `refereeOptions` | ref | sv-first | keep |
| AdminConsole.tsx:3723/3734-3735 | `svNumberFor(name)` | ref | name → sv | deleted; the picker's `svNumber` is sent |
| AdminConsole.tsx:3799 | manual game RC picker | rc | name | + `assigned_rc_id` |
| AdminConsole.tsx:3805 | created toast | game | `match_no \|\| made.id` | `match_no` (always set after step 3), else teams + date |
| AdminConsole.tsx:4131/4175-4178 | `foldOverviewGames` key | game | `gameId \|\| date\|teams`; done rows `gameId ''` | done rows keyed by `gameId` |
| AdminConsole.tsx:4155/4162/4441 | `OverviewDetail({rcName})` | rc | `r.fullName` | `r.id` |
| AdminConsole.tsx:4498 | `coacheeFor(name)` | ref | `coacheeIndex` | `firstCoacheeId/secondCoacheeId` |
| AdminConsole.tsx:4500 | `assign(game, rcName)` | rc | name | id + name |
| AdminConsole.tsx:4528 | games search | game | fold | keep (`identity:display`) |
| AdminConsole.tsx:4637/4642 | RC `<select>` | rc | value = `fullName` | value = `p.id`; a stored name with no id shows as a disabled option instead of "–" |
| StatisticsAdmin.tsx:231 | RC filter | rc | id | keep |
| AuthGate.tsx:108-110 | `RcAuth` | rc | id | keep |

### e2e fixtures and specs that pin the shapes

| file:line | what | today | target |
|---|---|---|---|
| e2e/support/app.ts:14/20/26 | `RC`, `COACHEE` (no `referee_id`), `GAME` (`matchNo '2345678'`) | record ids | `COACHEE.referee_id '90003'`, `GAME.firstRefereeId '90003'`, `firstCoacheeId 'c1'`, `assignedRcId 'rc1'`; new `COACHEE_UNLINKED`, `GAME_NOSV`, `GAME_MANUAL` |
| season-requests.spec.ts:73/75/77/142, quick-filters.spec.ts:16, late-take.spec.ts:12, vm-marked-game.spec.ts:11 | `{...GAME, id: 'x'}` keeping `matchNo 2345678` | two games, one number | distinct numbers **before step 9** (otherwise the resolver's tie rule decides which game Back reopens) |
| routes.spec.ts:37-38/126-188/201-223 | parse/emit rows | PB-shaped ids | keep + rows `/games/90003`, `/form/2345678/1sr`, `/feedbacks/90003/fb1`, encoded token with a space |
| deep-links.spec.ts:49/64/68/78 | `/games/c1`, click-through URL | record id | 64 → `/games/90003`; 49/68 stay as the fallback contract |
| path-routing.spec.ts:51-116 | `/form/g1/…`, `goBack() === null` | record id | `/form/2345678/…`; Back assertions kept; + landing on `/form/g1/1sr` canonicalises without a Back step |
| legacy-links.spec.ts:44-46 | `#/games/c1` | lands on `/games/c1` | `/games/90003` (open question 1) + an unlinked fixture pinning `/games/c2` verbatim |
| season-requests.spec.ts:144/155 | other-season game / coachee | not found | + rollover: SV of a person with rows in both seasons opens this season's; only-last-season → the distinct notice |
| notebook.spec.ts:244/249, forms-database.spec.ts:187, prior-goals.spec.ts:92-149 | entry paths | record id | updated / kept as fallback |
| redirects-config.spec.ts:29-42 | prefixes | wildcards | unchanged |

## 5. Steps

Each step is one PR on `main` (CI: tsc + Playwright → Pages), plus the hand copy of the API to lenovoserver where marked. Re-grep every line number and check `HEAD` before editing: a second Claude session commits on this checkout.

### Step 1 — Identity helper + ratchet spec (no behaviour change)

- **Files:** `src/lib/identity.ts` (new), `src/lib/coacheeName.ts`, `e2e/identity-rules.spec.ts` (new), `e2e/identity-ratchet.spec.ts` (new).
- **Change:** `identity.ts` exports `foldName` (moved from coacheeName.ts:62, re-exported there), `nameKeys(name)` (= server `nameKeyVariants` 2204), `type PersonRef {id; name}`, `samePerson(rec, person, knownIds?)` (§2), `indexPeople(rows: {id; names[]; season: number|null; value}[])` → `{find(season, {id, name}), has(season, {id, name})}` where a `null` season means every season (2778-2780 rule), and the URL helpers used in steps 8-9. `identity-ratchet.spec.ts` (modelled on `redirects-config.spec.ts`, which reads repo files) reads `server/*.ts`, `src/App.tsx`, `src/components/*.tsx`, `src/lib/*.ts` and counts per file, skipping lines carrying `// identity:display`: (A) `/(normalizeName|normName|foldName)\([^)]*\)\s*(===|!==)/`, (B) `/\.(has|get)\((normalizeName|normName|foldName)\(/`, (C) `/\.toLowerCase\(\)\s*(===|!==)/`, (D) raw compares `/(assignedRc|rc_name|rcName|\.fullName\))\s*===/` in `src/**`, (E) ``getFirstListItem(`match_no`` or ``filter: `match_no`` without `sort:` in the same statement. Pins today's measured numbers EXACTLY: server/index.ts A=10 B=11 E=3; App.tsx A=9 B=24 D=2; AdminConsole.tsx A=2 B=2; demo.ts C=2; everything else 0. Message: "new name-only identity match in <file>:<line> — go through samePerson()/indexPeople() in src/lib/identity.ts, or lower the pin if you removed one". Allow-list with its own pins: `src/lib/identity.ts`, `server/coacheeIndex.ts` (the name tier lives there), `server/forms.ts` (`personKey`). Narrowed to comparison idioms (not every fold call) so search boxes, sort keys and the import key at 5097 move the pin less often — the second session's unrelated commits are the cost of an exact pin; relax to `<=` only if it proves too noisy.
- **Fallback:** pure helpers; with no id on either side `samePerson` is folded-name equality, identical to today.
- **Data/admin:** none.
- **Tests:** `identity-rules.spec.ts`: samePerson table (id equal; known-different → false; unknown id → name; no roster → name; León/Leon; "Nachname Vorname"; middle names do NOT fold); indexPeople (season row beats seasonless; other-season never; null season matches any; id wins over a different spelling). `identity-ratchet.spec.ts` self-check: a fixture string with the idiom counts, one tagged `identity:display` does not.
- **Ships alone:** yes.

### Step 2 — Server: every coachee/referee match SV-first, register tier, safe merge rule, sorted lookups (fixes the live León submit/reminder failure)

- **Files:** `server/coacheeIndex.ts` (new), `server/gamesSync.ts`, `server/index.ts`, `e2e/identity-rules.spec.ts`, `e2e/games-sync-rules.spec.ts`.
- **Change:** (a) `getCoacheeNameIndex` (2740) → `buildCoacheeIndex(rows, register)` in `server/coacheeIndex.ts` (rules §2; register from `listRefereeRecords()` 5353, cached like the RC roster); `forSeason(season).has(name)` kept for untouched callers. (b) Every consumer passes the slot id: 2870, 2924, 2948, 3190 + 3696, 7418, 7604, ~8856; `/api/coachees/:id/games` (8059) adds the id columns to `gameFields` (8102) and matches `coachee.referee_id` first; `calendar-status` (8404) the same. (c) rc-overview grouping (7373): key `sv:<referee_id>` when the slot resolves, else `name:<fold>`; `coacheeId` filled for game-only rows. (d) `findCoacheeRecord` (10200): `referee_id` filter kept; the exact name filter replaced by an in-memory `buildCoacheeIndex.find` over `listCoacheesWithFallbackSort()` (season row → newest, register tier, `nameKeys`); `buildCoacheeNameFilter`/`coacheeNameFilterAsync` deleted; **the final throwing `getFirstListItem` stays** so `isRecordNotFound` (9487, 10282) keeps answering 422 / skip, never 500 + outbox retry. (e) Submit `srName` guard (9438) also passes when the body `refereeId` equals the slot id. (f) `mergeIncomingGame(existing, incoming)` in `gamesSync.ts` (pure): stored `first/second_referee_id` kept ONLY when the incoming id is `''` AND `foldName` of that slot's name is unchanged — a replaced referee never inherits the previous number; `game_result` preservation folded in; `upsertGame` uses it instead of writing the whole payload. `vmFactsPatch` fills a blank id from the incoming row when the names fold equal, never blanks one, so not-kept rows inside the sync window gain ids too. (g) `findGameByMatchNo(matchNo, {excludeIds})` with `sort: '-match_date'` replaces 3224, 3431, 3511 and is used by `upsertGame` after the `external_id` key with `excludeIds = manual_games` (loaded once per sync run). (h) SV-mismatch accepted + `log.warn('identity.sv-mismatch')`.
- **Fallback:** slot id empty (about two thirds of stored games) or row unlinked → register tier, then folded name both orders — today's list behaviour; submit/reminders gain the fold they lacked. No row → 422 as today.
- **Data/admin:** none. **Say out loud before the first nightly run after deploy:** `hasCoacheeOnRow` by id/register widens what the sync imports — games of a LINKED coachee whose VM spelling differs beyond folding (middle names) were silently dropped unless RD/RSV-marked; expect a one-off jump in imported games and Home "planned" rows.
- **Tests:** `identity-rules.spec.ts`: buildCoacheeIndex (sv on game + unlinked row → name; sv on both → match despite "Kevin León Peña de los Santos" vs "Kevin Peña"; no sv + register spells the licence name → register tier; two register hits → no register match; other-season row with the sv → none; null game season matches any; mismatch → accepted with via 'name'); submit guard (claimed "Leon Kevin" vs slot "Kevin León" accepted; different person refused). `games-sync-rules.spec.ts`: `mergeIncomingGame` keep/replace (blank incoming id + same folded name keeps; blank id + changed name replaces; non-blank incoming wins), `vmFactsPatch` fills a blank id and never blanks. `isRowWanted` is already pinned there and is not re-extracted. Ratchet pins lowered for server/index.ts. Existing `coachee-name-accents`, `coachee-row-games`, `rc-game-flag`, `vm-marked-game`, `home-planned-games` stay green.
- **Ships alone:** yes (API copy to lenovoserver).

### Step 3 — Data hygiene: link on every import, inherit across seasons, SV column, hand-link, backfill, unique manual numbers

- **Files:** `server/index.ts`, `src/components/AdminConsole.tsx`, `src/lib/pocketbase.ts`, `e2e/coachee-import.spec.ts`, `e2e/referee-register.spec.ts`, `e2e/manual-game-picker.spec.ts`.
- **Change:** (a) `POST /api/admin/coachees/link-referees` (new) runs `linkCoacheesToReferees` (5556) standalone; it is also called at the end of `POST /api/coachees/import` (5088) and `sync-contacts` (5151), and its `{linked, alreadyLinked, unmatched, ambiguousNames}` returned. (b) The import inherits `referee_id`: before creating a new season row, look up previous seasons' rows with the same `personKey` (forms.ts:33) — exactly one distinct non-empty `referee_id` → copy it. (c) `parseXlsx` (AdminConsole 705) reads an optional `SV-Nr.` column (the header list of `parseRefereeXlsx` 657) into `referee_id`; the import writes it only when the number exists in the register. (d) `POST/PUT /api/coachees` (7973/7998) accept `referee_id` (`''` unlinks; 400 when not in `referees.sv_number`; 409 naming the other row when already linked on another same-season row). (e) `POST /api/admin/games/backfill-referee-ids` (new, modelled on `migrate-rc-ids`): for stored games with a blank slot id whose slot name folds to exactly one register row, write the `sv_number`; report `{filled, unresolved[], ambiguous[]}`; **called at the end of every register import** (5494). (f) `POST /api/admin/games` (6601): refuse a typed `match_no` that already exists (409 naming the game); default `TEST-<yyyymmdd>-<4 base36>` re-rolled on collision. (g) Console: coachee add/edit gains an `SV-Nr.` field backed by the register `PersonPicker` (3457, now emitting `{name, id, svNumber}`); "n Coachees ohne SV-Nr." badge + filter; import/sync toast shows linked/unmatched/ambiguous; `RefereeRosterAdmin` gets "Coachees jetzt verknüpfen" and "SV-Nr. auf Spielen nachtragen".
- **Fallback:** rows that stay unlinked (ambiguous, absent from the register) remain name/register-matched and keep record-id URLs; the audit (step 6) lists them.
- **Data/admin (lenovoserver, after the API copy):** press "Coachees jetzt verknüpfen", then "SV-Nr. auf Spielen nachtragen", then link the ambiguous/unmatched rows by hand. Expect the 2026-08-27 numbers (135 rows, 11 word-matched) to move.
- **Tests:** `coachee-import.spec.ts`: import response carries link counts; a season+1 import inherits `referee_id` from the previous season's row of the same person; a sheet with an SV-Nr. column sends it. `referee-register.spec.ts`: edit form shows/sets/unlinks SV; unknown number refused; second same-season link refused with the other row's name; register import result includes the backfill report. `manual-game-picker.spec.ts`: generated shape `/^TEST-\d{8}-[a-z0-9]{4}$/`; typed duplicate → 409 shown.
- **Ships alone:** yes.

### Step 4 — Ids on the wire, server-computed coachee ids, client id-first (client half of asks 1 and 2)

- **Files:** `server/index.ts`, `src/types.ts`, `src/lib/pocketbase.ts`, `src/lib/liveEvents.ts`, `src/lib/identity.ts`, `src/lib/coacheeName.ts`, `src/App.tsx`, `src/components/AdminConsole.tsx`, `src/lib/demo.ts`, `e2e/support/app.ts`, `e2e/identity-client.spec.ts` (new), `e2e/live-updates.spec.ts`, `e2e/coachee-name-accents.spec.ts`.
- **Change:** Server projections (additive): `/api/eligible-games` (2991) and `/api/coachees/:id/games` (8125): `firstRefereeId, secondRefereeId, assignedRcId, firstCoacheeId, secondCoacheeId` (this-season coachee record id from `buildCoacheeIndex`, `''` when none) and `firstCoacheeVia/secondCoacheeVia`; rc-overview crew `{name, role, coachee, svNumber, coacheeId}`, game rows `coacheeId`; done rows `feedbackId, gameId, matchNo`; calendar-status per-slot `coacheeId`; `publishLive game.assignment` (6816) `assignedRcId`. `PUT /api/games/:id/assign-rc` (6770): body `{assignedRc, assignedRcId}` as in §4. Client: `src/lib/identity.ts` gains `coacheeIdOnSlot(game, role)` (server field when defined, `coacheeIndex` legacy path only when undefined — older API / 30-day PWA cache), `isMyGame(game, rcAuth, knownIds)`, `isMyRecord(record, rcAuth)`. App.tsx: `coacheesById` replaces `coacheeByName`/`coacheeNames`; `upcomingGamesByReferee` (4834) and `plannedObsByCoachee` (5059) keyed by record id; chips 5310/5625/5720, filters 4946-5197, `observedCoacheesOnGame` 2477, dual-mode recipients 8730, Home crew/done 6128/6611 through the ids; the form meta-fill (1990-2040) sets `observedCoacheeId = coacheeIdOnSlot(...) || selectedCoacheeId-unless-other-slot`; **the single-mode confirm dialog (4599/8749) reads `observedCoacheeId`, never the navigated-from `selectedCoacheeId`**; every mine check (2429, 2621, 7163, 7413, 7442, 7856, 9198) → `isMyGame` with `knownIds` from `rcPeople`; `loadHome myRow` (2290) by `r.id`; `assignRcToGame(gameId, {assignedRc, assignedRcId})` (pocketbase.ts:716). AdminConsole: `coacheeFor` (4498) by slot ids; `assign` sends id + name; RC `<select>` (4637) bound to `assignedRcId` with a disabled stored-name option; `svNumberFor` (3723) deleted. **demo.ts (in this step's file list):** games gain `firstRefereeId`, `firstCoacheeId`, `assignedRcId`; records gain `rc_id: RC.id`; crew flag (606) by `g.coacheeId === c.id`; `assignRcToGame` stores both halves. The submit payload gains `refereeId` (the slot's sv) for step 2(e).
- **Fallback:** any field undefined (older API, cached entry) → the legacy folded-name path inside `identity.ts`, tagged and pinned; `firstCoacheeId ''` → not a coachee, exactly the server's answer. The client never requires an id; Pages ahead of the API is safe; the name stays in the assign-rc body so a new client against the old API still takes the game.
- **Data/admin:** none.
- **Tests:** `e2e/support/app.ts`: `COACHEE.referee_id '90003'`, `GAME.firstRefereeId '90003'`, `firstCoacheeId 'c1'`, `assignedRcId 'rc1'`; `COACHEE_UNLINKED`, `GAME_NOSV`. `identity-client.spec.ts` (the contract that the client does not match by name): (1) referee spelled "Zzz Nobody" with `firstCoacheeId 'c1'` → amber Coachee badge, listed under the row, Niveau pre-filled; (2) referee spelled exactly `COACHEE.full_name` with `firstCoacheeId ''` → no badge, not in the coachee filter; (3) `assignedRc 'ANNA  MÜSTER'` + `assignedRcId 'rc1'` → Abgeben + Beobachtung starten; `assignedRc 'Anna Muster'` + `assignedRcId 'rc2'` (rc2 in `rcPeople`) → taken by someone else; `assignedRcId 'rc-gone'` (not in the roster) + name equal → mine (name fallback, same as the server); (4) SSE event carrying only `assignedRcId` flips mine; (5) all with ids stripped still pass through the name path; (6) single-mode confirm dialog names the observed referee after a role flip, not the navigated-from coachee. `coachee-name-accents.spec.ts`: names not folding equal but SV equal → filled. Ratchet pins lowered for App.tsx, AdminConsole.tsx, demo.ts.
- **Ships alone:** yes (client first or API first, either order).

### Step 5 — Remaining RC sites by id: Börse alert, reminder holder, admin resolvers with aliases, raw feedback create, RC detail by id, president notes, survey rows

- **Files:** `server/index.ts`, `src/lib/pocketbase.ts`, `src/App.tsx`, `src/components/AdminConsole.tsx`, `src/lib/demo.ts`, `deploy/hetzner/seed/setup-schema.mjs` (5c only), `e2e/admin-overview-detail.spec.ts`, `e2e/president-note.spec.ts`, `e2e/boerse-rules.spec.ts`, `e2e/survey-form.spec.ts`, `e2e/demo-home.spec.ts` (new).
- **Change:** (a) `alertBoerseOffers` (3518) and `buildRemindersFor` holder (10320-10324) → `rcRefMatches` over `getActiveRcPeople()`; holder rule extracted to `server/boerse.ts` and pinned. (b) `rcIdForName`/`resolveRefereeCoachPersonId` → `resolveRcName` (aliases, both orders, unique); `resolveRefereeCoachPersonId` accepts an admin body `rcId` first. (c) `POST/PUT /api/referee-coaches` (9041/9058) accept `rc_id`, resolve from `rc_name`, refuse an unresolvable name (422). (d) `POST /api/admin/games` accepts `assigned_rc_id` from the picker. (e) `GET /api/rc-overview/:rcRef/coachees` (7307): segment = roster id when it matches, else name; `loadrcCoachSummary(rcRef)` passes `rcAuth.rcId` (App 2283/2375) and `r.id` (AdminConsole 4162/4441); **`demo.loadrcCoachSummary` accepts `RC.id` or `RC.name`** (demo.ts:640). (f) President-note entry (6301-6312) stores `matchNo`, `rcId`, `refereeId`; `renameRcReferences` (5002) also re-stamps `rc_game_notes.rc_name` and president-note `rcName`; `migrate-rc-ids` (10015) honours `name_aliases`, both orders, all people, and `rc_game_notes`. (g) `collectExpenseVisits` (6911) calls `getActiveRcPeople()` first. (h) `rcRefMatches` becomes the `samePerson` wrapper. (c-optional, "5c") `rc_visit_feedback` gains `T('rc_id'), T('game_id')`; `createSurveyToken` (6015/9671) stores them; `surveyGameHadTwoReferees` reads `game_id` first — the schema comment at setup-schema.mjs:222-225 ("the row cannot point back at a person") predates ccf2d93 (Anonym absenden retired) and is updated; open question 7.
- **Fallback:** blank/unknown id → folded name as today; ambiguous admin name → refused with the name in the error; survey rows without the new fields → `rc_name`/`match_no` as today.
- **Data/admin:** 5c only: run `setup-schema.mjs` on **lenovoserver** (`docker cp` + `docker exec svrz-rc-svrz-api-1 node deploy/hetzner/seed/setup-schema.mjs`) BEFORE the API build — PocketBase drops writes to undeclared columns. Then re-run `migrate-rc-ids` once (aliases now honoured).
- **Tests:** `admin-overview-detail.spec.ts`: detail requested with `r.id`; a name-shaped legacy call still answers; two coaches with one folded name resolve separately. `president-note.spec.ts`: entry carries `matchNo` + `rcId`. `boerse-rules.spec.ts`: holder rule (id first, known-id veto, name fallback). `survey-form.spec.ts` (5c): token row carries `rc_id/game_id`. `demo-home.spec.ts`: `#/demo` Home shows the summary and a taken game reads as mine. Ratchet pins lowered for server/index.ts.
- **Ships alone:** yes (5c: schema run before the API copy).

### Step 6 — Identity audit endpoint + console card ("Datenqualität")

- **Files:** `server/identityAudit.ts` (new, pure), `server/index.ts`, `src/components/AdminConsole.tsx`, `src/lib/pocketbase.ts`, `e2e/admin-identity-audit.spec.ts` (new), `e2e/identity-rules.spec.ts`.
- **Change:** `GET /api/admin/identity-audit?season=` → `{ coacheesUnlinked: [{id, name, season, reason: 'unmatched'|'ambiguous'|'never-linked', candidates: [{sv, name}]}], duplicateSvPerSeason: [{sv, rowIds}], svDisagreesWithGame: [{coacheeId, rowSv, matchNo, slotSv}] (the step 2 warnings, made visible), gameSlotsByName: [{gameId, matchNo, slot, name, via}] for this season's slots resolved at the name tier or not at all, gameSlotsNoSv: n, duplicateMatchNos: [{matchNo, gameIds}], blankMatchNo: [gameIds], rcRefsUnresolved: rows in games/feedbacks/rc_game_notes/president notes whose rc id is blank or unknown, rcsWithoutSv: [ids], assignByNameLast30d (from the log) }` computed by a pure `identityAudit(rows…)`. Console: a card on the Coachees tab with counts (green 0 / amber n), the lists, per-row link picker (single candidate pre-selected), and the three buttons (link-referees, backfill-referee-ids, migrate-rc-ids) with their reports; the admin Games tab marks a slot resolved by name with a grey "nur Name" chip (from `firstCoacheeVia`).
- **Fallback:** n/a — this is the surface for everything that stays unlinked.
- **Data/admin:** drive "nicht verknüpft" to 0 by hand; read `duplicateMatchNos` before step 9 (also answers open question 3 for prod data).
- **Tests:** `identity-rules.spec.ts`: the classifier (unlinked with candidates, duplicate SV per season, SV-disagrees, duplicate/blank match_no, RC rows without id). `admin-identity-audit.spec.ts`: stubbed report renders; buttons post to the three endpoints; the link click PUTs `referee_id` and the badge drops.
- **Ships alone:** yes.

### Step 7 — Human-facing game references by match number (ask 3)

- **Files:** `src/App.tsx`, `src/components/AdminConsole.tsx`, `src/lib/offlineQueue.ts`, `src/types.ts`, `server/index.ts`, `e2e/form-draft.spec.ts`, `e2e/home-done-open.spec.ts` (new), `e2e/manual-game-picker.spec.ts`, `e2e/net-fail-lifecycle.spec.ts`, `e2e/notebook.spec.ts`.
- **Change:** draft banner (4379) `list[0].label || list[0].matchNo || teams+date`, never `gameId`; feedback picker rows (9341/9359) show `#<match_no>`; outbox label (3500) and notebook `markUsed` label (4550) `#<matchNo> · teams` via one `gameLabel(game)` helper (keys unchanged); `openDoneObservation` (3010) opens by `feedbackId` when the row carries one, else today's day match; AdminConsole toast (3805) `match_no`, else teams + date; `foldOverviewGames` (4131) keys done rows by `gameId`; president-notes list shows `matchNo`. Log lines already print `match_no || id` — a log is not a screen. iCal UIDs (server 8806, App 538) stay record ids on purpose.
- **Fallback:** blank `match_no` (legacy manual games) → teams + date; the audit lists them so the admin can give a number.
- **Data/admin:** none.
- **Tests:** `form-draft.spec.ts`: banner reads `#2345678` for a game that left the list. `home-done-open.spec.ts`: two observations of one coachee on one day open the right record each. `manual-game-picker.spec.ts`: toast never contains a 15-char id. `net-fail-lifecycle.spec.ts`: outbox row shows `#2345678`. `notebook.spec.ts`: "used in" label shows `#2345678`.
- **Ships alone:** yes.

### Step 8 — Coachee URLs by SV number (ask 4)

- **Files:** `src/App.tsx`, `src/lib/identity.ts`, `src/lib/routes.ts`, `src/lib/logger.ts`, `e2e/support/app.ts`, `e2e/deep-links.spec.ts`, `e2e/legacy-links.spec.ts`, `e2e/path-routing.spec.ts`, `e2e/season-requests.spec.ts`, `e2e/routes.spec.ts`.
- **Change:** `coacheeUrlToken` / `resolveCoacheeToken(token, coachees, season) → {row, otherSeason}` in identity.ts (§3); `currentRoute` (1850) emits the token; `openDeepLink` (3063) resolves sv-in-season → id-in-season → id-any-season (distinct notice) → not found; `historyKeyOf` (1866) maps the token to the resolved record id before comparing, so an old-shape address bar and a new-shape state are one view and the existing effect replaceStates the canonical shape. `routeToPath` gains `encodeURIComponent`; routes.ts comments at 40-44/132-135 updated (token may be an SV; never lowercased; no shape test). `logger.ts scrubTokens` (184): optional digit-segment mask (open question 2). API paths unchanged.
- **Fallback:** coachee without `referee_id` → record-id URL, permanently. Unknown token → "Coachee nicht gefunden — vielleicht eine andere Saison." and the list.
- **Data/admin:** none.
- **Tests:** `deep-links.spec.ts`: 64 flips to `/games/90003`; cold loads of `/games/90003` and `/feedbacks/90003/<record>`; `/games/c1` and `/feedbacks/c1/<record>` kept as the permanent fallback. `legacy-links.spec.ts`: `#/games/c1` → `/games/90003` with `goBack() === null` (per open question 1); `#/games/<unlinked>` pins the record-id shape verbatim. `path-routing.spec.ts` 112-117 with the SV token. `season-requests.spec.ts`: only-last-season SV → the other-season notice; rows in both seasons → this season's. `routes.spec.ts`: `/games/90003`, `/feedbacks/90003/fb1` round-trip; a token with a space encodes and decodes.
- **Ships alone:** yes.

### Step 9 — Game URLs by match number (ask 5)

- **Files:** `src/App.tsx`, `src/lib/identity.ts`, `src/lib/routes.ts`, `e2e/support/app.ts`, `e2e/path-routing.spec.ts`, `e2e/notebook.spec.ts`, `e2e/season-requests.spec.ts`, `e2e/form-draft.spec.ts`, `e2e/routes.spec.ts`, `e2e/manual-game-visible.spec.ts`, plus the 7 fixture sites (season-requests 73/75/77/142, quick-filters 16, late-take 12, vm-marked-game 11).
- **Change:** `gameUrlToken(g, eligibleGames)` = `matchNo` when `!g.isManual` and the number is unique among `eligibleGames`, else `g.id`; `resolveGameToken` as in §3. `currentRoute` emits it; `openGameRoute` (4236) early-return compares `resolveGameToken(token)?.id === selectedGameId` (a Back onto the same form must not re-select and flush the draft); `openUrlGame` (4262) uses the resolver; `autoResumeRef` (2146) and the draft-boot compare (4313-4324) resolve `initialRoute.gameId` to a record id once `eligibleGames` arrive (`wanted` = resolved id; the honoured-half check compares against it) so `/form/2345678/2sr` still resumes its draft silently; `historyKeyOf` resolves game tokens too. Draft keys, resume hint, outbox, notebook `PageUse.g`, parked drafts: record ids, no migration. **First commit of this PR: give the 7 fixture clones distinct match numbers** — otherwise the stubbed lists hold two games with one number and the tie rule decides what Back reopens.
- **Fallback:** manual games, blank numbers and duplicated numbers emit the record id. Unknown token or other season → "Spiel nicht gefunden — vielleicht eine andere Saison." A typed `/form/TEST-…/1sr` resolves by number when unique.
- **Data/admin:** read the audit's `duplicateMatchNos` on prod first (open question 3).
- **Tests:** `path-routing.spec.ts` 51-96 with `/form/2345678/1sr|2sr`, `goBack() === null` kept; `/form/g1/1sr` canonicalises without an extra entry; `GAME_MANUAL {isManual, matchNo 'TEST-20260916-a1b2'}` keeps `/form/<recordId>/1sr` (`manual-game-visible.spec.ts`); two eligible games with one number → record id emitted. `notebook.spec.ts` 244/249 → `/form/2345678/1sr`. `season-requests.spec.ts`: last-season number → not found; two games sharing a number, one this season → this season's opens. `form-draft.spec.ts`: a draft resumes from `/form/2345678/2sr` on the 2. SR half; cross-tab and resume-hint paths unchanged. `routes.spec.ts`: `/form/TEST-20260916-a1b2/2sr`, encoded round-trip.
- **Ships alone:** yes.

### Step 10 — Close the ratchet, record the contract

- **Files:** `e2e/identity-ratchet.spec.ts`, `src/lib/identity.ts`, `src/lib/routes.ts`, `infrastructure.md`, project memory (`svrz-rc-path-routing.md`).
- **Change:** pins at 0 outside the allow-list (remaining display/search/import-key sites carry `identity:display` with a reason); the URL scheme and the id-first rule written into the routes.ts and identity.ts headers; "link after import / SV field / two URL shapes forever / schema-before-code" notes in infrastructure.md and memory.
- **Fallback:** n/a. **Data/admin:** none. **Tests:** final pins; full suite green. **Ships alone:** yes.

### Step 11 — Optional, gated on prod checks: VM `associationId` for sync-contacts, unique index

- **Files:** `server/index.ts`, `deploy/hetzner/seed/setup-schema.mjs`, `e2e/admin-sync.spec.ts`.
- **Change:** (a) add `'person.associationId'` to `VM_CONTACT_COLUMNS` (2091) behind `VM_CONTACT_SV=1`; `VmRefereeContact` gains `svNumber`; when the number is in the register, `sync-contacts` writes `referee_id` for a name-matched unlinked coachee. Never read unrequested: the comment at 2100 says the addressviewer returns only the requested columns. (b) `indexes` support in `setup-schema.mjs` (`pb.collections.update(id, { indexes: ['CREATE UNIQUE INDEX idx_games_match_no ON games (match_no)'] })`), applied once the audit reports zero duplicates.
- **Fallback:** without (a) the register import stays the link source; without (b) code-level uniqueness + audit.
- **Data/admin:** (a) one flagged sync run, the log line says whether the column came back; (b) schema run on lenovoserver after a duplicate check.
- **Tests:** `admin-sync.spec.ts`: stub with `associationId` links an unlinked coachee; without it nothing is written.
- **Ships alone:** yes.

## 6. Rollout order and deploy notes

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → (11). Steps 2+3 first: they fix the live León submit/reminder failure without touching the client. Steps 8 and 9 last: they need the fixtures and the audit's duplicate count.

- **Hosts:** Pages ships on push to `main` (CI: tsc + Playwright → wrangler). The API is copied and built by hand on **lenovoserver** (`/home/lucanepa/svrz_rc`, copy-then-build, never `git pull`). Schema runs (5c, 11b) go on **lenovoserver** BEFORE the API build. Never touch ports 8787/8090 from a dev session.
- **Skew rules:** every new wire field is optional; the client falls to the name for any missing id; the assign-rc body always carries the name. No step makes a field required.
- **Admin runs after step 3:** link-referees → backfill-referee-ids → hand-link the rest; after step 5: migrate-rc-ids; before step 9: audit duplicate match numbers.

## 7. Risks

- **Shared checkout.** A second session commits on `main` in this tree; line numbers are HEAD 2d0a9c6 at planning time. Re-grep before editing, check HEAD before committing. The exact-pin ratchet moves on any commit that adds/removes a comparison idiom — narrowed to idioms and with the marker escape hatch, but an unrelated commit can still block the deploy of everything behind it until its pin is updated.
- **Trusting `coachees.referee_id`.** Filled partly by the word-subset heuristic; a wrong link pairs a game with the wrong person by id, which the name fallback cannot catch. Mitigation: accept-and-warn on mismatch (step 2h), the audit's "SV-Nr. widerspricht Spiel" list (step 6), no veto until the links have been reviewed (open question 4).
- **Import widening (step 2).** One-off jump in imported games / Home planned rows on the first nightly run — intended, announce it.
- **Merge rule trusts the folded name.** `mergeIncomingGame` keeps a stored id when the slot name is unchanged; two different referees whose names fold equal swapping on one game would keep the wrong number — the same class of risk `forms.ts` documents for `personKey`.
- **Two thirds of stored games carry no slot SV.** Backfill + `vmFactsPatch` fill widen it; the register tier and the name fallback cover the rest.
- **rc-overview grouping change.** `coacheeId` now filled for game-only coachees → Home rows become clickable; `home-planned-games`/admin specs assuming `''` need fixture updates.
- **SV number in the path is a person identifier**: reaches Pages request logs, the same-origin Referer of `/assets` fetches and Admin → Protokoll (`nav.change`/`ui.click`). Open question 2.
- **History integrity.** Any moment the bar shows one shape while the state emits the other would push a junk Back entry unless `historyKeyOf` resolves both; the `goBack() === null` assertions in `path-routing`/`legacy-links` are the tripwire.
- **Draft auto-resume.** If step 9 ships without resolving the token first, `/form/<matchNo>/…` stops resuming its draft silently; `form-draft.spec.ts` must cover it.
- **Demo mode** makes zero backend calls; any client site that REQUIRES an id breaks it silently. Step 4 seeds the demo with ids, step 5 fixes the summary lookup, `demo-home.spec.ts` pins it.
- **`match_no` uniqueness is code-enforced** until step 11b; a manual game typed with a real VM number before step 3 is still adopted by the sync only if it has no `external_id` sibling — the `manual_games` exclusion in `findGameByMatchNo` ends that.
- **`getCoacheeNameIndex` rebuild cost:** one full coachees read per call, three calls per `/api/eligible-games` request; step 2 adds the register read. If `feedback.submit` phase timings show it, add a 30-60 s cache invalidated by the coachee/register write routes.
- **`rc_visit_feedback` ids (5c)** change the meaning of a table the schema comment calls deliberately person-free; only proceed because "Anonym absenden" was retired in ccf2d93 (open question 7).

## 8. Open questions (yours to decide)

1. **Canonicalise the address bar?** After an old `/games/<recordId>` or `/form/<recordId>` link resolves, rewrite to `/games/<sv>` / `/form/<matchNo>` with `replaceState` (recommended; no extra Back step; `legacy-links.spec.ts:44` then asserts the SV form) — or leave the typed shape?
2. **Privacy of the SV number in the path.** Accept it (it is the licence number printed on every score sheet) or extend `scrubTokens` to mask digit segments under `/games/` and `/feedbacks/` in the client log (cheap, step 8)? Cloudflare request logs and Referers cannot be masked.
3. **Do VolleyManager match numbers repeat across seasons?** The tie rule (season on screen, then newest) covers it either way; if the audit on lenovoserver shows repeats, a season qualifier (`/form/<matchNo>?s=2026`) is cleaner. Decide after step 6's count.
4. **SV mismatch: warn (this week) or veto?** Recommended: warn until the audit's "SV-Nr. widerspricht Spiel" list has been reviewed once, then flip to the known-different veto `rcRefMatches` uses for coaches.
5. **Ask the commission for an `SV-Nr.` column in the coachee XLSX** they maintain? The one change that makes every future season start at "nicht verknüpft: 0" without a register re-import.
6. **Hand-link only to register rows** (recommended; a typo cannot create a phantom identity) or allow a free-typed number?
7. **Survey rows: add `rc_id`/`game_id`** (schema run, step 5c) now that "Anonym absenden" is retired, or keep them name-only as the schema comment intended?
8. **Try `person.associationId` on the VM addressviewer** (step 11a, one flagged column, one sync run)?
9. **Once `/form/<matchNo>/<role>` exists, link the reminder mail and the iCal event straight to the form?** A new feature, not one of the five asks.

## 9. Effort

| Step | Days |
|---|---|
| 1 helper + ratchet | 0.5 |
| 2 server SV-first, register tier, merge rule, sorted lookups | 1.5 |
| 3 link/inherit/SV column/hand-link/backfill/409 | 1.0 |
| 4 wire ids, server coachee ids, client id-first, demo, contract spec | 2.0 |
| 5 RC sites, rc-overview by id, president notes, survey ids (+ schema run) | 1.0 |
| 6 audit endpoint + card | 1.0 |
| 7 human-facing match numbers | 0.5 |
| 8 coachee URLs | 0.5 |
| 9 game URLs + fixture renumbering | 1.0 |
| 10 close the ratchet + docs | 0.25 |
| 11 optional VM column + index | 0.5 |
| **Total** | **~9.5-10 developer days**, ten PRs each under two days and each deployable alone |
