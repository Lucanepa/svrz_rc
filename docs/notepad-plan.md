<!-- Status: PLANNED, not built. v2 written 2026-09-15 (evening) after Luca's decisions; supersedes the per-game v1 of the same day (kept in the session scratchpad as notepad-plan-v1-per-game.md). Line numbers were verified against HEAD 6f3e8b6; once the Spielprotokoll commit lands, server/index.ts lines ≥ 3904 shift by +2. Companion memory: svrz-rc-notepad-plan. -->

# Notizblock — implementation plan (v2: the free notebook)

**What Luca decided (2026-09-15):** the notebook is **not per game** — "it is literally like a noteblock": pages a coach writes or draws on, wherever they are in the app. Notes are **for the RC only** (author-only; nobody else, ever) and are **deleted at most one week after** they were written. Everything else from the first plan stands — rich-text import into the form, the server as the source of truth, the pen page, the launcher on every screen, the fullscreen toggle. The English name is **Notebook**.

Where v1 had one pad per game with referee/set/tone tags, chips on game rows, a coachee-page section and an Übersicht with a game picker, v2 has **pages**. The building blocks that three verifiers checked against the code on 2026-09-15 (server route pattern, IndexedDB module, sync engine, ink pad, `appendPlainToRich`, privacy guards, test idioms) are reused as they were verified; the file:line pointers below are theirs.

---

## 1. Summary

- **One Notizblock per coach**, reachable from every RC screen through a launcher in the app's chrome. It is a stack of **pages**, newest on top: a **Textseite** (one free-form `<textarea>` — iPadOS Scribble, Samsung S Pen and Gboard write into it natively) or a **Stiftseite** (vector ink, pen-first, finger toggle). No game, no referee, no tags; a page carries only when it was written.
- **A page lives one week.** Every page shows "wird am {date} gelöscht"; the server deletes rows seven days after they were created, the device purges the same way, and nothing extends it. What must outlive the week goes into the report (import) — that is the whole point of the notebook.
- **The server is the source of truth** (PocketBase `rc_notebook`, one row per page, owner from the session only, chair and admin console refused); the device store (IndexedDB `svrz-notebook`) is a cache/offline buffer. A wiped phone gets its pages back at the next sign-in. Two devices merge per page (last writer wins per page, tombstones, absence never deletes).
- **Into the form only on purpose**: on the observation form, the sheet's footer offers **Übernehmen…** — pick text pages, pick the target field, read the sentence that says the text is mailed to the referee with the PDF, insert into the half on screen. Ink is never imported.
- **Fullscreen** toggle in the sheet header (remembered per device; the pen page grows with it).
- What it is **not**: not per game, not tagged, not a chair-visible channel, not handwriting recognition, not part of feedback_json/tipsAndTricks/the PDF, not a route, not a floating button, not on game rows, not on the coachee page, not for admin console sessions, not in demo mode.

---

## 2. Decisions

### 2.1 Taken by Luca (2026-09-15)

| # | Decision | Consequence in this plan |
|---|---|---|
| L1 | **Free notebook, not per game** — "literally like a noteblock" | Pages instead of entries; no `gameId`/`who`/`set`/`tone`/`coacheeId`; no chips on game rows, no coachee-page section, no Übersicht/game picker; the launcher opens the notebook itself |
| L2 | **RC-only** — "the notes are for the RC only" | Author-only on the server (parkOwner pattern), chair's president session 401, admin console 403; no admin/chair read path anywhere; `data-log-redact` on every rendered page |
| L3 | **Deleted at most one week after** | `NOTEBOOK_TTL_MS = 7 d` from the page's creation on both sides; the server prunes by its own `created` autodate, the device by `createdAt`; pages past their date are hidden immediately and purged at boot; no "keep longer" |
| L4 | Rich text etc. "is fine" | The import writes the four rich boxes through `appendPlainToRich` (v1 §7) and Tipps & Tricks as plain text; the notebook's own text is plain (a `<textarea>`) |
| L5 | **English name: Notebook** | `PAD_STRINGS.EN.padTitle = 'Notebook'`, every EN string and every test regex below |

### 2.2 Taken in the plan (the v1 reasoning that still applies, in one line each)

| # | Decision | Why |
|---|---|---|
| 1 | One **row per page**; a text page and an ink page are the same record type with `kind` | Per-page LWW + tombstones bound every failure to one page; each ink page has its own 2 MB J() budget (setup-schema.mjs:14; server/index.ts:247-258 says the cap can never be raised in place) |
| 2 | Monotonic per-page versions (`updatedAt = max(Date.now(), prev + 1)`), the ack returns the stamp the server stored (clamped when > 24 h ahead) and the client adopts it; no learned clock offset | v1 decision 5 — closes the future-clock and tombstone-under-live cases without an offset |
| 3 | Full index pull at boot and on `online` (≥ 60 s apart); page pull (no ink) on every sheet open; ink fetched lazily per page | v1 decisions 6 and 24; a week of pages is a handful of rows |
| 4 | Sync 5 s after a local commit, dirty pages only, batches ≤ 50 pages and ≤ 1 MB serialised, ink pages in their own request, backoff 10 → 60 s after a failed push, no push while offline, keepalive POST on pagehide only for a text body < 32 KB | v1 decision 16 — the fetch patch mails the operator for slow failed fetches (logger.ts:336-356), so no tight retry loop |
| 5 | `/api/notebook` excluded from the SW NetworkFirst rule (vite.config.ts:152-154) and every GET answers `Cache-Control: no-store` | v1 decision 17 |
| 6 | **No route**; the sheet is a modal like the SR-Spiel note (App.tsx:8461) that closes on any navigation under it (view-change effect + top of `onPop`) | v1 decision 20; nothing in routes.ts, `_redirects` or the three route specs changes |
| 7 | Launcher in the chrome on every RC screen: title card (App.tsx:5395-5403) and first in the controls bar (5227-5231); **no FAB**, no Home-row tool button | v1 decisions 7 and 28 |
| 8 | Fullscreen toggle: layout-level, remembered in `localStorage['svrz_pad_full']`, Fullscreen API on `document.documentElement` (never the panel — `<UiHost/>` toasts and confirms mount at the root, main.tsx:233) | v1 decision 29 |
| 9 | Import inserts a page **verbatim** (trailing whitespace trimmed), pages joined by a blank line, no bullet, no prefix — a free page is prose, not a list of remarks | The `addBullet` idiom (App.tsx:750-753) is for lines; the PDF is always German (App.tsx:3231-3250), so no UI-language prefix |
| 10 | Import writes only the half on screen (`formData.role`); `usedIn[]` marks a page with field, half and the game's label; re-inserting the same page into the same field/half asks first | v1 decisions 10 and 12 |
| 11 | Admin console sessions and demo mode get **no notebook** (launcher hidden; server 403) | v1 decision 18 |
| 12 | Server-only mode when IndexedDB is unavailable or the database opened without both stores | v1 decision 19 |
| 13 | Ink: fixed A4-ratio logical page 1000 × 1414, serialised size ≤ 800 000 chars and ≤ 4 000 strokes per page (the same predicate on both sides), DPR ≤ 2, perfect-freehand@1.2.3 behind one `renderStroke()` | v1 decisions 14 and 15 |
| 14 | Strings in `src/lib/notepadStrings.ts` (`PAD_STRINGS = { DE, EN }`, `fill()` helper) — `UI_STRINGS` (App.tsx:113) is module-private; the feature is called **Notizblock / Notebook**, never "Notizen" alone (`t.notes` already labels the coachee.notes box, App.tsx:6884-6903) | v1 decisions 25 and 26 |
| 15 | A page cap of **40 live pages per coach** (server: `rejected: 'too-many-pages'`; client: "Neue Seite" disabled with a sentence) | A backstop for a wedged client, not a working budget — a week of games is a handful of pages |
| 16 | The first text page is **created on the first keystroke**, not on open | An auto-created blank page would sync an empty row every time the sheet is opened and closed |
| 17 | One small **Zeit** button on a text page inserts `HH:MM ` at the caret (Europe/Zurich, appTime.ts:142 `clockLabel`) | The one thing a paper block cannot do and a coach in a hall wants; one tap, plain text, no structure |

### 2.3 Still open for Luca (recommended default in bold)

