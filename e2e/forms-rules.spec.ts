import { test, expect } from '@playwright/test';
import { personKey, formsRowOf, formsEntryName, formsFileKind, groupForms } from '../server/forms';

// The sorting rules of Admin → Formulare on their own, without a database:
// which filed forms belong to the same referee, what a folder is called, how
// a form is named on disk.

type Rec = Record<string, unknown> & { id: string };

function filed(over: Partial<{
  id: string; role: string; rc: string; submitted: string; file: string;
  game: Record<string, unknown> | null; coachee: Record<string, unknown> | null; meta: Record<string, unknown>;
}> = {}): Rec {
  const game = over.game === null ? undefined : {
    id: 'g1', match_no: '2345678', league: '3L', match_date: '2026-03-14 19:30:00.000Z',
    home_team: 'A', away_team: 'B', first_referee: 'Hans Muster', second_referee: 'Petra Beispiel',
    first_referee_id: '', second_referee_id: '',
    ...(over.game ?? {}),
  };
  const coachee = over.coachee === null ? undefined : { id: 'c1', full_name: 'Hans Muster', referee_id: '', season: 2025, ...(over.coachee ?? {}) };
  return {
    id: over.id ?? 'fb1',
    role_assessed: over.role ?? '1. SR',
    rc_name: over.rc ?? 'Anna Coach',
    submitted_at: over.submitted ?? '2026-03-15T10:00:00Z',
    pdf_file: over.file ?? 'feedback_abc.pdf',
    feedback_json: { meta: { srName: 'Hans Muster', ...(over.meta ?? {}) } },
    expand: { game, coachee },
  };
}

test('a person is the same person whichever way round the sheet writes them', () => {
  expect(personKey('Hans Muster')).toBe(personKey('Muster Hans'));
  expect(personKey('Müller  Hans')).toBe(personKey('hans muller'));
  expect(personKey('Hans Muster')).not.toBe(personKey('Hans Master'));
  expect(personKey('')).toBe('');
});

test('a form is about the coachee row first, the game slot second, the typed name last', () => {
  // The roster's spelling wins.
  expect(formsRowOf(filed({ coachee: { full_name: 'Muster Hans' } })).name).toBe('Muster Hans');
  // A test game filed against the register has no coachee: the game's slot for the ROLE.
  expect(formsRowOf(filed({ coachee: null })).name).toBe('Hans Muster');
  expect(formsRowOf(filed({ coachee: null, role: '2. SR' })).name).toBe('Petra Beispiel');
  // Nothing but what the coach typed.
  expect(formsRowOf(filed({ coachee: null, game: null, meta: { srName: 'Typed Name' } })).name).toBe('Typed Name');
  // The SV-Nr. comes from the coachee row, else from the game's slot.
  expect(formsRowOf(filed({ coachee: { referee_id: '4711' } })).refereeId).toBe('4711');
  expect(formsRowOf(filed({ coachee: null, game: { first_referee_id: '4712' } })).refereeId).toBe('4712');
  expect(formsRowOf(filed({ coachee: null, role: '2. SR', game: { second_referee_id: '4713' } })).refereeId).toBe('4713');
});

test('a form is named by date, person, role and match — and keeps the stored kind', () => {
  expect(formsEntryName(formsRowOf(filed()))).toBe('2026-03-14_Hans-Muster_1SR_2345678.pdf');
  expect(formsEntryName(formsRowOf(filed({ role: '2. SR', coachee: { full_name: 'Zoë Müller-Lüthi' } })))).toBe('2026-03-14_Zoe-Muller-Luthi_2SR_2345678.pdf');
  // A manual upload is a photo of a paper form and stays one.
  expect(formsEntryName(formsRowOf(filed({ file: 'scan_x.jpg' })))).toBe('2026-03-14_Hans-Muster_1SR_2345678.jpg');
  expect(formsEntryName(formsRowOf(filed({ game: null })))).toBe('ohne-datum_Hans-Muster_1SR_unbenannt.pdf');
  expect(formsFileKind('feedback_abc.pdf')).toBe('pdf');
  expect(formsFileKind('scan.JPG')).toBe('image');
  expect(formsFileKind('')).toBe('');
});

