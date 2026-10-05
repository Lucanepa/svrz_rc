import { test, expect } from '@playwright/test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  normalizeSvNumber, normalizePin, isWeakPin, mintPin, parsePinMap,
  signFileSession, verifyFileSession, sessionStillValid,
  formRefereeId, fileEntries, fileOwnerName,
} from '../server/coacheeFile';

// The coachee file (/dossier) on its own, without a database: who may read
// which report, what a PIN looks like, and that the session token cannot be
// confused with any other the server signs.

const SECRET = 'test-secret';
const sign = (data: string) => createHmac('sha256', SECRET).update(data).digest('base64url');
const equals = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Rec = Record<string, unknown> & { id: string };

function filed(over: Partial<{
  id: string; role: string; coachee: Record<string, unknown> | null; game: Record<string, unknown> | null;
  detached: Record<string, unknown>; goals: string; file: string;
}> = {}): Rec {
  const game = over.game === null ? undefined : {
    id: 'g1', match_no: '312456', league: '3L ♂', match_date: '2026-03-14 18:30:00.000Z',
    home_team: 'VBC A', away_team: 'VBC B', first_referee: 'Hans Muster', second_referee: 'Petra Beispiel',
    first_referee_id: '', second_referee_id: '',
    ...(over.game ?? {}),
  };
  const coachee = over.coachee === null ? undefined : { id: 'c1', full_name: 'Hans Muster', referee_id: '12345', ...(over.coachee ?? {}) };
  return {
    id: over.id ?? 'fb1',
    role_assessed: over.role ?? '1. SR',
    rc_name: 'Anna Coach',
    pdf_file: over.file ?? 'feedback_abc.pdf',
    game: game?.id ?? '',
    feedback_json: { results: { goals: over.goals ?? '' }, ...(over.detached ? { detached: over.detached } : {}) },
    expand: { game, coachee },
  };
}

const plain = (s: string) => s.replace(/<[^>]+>/g, '');

test.describe('input', () => {
  test('an SV-Nr. is digits, forgiving of spaces and dots', () => {
    expect(normalizeSvNumber(' 12 345 ')).toBe('12345');
    expect(normalizeSvNumber('12.345')).toBe('12345');
    expect(normalizeSvNumber('012345')).toBe('12345');
    expect(normalizeSvNumber('12a45')).toBe('');
    expect(normalizeSvNumber('12')).toBe('');
    expect(normalizeSvNumber(undefined)).toBe('');
  });

  test('a PIN is exactly six digits', () => {
    expect(normalizePin('482 913')).toBe('482913');
    expect(normalizePin('48291')).toBe('');
    expect(normalizePin('4829134')).toBe('');
    expect(normalizePin('48291a')).toBe('');
  });
});

test.describe('PINs', () => {
  test('the guesses an attacker tries first are never minted', () => {
    for (const weak of ['000000', '777777', '123456', '654321', '890123', '121212', '123123']) {
      expect(isWeakPin(weak), weak).toBe(true);
    }
    expect(isWeakPin('482913')).toBe(false);
    // A source that keeps offering weak ones is asked again.
    const offers = [123456, 111111, 482913];
    expect(mintPin(() => offers.shift()!)).toBe('482913');
    // Leading zeros are kept: it is a code, not a number.
    expect(mintPin(() => 4821)).toBe('004821');
  });

  test('the stored map keeps only well-formed entries', () => {
    const map = parsePinMap(JSON.stringify({
      '12345': { pin: '482913', gen: 2, createdAt: '2026-10-05T10:00:00Z' },
      '99999': { pin: '12', gen: 1 },
      'abc': { pin: '482913' },
      '55555': { pin: '582913' },
    }));
    expect(map).toEqual({
      '12345': { pin: '482913', gen: 2, createdAt: '2026-10-05T10:00:00Z' },
      '55555': { pin: '582913', gen: 1, createdAt: '' },
    });
    expect(parsePinMap('not json')).toEqual({});
    expect(parsePinMap(undefined)).toEqual({});
  });
});

