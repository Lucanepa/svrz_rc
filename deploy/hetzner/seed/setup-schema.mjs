import fs from 'fs';
import PocketBase from 'pocketbase';

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://pocketbase:8090');
pb.autoCancellation(false);
const email = process.env.POCKETBASE_ADMIN_EMAIL, password = process.env.POCKETBASE_ADMIN_PASSWORD;

async function login() {
  try { await pb.collection('_superusers').authWithPassword(email, password); }
  catch { await pb.admins.authWithPassword(email, password); }
}
const T = n => ({ name:n, type:'text', required:false });
const NUM = n => ({ name:n, type:'number', required:false });
const J = n => ({ name:n, type:'json', required:false, maxSize:2000000 });
const B = n => ({ name:n, type:'bool', required:false });
const FILE = n => ({ name:n, type:'file', required:false, maxSelect:1, maxSize:5242880 });
const REL = (n,cid) => ({ name:n, type:'relation', required:false, collectionId:cid, cascadeDelete:false, maxSelect:1 });

// PocketBase 0.26 does not auto-add created/updated — add them explicitly so
// "newest first" sorts (filter/sort on `created`) work across the app.
const AUTODATE = [
  { name:'created', type:'autodate', onCreate:true, onUpdate:false },
  { name:'updated', type:'autodate', onCreate:true, onUpdate:true },
];

// Additive only: never drops or retypes an existing field, so it is safe to
// re-run against the live DB whenever the app starts writing a new column.
async function ensureFields(collection, fields) {
  const have = new Set((collection.fields ?? []).map(f => f.name));
  const missing = fields.filter(f => !have.has(f.name));
  if (missing.length === 0) return collection;
  const updated = await pb.collections.update(collection.id, { fields:[...collection.fields, ...missing] });
  console.log('FIELDS_ADDED', collection.name, missing.map(f => f.name).join(','));
  return updated;
}

async function ensure(name, fields) {
  let existing = null;
  try { existing = await pb.collections.getOne(name); } catch {}
  if (existing) return ensureFields(existing, fields);
  return pb.collections.create({ name, type:'base', fields:[...fields, ...AUTODATE] });
}

