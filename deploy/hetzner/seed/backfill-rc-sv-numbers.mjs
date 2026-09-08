// Fill referee_coaches.sv_number from the numbers the games already carry.
//
// A game names its referees as text AND, for roughly a third of fixtures, by
// their Swiss Volley number. A coach is matched to their own SR-Spiele by that
// text, so a change of surname detaches them from every fixture written before
// it — which is what happened when Diehl became Schöni. The number does not
// change, so it is the better key; this fills it in from evidence the database
// already holds rather than asking anyone to type fifteen numbers.
//
// Conservative on purpose:
//   · only ACTIVE coaches,
//   · only where the name appears with exactly ONE number across all games —
//     two different numbers for one spelling means two people, and guessing
//     which is which would file a coach's games under a stranger,
//   · only where sv_number is still empty, so a number typed by hand in the
//     console always wins and re-running this changes nothing.
//
// Idempotent. Safe to re-run after every games sync, which is when new evidence
// appears for the coaches that have none yet.
//
//   docker exec svrz-rc-svrz-api-1 node deploy/hetzner/seed/backfill-rc-sv-numbers.mjs
//   docker exec svrz-rc-svrz-api-1 node deploy/hetzner/seed/backfill-rc-sv-numbers.mjs --dry-run

const BASE = process.env.POCKETBASE_URL || 'http://pocketbase:8090';
const DRY = process.argv.includes('--dry-run');

let token = '';
for (const path of ['/api/collections/_superusers/auth-with-password', '/api/admins/auth-with-password']) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identity: process.env.POCKETBASE_ADMIN_EMAIL,
      email: process.env.POCKETBASE_ADMIN_EMAIL,
      password: process.env.POCKETBASE_ADMIN_PASSWORD,
    }),
  });
  if (r.ok) { token = (await r.json()).token; break; }
}
if (!token) { console.error('AUTH_FAILED'); process.exit(1); }

const all = async (collection, fields) => {
  let page = 1, out = [];
  for (;;) {
    const qs = new URLSearchParams({ perPage: '500', page: String(page), ...(fields ? { fields } : {}) });
    const r = await fetch(`${BASE}/api/collections/${collection}/records?${qs}`, { headers: { Authorization: token } });
    if (!r.ok) throw new Error(`${collection}: ${r.status}`);
    const body = await r.json();
    out = out.concat(body.items || []);
    if (page >= (body.totalPages || 1)) break;
    page += 1;
  }
  return out;
};

// The same folding the server's normalizeName does, so a name this resolves is
// a name the matching would have resolved too.
const norm = (s) => (s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

const coaches = (await all('referee_coaches')).filter((p) => p.active === true);
const games = await all('games', 'first_referee,second_referee,first_referee_id,second_referee_id');

// name -> number -> how many games said so
const seen = new Map();
for (const g of games) {
  for (const [name, id] of [[g.first_referee, g.first_referee_id], [g.second_referee, g.second_referee_id]]) {
    const key = norm(name);
    const number = String(id || '').trim();
    if (!key || !number) continue;
    if (!seen.has(key)) seen.set(key, new Map());
    const counts = seen.get(key);
    counts.set(number, (counts.get(number) || 0) + 1);
  }
}

let written = 0, kept = 0, ambiguous = 0, unknown = 0;
for (const person of coaches) {
  const label = `${person.first_name} ${person.last_name}`;
  if (String(person.sv_number || '').trim()) { kept += 1; console.log(`KEEP      ${person.sv_number}  ${label}`); continue; }
  const counts = seen.get(norm(label));
  if (!counts) { unknown += 1; console.log(`NO_DATA          ${label}`); continue; }
  if (counts.size > 1) { ambiguous += 1; console.log(`AMBIGUOUS        ${label}  ${JSON.stringify([...counts])}`); continue; }
  const [number, games_] = [...counts][0];
  if (DRY) { console.log(`WOULD_SET ${number}  ${label}  (${games_} game(s))`); written += 1; continue; }
  const r = await fetch(`${BASE}/api/collections/referee_coaches/records/${person.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: token },
    body: JSON.stringify({ sv_number: number }),
  });
  if (!r.ok) { console.log(`FAILED    ${number}  ${label}  ${r.status}`); continue; }
  written += 1;
  console.log(`SET       ${number}  ${label}  (${games_} game(s))`);
}
console.log(`\n${DRY ? 'DRY RUN — ' : ''}written=${written} kept=${kept} ambiguous=${ambiguous} no_data=${unknown}`);