test('one folder per referee across seasons, whichever coach filed and however the rows spell them', () => {
  const rows = [
    // Season 2025: coachee row with an SV-Nr.
    filed({ id: 'a', coachee: { id: 'c25', full_name: 'Hans Muster', referee_id: '4711', season: 2025 } }),
    // Season 2026: a new coachee row, reversed name, NOT yet linked to the register.
    filed({ id: 'b', rc: 'Beat Coach', coachee: { id: 'c26', full_name: 'Muster Hans', referee_id: '', season: 2026 }, game: { match_date: '2026-10-03 19:30:00.000Z', match_no: '999' } }),
    // Same person again, second referee, filed by a third coach.
    filed({ id: 'c', role: '2. SR', rc: 'Cora Coach', coachee: { id: 'c26', full_name: 'Muster Hans', referee_id: '', season: 2026 }, game: { match_date: '2026-11-20 19:30:00.000Z', match_no: '1000', second_referee: 'Muster Hans' } }),
    // Somebody else.
    filed({ id: 'd', coachee: { id: 'c2', full_name: 'Petra Beispiel', referee_id: '', season: 2026 }, game: { match_date: '2026-10-10 19:30:00.000Z' } }),
    // A test game filed against the register: no coachee at all.
    filed({ id: 'e', coachee: null, game: { first_referee: 'Zoë Test', first_referee_id: '9000', match_date: '2026-09-01 19:30:00.000Z' } }),
  ].map(formsRowOf);

  const folders = groupForms(rows);
  expect(folders.map((f) => f.name)).toEqual(['Petra Beispiel', 'Muster Hans', 'Zoë Test']);

  const hans = folders.find((f) => f.key === 'sv:4711')!;
  // The SV-Nr. of the linked season is lent to the unlinked one, so the key is the person.
  expect(hans.key).toBe('sv:4711');
  expect(hans.refereeId).toBe('4711');
  expect(hans.seasons).toEqual([2026, 2025]);
  // Newest first, and every coach's form is in it.
  expect(hans.forms.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  expect(hans.forms.map((f) => f.rc)).toEqual(['Cora Coach', 'Beat Coach', 'Anna Coach']);
  expect(hans.forms[0]).toMatchObject({ role: '2. SR', date: '2026-11-20', season: 2026, matchNo: '1000', file: 'pdf', filename: '2026-11-20_Muster-Hans_2SR_1000.pdf' });
  // The newest roster row names the folder, however the older ones spelt it.
  expect(hans.name).toBe('Muster Hans');

  const petra = folders.find((f) => f.name === 'Petra Beispiel')!;
  expect(petra.key).toBe('name:beispiel petra');
  expect(petra.refereeId).toBe('');

  const zoe = folders.find((f) => f.name === 'Zoë Test')!;
  expect(zoe.key).toBe('sv:9000');
  expect(zoe.forms).toHaveLength(1);
});

test('a record without a stored file is listed, so the gap shows instead of vanishing', () => {
  const [folder] = groupForms([formsRowOf(filed({ file: '' }))]);
  expect(folder.forms[0].file).toBe('');
  expect(folder.forms[0].filename).toBe('2026-03-14_Hans-Muster_1SR_2345678.pdf');
});

test('a nameless record gets a folder of its own rather than a shared "unnamed" one', () => {
  const rows = [
    filed({ id: 'x', coachee: null, game: { first_referee: '' }, meta: { srName: '' } }),
    filed({ id: 'y', coachee: null, game: { first_referee: '' }, meta: { srName: '' } }),
  ].map(formsRowOf);
  const folders = groupForms(rows);
  expect(folders).toHaveLength(2);
  expect(folders.map((f) => f.key).sort()).toEqual(['name:x', 'name:y']);
});
