// The same calls against PocketBase (the SDK) and Postgres (server/db/records.ts),
// answers compared exactly: values, key order, record order, error text.
//
//   npx tsx deploy/postgres/compare-backends.ts
//
// Run right after migrate-from-pb.ts, against THROWAWAY copies — the second
// half writes (and cleans up after itself); READS_ONLY=1 skips it, for
// production. Needs the same env as the
// migration. Every query shape the server uses is here, with values taken from
// the data; the output names the case, never a value.

import PocketBase from 'pocketbase';
import { disconnectDatabase } from '../../server/db/client.ts';
import { collection } from '../../server/db/records.ts';

type AnyRecord = Record<string, any>;
type Api = (name: string) => any;

const pb = new PocketBase(process.env.POCKETBASE_URL);
pb.autoCancellation(false);
await pb.collection('_superusers').authWithPassword(process.env.POCKETBASE_ADMIN_EMAIL!, process.env.POCKETBASE_ADMIN_PASSWORD!);
const PB: Api = (n) => pb.collection(n);
const PG: Api = (n) => collection(n);

let failed = 0;
let passed = 0;

// PocketBase 0.40 writes a list result, and a record cut down with `fields`,
// as a Go map in no fixed key order (the same call answers differently twice),
// so nothing can depend on it: those keys are put in one order on both sides.
// A full record's keys (always sorted) and the keys INSIDE a JSON value are
// compared as they come.
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object' && Array.isArray(v.items) && 'page' in v) {
    return { items: canonical(v.items), page: v.page, perPage: v.perPage, totalItems: v.totalItems, totalPages: v.totalPages };
  }
  if (v && typeof v === 'object' && ('id' in v || 'collectionId' in v || Object.keys(v).length <= 12)) {
    const out: AnyRecord = {};
    for (const k of Object.keys(v).sort()) out[k] = k === 'expand' ? Object.fromEntries(Object.entries(v.expand).map(([n, r]) => [n, canonical(r)])) : v[k];
    return out;
  }
  return v;
}

/** What a call answered, made comparable: the value, or the error's text and data. */
async function outcome(fn: () => Promise<unknown>, scrub?: (v: any) => any): Promise<string> {
  try {
    const v = canonical(await fn());
    return 'ok ' + JSON.stringify(scrub ? scrub(v) : v);
  } catch (e: any) {
    return `error ${String(e)} ${JSON.stringify(e?.data ?? null)}`;
  }
}

// With `fields`, PocketBase 0.40 also re-serialised JSON values through a Go
// map — their keys in a different order on every call. A case that picks a
// JSON field compares those keys sorted.
const deepSorted = (v: any): any => Array.isArray(v) ? v.map(deepSorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, deepSorted(v[k])])) : v;

async function same(label: string, call: (api: Api) => Promise<unknown>, scrub?: (v: any) => any) {
  const a = await outcome(() => call(PB), scrub);
  const b = await outcome(() => call(PG), scrub);
  if (a === b) { passed++; return; }
  failed++;
  // Where they part, by position only — never the content.
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  console.log(`DIFF ${label}: first difference at character ${i} (pb ${a.length}, pg ${b.length}; ${a.startsWith('ok') ? 'pb ok' : 'pb error'} / ${b.startsWith('ok') ? 'pg ok' : 'pg error'})`);
}

const esc = (v: string) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const pick = <T>(list: T[], i = 0): T => list[Math.min(i, list.length - 1)];

// ── samples from the data ────────────────────────────────────────────
const games = await pb.collection('games').getFullList({ sort: '@rowid' });
const coachees = await pb.collection('coachees').getFullList({ sort: '@rowid' });
const settings = await pb.collection('app_settings').getFullList({ sort: '@rowid' });
const feedbacks = await pb.collection('referee_coach_feedbacks').getFullList({ sort: '@rowid' });
const observations = await pb.collection('observations').getFullList({ sort: '@rowid' });
const notes = await pb.collection('rc_game_notes').getFullList({ sort: '@rowid' });
const offers = await pb.collection('boerse_offers').getFullList({ sort: '@rowid' });
const sigs = await pb.collection('signatures').getFullList({ sort: '@rowid' });
const visits = await pb.collection('rc_visit_feedback').getFullList({ sort: '@rowid' });
const pages = await pb.collection('rc_notebook').getFullList({ sort: '@rowid' });
const rcs = await pb.collection('referee_coaches').getFullList({ sort: '@rowid' });