1. Text page look: **plain `<textarea>`** (Scribble/S Pen/Gboard-friendly, verbatim into the form) vs the app's RichSurface (bold/colour inside the notebook itself). Plain: the notebook is scratch; formatting happens in the form after import.
2. **Zeit** button: **yes** (decision 17) vs none.
3. Page cap: **40** vs something else — one constant on each side.
4. perfect-freehand dependency: **add it** vs polylines (v1 §2.3 item 5).
5. Ink tools: **black + red, one width, undo, whole-stroke eraser, clear page**.
6. Fullscreen: **manual toggle, remembered** vs auto-fullscreen for the Stift tab on phones.
7. Insert format: **verbatim page, pages separated by a blank line** vs `• ` per line.

---

## 3. Data model

### 3.1 Client types — `src/lib/notebook.ts` (new)

Flat types only (tsconfig has no `strict`; boolean-tagged unions do not narrow). `deleted` and `dirty` are plain fields, never discriminants.

```ts
export const NOTEBOOK_SCHEMA = 1;               // "newer is skipped, never migrated blind" (formDraft.ts:276-292)
export const NOTEBOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // from createdAt — Luca: "deleted at most 1 week after"
export const NOTEBOOK_MAX_PAGES = 40;           // live pages per coach (backstop)
export const NOTEBOOK_MAX_TEXT = 20_000;        // chars per text page, stored verbatim (no trim — server/index.ts:10166-10172 rule)
export const NOTEBOOK_INK_MAX_CHARS = 800_000;  // JSON.stringify(page).length — the SAME predicate the server enforces
export const NOTEBOOK_INK_MAX_STROKES = 4_000;
export const NOTEBOOK_SYNC_DELAY_MS = 5_000;    // exported so a spec can name it
export const NOTEBOOK_BATCH_MAX_BYTES = 1_000_000;         // strictly below the server's wire cap

export type PageKind = 'text' | 'ink';
export type PadField = 'bemerkungen' | 'highlights' | 'improvements' | 'goals' | 'tips';
/** What "übernommen" prints: the field, the half, and the game it went into. */
export type PageUse = { f: PadField; r: '1. SR' | '2. SR'; g: string; label: string; t: number };

/** One page. `id` is DERIVED (`${ownerId}|${pageId}`), never passed — the e2e seed
 *  derives it the same way (form-draft.spec.ts:55-58 trap). */
export type NotebookPage = {
  id: string;
  schema: number;
  ownerId: string;        // outboxOwnerId (App.tsx:1505); the only identity that reads it back (formDraft.ts:3-4)
  pageId: string;         // crypto.randomUUID() at creation (pocketbase.ts:734 precedent) — the merge identity
  kind: PageKind;
  text: string;           // kind 'text'; '' on ink
  points: number;         // kind 'ink' — sample count (cheap "is there ink"); 0 for text
  usedIn: PageUse[];      // ≤ 10
  createdAt: number;      // epoch ms, device clock — the page's EXPIRY clock (createdAt + NOTEBOOK_TTL_MS)
  updatedAt: number;      // epoch ms — the LWW version of THIS page; MONOTONIC on every write
  deleted: boolean;       // tombstone: the row STAYS (until the TTL) so a stale copy elsewhere cannot resurrect it
  dirty: boolean;         // LOCAL ONLY — not yet acknowledged by the server; stripped from the wire
  savedAt: string;        // LOCAL ONLY — server autodate of the last ack; '' = never reached the server
  rejectedReason: string; // LOCAL ONLY — a terminal server refusal; the engine skips the page until an edit clears it
  extra?: Record<string, unknown>;   // forward-compat bag (formDraft.ts:71-74 contract), never for content
};

/** Ink lives in its OWN object store under the page's key, so listing pages never deserialises strokes. */
export type InkStroke = { c: 0 | 1; w: number; p: 0 | 1; d: number[] };   // v1 §3.1 encoding, unchanged
export type InkPage = { w: 1000; h: 1414; strokes: InkStroke[] };
export type NotebookInk = { id: string; ownerId: string; page: InkPage };

/** What travels. NO id, ownerId, dirty, savedAt, rejectedReason. */
export type PageWire = Omit<NotebookPage, 'id' | 'ownerId' | 'dirty' | 'savedAt' | 'rejectedReason'> & { ink?: InkPage };

export type PageAck = {
  ownerId: string;
  saved: { pageId: string; savedAt: string; updatedAt: number; createdAt: number }[];   // both stamps as the server stored them
  stale: { pageId: string; updatedAt: number }[];
  rejected: { pageId: string; reason: string }[];
};

export const pageExpiresAt = (p: NotebookPage) => p.createdAt + NOTEBOOK_TTL_MS;
export const pageIsLive = (p: NotebookPage, now: number) => !p.deleted && pageExpiresAt(p) > now;
```

### 3.2 Server collection — `deploy/hetzner/seed/setup-schema.mjs`, after `parked_drafts` (lines 260-262), before `console.log('SCHEMA_OK')` (263)

```js
// The coach's PRIVATE notebook: pages of text or ink written anywhere in the app,
// kept for ONE WEEK after they were written and then deleted — a scratch pad,
// not a record. ONE ROW PER PAGE: two devices in one evening merge per page, a
// deleted page stays as a tombstone (deleted = true, payload = {}) until its
// week is up so a stale copy elsewhere cannot bring it back, and a page of ink
// gets its own 2_000_000 J() budget.
//
// owner_id is the RC's id from the SESSION and never from a request body — the
// same rule as parked_drafts. Author-only: the chair's president session and the
// admin console are refused (see /api/notebook in server/index.ts). The server
// stores it opaquely: it files nothing, mails nothing, and nothing here reaches
// feedback_json or the PDF unless the coach inserts it in the app.
//
// created_at / updated_at are the DEVICE clock (which of two copies is newer;
// when the page expires); `created` / `updated` (autodate) are the server's, for
// sort and for the prune — a tablet that boots in 1970 must not be able to make
// a page immortal or kill it on arrival.
//
// PocketBase drops keys a collection does not declare: the first tombstone
// written in the hand verification must read `deleted: true` back.
await ensure('rc_notebook', [
  T('owner_id'), T('page_id'), T('kind'), T('created_at'), T('updated_at'), B('deleted'),
  NUM('schema'), J('payload')
]);
```

`payload` = `{ text, points, usedIn, ink?, extra? }` — `{}` on a tombstone. Eight declared columns plus the autodate `created`/`updated` that `ensure()` appends (setup-schema.mjs:38-43).

### 3.3 Server caps (constants in the new section, §9.1; the body-gate pair beside `PARK_*` at 259-261)

| constant | value | why |
|---|---|---|
| `NOTEBOOK_MAX_BYTES` (Content-Length gate ahead of the parser) | 1_500_000 | strictly below J() 2_000_000 (247-258 rule); one 800 KB ink page fits |
| `NOTEBOOK_MAX_PAGES_PER_REQUEST` | 50 | beyond it `rejected: 'too-many'`, never a silent slice |
| `NOTEBOOK_MAX_TEXT_LEN` | 20_000 | a page, not a report |
| `NOTEBOOK_MAX_INK_CHARS` / `_STROKES` | 800_000 / 4_000 | equals the client's; refused per page (`'ink-too-big'` / `'ink-shape'`), never a 500 |
| `NOTEBOOK_MAX_PAGES` | 40 live pages per owner | counted under the lock; an incoming live page whose row is absent or tombstoned counts as new → `'too-many-pages'` |
| `NOTEBOOK_MAX_USED_IN` / `_EXTRA_BYTES` | 10 / 20_000 | parkExtra twin |
| `NOTEBOOK_PAGE_ID_RE` | `/^[A-Za-z0-9_-]{8,64}$/` | else `rejected: 'bad-id'` |
| `NOTEBOOK_MAX_CLOCK_SKEW_MS` | 24 h | future `updatedAt` **and** `createdAt` beyond it → server now (10087 rule); both accepted stamps returned in the ack |
| `NOTEBOOK_TTL_MS` | 7 d | by server `created`; rows (tombstones included) older than it are **deleted** by the prune |
| `NOTEBOOK_PRUNE_EVERY_MS` | 10 min per owner | v1 verifier: no full read after every 5-second push |
| `NOTEBOOK_RATE_LIMIT_MAX` | 300 / 5 min, keyed by RC id | two devices of one coach share the bucket |

