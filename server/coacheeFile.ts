// The coachee's own file ("Mein Coaching-Dossier") — the rules, pure, so they
// can be tested without a PocketBase (see e2e/coachee-file-rules.spec.ts).
// index.ts keeps the I/O: the PIN map in app_settings, the routes, the mail.
//
// What it is: a referee who has been coached opens /dossier, types their
// SV-Nr. and a personal 6-digit PIN, and sees every report the coaching ever
// mailed them, across seasons and coaches, each PDF openable again. Asked for
// because reports to the same referee pile up in their inbox over the years
// and an old one is hard to find (Luca, 2026-10-04).
//
// NOT ROLLED OUT. The chair asked to wait until Swiss Volley has accepted the
// tool (Jasmin, 2026-10-04: "Maybe later … This is under the radar"). The one
// switch is `coachee_file_enabled`, and what it controls is the PIN MAIL —
// the only way a coachee ever learns a PIN. While it is off no coachee has
// one, so the page and its login exist but open for nobody except a PIN the
// admin minted in the console to try it out.
//
// What a coachee sees is exactly what they were already sent: the filed PDF
// (the report the mail carried) and its "Ziele für nächste Spiele". Never the
// chair's private note, never a parked draft, never another person's report.

type Rec = Record<string, unknown>;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

export const PIN_LENGTH = 6;

/** An SV-Nr. as typed: digits only, spaces and dots forgiven ("12 345").
 *  '' for anything that cannot be one. */
