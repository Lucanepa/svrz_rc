// The forms database (Admin → Formulare), as the server reads it — pure, so it
// can be tested without a PocketBase (see e2e/forms-rules.spec.ts). index.ts
// keeps only the I/O around these: the list of filed feedbacks, the file
// fetches, the ZIP and the routes.
//
// The season ZIP answers "everything we wrote this season". The chair's other
// question — "everything we ever wrote about THIS referee" — has no season, so
// it is answered per person: every filed form, whichever season and whichever
// coach, sorted into one folder per referee.
//
// What makes a folder is the person, not the coachee row. Coachees are one row
// per season, and a form is filed against the row of its season; the same
// referee therefore has as many rows as seasons, and grouping by row would
// give the chair one folder per season — the very thing she asked not to have.
import { seasonOfGame } from './season.ts';

type Rec = Record<string, unknown>;

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/** Case-blind, accent-blind, spaces squeezed — the same folding the rest of
 *  the server does to a name. */
function foldName(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
}

/** The same person however the sheet orders their names: VolleyManager writes
 *  "Vorname Nachname" on some fixtures and "Nachname Vorname" on others, and
 *  the XLSX has its own idea. Sorting the parts makes the two spellings one
 *  key. Two different referees sharing every name part is a risk taken
 *  knowingly — their folders would merge — because splitting one person into
 *  two folders is the failure the feature exists to avoid. */
export function personKey(name: string): string {
  return foldName(name).split(' ').filter(Boolean).sort().join(' ');
}

export type FormsFile = '' | 'pdf' | 'image';

/** One filed form as the folder lists it — the light shape, without the
 *  written assessment: the folder is an index, the PDF is the document. */
export type FormsEntry = {
  id: string;
  /** The game's date, YYYY-MM-DD; '' for a game without one. */
  date: string;
  season: number | null;
  role: '1. SR' | '2. SR';
  matchNo: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  rc: string;
  submittedAt: string;
  /** What is stored for it: the drawn PDF, a scanned/photographed paper form,
   *  or nothing (a record whose upload failed half-way). */
  file: FormsFile;
  /** The name it opens and downloads as. */
  filename: string;
  /** The game the form is about, so a folder row can lead to it. '' for a
   *  form whose game was deleted. */
  gameId: string;
  /** Filed on a throwaway fixture: the chair's bin exists for exactly these,
   *  and nothing in the folder said which rows they were. */
  isManual: boolean;
};

export type FormsFolder = {
  /** Opaque to the client; the ZIP route hands it back to name the folder. */
  key: string;
  name: string;
  /** The SV-Nr., when any row of the person carries one. */
  refereeId: string;
  seasons: number[];
  forms: FormsEntry[];
};

