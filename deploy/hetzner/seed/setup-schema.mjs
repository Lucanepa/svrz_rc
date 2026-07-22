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
const N = n => ({ name:n, type:'number', required:false });
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
  T('assigned_rc'),J('feedback_closed_roles'),J('source_payload')
]);
const coachees = await ensure('coachees', [
  T('full_name'),T('first_name'),T('last_name'),T('email'),T('phone'),
  T('referee_level'),T('stage'),T('groups'),J('feedback_entries'),T('last_feedback_at'),
  // PocketBase drops keys the collection doesn't declare, and the xlsx import
  // projects `season` explicitly — a projection onto an undeclared column 400s
  // the whole import, so both have to exist here.
  T('notes'),N('season')
]);
const rcs = await ensure('referee_coaches', [
  T('first_name'),T('last_name'),T('email'),T('phone'),B('active'),
  // Reads the post-visit surveys (rc_visit_feedback). Set it HERE, not in the
  // admin console: a flag an admin can tick is one they can tick for
  // themselves, and admin rights must not open that view.
  B('is_rc_president'),
  // Per-RC login: the scrypt-hashed PIN and the admin role. Without these the
  // hash is silently dropped on write and nobody can ever log in.
  T('pin_hash'),B('is_admin')
]);
await ensure('referee_coach_feedbacks', [
  REL('game',games.id),REL('coachee',coachees.id),T('rc_name'),
  T('role_assessed'),J('feedback_json'),T('submitted_at'),FILE('pdf_file')
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
// Key/value store behind everything an admin can change without a deploy:
// default_season, test_mode, groups, coachee_targets, rc_mandates, default_goal,
// starred_games, the e-mail templates, the reminder-sent marker and the
// president notes. `value` is always a string (JSON-encoded where it holds a
// map), matching setSetting() in server/index.ts.
await ensure('app_settings', [T('key'),T('value')]);
// Cross-device signing sessions: the coach opens #/sign/<slug> on the phone
// they hand to the referee. `data` holds the signature PNG as a data URL.
await ensure('signatures', [
  T('slug'),T('context'),T('signer'),T('data'),B('signed')
]);
console.log('SCHEMA_OK');

// seed RCs (idempotent-ish: skip if any exist)
const existing = await pb.collection('referee_coaches').getFullList({ batch:200 }).catch(()=>[]);
if (existing.length === 0) {
  const seed = JSON.parse(fs.readFileSync(new URL('./referee_coaches.json', import.meta.url)));
  let n=0; for (const rc of seed){ try{ await pb.collection('referee_coaches').create(rc); n++; }catch(e){ console.error('rc',rc.email,e.message);} }
  console.log('SEEDED_RCS', n);
} else { console.log('RCS_EXIST', existing.length); }