const assigned = games.filter((g) => g.assigned_rc || g.assigned_rc_id);
const g1 = pick(assigned.length ? assigned : games, 3);
const dates = games.map((g) => g.match_date).filter(Boolean).sort();
const mid = dates[Math.floor(dates.length / 2)] ?? '2026-10-01';
const day = mid.slice(0, 10);
const pbStamp = (d: Date) => d.toISOString().replace('T', ' ');

// ── reads ────────────────────────────────────────────────────────────
for (const name of ['games', 'coachees', 'referee_coaches', 'referee_coach_feedbacks', 'observations', 'app_settings', 'signatures', 'rc_visit_feedback', 'referees', 'parked_drafts', 'rc_game_notes', 'boerse_offers', 'rc_notebook', 'rc_switch_requests', 'push_subscriptions']) {
  await same(`${name} full list`, (api) => api(name).getFullList());
  await same(`${name} list p1`, (api) => api(name).getList(1, 30));
  await same(`${name} list p2 skipTotal`, (api) => api(name).getList(2, 7, { skipTotal: true }));
  await same(`${name} -created`, (api) => api(name).getFullList({ sort: '-created' }));
  await same(`${name} -updated`, (api) => api(name).getFullList({ sort: '-updated' }));
  await same(`${name} created`, (api) => api(name).getFullList({ sort: 'created' }));
  await same(`${name} fields id`, (api) => api(name).getFullList({ fields: 'id' }));
  await same(`${name} fields id,updated`, (api) => api(name).getFullList({ fields: 'id,updated' }));
  await same(`${name} created = ""`, (api) => api(name).getFullList({ filter: 'created = ""', fields: 'id' }));
  await same(`${name} created < stamp`, (api) => api(name).getFullList({ filter: `created < "${pbStamp(new Date('2026-09-15T12:00:00Z'))}"`, fields: 'id' }));
  await same(`${name} getOne missing`, (api) => api(name).getOne('nosuchid1234567'));
  await same(`${name} first missing`, (api) => api(name).getFirstListItem('id = "nosuchid1234567"'));
}

for (const s of ['-match_date', 'match_date', '-match_date,-created', 'league', '-league', 'match_no', 'location', 'assigned_rc', '-assigned_at']) {
  await same(`games sort ${s}`, (api) => api('games').getFullList({ sort: s, fields: 'id,match_no' }));
}
await same('games paged -match_date', (api) => api('games').getList(3, 50, { sort: '-match_date' }));
await same('games match_no', (api) => api('games').getFullList({ filter: `match_no = "${esc(g1.match_no)}"` }));
await same('games first match_no -match_date', (api) => api('games').getFirstListItem(`match_no = "${esc(g1.match_no)}"`, { sort: '-match_date', fields: 'second_referee' }));
await same('games external_id', (api) => api('games').getFirstListItem(`external_id = "${esc(g1.external_id)}"`));
for (const [from, to] of [[`${day}T00:00:00.000Z`, `${day}T23:59:59.999Z`], [`${day} 00:00:00`, `${day} 23:59:59`], [day, `${day}z`], [mid, '9999']]) {
  await same(`games date window`, (api) => api('games').getFullList({ filter: `match_date >= "${from}" && match_date < "${to}"`, sort: 'match_date' }));
}
await same('games others assigned', (api) => api('games').getFullList({ filter: `id != "${g1.id}" && (assigned_rc != "" || assigned_rc_id != "")`, fields: 'id,assigned_rc,assigned_rc_id' }));
await same('games assigned since', (api) => api('games').getFullList({ filter: `(assigned_rc != "" || assigned_rc_id != "") && match_date >= "${mid}"`, sort: '-match_date' }));
await same('games assigned no stamp', (api) => api('games').getFullList({ filter: '(assigned_rc != "" || assigned_rc_id != "") && assigned_at = ""' }));
await same('games bools', (api) => api('games').getFullList({ filter: 'is_rd_game = true || is_rsv_game = false && is_ld_game != true', fields: 'is_rd_game,is_rsv_game' }));
await same('games or-and precedence', (api) => api('games').getFullList({ filter: `assigned_rc != "" || league = "${esc(g1.league)}" && match_date < "${mid}"`, fields: 'id' }));