/** Safe inside a ZIP, in a Content-Disposition and in a folder listing. */
export function archiveSlug(value: string): string {
  return text(value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unbenannt';
}

/** Which of the two stored kinds a file name says it is. PocketBase keeps the
 *  extension the upload was given, and the submit route derives that from the
 *  sniffed bytes — so the name is honest. */
export function formsFileKind(storedName: string): FormsFile {
  const ext = /\.([a-z0-9]+)$/i.exec(text(storedName))?.[1]?.toLowerCase() ?? '';
  if (!ext) return '';
  return ext === 'pdf' ? 'pdf' : 'image';
}

/** The shape one filed feedback takes on the way into a folder. */
export type FormsRow = {
  rec: Rec & { id: string };
  game?: Rec;
  coachee?: Rec;
  /** The SV-Nr. from the coachee row, else from the game's slot for the role. */
  refereeId: string;
  /** Who the form is about, from the best source that names them. */
  name: string;
  role: '1. SR' | '2. SR';
  date: string;
  /** The game is a manual (test) fixture — stamped by the caller that read
   *  the manual set; absent where nobody did. */
  isManual?: boolean;
};

export function formsRowOf(rec: Rec & { id: string }): FormsRow {
  const expand = (rec.expand ?? {}) as Record<string, Rec | undefined>;
  const game = expand.game;
  const coachee = expand.coachee;
  const second = text(rec.role_assessed).replace(/[^0-9]/g, '') === '2';
  const slot = second ? 'second' : 'first';
  const meta = ((rec.feedback_json as Rec | undefined)?.meta ?? {}) as Rec;
  return {
    rec, game, coachee,
    refereeId: text(coachee?.referee_id) || text(game?.[`${slot}_referee_id`]),
    // The coachee row spells the name the way the roster does; a form filed
    // against the register (a test game) has only the game's referee line,
    // and a manual upload of a paper form may have only what the coach typed.
    name: text(coachee?.full_name) || text(game?.[`${slot}_referee`]) || text(meta.srName),
    role: second ? '2. SR' : '1. SR',
    date: text(game?.match_date).slice(0, 10),
  };
}

/** `2026-03-14_Hans-Muster_1SR_12345.pdf` — date first so a folder listing
 *  sorts itself, the person so a file found loose still says whose it is. */
export function formsEntryName(row: FormsRow): string {
  const role = row.role === '2. SR' ? '2SR' : '1SR';
  const ext = /\.([a-z0-9]+)$/i.exec(text(row.rec.pdf_file))?.[1]?.toLowerCase() || 'pdf';
  return `${row.date || 'ohne-datum'}_${archiveSlug(row.name)}_${role}_${archiveSlug(text(row.game?.match_no))}.${ext}`;
}

export function formsEntryOf(row: FormsRow): FormsEntry {
  return {
    id: row.rec.id,
    date: row.date,
    season: seasonOfGame(row.game?.match_date),
    role: row.role,
    matchNo: text(row.game?.match_no),
    league: text(row.game?.league),
    homeTeam: text(row.game?.home_team),
    awayTeam: text(row.game?.away_team),
    rc: text(row.rec.rc_name),
    submittedAt: text(row.rec.submitted_at),
    file: formsFileKind(text(row.rec.pdf_file)),
    filename: formsEntryName(row),
    gameId: text(row.game?.id) || text(row.rec.game),
    isManual: row.isManual === true,
  };
}

/** The folder a row belongs in. A row with an SV-Nr. lends it to every row
 *  that shares its name, so the seasons filed before the register was linked
 *  land in the same folder as the ones after. */
export function folderKeys(rows: FormsRow[]): Map<FormsRow, string> {
  const idByName = new Map<string, string>();
  for (const r of rows) {
    const k = personKey(r.name);
    if (r.refereeId && k && !idByName.has(k)) idByName.set(k, r.refereeId);
  }
  const out = new Map<FormsRow, string>();
  for (const r of rows) {
    const k = personKey(r.name);
    const id = r.refereeId || idByName.get(k) || '';
    out.set(r, id ? `sv:${id}` : `name:${k || r.rec.id}`);
  }
  return out;
}

/** Newest game first, then newest filing — the order a folder reads in. */
const newestFirst = (a: FormsRow, b: FormsRow): number =>
  (b.date || '').localeCompare(a.date || '') || text(b.rec.submitted_at).localeCompare(text(a.rec.submitted_at));

/** One folder per referee, newest form first inside each; folders by name. */
export function groupForms(rows: FormsRow[]): FormsFolder[] {
  const keys = folderKeys(rows);
  const byKey = new Map<string, FormsRow[]>();
  for (const r of rows) {
    const key = keys.get(r)!;
    const list = byKey.get(key);
    if (list) list.push(r); else byKey.set(key, [r]);
  }
  const out: FormsFolder[] = [];
  for (const [key, list] of byKey) {
    list.sort(newestFirst);
    // The folder carries the newest roster spelling of the name — the row the
    // admin is curating now — and falls back to whatever the newest form says.
    const named = list.find((r) => r.coachee && r.name) ?? list.find((r) => r.name);
    const seasons: number[] = [];
    const forms = list.map((r) => {
      const entry = formsEntryOf(r);
      if (entry.season != null && !seasons.includes(entry.season)) seasons.push(entry.season);
      return entry;
    });
    out.push({
      key,
      name: named?.name ?? '',
      refereeId: list.find((r) => r.refereeId)?.refereeId ?? '',
      seasons: seasons.sort((a, b) => b - a),
      forms,
    });
  }
  out.sort((a, b) => surnameFirst(a.name).localeCompare(surnameFirst(b.name), 'de'));
  return out;
}

/** "Nachname Vorname" for ordering — the last word is taken as the surname,
 *  which is what the app's coachee lists do for a bare full_name too. */
function surnameFirst(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(' ');
  return `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`;
}
