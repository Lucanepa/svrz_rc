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
// The SR-Börse: VolleyManager's exchange, where a referee who cannot whistle a
// game they are convoked for offers THAT SLOT for someone else to take. One row
// here is one OFFER, not one game — a game can appear twice, once per head slot,
// and the same slot can be offered again after a withdrawal.
//
// A sibling of `games` rather than columns on it, and that is not a style
// choice: `mapIncomingGame` returns the full update payload, so any börse column
// living on `games` would be silently blanked by the next 05:00 import unless
// that function were taught about it too. Nothing here is coupled to that.
//
// Whose slot is it? Match `referee_position` against the entry of the same
// position in `refereeGame.refereeConvocations` — for an OPEN offer that person
// is the one who would be replaced, whoever filed it (the association files on
// referees' behalf constantly, so `submitted_by_*` is not the answer). For a
// TAKEN offer the same convocation already names whoever took it, which is why
// `status` has to be read before that join is trusted.
//
// Line judges are deliberately absent. Only head-one and head-two are stored;
// SVRZ has never had a line-judge offer, and the two endpoints disagree about
// the word anyway (`Linesman` here, `LineJudge` on the games search).
await ensure('boerse_offers', [
  // The exchange row's own identity in VolleyManager — the upsert key. A slot
  // offered, withdrawn and offered again is two different offers and must get
  // two rows, or the second one inherits the first one's `first_seen` and the
  // banner dates an hours-old offer to last Monday.
  T('vm_offer_id'),
  // The join to games.match_no. Both sides are String(game.number): a plain
  // 6-digit integer, no leading zeros, so the formats agree.
  T('match_no'),T('game_starts_at'),
  // The raw VolleyManager value, unmapped, so a vocabulary change is visible as
  // an unresolved slot rather than as silence. `slot` is the normalisation:
  // '1' or '2', matching games.first_referee / second_referee.
  T('referee_position'),T('slot'),
  // open | applied | not_applied — note the underscore; VM spells this one with
  // an underscore where every other enum here uses a hyphen.
  T('status'),
  // The person whose slot is on offer. The SV-Nr. is the identity that matches
  // games.first_referee_id; it is only readable through the refereeConvocations
  // ARRAY — the activeRefereeConvocation*HeadReferee accessors return a fixed
  // projection that omits it however you ask for it.
  T('slot_person_name'),T('slot_person_sv'),T('slot_person_vm_id'),
  T('submitted_by_name'),T('submitted_by_sv'),T('submitting_type'),T('submitted_at'),
  T('applied_by_name'),T('applied_by_sv'),T('applied_at'),
  // How confident we are that slot_person is the referee our own games row
  // names in that slot: position | position+sv | position+name | conflict |
  // unresolved. Diagnostic, for the admin console — never a colour on a phone.
  T('join_via'),
  // last_seen is how a withdrawal is detected: an offer absent from a fetch we
  // can PROVE was complete. withdrawn_at is only ever set from such a fetch.
  T('first_seen'),T('last_seen'),T('withdrawn_at'),
  // A trimmed evidence blob — the offer's own scalars plus the one matching
  // convocation, so a wrong join can be diagnosed without re-running a sync.
  // Trimmed on purpose: games.source_payload is dead because storing whole VM
  // rows was the wrong idea the first time.
  J('raw')
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
  // Swiss Volley's number for this coach. A game carries its referees' numbers
  // beside their names, and a number survives a change of surname — which the
  // name matching did not: renaming a coach detached them from every game the
  // sync had already written under the old name. Optional, and the name stays
  // the fallback: only about a third of games carry referee numbers at all.
  T('sv_number'),
  // Other spellings this coach's fixtures are written under — a maiden name,
  // or a full given name the coach does not go by. Comma-separated. The
  // register name can then be changed without detaching them from the
  // fixtures already synced under the old one, which is what sv_number cannot
  // cover alone: only about a third of games carry a referee number.
  T('name_aliases'),
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
// 4.4.10 SR-Spiel. A referee coach standing ON the whistle next to a coachee
// cannot observe them — there is nobody in the stand. The regulation therefore
// asks for NO Feedbackformular on that referee, and for a short Rückmeldung
// from the coach instead. That was a separate Google form until now, and the
// coach retyped the match, the league, the teams and who whistled which slot
// into it every time; here the note is the only thing left to write, and every
// other column below is context the app already holds.
//
// Its own collection, deliberately not a feedback with empty grades: the season
// counters, the coachee's feedback history and the president's list all read
// referee_coach_feedbacks, and a Rückmeldung is not an observation in any of
// them.
await ensure('rc_game_notes', [
  REL('game',games.id),T('game_id'),T('rc_name'),T('rc_id'),T('rc_role'),
  T('coachee_name'),T('coachee_id'),T('coachee_role'),
  T('note'),T('submitted_at'),NUM('season'),
  // Infoschreiben 7.3: an RC and an N3-3 may agree to swap 1. and 2. SR. The
  // roles above are then the opposite of what VolleyManager still says, and the
  // swap has to reach the RC-Präsidium so it can be corrected there.
  B('roles_swapped'),
  // Same job as referee_coach_feedbacks.submission_key: a retry that the server
  // already committed must be recognised, not filed twice.
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
// The opt-in server copy of an UNFINISHED observation. Every other copy of a
// draft is device-local (src/lib/formDraft.ts, IndexedDB), which is right until
// the phone is lost, stolen, wiped or simply dead — and then the work goes with
// it, along with two signatures nobody can collect a second time. Nothing lands
// here unless the coach asks for it, and an empty table is the ordinary state
// of this feature, never an error.
//
// owner_id is the RC's id from the SESSION and never from a request body. It is
// what every read and every write filters on, so a coach cannot reach a
// colleague's unfinished observation — see the ownership rule spelled out over
// /api/drafts/parked in server/index.ts.
//
// payload is one role's DraftRecord minus its identity fields (id, ownerId,
// submissionKey) and always status 'editing'. The server stores it opaquely: it
// files nothing, mails nothing and creates no observation from it. J() caps the
// column at 2_000_000; the park route's own wire cap is set strictly BELOW that
// (PARK_MAX_BYTES in server/index.ts), because a body this column would refuse
// must be turned away with a 413 rather than accepted and then 500.
//
// updated_at is the DEVICE's clock, kept because it is what decides which of
// two copies of a form is the newer one; `updated` (autodate) is the server's
// own, which is the one to trust when a tablet boots in 1970.
await ensure('parked_drafts', [
  T('owner_id'),T('game_id'),T('role'),T('updated_at'),NUM('schema'),J('payload')
]);
console.log('SCHEMA_OK');

// seed RCs (idempotent-ish: skip if any exist)
const existing = await pb.collection('referee_coaches').getFullList({ batch:200 }).catch(()=>[]);
if (existing.length === 0) {
  const seed = JSON.parse(fs.readFileSync(new URL('./referee_coaches.json', import.meta.url)));
  let n=0; for (const rc of seed){ try{ await pb.collection('referee_coaches').create(rc); n++; }catch(e){ console.error('rc',rc.email,e.message);} }
  console.log('SEEDED_RCS', n);
} else { console.log('RCS_EXIST', existing.length); }
