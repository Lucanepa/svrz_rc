// Fill referee_coaches.sv_number from the referee register, and from the
// numbers the games already carry.
//
// A game names its referees as text AND, for roughly a third of fixtures, by
// their Swiss Volley number. A coach is matched to their own SR-Spiele by that
// text, so a change of surname detaches them from every fixture written before
// it — which is what happened when Diehl became Schöni. The number does not
// change, so it is the better key; this fills it in from evidence the database
// already holds rather than asking anyone to type fifteen numbers.
//
// Two sources, register first because it is the authority:
//   1. `referees` — Swiss Volley's own list, as imported from the
//      "Schiedsrichter verwalten" export. An exact name match settles it.
//      Where the register prints a fuller given name than the coach goes by
//      ("Daniela Carina" for Daniela, "Carlos Enrique" for Carlos) and the
//      surname belongs to exactly one referee, that is the same person — the
//      number is taken AND the register's spelling is recorded as an alias,
//      because that is the spelling their fixtures are written under.
//   2. The games themselves, for a coach the register does not list.
//
// Conservative on purpose:
//   · only ACTIVE coaches,
//   · from the register, only where the surname belongs to exactly ONE
//     referee and the given names are prefixes of one another — a shared
//     surname is left alone rather than guessed at,
//   · from the games, only where the name appears with exactly ONE number
//     across all of them — two different numbers for one spelling means two
//     people, and guessing which is which would file a coach's games under a
//     stranger,
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
// The collection is `referees`. It is NOT called referee_register — asking for
// that name answers 404, which reads exactly like "the register was never
// imported" and is how this was first misread.
const register = await all('referees', 'sv_number,first_name,last_name,full_name');

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

/** The register's answer for one coach: their number, and the register's own
 *  spelling of their name when it differs from the one the club uses. */
const fromRegister = (first, last) => {
  const exact = register.filter((r) =>
    norm(`${r.first_name} ${r.last_name}`) === norm(`${first} ${last}`)
    || norm(r.full_name) === norm(`${first} ${last}`));
  if (exact.length === 1) return { number: String(exact[0].sv_number).trim(), alias: '', why: 'register, exact' };
  if (exact.length > 1) return null;
  // No exact hit: the register may print a fuller given name. Accept only when
  // the surname is unique in the register AND one given name begins with the
  // other, so "Daniela" ↔ "Daniela Carina" resolves and "Andrea" ↔ "Andreas"
  // does not.
  const sameSurname = register.filter((r) => norm(r.last_name) === norm(last));
  if (sameSurname.length !== 1) return null;
  const theirs = norm(sameSurname[0].first_name), ours = norm(first);
  if (!theirs || !ours) return null;
  const prefix = theirs.startsWith(`${ours} `) || ours.startsWith(`${theirs} `);
  if (!prefix) return null;
  return {
    number: String(sameSurname[0].sv_number).trim(),
    alias: `${sameSurname[0].first_name} ${sameSurname[0].last_name}`.trim(),
    why: 'register, fuller given name',
  };
};

let written = 0, kept = 0, ambiguous = 0, unknown = 0;
for (const person of coaches) {
  const label = `${person.first_name} ${person.last_name}`;
  if (String(person.sv_number || '').trim()) { kept += 1; console.log(`KEEP      ${person.sv_number}  ${label}`); continue; }

  let number = '', alias = '', why = '';
  const hit = fromRegister(person.first_name, person.last_name);
  if (hit && hit.number) ({ number, alias, why } = hit);
  else {
    const counts = seen.get(norm(label));
    if (!counts) { unknown += 1; console.log(`NO_DATA          ${label}  (not in the register, and no game carries a number for this name)`); continue; }
    if (counts.size > 1) { ambiguous += 1; console.log(`AMBIGUOUS        ${label}  ${JSON.stringify([...counts])}`); continue; }
    const [n, games_] = [...counts][0];
    number = n; why = `${games_} game(s) agree`;
  }

  // Only ADD an alias — never replace what somebody typed.
  const existing = String(person.name_aliases || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const merged = alias && !existing.some((x) => norm(x) === norm(alias))
    ? [...existing, alias].join(', ')
    : null;

  if (DRY) {
    console.log(`WOULD_SET ${number.padEnd(8)} ${label}  (${why})${merged ? `  + alias "${alias}"` : ''}`);
    written += 1;
    continue;
  }
  const r = await fetch(`${BASE}/api/collections/referee_coaches/records/${person.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: token },
    body: JSON.stringify(merged ? { sv_number: number, name_aliases: merged } : { sv_number: number }),
  });
  if (!r.ok) { console.log(`FAILED    ${number}  ${label}  ${r.status}`); continue; }
  written += 1;
  console.log(`SET       ${number.padEnd(8)} ${label}  (${why})${merged ? `  + alias "${alias}"` : ''}`);
}
console.log(`\n${DRY ? 'DRY RUN — ' : ''}written=${written} kept=${kept} ambiguous=${ambiguous} no_data=${unknown}`);