const c1 = pick(coachees, 5);
await same('coachees full_name', (api) => api('coachees').getFullList({ filter: `full_name = "${esc(c1.full_name)}"` }));
for (const season of [2025, 2026, 2030]) {
  await same(`coachees name+season ${season}`, (api) => api('coachees').getFirstListItem(`full_name = "${esc(c1.full_name)}" && (season = ${season} || season = '' || season = null)`, { sort: '-season' }));
}
await same('coachees sort last_name', (api) => api('coachees').getFullList({ sort: 'last_name' }));
await same('coachees sort last_name,first_name', (api) => api('coachees').getFullList({ sort: 'last_name,first_name', fields: 'id,full_name,first_name,last_name,season,referee_id' }));
await same('coachees sort full_name', (api) => api('coachees').getFullList({ sort: 'full_name' }));
await same('coachees -season', (api) => api('coachees').getFullList({ sort: '-season', fields: 'season' }));
await same('coachees season text', (api) => api('coachees').getFullList({ filter: 'season = "2026"', fields: 'id' }));
await same('coachees referee_id empty', (api) => api('coachees').getFullList({ filter: 'referee_id = ""', fields: 'id,referee_id' }));

await same('rcs active', (api) => api('referee_coaches').getFullList({ filter: 'active = true', sort: 'last_name' }));
await same('rcs fields', (api) => api('referee_coaches').getFullList({ sort: 'last_name,first_name', fields: 'id,first_name,last_name' }));
if (rcs[0]) await same('rcs email', (api) => api('referee_coaches').getFirstListItem(`email = "${esc(rcs[0].email)}"`));

for (const s of settings) await same('settings key', (api) => api('app_settings').getFirstListItem(`key = "${esc(s.key)}"`));
for (const prefix of ['president_notes', 'vm_', 'PRESIDENT', 'mail', 'notes_']) {
  await same('settings key ~', (api) => api('app_settings').getFullList({ filter: `key ~ "${prefix}"`, sort: '-updated' }));
}