test.describe('the session token', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  const token = signFileSession({ sv: '12345', gen: 2, exp: now + 60_000 }, sign);

  test('round-trips, and dies at expiry', () => {
    expect(verifyFileSession(token, sign, equals, now)).toEqual({ sv: '12345', gen: 2, exp: now + 60_000 });
    expect(verifyFileSession(token, sign, equals, now + 60_000)).toBeNull();
  });

  test('a tampered payload or a foreign signature is refused', () => {
    const [payload, sig] = token.split('.');
    const other = Buffer.from(JSON.stringify({ purpose: 'coachee-file', sv: '99999', gen: 2, exp: now + 60_000 })).toString('base64url');
    expect(verifyFileSession(`${other}.${sig}`, sign, equals, now)).toBeNull();
    expect(verifyFileSession(`${payload}.${sig}x`, sign, equals, now)).toBeNull();
    expect(verifyFileSession(`${payload}.${sig}.extra`, sign, equals, now)).toBeNull();
    expect(verifyFileSession('', sign, equals, now)).toBeNull();
  });

  test('cannot pass for another kind of session, nor another for it', () => {
    // An RC/console token signs the BARE payload; this one signs it behind its
    // purpose. A bare-signed payload — even one claiming this purpose — fails.
    const payload = Buffer.from(JSON.stringify({ purpose: 'coachee-file', sv: '12345', gen: 2, exp: now + 60_000 })).toString('base64url');
    expect(verifyFileSession(`${payload}.${sign(payload)}`, sign, equals, now)).toBeNull();
    // And a payload signed the right way but carrying the RC purpose fails too.
    const rc = Buffer.from(JSON.stringify({ purpose: 'rc', sv: '12345', gen: 2, exp: now + 60_000 })).toString('base64url');
    expect(verifyFileSession(`${rc}.${sign(`coachee-file.${rc}`)}`, sign, equals, now)).toBeNull();
    // Conversely, the token's signature is not the bare payload's.
    const [p, s] = token.split('.');
    expect(s).not.toBe(sign(p));
  });

  test('a replaced PIN ends the sessions opened with the old one', () => {
    const session = verifyFileSession(token, sign, equals, now)!;
    expect(sessionStillValid(session, { '12345': { pin: '482913', gen: 2, createdAt: '' } })).toBe(true);
    expect(sessionStillValid(session, { '12345': { pin: '582913', gen: 3, createdAt: '' } })).toBe(false);
    expect(sessionStillValid(session, {})).toBe(false);
  });
});

test.describe('which reports are whose', () => {
  test('a report is about the SV-Nr. on its own coachee row, else its game slot', () => {
    expect(formRefereeId(filed())).toBe('12345');
    expect(formRefereeId(filed({ coachee: null, game: { first_referee_id: '777' } }))).toBe('777');
    expect(formRefereeId(filed({ coachee: null, role: '2. SR', game: { first_referee_id: '777', second_referee_id: '888' } }))).toBe('888');
    // A coachee row deleted since: the copy kept on the form still says who.
    expect(formRefereeId(filed({ coachee: null, detached: { coachee: { referee_id: '4242', full_name: 'X' } } }))).toBe('4242');
  });

  test('a report without its own number is NOT lent one by name', () => {
    // The chair's folders lend an SV-Nr. across same-named forms; here that
    // would show one referee's assessment to a namesake. Strict on purpose.
    const records = [
      filed({ id: 'a' }),
      filed({ id: 'b', coachee: { referee_id: '' } }), // same name, no number
    ];
    expect(fileEntries(records, '12345', { toPlain: plain, manualGameIds: new Set() }).map((e) => e.id)).toEqual(['a']);
  });

  test('the list: own reports only, newest first, goals as plain text, test games marked', () => {
    const records = [
      filed({ id: 'old', game: { id: 'g0', match_date: '2025-11-02 18:00:00.000Z' }, goals: '<p>Pfiff <b>klarer</b></p>' }),
      filed({ id: 'new', game: { id: 'g9', match_date: '2026-03-14 18:30:00.000Z' }, role: '2. SR', coachee: { referee_id: '12345' } }),
      filed({ id: 'theirs', coachee: { referee_id: '55555', full_name: 'Petra Beispiel' } }),
      filed({ id: 'nofile', game: { id: 'g5', match_date: '2026-01-10 18:00:00.000Z' }, file: '' }),
    ];
    const list = fileEntries(records, '12345', { toPlain: plain, manualGameIds: new Set(['g9']) });
    expect(list.map((e) => e.id)).toEqual(['new', 'nofile', 'old']);
    expect(list[0]).toMatchObject({ role: '2. SR', date: '2026-03-14', isTest: true, matchNo: '312456' });
    expect(list[1].hasFile).toBe(false);
    expect(list[2]).toMatchObject({ goals: 'Pfiff klarer', isTest: false, rc: 'Anna Coach' });
    expect(fileEntries(records, 'nonsense', { toPlain: plain, manualGameIds: new Set() })).toEqual([]);
  });

  test('the greeting uses the newest roster spelling', () => {
    const records = [
      filed({ id: 'a', game: { match_date: '2025-11-02 18:00:00.000Z' }, coachee: { full_name: 'Hans Muster' } }),
      filed({ id: 'b', game: { match_date: '2026-03-14 18:00:00.000Z' }, coachee: { full_name: 'Hans Peter Muster' } }),
    ];
    expect(fileOwnerName(records, '12345')).toBe('Hans Peter Muster');
    expect(fileOwnerName(records, '99999')).toBe('');
  });
});