### 3.4 Retention — the one-week rule, both sides

- **Server:** `pruneNotebook(ownerId)` deletes every row of the owner whose autodate `created` is older than `NOTEBOOK_TTL_MS`, and, above the page cap, the oldest live pages by `created` (clone of `pruneParkedDrafts`, server/index.ts:10301-10322, throttled per owner). Sort and age by the server clock, never by `created_at` (10303-10311 reasoning).
- **Client:** `pageIsLive(p, now)` gates every reader — an expired page is invisible the moment its week is up, even before the next boot. At boot, `pruneNotebook(ownerId)` deletes expired rows (entry and ink) and, for a **never-acked** page (`savedAt === ''`) only, still respects `createdAt` — a dirty page past its week is deleted too, because "at most one week" is the promise and the row would be refused server-side anyway (the server clamps and prunes by its own clock).
- **Shown:** every page carries `fill(tp.padExpires, { date: dayLabel(expiresAt) })` — "wird am Sa 22.09. gelöscht" — in its meta line; a page within 24 h of expiry shows it in amber.
- **Send / discard / reset of an observation:** nothing happens to the notebook. Only the calendar deletes.

### 3.5 Schema / versioning

`schema: NOTEBOOK_SCHEMA` on every page; `listPages()` filters `(p.schema ?? 1) <= NOTEBOOK_SCHEMA` (formDraft.ts:283-292 policy). A future ink encoding change is `NOTEBOOK_SCHEMA = 2` + a refusal, never a blind migration.

---

## 4. Storage & sync

### 4.1 IndexedDB — `src/lib/notebook.ts`