const f1 = pick(feedbacks, 2);
if (f1) {
  await same('feedbacks expand', (api) => api('referee_coach_feedbacks').getFullList({ sort: 'submitted_at', expand: 'game,coachee' }));
  await same('feedbacks getOne expand', (api) => api('referee_coach_feedbacks').getOne(f1.id, { expand: 'game,coachee' }));
  await same('feedbacks game+role', (api) => api('referee_coach_feedbacks').getFullList({ filter: `game = "${f1.game}" && role_assessed = "${esc(f1.role_assessed)}"`, fields: 'id,game,role_assessed' }));
  await same('feedbacks game+role since', (api) => api('referee_coach_feedbacks').getFullList({ filter: `game = "${f1.game}" && role_assessed = "${esc(f1.role_assessed)}" && submitted_at >= "${esc(f1.submitted_at)}"` }));
  await same('feedbacks coachee', (api) => api('referee_coach_feedbacks').getFullList({ filter: `coachee = "${f1.coachee}"`, sort: '-submitted_at,-created' }));
  await same('feedbacks game != x', (api) => api('referee_coach_feedbacks').getFullList({ filter: `game != "${f1.game}"`, fields: 'id' }));
  await same('feedbacks game empty', (api) => api('referee_coach_feedbacks').getFullList({ filter: 'game = "" || coachee = ""', fields: 'id' }));
  await same('feedbacks fields', (api) => api('referee_coach_feedbacks').getFullList({ fields: 'id,rc_name,rc_id,game,coachee,submitted_at', sort: '-submitted_at' }));
  await same('feedbacks fields+expand', (api) => api('referee_coach_feedbacks').getFullList({ fields: 'id,game', expand: 'game' }));
  await same('feedbacks submission_key', (api) => api('referee_coach_feedbacks').getFullList({ filter: `submission_key = "${esc(f1.submission_key)}"` }));
}
const o1 = pick(observations, 1);
if (o1) {
  await same('observations triple', (api) => api('observations').getFirstListItem(`coachee = "${o1.coachee}" && game = "${o1.game}" && coachee_function = "${esc(o1.coachee_function)}"`));
  await same('observations game', (api) => api('observations').getFullList({ filter: `game = "${o1.game}"` }));
  await same('observations rc', (api) => api('observations').getList(1, 50, { filter: `referee_coach = "${o1.referee_coach}" && promotion = "${esc(o1.promotion)}"`, sort: '-created' }));
  await same('observations fields', (api) => api('observations').getFullList({ fields: 'grades,promotion,motivation,coachee_function' }), deepSorted);
  await same('observations coachee fields', (api) => api('observations').getFullList({ filter: `coachee = "${o1.coachee}"`, fields: 'coachee,second_observation,created,updated' }));
}
const n1 = pick(notes, 0);
if (n1) await same('notes game or game_id', (api) => api('rc_game_notes').getFullList({ filter: `game = "${n1.game}" || game_id = "${esc(n1.game_id)}"` }));
await same('offers open', (api) => api('boerse_offers').getFullList({ filter: 'withdrawn_at = ""', fields: 'id,vm_offer_id,status,withdrawn_at,game_starts_at,alerted_at,match_no,slot,slot_person_name' }));
await same('offers open count', (api) => api('boerse_offers').getList(1, 1, { filter: 'withdrawn_at = ""' }));
if (offers[0]) await same('offers match_no', (api) => api('boerse_offers').getFullList({ filter: `match_no = "${esc(offers[0].match_no)}"`, fields: 'match_no,slot,status,withdrawn_at,slot_person_name,slot_person_sv' }));
for (const s of sigs) await same('signature slug', (api) => api('signatures').getFirstListItem(`slug = "${esc(s.slug)}"`));
const now = Date.now();
await same('signature ttl', (api) => api('signatures').getList(1, 200, { filter: `(signed = false && created < "${pbStamp(new Date(now - 864e5))}") || (signed = true && created < "${pbStamp(new Date(now - 30 * 864e5))}")`, fields: 'id', skipTotal: true }));
for (const v of visits) await same('visit token', (api) => api('rc_visit_feedback').getFirstListItem(`token = "${esc(v.token)}"`));
await same('visits submitted', (api) => api('rc_visit_feedback').getFullList({ filter: 'submitted = true', sort: '-submitted_at' }));
if (pages[0]) {
  await same('notebook owner', (api) => api('rc_notebook').getFullList({ filter: `owner_id = "${esc(pages[0].owner_id)}"`, sort: '-updated' }));
  await same('notebook page', (api) => api('rc_notebook').getFirstListItem(`owner_id = "${esc(pages[0].owner_id)}" && page_id = "${esc(pages[0].page_id)}"`));
}
await same('switch pending', (api) => api('rc_switch_requests').getFullList({ filter: `status = "pending" || decided_at >= "${pbStamp(new Date(now - 864e5))}"` }));
await same('bad field', (api) => api('games').getList(1, 1, { filter: 'nosuchfield = 1' }));
await same('unknown collection', (api) => api('nosuch').getList(1, 1));
await same('getOne empty id', (api) => api('games').getOne(''));
await same('perPage cap', (api) => api('games').getList(1, 5000, { fields: 'id' }));
await same('perPage 0', (api) => api('games').getList(1, 0, { fields: 'id' }));
console.log(`== reads: ${passed} same, ${failed} different`);