export function normalizeSvNumber(raw: unknown): string {
  const digits = text(raw).replace(/[\s.'’-]/g, '');
  return /^\d{3,9}$/.test(digits) ? digits.replace(/^0+(?=\d)/, '') : '';
}

/** A PIN as typed: exactly six digits once spaces are dropped, else ''. */
export function normalizePin(raw: unknown): string {
  const digits = text(raw).replace(/\s/g, '');
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(digits) ? digits : '';
}

/** PINs a person would guess first. A fresh PIN is never one of these: the
 *  attempt budget is per SV-Nr., and the guesses an attacker spends first
 *  should be ones that can never be right. */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;            // 000000, 777777
  const asc = '0123456789012345';
  const desc = '9876543210987654';
  if (asc.includes(pin) || desc.includes(pin)) return true; // 123456, 654321
  if (/^(\d\d)\1\1$/.test(pin) || /^(\d{3})\1$/.test(pin)) return true; // 121212, 123123
  return false;
}

/** A fresh PIN from the injected randomness (crypto.randomInt in index.ts). */
export function mintPin(randomInt: (max: number) => number): string {
  for (;;) {
    const pin = String(randomInt(10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
    if (!isWeakPin(pin)) return pin;
  }
}

/** One person's PIN. `gen` counts resets: a session carries the generation it
 *  was opened under, so a reset also ends every session opened with the old
 *  PIN. Stored readable, on purpose — it is mailed again with every report,
 *  and the database it sits in already holds the reports it protects. */
export type PinEntry = { pin: string; gen: number; createdAt: string };
export type PinMap = Record<string, PinEntry>;

export function parsePinMap(raw: unknown): PinMap {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  const out: PinMap = {};
  if (!value || typeof value !== 'object') return out;
  for (const [sv, entry] of Object.entries(value as Record<string, unknown>)) {
    const id = normalizeSvNumber(sv);
    const e = (entry ?? {}) as Rec;
    const pin = normalizePin(e.pin);
    if (!id || !pin) continue;
    const gen = Number(e.gen);
    out[id] = { pin, gen: Number.isInteger(gen) && gen > 0 ? gen : 1, createdAt: text(e.createdAt) };
  }
  return out;
}

// ── Session token ─────────────────────────────────────────────────────
// A short session, not a cookie: the page sends it in a header, so it never
// rides along on a request the page did not make, and it dies with the tab.

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const TOKEN_PURPOSE = 'coachee-file';

export type FileSession = { sv: string; gen: number; exp: number };

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/** `sign` is index.ts's HMAC. The purpose is inside the signed payload AND
 *  prefixed to what is signed, so this token can never pass for an RC or a
 *  console session (those verifiers sign the bare payload), and theirs can
 *  never pass for this. */
export function signFileSession(s: FileSession, sign: (data: string) => string): string {
  const payload = b64url(JSON.stringify({ purpose: TOKEN_PURPOSE, sv: s.sv, gen: s.gen, exp: s.exp }));
  return `${payload}.${sign(`${TOKEN_PURPOSE}.${payload}`)}`;
}

export function verifyFileSession(
  token: string,
  sign: (data: string) => string,
  equals: (a: string, b: string) => boolean,
  now: number,
): FileSession | null {
  const [payload, signature, extra] = text(token).split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!equals(signature, sign(`${TOKEN_PURPOSE}.${payload}`))) return null;
  try {
    const parsed = JSON.parse(unb64url(payload)) as Rec;
    if (parsed.purpose !== TOKEN_PURPOSE) return null;
    const sv = normalizeSvNumber(parsed.sv);
    const gen = Number(parsed.gen);
    const exp = Number(parsed.exp);
    if (!sv || !Number.isInteger(gen) || !Number.isFinite(exp) || exp <= now) return null;
    return { sv, gen, exp };
  } catch {
    return null;
  }
}

/** Still the PIN generation the session was opened under? A reset in the
 *  console ends it at once, not at its expiry. */
export function sessionStillValid(session: FileSession, pins: PinMap): boolean {
  return pins[session.sv]?.gen === session.gen;
}

// ── Which forms are this person's ─────────────────────────────────────

/** The SV-Nr. a filed form is about, from its OWN records only: the coachee
 *  row, the copy kept when that row was deleted, the game's slot for the role.
 *
 *  Deliberately stricter than the chair's folders (server/forms.ts
 *  folderKeys), which lend an SV-Nr. to every form sharing the name so the
 *  seasons before the register was linked land in the same folder. Two
 *  referees with the same name would merge there — a risk the chair takes
 *  knowingly for her own archive. Here it would hand one referee's assessment
 *  to another, so a form without its own number is simply not shown. */
export function formRefereeId(rec: Rec): string {
  const expand = (rec.expand ?? {}) as Record<string, Rec | undefined>;
  const detached = (((rec.feedback_json as Rec | undefined)?.detached ?? {}) as Rec);
  const game = expand.game ?? (detached.game as Rec | undefined);
  const coachee = expand.coachee ?? (detached.coachee as Rec | undefined);
  const second = text(rec.role_assessed).replace(/[^0-9]/g, '') === '2';
  const slot = second ? 'second' : 'first';
  return normalizeSvNumber(text(coachee?.referee_id) || text(game?.[`${slot}_referee_id`]));
}

/** One report as the coachee's page lists it. */
export type FileEntry = {
  id: string;
  date: string;
  role: '1. SR' | '2. SR';
  matchNo: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  rc: string;
  /** "Ziele für nächste Spiele", as plain text — the one field worth reading
   *  without opening the PDF, and the one the next coach is shown too. */
  goals: string;
  /** Whether a document is stored to open. */
  hasFile: boolean;
  /** Filed on a Testspiel — only ever the people trying the flow out. */
  isTest: boolean;
};

export function fileEntries(
  records: Array<Rec & { id: string }>,
  sv: string,
  opts: { toPlain: (rich: string) => string; manualGameIds: Set<string> },
): FileEntry[] {
  const want = normalizeSvNumber(sv);
  if (!want) return [];
  const out: FileEntry[] = [];
  for (const rec of records) {
    if (formRefereeId(rec) !== want) continue;
    const expand = (rec.expand ?? {}) as Record<string, Rec | undefined>;
    const detached = (((rec.feedback_json as Rec | undefined)?.detached ?? {}) as Rec);
    const game = expand.game ?? (detached.game as Rec | undefined) ?? {};
    const results = (((rec.feedback_json as Rec | undefined)?.results ?? {}) as Rec);
    const second = text(rec.role_assessed).replace(/[^0-9]/g, '') === '2';
    out.push({
      id: rec.id,
      date: text(game.match_date).slice(0, 10),
      role: second ? '2. SR' : '1. SR',
      matchNo: text(game.match_no),
      league: text(game.league),
      homeTeam: text(game.home_team),
      awayTeam: text(game.away_team),
      rc: text(rec.rc_name),
      goals: opts.toPlain(text(results.goals)).trim(),
      hasFile: !!text(rec.pdf_file),
      isTest: opts.manualGameIds.has(text(game.id) || text(rec.game)),
    });
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return out;
}

/** The name the page greets with: the newest coachee row's spelling, else
 *  the game's line for the role. */
export function fileOwnerName(records: Array<Rec & { id: string }>, sv: string): string {
  const want = normalizeSvNumber(sv);
  let best = '';
  let bestDate = '';
  for (const rec of records) {
    if (formRefereeId(rec) !== want) continue;
    const expand = (rec.expand ?? {}) as Record<string, Rec | undefined>;
    const detached = (((rec.feedback_json as Rec | undefined)?.detached ?? {}) as Rec);
    const game = expand.game ?? (detached.game as Rec | undefined) ?? {};
    const coachee = expand.coachee ?? (detached.coachee as Rec | undefined);
    const second = text(rec.role_assessed).replace(/[^0-9]/g, '') === '2';
    const name = text(coachee?.full_name) || text(game[second ? 'second_referee' : 'first_referee']);
    const date = text(game.match_date);
    if (name && (!best || date > bestDate)) { best = name; bestDate = date; }
  }
  return best;
}