- `DB_NAME = 'svrz-notebook'`, `DB_VERSION = 1`, two object stores created in `onupgradeneeded`: `'pages'` (keyPath `id`) and `'ink'` (keyPath `id`). Its OWN database (formDraft.ts:1-11: a version bump here must never block `svrz-drafts`/`svrz-offline`; a quota failure on ink must never abort a transaction on finished submissions).
- `openDb` copied from formDraft.ts:166-191 with three changes: `onupgradeneeded` creates BOTH stores; the `onblocked` message names this store; **`onsuccess` verifies `db.objectStoreNames.contains('pages') && contains('ink')` and rejects otherwise** → server-only mode (a v1 database created with one store never runs `onupgradeneeded` again).
- `run(mode, store, fn)` / `runTx(mode, stores, fn)` from formDraft.ts:193-234 — resolve on transaction COMMIT so QuotaExceeded rejects; `runTx` takes the store list.
- API: `pageKey(ownerId, pageId)`, `listPages(ownerId, now)` (`getAll()` + owner + schema + `pageIsLive` filter, no index on purpose), `getInk(ownerId, pageId)`, `putPages(records)`, `putInk(record)`, `tombstone(ownerId, pageId)` (read + write in ONE `runTx` over `['pages','ink']`: `deleted: true, dirty: true, updatedAt: nextVersion(prev)`, and **the `ink` row is deleted** — a deleted pen page's strokes must not stay on a shared tablet's disk; a missing record is never created), `applyServer(ownerId, rows)` and `ackSaved(ownerId, ack)` (read-decide-write inside one transaction), `pruneNotebook(ownerId, now)` (boot only; `getAll()` without owner filter, not exported as a reader — formDraft.ts:365-367), `notebookStoreAvailable()` (formDraft.ts:424-444 shape), and the shared `requestPersistentStorage()` (formDraft.ts:446) after the first successful commit.
- Pure, unit-tested: `mergeFromServer(local, server)` → `{ write, dropInk, fetchInk }`, `serverDecision(row, incoming)`, `nextVersion(prev?)`, `wireFrom(page, ink)`, `batchesFor(pages)`, `syncBatchFor(ownerId, pages)` (null when any page's owner differs), `pageIsLive`, `pageExpiresAt`.
- Every storage access swallows errors; a failed write surfaces as `padSaveFailed` in the sheet's status line, never as a throw into any submit path (App.tsx:3782-3788 rule).

The e2e seed must use these literals: `'svrz-notebook'` / `'pages'` / `'ink'` / version 1 / id `${ownerId}|${pageId}` — and create BOTH stores in `onupgradeneeded` even when it seeds only pages.

### 4.2 Sync engine — `src/lib/notebookSync.ts` (new, ~250 lines)

Identical in shape to v1 §4.2 with `gameId` gone:

```ts
export const notebookSync = {
  configure(opts: { getOwner: () => string; onStatus: (s: PadSyncStatus) => void; onPages: (rows: NotebookPage[]) => void }): void,
  commit(page: NotebookPage, ink?: InkPage, debounceMs = 0): void,   // local write, debounced per page id; arms the 5 s push timer
  flushLocal(): Promise<void>,          // drain pending local commits into IndexedDB (memory in server-only mode); NO network
  flushNow(): Promise<void>,            // flushLocal() then push dirty pages of the LIVE owner
  flushOnHide(): void,                  // flushLocal() started, then the keepalive rule
  pullIndex(opts?: { force?: boolean }): Promise<void>,   // boot / online (skipped when < 60 s old unless forced) / sheet open — pages without ink
  fetchInk(pageId: string): Promise<InkPage | null>,      // lazy, on page open
  reset(): void,                        // owner flip: flushLocal(), cancel timers, forget backoff
  stop(): void,                         // unmount
};
```

- `getOwner` reads a ref (`padOwnerRef`); pages are pushed only when `page.ownerId === getOwner()`; an ack is applied only when its `ownerId` matches — a coach hand-off can never file A's pages under B.
- **Local commit:** a text page on every change (500 ms debounce — a free textarea, not a line composer), ink on every stroke end (2 s), a delete at 0 ms, a `usedIn` mark at 0 ms. Each write sets `dirty: true`, `rejectedReason: ''`, `updatedAt: nextVersion(prev)`.
- **Push:** `PUT /api/notebook/pages { pages: PageWire[] }` 5 s after the last commit or immediately on sheet close, `online` (chained into `goOnline`, App.tsx:2280), hidden `visibilitychange`/`pagehide` (chained into the existing `flush` at 3808 — one hook), and after every `pullIndex`. `window.__svrzFlushDraft` (3818) becomes `() => Promise.all([flushDraftNowRef.current(), notebookSync.flushLocal()])` — local only. Batches by bytes and count; ink pages alone; a page that alone exceeds `NOTEBOOK_MAX_BYTES` gets `rejectedReason: 'too-big'` and is never sent.
- **Keepalive on pagehide (best-effort):** only a dirty TEXT body < 32 000 bytes, `fetch(url, { method: 'POST', keepalive: true, credentials: 'include' })` — preflighted, so it lands only when the preflight is still cached from an earlier PUT; a bonus, never the guarantee. **Never a text/plain parser on an authenticated route** (a CORS-simple POST with the SameSite=none cookie is a CSRF write).
- **Ack:** compare-and-clear `dirty` only if the stored `updatedAt` still equals the one sent, then adopt the returned `updatedAt` **and `createdAt`** (a clamped creation stamp moves the expiry to what the server will actually enforce) and `savedAt`; `stale[]` → `pullIndex`; `rejected[]` → keep dirty, set `rejectedReason`, amber line on the page, never auto-delete. A 2xx whose body is not `{ ownerId, saved, stale, rejected }` (the e2e catch-all answers `[]` to a PUT, e2e/support/app.ts:63-67) counts as a network failure.
- **Failure classes:** offline → no request, "Server folgt, sobald online"; network / 5xx / 401 / 403 / 404 → silent pending with backoff (10 → 20 → 40 → 60 s, reset on success); 429 → wait `retryAfterMs` (pocketbase.ts:287-289); 413 → split the batch, a single page → `'too-big'`; 400 with the schema sentence → `padSyncFailed` with that sentence.

### 4.3 Reads

- `GET /api/notebook` (fields-limited, no ink, `cache: 'no-store'`) at boot once per owner, on `online` (≥ 60 s apart) and on every sheet open. The page list shown = union of local live pages and server rows by `pageId`, higher `updatedAt` wins, tombstones and expired pages excluded.
- `GET /api/notebook/pages/:pageId` for a pen page's strokes when the local ink is absent or the local page is older than the server's (the merge marks `fetchInk`).
- Any response that is not `{ pages: [...] }` is treated as empty.

### 4.4 The merge rule (unchanged from v1 §4.4, per page)

Identity = `pageId`; version = `updatedAt`, monotonic per page; a tombstone is a version with `deleted: true`. Client pull, in ONE `runTx` over both stores: no local → adopt; server newer → adopt (even over a dirty local — bounded to one page); local newer → keep (the next push carries it); tie → server; **absent on the server → never deleted locally**. Server push: dedupe by `pageId` (newest wins); no row → create (subject to caps); `row.updated_at >= incoming.updatedAt` → `stale[]`; else update (tombstone → `deleted: true, payload: {}`). `DELETE /api/notebook/pages/:pageId` (fallback) stamps the tombstone `max(server now, row.updated_at + 1 ms)`.

### 4.5 Offline, lifecycle, wiped device

- A whole evening offline is normal: pages land in `svrz-notebook` within a second, stay `dirty`, push on `online`/next commit/close. Server-only mode when the store is unavailable (footer says so; unsaved = unacked).
- Owner flip (App.tsx:4086-4100): `notebookSync.reset()`, pages state cleared, sheet closed. Unmount (3820-3838): `stop()` from the configure effect's cleanup.
- Wiped device: everything acknowledged comes back at the next sign-in (boot pull → pages; opening a pen page pulls its ink). Lost: pages written offline that never synced, and the last ≤ 7 s before the wipe.

### 4.6 Service worker

vite.config.ts:152-154: `&& !url.pathname.startsWith('/api/notebook')` with a one-line comment; `res.set('Cache-Control', 'no-store')` on both GETs.

---

## 5. UI

### 5.1 Files

- `src/components/NotebookSheet.tsx` (new, ~450 lines): sheet, page strip, text page, Stift page host, import mode, status strip. Reads `PAD_STRINGS[lang]`.
- `src/components/InkPad.tsx` (new, lazy chunk: `const InkPad = lazy(() => import('./components/InkPad'))` beside App.tsx:6 — the PdfReader precedent; `<Suspense fallback={<AppSpinner size={64} />}>`; warmed with `void import('./components/InkPad')` when the sheet opens, as App.tsx:1528 does). Precached by the `**/*.js` glob (vite.config.ts:88) — no `globIgnores`.
- `src/lib/notebook.ts`, `src/lib/notebookSync.ts`, `src/lib/notebookImport.ts`, `src/lib/notepadStrings.ts`, `src/lib/richText.ts` (+ `appendPlainToRich`, export `escapeHtml`), `src/lib/pocketbase.ts` (four wrappers), `src/App.tsx` (state, launcher, wiring), `src/lib/infoHints.ts` + `src/components/InfoHint.tsx` (one hint, `ref: ''` — InfoHint.tsx:62 gains `{hint.ref && (…)}`).

### 5.2 Launcher — on every RC screen

One control rendered in two fixed places (v1 §5.2 item 0, unchanged): the **title card** of the list screens (App.tsx:5395-5403, between the `<h1>` block and `<SvrzLogo>`, icon-only below `sm`) and **first after Zurück in the controls bar** on every other subview (5227-5231). `<NotebookPen size={18} />`, `aria-label={tp.padLaunch}`, a count bubble (`data-testid="pad-total"`) with the number of live pages. Render predicate: `outboxOwnerId !== 'admin' && outboxOwnerId !== 'anon' && !isDemoMode() && !homelessAdmin` (App.tsx:1234). On the form the same control carries the `insert` context (§7).

### 5.3 The sheet

Shell copied from ExpandableTextarea (App.tsx:775-820): wrapper `no-print fixed inset-0 z-50 bg-stone-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4`; panel `bg-white w-full sm:max-w-2xl h-[92dvh] sm:h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col`, `role="dialog" aria-modal="true" aria-label={tp.padTitle}`; body scroll lock with `previousOverflow` saved and restored (ConfirmDialog.tsx:33-35); focus restored on close (ConfirmDialog.tsx:33-49); rendered in-tree next to the RC-note modal (App.tsx:8461). **Fullscreen** exactly as v1 §5.3 (`padFull`, `data-full`, `Maximize2`/`Minimize2`, `svrz_pad_full`, Fullscreen API on the document). `data-log-redact` on the page strip, the text page, the ink thumbnails, the import list and preview — not on the panel root.

Phone layout (Pixel 5, 393 × 727), top → bottom:

```
┌────────────────────────────────────────────────┐ 48px  header: [NotebookPen] Notizblock                    [⤢] [X]
│ Privat: nur du siehst diese Seiten. Jede Seite wird eine Woche nach dem Schreiben gelöscht. │ 30px  privacy line (bg-stone-50)
├────────────────────────────────────────────────┤
│ [ Sa 19:41 ✎ ] [ Sa 19:20 🖊 ] [ Fr 20:05 ✎ ] …                        [+ Seite ▾]      │ 44px  page strip: newest first, horizontal scroll, current = bg-slate-900 text-white
├────────────────────────────────────────────────┤
│ Sa 15.09. 19:41 · wird am Sa 22.09. gelöscht                      [🕒 Zeit]             │ 22px  meta line + Zeit button (text page only)
│ ┌────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 19:41 2. SR steht zu weit links beim Aufschlag                                    │ │       text page: <textarea> flex-1, text-sm, leading-relaxed, no resize,
│ │ 19:52 Netzberührung übersehen 18:18                                               │ │       placeholder "Schreib hier …", data-log-redact, autoFocus on a new page
│ │                                                                                    │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────┤
│ Gespeichert · 19:52 · Auf dem Server gesichert       [Seite löschen]  [Übernehmen…]     │ 40px  strip + footer (Übernehmen only on the form)
└────────────────────────────────────────────────┘
```

- **Page strip** (`flex gap-1.5 overflow-x-auto`, `-webkit-overflow-scrolling: touch`): one pill per live page, newest first — `shortDayLabel` + `clockLabel` of `createdAt` (appTime.ts:127, 142) and a kind glyph (`Pencil` for text, `PenLine` for ink); current page in the segmented-control colours (App.tsx:5261-5291); `aria-current="page"`. **+ Seite** opens a two-item menu `Textseite` / `Stiftseite` (`Pencil` / `PenLine`), disabled with `tp.padPagesFull` at the cap.
- **Text page:** `<textarea>` filling the body; `onChange` → `notebookSync.commit(page, undefined, 500)`. The empty notebook opens on a **virtual** text page (not in the store) that is committed on the first keystroke (decision 16). `enterKeyHint="enter"` (a free page — Enter is a newline). **Zeit** inserts `clockLabel(Date.now()) + ' '` at the caret (`setRangeText`, then `onChange`).
- **Stift page:** the InkPad (§6) letterboxed in the body at `aspect-ratio: 1000/1414`, toolbar under it (`Stift ◉ · Rot · Radierer · Rückgängig · Seite leeren · Finger ☐`), one line `tp.padInkNotImported`. Only one page is in the DOM at a time, so a textarea is never within 50 px of the canvas (Scribble / Android handwriting hot zones).
- **Seite löschen** → `confirmDialog({ title: tp.padDeleteTitle, message: tp.padDeleteMsg, tone: 'danger', lang })` → tombstone; the strip moves to the next page.
- **Status strip:** `padSaving` / `padSaved · HH:MM` / `padSynced` / `padSyncPending` / `padSyncFailed` / `padServerOnly` — the vocabulary of the form's own strip (App.tsx:7637-7700).
- Keyboard on iOS: the textarea is the whole body, so the keyboard covers the lower half of the page the coach is typing on and the caret scrolls into view natively — the composer-on-top problem of v1 does not arise. No `visualViewport` code.
- Close: X / backdrop (mousedown-started-on-backdrop, ConfirmDialog.tsx:92-105) / Escape / Back / any navigation under it → `closeNotebook()` (`flushNow()` + `setPadOpen(false)` + focus restore).

### 5.4 App.tsx wiring

- State: `padOpen`, `padMode: 'pages' | 'import'`, `padFull`, `padPages: NotebookPage[]` (from `onPages`), `padCurrentId`, `padStoreOk`, `padSync`, `padPendingLocal`, `padSaveFailed`, `openFeedbackGameId` (v1 §5.10 — keeps `insert` off a filed record whose game did not come back).
- `padOwnerRef` + ONE configure/stop effect (StrictMode double-mount, main.tsx:202); own boot effect keyed on the owner (`bootNotebook` = `notebookStoreAvailable()` → prune → local list → `pullIndex({ force: true })` → `flushNow()`), skipped for `'admin'`/`'anon'`/demo.
- `openNotebook()` (no argument — there is no context); `closeNotebook()`; view-change effect on `[selectedGameId, feedbackSubView, listTab, selectedCoacheeId]` and the first statement of `onPop` (1785); Escape chain (3600-3612) FIRST; `workUnsaved` (4288) gains `padUnsaved` OUTSIDE the `formIsDirty` conjunction; `goOnline` (2280) and the pagehide `flush` (3808) chained as in §4.2; owner flip (4086-4100) → `notebookSync.reset()`.
- `insert` prop (the form only): `feedbackSubView === 'feedbackForm' && selectedGame && !formDisabled && !openFeedbackId && !isDemoMode() && draftLoadingRef.current === '' ? { role: formData.role, gameId: selectedGame.id, label: `${selectedGame.homeTeam} vs ${selectedGame.awayTeam}`, onInsert } : null` — the send button's gate (8090-8094), "a filed record is not a draft" (3649) and the resume window (3655, 3868-3937). Re-checked inside `onInsert`.

### 5.5 i18n — `src/lib/notepadStrings.ts` (`PAD_STRINGS = { DE, EN }`, `fill()`; never `t.notes*`)

| key | DE | EN |
|---|---|---|
| padTitle | Notizblock | Notebook |
| padLaunch | Notizblock öffnen | Open the notebook |
| padPrivacy | Privat: nur du siehst diese Seiten. Jede Seite wird eine Woche nach dem Schreiben gelöscht. Nichts davon geht an den Schiedsrichter — ausser du tippst «Übernehmen». | Private: only you can see these pages. Every page is deleted one week after it was written. Nothing here reaches the referee — unless you tap "Insert". |
| padExpires | wird am {date} gelöscht | deleted on {date} |
| padExpiresSoon | wird morgen gelöscht | deleted tomorrow |
| padNewPage / padNewText / padNewInk | Seite / Textseite / Stiftseite | Page / Text page / Pen page |
| padPagesFull | Höchstens 40 Seiten — lösche eine, um Platz zu machen. | At most 40 pages — delete one to make room. |
| padPlaceholder | Schreib hier … | Write here … |
| padTime | Zeit | Time |
| padEmpty | Noch keine Seiten. Schreib los — oder nimm den Stift. | No pages yet. Start writing — or pick up the pen. |
| padDeletePage / padDeleteTitle / padDeleteMsg | Seite löschen / Seite löschen? / Die Seite wird auf allen deinen Geräten gelöscht. | Delete page / Delete page? / The page is deleted on all your devices. |
| padSaving / padSaved / padSynced / padSyncPending / padSyncFailed | Wird gespeichert… / Gespeichert / Auf dem Server gesichert / Server folgt, sobald online / Server hat die Seite abgelehnt | Saving… / Saved / Backed up on the server / Server follows once online / The server refused the page |
| padSyncRejected | Diese Seite wurde vom Server abgelehnt ({reason}) — bearbeite sie, um es erneut zu versuchen. | The server refused this page ({reason}) — edit it to try again. |
| padNoStore / padServerOnly / padSaveFailed | Dieses Gerät kann den Notizblock nicht speichern (privater Modus?). / Nur auf dem Server gesichert — dieses Gerät speichert nichts. / Seite konnte nicht gespeichert werden — Speicher voll? | This device cannot store the notebook (private mode?). / Backed up on the server only — this device stores nothing. / Could not save the page — storage full? |
| padInsert | Übernehmen… | Insert… |
| padInsertFor | Für: {role} · {name} (aktuelles Formular) | For: {role} · {name} (current form) |
| padInsertRemarks / padInsertHighlights / padInsertImprovements / padInsertGoals / padInsertTips | Bemerkungen / Highlights & Potenziale / Verbesserung / Ziele / Tipps & Tricks (nur E-Mail) | Remarks / Highlights & potential / Improvement / Goals / Tips & Tricks (e-mail only) |
| padInsertCount1 / padInsertCountN | 1 Seite → {field} ({role}) / {n} Seiten → {field} ({role}) | 1 page → {field} ({role}) / {n} pages → {field} ({role}) |
| padImportWarn | Übernommener Text wird Teil des Feedbacks und geht mit dem PDF per E-Mail an den Schiedsrichter. | Inserted text becomes part of the feedback and is e-mailed to the referee with the PDF. |
| padImportWarnTips | Tipps & Tricks gehen nur per E-Mail an den Schiedsrichter, nicht ins Feedback. | Tips & Tricks go to the referee by e-mail only, not into the feedback. |
| padInserted1 / padInsertedN | 1 Seite in «{field}» übernommen — geht mit dem Feedback an den Schiedsrichter. / {n} Seiten in «{field}» übernommen — geht mit dem Feedback an den Schiedsrichter. | 1 page inserted into "{field}" — goes to the referee with the feedback. / {n} pages inserted into "{field}" — goes to the referee with the feedback. |
| padInsertAgainTitle / padInsertAgainMsg | Nochmals übernehmen? / Diese Seite wurde bereits in «{field}» übernommen. | Insert again? / This page was already inserted into "{field}". |
| padUsedIn | übernommen → {field} ({role}) · {label} | inserted → {field} ({role}) · {label} |
| padShowUsed | Bereits übernommene anzeigen | Show inserted pages |
| padInkOnly / padInkNotImported | Stiftseite — kann nicht übernommen werden, nur angesehen. / Stiftseiten werden nicht übernommen — sie sind zum Nachlesen. | Pen page — cannot be inserted, view only. / Pen pages are not inserted — they are for reading back. |
| padReviewOnly | Beobachtung gesendet — der Notizblock bleibt privat; übernehmen geht hier nicht mehr. | Observation sent — the notebook stays private; inserting is no longer possible here. |
| padPenBlack / padPenRed / padEraser / padUndo / padClearPage / padClearPageMsg | Stift / Rot / Radierer / Rückgängig / Seite leeren / Alle Striche auf dieser Seite werden gelöscht. | Pen / Red / Eraser / Undo / Clear page / Every stroke on this page is removed. |
| padFinger / padFingerOn / padFingerOff / padPenSeen | Finger / Finger zeichnet / Nur der Stift zeichnet / Stift erkannt — der Finger zeichnet jetzt nicht mehr. | Finger / Finger draws / Pen only / Pen detected — the finger no longer draws. |
| padPageFull | Seite voll — bitte eine neue Seite beginnen. | Page full — please start a new page. |
| padInkLoading | Stiftseite wird geladen… | Loading pen page… |
| padScribbleHint | Striche fehlen? Auf dem iPad: Einstellungen → Apple Pencil → Kritzeln aus. | Missing strokes? On iPad: Settings → Apple Pencil → Scribble off. |
| padFull / padFullExit | Vollbild / Vollbild verlassen | Fullscreen / Exit fullscreen |

Reused: `t.close`. Icons in lucide-react 0.577 (verified): `NotebookPen`, `Pencil`, `PenLine`, `Undo2`, `Eraser`, `Hand`, `Trash2`, `Clock`, `CloudOff`, `Loader2`, `Maximize2`, `Minimize2`. InfoHint `notebook`: DE "Privater Notizblock. Seiten werden nach einer Woche gelöscht und gelangen nur ins Feedback, wenn du sie ausdrücklich übernimmst — dann liest sie der Schiedsrichter." / EN "Private notebook. Pages are deleted after a week and reach the feedback only when you insert them explicitly — the referee reads them then."

---

## 6. Ink

Unchanged from v1 §6 (component API, two stacked canvases, DPR ≤ 2, re-render from vectors on resize, Pointer Events only with `getCoalescedEvents`, guarded `setPointerCapture`, pen-authoritative palm policy with the 500 ms trailing window and the 40 px contact rule, finger toggle defaulting to on where no pen was ever seen, `pointercancel` drops the stroke and the Scribble hint after two, whole-stroke eraser, undo, the `{ c, w, p, d }` integer encoding, the 800 000-char / 4 000-stroke budget checked at stroke end with the server's predicate, perfect-freehand behind `renderStroke()` with a polyline fallback). The only change: a pen page is a `NotebookPage` of kind `'ink'` keyed by `pageId`, with no page number — order is `createdAt`.

---

## 7. Import flow (the form only)

### 7.1 Mode 'import' inside the sheet

Opened from the footer **Übernehmen…** (only when `insert` is non-null). The page strip and page are replaced by:

```
header:  Übernehmen · VBC Züri Unterland – Volley Näfels II                    [X]
sub:     Für: 1. SR · Müller (aktuelles Formular)
target:  [Bemerkungen ✓] [Highlights] [Verbesserung] [Ziele] [Tipps & Tricks]   ← segmented h-9 (App.tsx:5261-5291)
list:    ☑ Sa 19:41 ✎  19:41 2. SR steht zu weit links beim Aufschlag …        ← text pages, newest first; current page pre-ticked
         ☐ Fr 20:05 ✎  Aufwärmen: gut strukturiert, Pfiff zu spät …
         ○ Sa 19:20 🖊  Stiftseite — kann nicht übernommen werden               [thumbnail]
         [Bereits übernommene anzeigen ☐]
preview: 19:41 2. SR steht zu weit links beim Aufschlag                          ← verbatim, scrollable, text-xs
         19:52 Netzberührung übersehen 18:18
footer:  ⚠ Übernommener Text wird Teil des Feedbacks und geht mit dem PDF per E-Mail an den Schiedsrichter.
         [Abbrechen]                          [ 1 Seite → Bemerkungen (1. SR) ]   ← h-10 bg-red-600 text-white font-semibold
```

Defaults: target Bemerkungen; the page the coach was on is pre-ticked; ink pages greyed with no checkbox; pages already used in this field/half hidden until the toggle. The warning swaps to `padImportWarnTips` for Tipps & Tricks.

### 7.2 What is written

`src/lib/notebookImport.ts` (pure): `importBlock(pages) = pages.map(p => p.text.replace(/\s+$/, '')).filter(Boolean).join('\n\n')` — verbatim, blank line between pages, no bullet (decision 9). The four rich fields exactly as the ExpandableTextarea `onChange` does (App.tsx:7970, 7982): `setFormData(prev => ({ ...prev, results: { ...prev.results, [field]: appendPlainToRich(prev.results[field] || '', block) } }))`; `tips` → `setTipsAndTricks(prev => prev ? `${prev.replace(/\s+$/, '')}\n${block}` : block)` (8022-8039; mailed, never stored). `appendPlainToRich` is the v1 §7.2 helper verbatim (plain stays plain; the value flips to markup only when either side is markup by `isHtmlValue`'s own test, then both halves are escaped once; no trailing whitespace — feedbackPdf.ts:793-801 prints a heading over any non-blank band). Verified trace: `a <b>b</b> & c` onto an empty field → stored `a &lt;b&gt;b&lt;/b&gt; &amp; c`, rendered as text.

After the write: each imported page gets `usedIn.push({ f, r: formData.role, g: gameId, label, t: Date.now() })` (≤ 10), `updatedAt = nextVersion(prev)`, `dirty` → `notebookSync.commit`; toast `padInserted1/N`; the sheet returns to the pages; the form scrolls the target into view on close. The form's own autosave (3793-3801) commits the draft 1.2 s later and parks it 45 s later. **No server call from the import; `/api/feedback/submit` stays the only door.** Gating and re-insert confirm as v1 §7.5-7.6.

---

## 8. Privacy & security

All of v1 §8, with `notepad` → `notebook`:

1. `requireRcSession` (984-1003); a president-only session is 401 here.
2. Body gate ahead of the parser: `NOTEBOOK_BODY_PATH_RE = /^\/api\/notebook\/pages\/?$/i` beside `PARK_BODY_PATH_RE` (259-261), branch beside 184-191, `log.warn('notebook.too-big', …)` then 413 with a fixed sentence; the list GET `/api/notebook` keeps the 256 kb parser (its path differs on purpose).
3. `notebookOwner` = clone of `parkOwner` (10132-10140) — admin console → 403 `'Den Notizblock gibt es nur für angemeldete Referee Coaches.'`; an admin who also picked a coach name resolves to that coach.
4. Rate bucket `notebookAttempts` 300 / 5 min keyed by RC id; **both `parkAttempts` (missing today) and `notebookAttempts` go into the sweep at 701**.
5. `withNotebookLock(owner.id)` around read-then-write (one notebook per owner, so one lock key); the prune under the same key, throttled.
6. Sanitiser per page (§3.3), dedupe by `pageId` before the write loop, created rows appended to `existing`; identity fields dropped; both stamps clamped and returned.
7. Every query `owner_id = "${escapeFilterValue(owner.id)}"` (1141-1143); tombstones/deletes by row id after an owner-filtered read; `owner_id` rewritten from the session on every upsert; `pageId` sliced to 64 before interpolation.
8. Missing collection: reads `{ ownerId, pages: [] }`; writes `SchemaOutOfDateError('Die Sammlung „rc_notebook" fehlt in PocketBase — bitte setup-schema.mjs neu ausführen.')` → 400.
9. Per-page `create`/`update` in try/catch: `isPocketBaseBadRequest` → `rejected: 'server-refused'` + warn; else rethrow.
10. `CONFIDENTIAL_BODY_PATHS` (273-287): the regex **literal** `/^\/api\/notebook(\/[^/]+){0,2}\/?$/i` (a constant declared in the new section would be in its temporal dead zone); 4xx bodies stay fixed sentences (`req.out` 349-360 logs them); no page text in any URL.
11. `log.info('notebook.saved', …, { saved, stale, rejected, bytes })`, `log.warn` when anything was rejected; `safeError` only in a genuine 500 catch (only real failures mail the operator).
12. `Cache-Control: no-store` on both GETs. `publishLive` never carries pages.
13. What admin / chair see: nothing — no route reads another owner's rows, bodies log as `{ _confidential: true, keys }`, no mail path, nothing in the archive ZIP / `feedback_json` / `observations` except text the coach inserted and was told is published. Raw PocketBase rows on the host stay the same trust level as parked drafts, and die within a week.
14. Hand verification (Framework13, throwaway API on :8799 with a scratch PocketBase — never the live `pb_data`): two rc cookies A and B; A `PUT /api/notebook/pages` one page → `saved[]`; B `GET /api/notebook` → `pages: []`; B's own PUT creates B's row, A's list unchanged; B `DELETE /api/notebook/pages/<A's id>` → `removed: 0`; A tombstones → `deleted: true` reads back (column declared); admin cookie → 403; president cookie → 401; a page with `createdAt` 8 days ago → the next prune deletes it (set `NOTEBOOK_PRUNE_EVERY_MS` low for the check).

---

## 9. Build order

Each step is a commit; check `git log -1` first (a second Claude session commits this tree on main).

| # | Step | Files | Copy from | Ships alone | Effort |
|---|---|---|---|---|---|
| 1 | **Schema + server routes (dark)** | `deploy/hetzner/seed/setup-schema.mjs`, `server/index.ts`, `infrastructure.md` | `ensure('rc_notebook', …)` after 260-262; `NOTEBOOK_BODY_PATH_RE`/`_MAX_BYTES`/`notebookJson` beside 259-261; middleware branch beside 184-191; confidential literal (273-287); both rate stores into the sweep (701); the new section **between the park DELETE's closing `});` (10490) and the `// Anything that escapes a handler` comment (10491)** — BEFORE the final error handler (Express 5 forwards async rejections only to error middleware registered after the route); clones: `parkOwner` → `notebookOwner`, `withParkLock` → `withNotebookLock`, `parkText`/`parkExtra`/skew rule → `sanitizeNotebookPage` + `sanitizeNotebookInk`, `parkedRowsFor` → `notebookRowsFor(ownerId, fields?)`, `pruneParkedDrafts` → `pruneNotebook` (7-day, by `created`, throttled), routes §9.1. infrastructure.md: paragraph beside 328-340 and rewrite 329-330 to "BEFORE deploying the code". **Deploy (lenovoserver, copy-then-build, never git pull):** `docker cp` the schema script → `docker exec … node deploy/hetzner/seed/setup-schema.mjs` (SCHEMA_OK) → verify the collection's columns with the one-liner from v1 step 1 (`rc_notebook`, 8 columns + created, updated) → rsync (exclude pb_data/logs/env, no --delete) → `docker compose -p svrz-rc … up -d --build svrz-api` → `/api/health`. Then §8 item 14. | yes | 1 d |
| 2 | **Client library (dark)** | `src/lib/notebook.ts`, `src/lib/notebookSync.ts`, `src/lib/notebookImport.ts`, `src/lib/notepadStrings.ts`, `src/lib/pocketbase.ts`, `src/lib/richText.ts`, `vite.config.ts`, `e2e/notebook-merge.spec.ts` | openDb/run/runTx from formDraft.ts:166-234 (store list, both stores, verify-on-success); list/get/put/tombstone/prune/storeAvailable shapes from 236-444; wrappers `listNotebook()`, `fetchNotebookInk(pageId)`, `pushNotebookPages(pages, { keepalive? })`, `deleteNotebookPage(pageId)` beside pocketbase.ts:1472-1533 with `parkError` (1332) + status/retryAfterMs and the demo short-circuit; `appendPlainToRich` + export `escapeHtml` (richText.ts:38); SW exclusion at vite.config.ts:152-154; pure spec in the net-fail-instant.spec.ts:1-8 style | no | 1.25 d |
| 3 | **Notebook end to end (text pages)** | `src/components/NotebookSheet.tsx`, `src/App.tsx`, `src/lib/infoHints.ts`, `src/components/InfoHint.tsx` | Shell 775-820 + ConfirmDialog.tsx:33-49; page strip in the segmented-control colours (5261-5291); textarea classes from the RC-note modal (8514-8526); strip vocabulary 7637-7700; launcher (5395-5403, 5227-5231); fullscreen (§5.3); Escape chain 3600-3612; view-change effect + onPop 1785; goOnline 2280; pagehide flush 3808 + `__svrzFlushDraft` 3818; owner flip 4086-4100; workUnsaved 4288; own boot effect; InfoHint with `ref: ''`; server-only mode. **First coach-visible deploy: a notebook that survives the wiped phone, from every screen.** | yes | 2 d |
| 4 | **Import into the form** | `src/components/NotebookSheet.tsx`, `src/App.tsx` | Import mode (§7.1); `importPagesIntoForm(field, pages)` via the setFormData shape at 7970/7982 and setTipsAndTricks at 8037; the `insert` gate; `usedIn` + re-insert confirm; toast + scrollIntoView | yes | 0.75 d |
| 5 | **Ink** | `src/components/InkPad.tsx`, `src/components/NotebookSheet.tsx`, `package.json` | `npm i perfect-freehand@1.2.3`; canvas boilerplate SignaturePad.tsx:11-61 minus the snapshot hack, guarded capture; DPR cap PdfReader.tsx:486; `lazy()` beside App.tsx:6; Stiftseite, toolbar, lazy ink fetch, budgets | yes | 2 d |
| 6 | **e2e suite, device checks, docs** | `e2e/notebook*.spec.ts`, `infrastructure.md`, memory | §10; manual iPad (Scribble on/off into the textarea, palm, keyboard over the page) and Android (Gboard handwriting, finger-draw default) checks; 360-px screenshot of the title card with the launcher; confirm the daily log shows `{_confidential:true}` for `PUT /api/notebook/pages` and that `notebook.saved` never carries text; memory `svrz-rc-notepad-plan.md` → built | yes | 1.25 d |

Total ≈ 8.25 focused days; steps 1–3 (≈ 4.25 d) are the release that already helps at the next game weekend.

### 9.1 Server routes (skeleton; the push handler is v1 §9.1 with `entry` → `page`, no game, no page numbers)

```ts
// ───────────────────────── Notebook (the coach's private pages) ─────────────────────────
const NOTEBOOK_COLLECTION = 'rc_notebook';
const NOTEBOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000;      // Luca, 2026-09-15: "deleted at most 1 week after"
const NOTEBOOK_MAX_PAGES = 40;
// … caps of §3.3, notebookAttempts + checkNotebookRateLimit, withNotebookLock, notebookPrunedAt, notebookOwner, sanitizeNotebookPage, sanitizeNotebookInk, notebookRowsFor, pruneNotebook(Throttled), notebookSchemaError, toNotebookIndexRow, toNotebookWire, notebookNoStore …

app.get('/api/notebook', requireRcSession, async (req, res) => {           // index: no ink, no-store
  /* owner, rate, no-store; getFullList({ filter: owner, sort: '-created', fields: NOTEBOOK_INDEX_FIELDS }) → { ownerId, pages } ; missing collection → { ownerId, pages: [] } */
});
app.get('/api/notebook/pages/:pageId', requireRcSession, async (req, res) => {   // one page WITH ink
  /* owner, rate, no-store; pageId sliced to 64 + NOTEBOOK_PAGE_ID_RE; owner-filtered getFirstListItem → { ownerId, page } ; none → 404 { error: 'Seite nicht gefunden.' } */
});
app.put('/api/notebook/pages', requireRcSession, handleNotebookPush);
app.post('/api/notebook/pages', requireRcSession, handleNotebookPush);      // keepalive sends can only POST
app.delete('/api/notebook/pages/:pageId', requireRcSession, async (req, res) => {
  /* FALLBACK: owner-filtered read → deleted: true, payload: {}, updated_at: max(now, row.updated_at + 1 ms); nothing → { ok: true, removed: 0 } */
});
```

`handleNotebookPush`: owner → rate → dedupe by `pageId` (newest wins) → `ensureAdminAuth()` → `withNotebookLock(owner.id)`: `existing = notebookRowsFor(owner.id, 'id,page_id,kind,updated_at,deleted')`, `livePages = existing.filter(live).length`; per page: `stale` if `row.updated_at >= page.updatedAt`; a new live page above `NOTEBOOK_MAX_PAGES` → `rejected: 'too-many-pages'`; write `{ owner_id, page_id, kind, created_at, updated_at, deleted, schema, payload }` with the per-row try/catch; `saved.push({ pageId, savedAt, updatedAt, createdAt })` → `pruneNotebookThrottled` → log → `{ ok: true, ownerId, saved, stale, rejected }`.

---

## 10. Tests

Helpers per spec (never in `e2e/support/app.ts`): `seedNotebook(page, { pages, ink })` via `addInitScript` before `goto` creating BOTH stores at v1, `storedPages(page)` / `storedInk(page)` via `page.evaluate` getAll, `stubNotebook(page, { pages })` registered AFTER `stubSignedInApp` (`**/api/notebook` → `{ ownerId: RC.id, pages }`; `**/api/notebook/pages/*` GET → `{ ownerId, page }`; PUT/POST → records postData, fulfils the ack). Seeds use `NOW`-relative stamps (a seed older than 7 days is expired by design — that is test 9). Locators: `padButton = getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ })`, `sheet = getByRole('dialog', { name: /^(Notizblock|Notebook)$/ })`, `pageBox = sheet.getByPlaceholder(/^(Schreib hier|Write here)/)`, `padSaved = sheet.getByText(/^(Gespeichert|Saved)/)`, `padSynced` scoped to the sheet (`t.parkedAt` renders the same sentence under it). Every poll that waits for the 5 s push passes `{ timeout: 10_000 }`.

### `e2e/notebook.spec.ts` — the device keeps the page, only its owner sees it, a week is a week
1. a reload gives the typed page back (open → type → `padSaved` → reload → open → `toHaveValue`); the store has one page with `dirty: true` and the derived id.
2. another coach's pages on this device are not this coach's to see (seed under `'rc-someone-else'` → `padEmpty`).
3. a schema-newer page is left alone.
4. deleting a page tombstones it, and the tombstone survives a reload.
5. the empty notebook creates no row until the first keystroke (open, close, reopen → `storedPages` is `[]`; type one char → one row).
6. Zeit inserts the clock at the caret (`toHaveValue(/^\d\d:\d\d /)`).
7. Escape closes the sheet, not the form; a second Escape changes nothing.
8. discarding the draft keeps the notebook (form-draft.spec.ts:464-502 idiom; `storedPages` unchanged).
9. **an expired page is hidden and purged** — seed `createdAt: NOW - 8 d` (acked) and `createdAt: NOW - 6 d` → only the second is listed, its meta reads /gelöscht|deleted/ with the date; after boot `storedPages` holds only the second; a DIRTY page at `NOW - 8 d` is purged too (the week is the promise).
10. a page within 24 h of expiry says so (/morgen|tomorrow/).
11. phone: the sheet fits, the textarea is reachable (`test.skip(!isMobile)`; `scrollWidth <= innerWidth + 1`).
12. Back closes the sheet and pushes (`goBack()` → dialog 0; PUT within 2 s).
13. page text never reaches the click log (`window.svrzLogs()` → `'[redacted]'`).
14. the demo has no notebook; the console's own session has none.
15. the launcher is on every screen, exactly once each (Home, Coachees, Spiele, coachee page, form).
16. the page cap: seed 40 pages → `+ Seite` disabled with /Höchstens 40|At most 40/.

### `e2e/notebook-sync.spec.ts` — the server is the source of truth
17. a page is pushed within seconds and marked saved (body has no `ownerId`/`id`/`dirty`/`savedAt`/`rejectedReason`).
18. a wiped device gets its pages back (nothing seeded; stub index → open → pages listed; store holds them `dirty: false`).
19. local newer wins, server newer wins, tie goes to the server.
20. a server tombstone hides an older local live copy.
21. absence on the server never deletes.
22. a stale push re-pulls before clearing dirty.
23. **both ack stamps are adopted** — ack `createdAt: NOW - 6 d` for a page seeded at `NOW` → the page's meta now shows the earlier expiry date.
24. the server refusing is said in words; the network failing is not (net-fail-lifecycle idioms; `net.fail` entries filtered out).
25. a refused page is not re-sent until edited.
26. 429 is patience, not a refusal.
27. pagehide flushes small text with keepalive and never an ink page.
28. closing the sheet pushes at once.

### `e2e/notebook-import.spec.ts` — pulling a page into the form is a publish
29. the current page is pre-ticked, inserted verbatim, marked used, autosaved into the draft (`.rich-surface` `toContainText`; `storedRole(page, '1. SR').results.bemerkungen`; `storedPages()[0].usedIn[0]` = `{ f: 'bemerkungen', r: '1. SR', g: 'g1', … }`; hidden until /Bereits übernommene|Show inserted/).
30. two pages insert with a blank line between them and no bullet.
31. insert into Tips & Tricks (`tipsBox` `toHaveValue`; warning swaps).
32. a second insert into the same field asks first.
33. markup in a page becomes text, not a tag.
34. a filed record offers no insert (`/feedbacks/${COACHEE.id}/${RECORD.id}`; /gesendet|sent/ line; no /Übernehmen|Insert/; the pages are still there).
35. the button names the half on screen; switching the half (segmented group, App.tsx:5261-5291) changes the label and the target form.
36. a closed role offers no insert (`feedbackClosedRoles: ['1. SR']`).
37. an ink page is listed greyed and cannot be ticked.

### `e2e/notebook-ink.spec.ts` — v1 tests 34–42 with pages instead of numbered pages (mouse stroke stored as strokes; pen stroke with pressure and no `js.error`; touch ignored after a pen; finger by default with no pen; palm width; pointercancel + hint; undo; page cap; resize re-renders; ink pushed alone; ink fetched lazily on open).

### `e2e/notebook-launcher.spec.ts` — fullscreen (v1 tests 54–56): fills the viewport and is remembered; Escape in fullscreen closes the sheet, not the form; the pen page grows with fullscreen.

### `e2e/notebook-merge.spec.ts` (pure) — `mergeFromServer`, `serverDecision`, `nextVersion`, `batchesFor`, `syncBatchFor`, `pageIsLive`/`pageExpiresAt` (boundary: exactly 7 d is expired), `appendPlainToRich`, `importBlock` (trim, blank-line join, no bullet), `encodeInk`/`decodeInk` round trip.

tsc notes: as v1 §10 (flat types; `key?` on mapped components; `perfect-freehand` d.ts; `getCoalescedEvents` guard; `PAD_STRINGS` `satisfies Record<'DE'|'EN', Record<string, string>>`; no `test.only`).

---

## 11. Risks & open questions

| Risk | Mitigation |
|---|---|
| A coach expects a page to outlive the week | Every page prints its deletion date; the privacy line says it; the amber "morgen" warning; the import is the way to keep something — into the report, where it belongs |
| Two devices edit the same text page in the same minute; per-page LWW discards one edit | Bounded to one page; monotonic versions and the adopted ack keep the order sane; the strip shows "Auf dem Server gesichert" |
| Site data wiped while offline before any sync | Unavoidable for a web app; `padPrivacy` says "sobald online", the strip stays amber; `navigator.storage.persist()` requested |
| A clamped `createdAt` (device clock a day ahead) shortens a page's week | The ack returns the server's stamp and the client adopts it, so the shown date is the enforced one |
| iPadOS Scribble consumes pen strokes on the canvas | Only one page kind is in the DOM at a time; `touch-action: none` + `user-select: none` + `touchmove preventDefault`; `pointercancel` drops partial strokes; hint after two drops; manual iPad check |
| An 800 KB ink page on gym wifi | Own request 5 s after the last stroke, never on a beacon; failed push stays dirty with backoff; the index GET never carries ink |
| A flaky network makes the push loop mail the operator | No push while offline; backoff to 60 s; a refused page is never re-sent until edited |
| Self-declared identity: a colleague who picks the wrong name on a shared tablet reads (and syncs) another coach's pages | Same trust level as parked drafts and the president note, stated in the collection header and `padPrivacy`; owner-scoped keys, live-owner getter, ack owner check; no chair/admin read path; and the pages die within a week |
| Old PWA build vs new server and vice versa | Server first. New client + old server: 404 → silent pending, generic 413 → split; old client + new server: no calls; missing collection: reads empty, writes 400 with the sentence |
| Browser-level fullscreen on the wrong element hides the app's own dialogs | Requested on `document.documentElement`, never the panel |
| A third control in the title card crowds a 360-px phone | Icon-only below `sm`, the h1 is `flex-1`; screenshot in step 6 |
| The click logger or an error mail carries page text | `data-log-redact` on every text-bearing element (test 13); confidential body paths; no `clientLog` call with content; fixed 4xx sentences |

Open (not blocking; defaults in §2.3): plain textarea vs RichSurface for the page; Zeit button; the 40-page cap; perfect-freehand; ink tools; manual vs automatic fullscreen; verbatim vs bulleted insert.

---

## Changes from v1 (2026-09-15, evening) — what Luca's three answers removed or changed

- **Removed:** `gameId`, `who`/`whoName`/`coacheeId`/`tone`/`section`/`set`/`pageNo`/`label`/`matchNo`/`gameDate` on the record; the game columns in the collection; the per-game routes (`/api/notepad/:gameId`); the composer with chips and set stepper; the timeline with dividers; the chips on Home/Games/coachee rows; the coachee-page "Notizblock" section and its two-way join; the Übersicht with the game picker and `pickDefaultGame()`; the "Beobachtung öffnen →" link; the tone-driven import pre-filter and the other-half toggle; the `padIndex` map; 400-day retention and the 3000-row cap; the `_general` sentinel discussion.
- **Changed:** retention → **7 days from creation on both sides, hard delete on the server, hidden immediately on the client**; the record → a **page** (`text` or `ink`); import → **verbatim pages joined by a blank line**, current page pre-ticked, any page into either half (there is no referee tag to filter on); the launcher opens the notebook itself; `PageUse` records the game the text went into (the notebook has no game of its own); EN name **Notebook**; strings and test regexes accordingly.
- **Unchanged (verified 2026-09-15 against HEAD 6f3e8b6):** the server route pattern and every guard; the IndexedDB module shape; the sync engine, merge rule, ack handling and failure classes; the ink pad; `appendPlainToRich`; the launcher placement; the fullscreen rule; the SW exclusion; the deploy order (schema before code, lenovoserver, copy-then-build); the `parkAttempts` sweep omission fixed in passing.