// READS_ONLY=1: the check for a database that must not be written to — the
// cutover runs it against production right after the migration.
if (process.env.READS_ONLY === '1') {
  await disconnectDatabase();
  console.log(failed === 0 ? `BACKENDS_SAME (${passed} cases, reads only)` : `BACKENDS_DIFFER (${failed} of ${passed + failed}, reads only)`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── writes ───────────────────────────────────────────────────────────
// Ids and stamps are new on each side; everything else has to agree.
const scrubRec = (v: any): any => {
  if (Array.isArray(v)) return v.map(scrubRec);
  if (v && typeof v === 'object') {
    const out: AnyRecord = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id' || k === 'created' || k === 'updated') out[k] = typeof x === 'string' && x ? '<set>' : x;
      else if (k === 'pdf_file') out[k] = typeof x === 'string' && x ? x.replace(/_[A-Za-z0-9]{10}(\.\w+)$/, '_<rand>$1') : x;
      else if (['game', 'coachee', 'referee_coach'].includes(k) && typeof x === 'string' && x.length === 15) out[k] = '<id>';
      else out[k] = scrubRec(x);
    }
    return out;
  }
  return v;
};
const before = passed + failed;
const made: Record<'pb' | 'pg', AnyRecord> = { pb: {}, pg: {} };
// Where Postgres answers differently ON PURPOSE (docs/postgres-prisma-plan.md):
// these must differ exactly as described, or the case fails.
const DELIBERATE: Record<string, (pb: string, pg: string) => boolean> = {
  // A unique index where PocketBase had none: the second row is refused.
  'create dup slug': (a, b) => a.startsWith('ok ') && b.includes('validation_not_unique'),
  // `field+` modifiers: nothing uses them, so one appearing is refused loudly
  // instead of PocketBase's silent ignore on a JSON field.
  modifier: (a, b) => a.startsWith('ok ') && b.startsWith('error ClientResponseError 400'),
};
async function both(label: string, call: (api: Api, side: 'pb' | 'pg') => Promise<unknown>) {
  const a = await outcome(() => call(PB, 'pb'), scrubRec);
  const b = await outcome(() => call(PG, 'pg'), scrubRec);
  if (DELIBERATE[label]) {
    if (DELIBERATE[label](a, b)) passed++;
    else { failed++; console.log(`DIFF write ${label}: not the deliberate difference`); }
    return;
  }
  if (a === b) passed++;
  else {
    failed++;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    console.log(`DIFF write ${label}: at ${i}\n  pb ${a.slice(Math.max(0, i - 60), i + 60)}\n  pg ${b.slice(Math.max(0, i - 60), i + 60)}`);
  }
}
const slug = `compare-${now}`;
await both('create coerced', async (api, side) => (made[side].sig = await api('signatures').create({ slug, context: 42, signer: { a: 1 }, data: true, signed: 'true', nosuch: 1 })));
await both('update coerced', (api, side) => api('signatures').update(made[side].sig.id, { context: null, signer: 1.5, data: '', signed: 0 }));
await both('update nothing', (api, side) => api('signatures').update(made[side].sig.id, {}));
await both('create no slug', (api) => api('signatures').create({ context: 'x' }));
await both('update slug empty', (api, side) => api('signatures').update(made[side].sig.id, { slug: '' }));
await both('create dup slug', async (api, side) => (made[side].dup = await api('signatures').create({ slug })));
await both('create notebook json', async (api, side) => (made[side].page = await api('rc_notebook').create({ owner_id: 'cmp', page_id: `p${now}`, schema: '3', payload: { z: 1, a: { y: [3, { d: 1, c: 2 }], b: 3 }, 10: 'x', 2: null }, deleted: 'false' })));
for (const payload of ['{"z":1,"a":2}', 'hello', '', 'null', 'true', '12.5', '"quoted"', '[3,1]', null, ['b', { y: 1, x: 2 }], 7]) {
  await both(`json ${JSON.stringify(payload)}`, (api, side) => api('rc_notebook').update(made[side].page.id, { payload, schema: payload === 7 ? '' : 'x' }));
}
await both('date-ish text', (api, side) => api('rc_notebook').update(made[side].page.id, { created_at: new Date(Date.UTC(2026, 9, 10, 12)), updated_at: undefined, kind: ['a'] }));
await both('relation missing', (api) => api('observations').create({ game: 'doesnotexist123' }));
await both('relation array', async (api, side) => (made[side].obs = await api('observations').create({ game: [g1.id], coachee: c1.id, grades: { b: 1, a: 2 }, second_observation: 'TRUE' })));
await both('relation cleared', (api, side) => api('observations').update(made[side].obs.id, { coachee: '', game: null }));
await both('update missing', (api) => api('games').update('nosuchid1234567', {}));
await both('delete missing', (api) => api('games').delete('nosuchid1234567'));
await both('modifier', (api, side) => api('observations').update(made[side].obs.id, { 'grades+': 1 }));
// A game deleted from under a form: PocketBase unset the form's link.
await both('game for delete', async (api, side) => (made[side].game = await api('games').create({ match_no: `cmp${now}`, match_date: '2026-10-11 10:00:00.000Z', handed_over: [] })));
await both('feedback on it', async (api, side) => (made[side].fb = await api('referee_coach_feedbacks').create({ game: made[side].game.id, coachee: c1.id, rc_name: 'cmp', feedback_json: { q: 1 } })));
await both('pdf upload', (api, side) => {
  const fd = new FormData();
  fd.append('pdf_file', new Blob([Buffer.from('%PDF-1.4 compare')], { type: 'application/pdf' }), 'Rückmeldung SR 1.pdf');
  return api('referee_coach_feedbacks').update(made[side].fb.id, fd);
});
await both('pdf too big', (api, side) => {
  const fd = new FormData();
  fd.append('pdf_file', new Blob([Buffer.alloc(5242881)], { type: 'application/pdf' }), 'big.pdf');
  return api('referee_coach_feedbacks').update(made[side].fb.id, fd);
});
await both('pdf kept by name', (api, side) => api('referee_coach_feedbacks').getOne(made[side].fb.id).then((r: AnyRecord) => api('referee_coach_feedbacks').update(made[side].fb.id, { pdf_file: r.pdf_file, rc_name: 'cmp2' })));
await both('delete game', (api, side) => api('games').delete(made[side].game.id));
await both('form after game delete', (api, side) => api('referee_coach_feedbacks').getOne(made[side].fb.id).then((r: AnyRecord) => ({ ...r, updated: undefined })));
await both('new rows last', (api) => api('signatures').getFullList({ fields: 'slug', filter: `slug != "${slug}"` }).then((rows: AnyRecord[]) => rows.length));
await both('pdf cleared', (api, side) => api('referee_coach_feedbacks').update(made[side].fb.id, { pdf_file: null }));
for (const side of ['pb', 'pg'] as const) {
  const api = side === 'pb' ? PB : PG;
  for (const [c, key] of [['referee_coach_feedbacks', 'fb'], ['observations', 'obs'], ['rc_notebook', 'page'], ['signatures', 'sig'], ['signatures', 'dup']] as const) {
    if (made[side][key]) await api(c).delete(made[side][key].id).catch(() => undefined);
  }
}
console.log(`== writes: ${passed + failed - before} cases`);

await disconnectDatabase();
console.log(failed === 0 ? `BACKENDS_SAME (${passed} cases)` : `BACKENDS_DIFFER (${failed} of ${passed + failed})`);
process.exit(failed === 0 ? 0 : 1);