await login();
const games = await ensure('games', [
  T('external_id'),T('match_no'),T('league'),T('match_date'),T('location'),T('home_team'),T('away_team'),
  T('first_referee'),T('second_referee'),T('first_line_judge'),T('second_line_judge'),
  // Observation markings mirrored from VolleyManager: RD-Spiel / SR zu beobachten,
  // linesman supervision, and the RSV-Markierung.
  B('is_rd_game'),B('is_ld_game'),B('is_rsv_game'),T('maps_url'),T('game_result'),
  // assigned_rc is the RC's display NAME and stays: it is what the games list,
  // the exports and the calendar feed print. assigned_rc_id is the identity —
  // a name changes, and two coaches can normalise to the same string, at which
  // point either could give away the other's game. Written together; readers
  // prefer the id and fall back to the name for rows not yet backfilled
  // (POST /api/admin/migrate-rc-ids).
  T('assigned_rc'),T('assigned_rc_id'),J('feedback_closed_roles'),J('source_payload'),
  // The same argument as assigned_rc_id, one row down: who the referees are,
  // not how VolleyManager spelled them that day. The SV-Nr., filled by the
  // nightly import off `person.associationId` on the convocation VolleyManager
  // already sends with every game, and by the manual-game form off the
  // register. Empty on a game whose convocation carried only a name, and on
  // everything imported before 2026-08-27 — readers fall back to the name.
  T('first_referee_id'),T('second_referee_id')
]);
// The referee roster, keyed by the Swiss Volley number — the only identifier in
// this system that does not change when somebody marries, adds an accent or is
// filed surname-first. Imported from the SVRZ "Schiedsrichter verwalten" XLSX,
// which carries 143 referees where the coachee list carries ~110: not every
// referee is coached, but any of them can stand on a game.
//
// Deliberately NOT a copy of the whole export. Birthdate, street address and
// Pensum are in the file and are none of this app's business; what is kept is
// identity (number + name), the two ways to reach someone, and the level —
// including the Niveaustufe, which VolleyManager's API refuses to expose and
// which therefore has no other source.
await ensure('referees', [
  T('sv_number'),T('first_name'),T('last_name'),T('full_name'),T('email'),T('phone'),
  T('gender'),T('level'),T('stage'),T('lr_level'),T('license_association'),
  B('license_active'),B('retired'),B('dispensed'),T('language'),T('imported_at')
]);
const coachees = await ensure('coachees', [
  T('full_name'),T('first_name'),T('last_name'),T('email'),T('phone'),
  T('referee_level'),T('stage'),T('groups'),J('feedback_entries'),T('last_feedback_at'),
  // The coach's own notes on a coachee, and the season the row belongs to.
  // PocketBase drops keys a collection doesn't declare, so without these the
  // notes editor saved into the void and the xlsx import — which projects
  // `id,full_name,season` — answered 400.
  T('notes'),NUM('season'),
  // Which referee this row is, by Swiss Volley number. The name stays the thing
  // that prints; this is the thing that matches. Filled by the referee import
  // where the name resolves to exactly one referee, and by nothing else — a
  // coachee whose name is ambiguous keeps an empty id rather than a guessed one.
  T('referee_id')
]);
const rcs = await ensure('referee_coaches', [
  T('first_name'),T('last_name'),T('email'),T('phone'),B('active'),
  // Reads the post-visit surveys (rc_visit_feedback). Set it HERE, not in the
  // admin console: a flag an admin can tick is one they can tick for
  // themselves, and admin rights must not open that view.
  B('is_rc_president'),
  // Per-RC PIN login: the scrypt hash of the PIN, and whether this RC's session
  // counts as an admin one. Missing, a generated PIN is silently discarded and
  // every later login fails with "rc-has-no-password-set".
  T('pin_hash'),B('is_admin')
]);
await ensure('referee_coach_feedbacks', [
  // rc_name prints on the report and in the president's list; rc_id is who
  // owns the record. Ownership checks read the id first — see rcRefMatches.
  REL('game',games.id),REL('coachee',coachees.id),T('rc_name'),T('rc_id'),
  T('role_assessed'),J('feedback_json'),T('submitted_at'),FILE('pdf_file'),
  // The offline outbox's own item id, replayed unchanged on every retry, so a
  // resend can be recognised as the SAME submission rather than guessed at by a
  // 30-minute time window. A connection dropped after the server committed
  // leaves the client believing it never sent; the item then waits — often
  // until the app is next opened, the following morning — and re-sends. Same
  // game, same role, hours apart, is exactly what a legitimate second visit
  // looks like, so nothing else can tell them apart. Empty for submissions made
  // online, which never enter the outbox.
  T('submission_key')
]);
await ensure('observations', [
  REL('coachee',coachees.id),REL('referee_coach',rcs.id),REL('game',games.id),
  T('coachee_function'),J('grades'),T('game_level'),T('promotion'),T('motivation'),
  T('sr_goal'),T('game_result'),T('remarks'),B('second_observation')
]);
// The coachee's feedback ON the RC, collected by the public #/survey/<token>
// page linked from the feedback mail. Deliberately unrelated to `coachees`:
// "anonym absenden" has to mean the row cannot point back at a person.
await ensure('rc_visit_feedback', [
  T('token'),T('referee_name'),T('match_date'),T('match_no'),T('rc_name'),
  T('lang'),B('anonymous'),J('answers'),B('submitted'),T('submitted_at')
]);
// Key/value store behind every app setting: default season, groups, coachee
// targets, RC mandates, e-mail templates, starred games, the reminder dedupe
// stamp and the president's private notes. Without it every settings write 500s
// and every read silently answers "unset".
await ensure('app_settings', [T('key'),T('value')]);
// Cross-device signing sessions (#/sign/<slug>). Without it the signature pad
// can never open, so no feedback can be completed.
await ensure('signatures', [T('slug'),T('context'),T('signer'),T('data'),B('signed')]);
console.log('SCHEMA_OK');

// seed RCs (idempotent-ish: skip if any exist)
const existing = await pb.collection('referee_coaches').getFullList({ batch:200 }).catch(()=>[]);
if (existing.length === 0) {
  const seed = JSON.parse(fs.readFileSync(new URL('./referee_coaches.json', import.meta.url)));
  let n=0; for (const rc of seed){ try{ await pb.collection('referee_coaches').create(rc); n++; }catch(e){ console.error('rc',rc.email,e.message);} }
  console.log('SEEDED_RCS', n);
} else { console.log('RCS_EXIST', existing.length); }
