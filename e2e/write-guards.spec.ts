import { test, expect } from '@playwright/test';
import { sniffAttachmentType, ATTACHMENT_EXTENSIONS, whistleBlocksForm, createMailCooldown, createCoalescer } from '../server/writeGuards';
import { refereeSet } from '../src/lib/identity';

// The small rules the write routes lean on, without a PocketBase or an SMTP
// server: which uploaded bytes may be filed, when 4.4.10 closes the form for
// the coach who whistled, and how the mails from the association's address are
// throttled (server/writeGuards.ts).

const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(8)]);

test('a phone photo in any HEIF or AVIF brand is a filable image, anything unknown is not', () => {
  expect(sniffAttachmentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
  expect(sniffAttachmentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) expect(sniffAttachmentType(ftyp(brand))).toBe('image/heic');
  expect(sniffAttachmentType(ftyp('avif'))).toBe('image/avif');
  // An MP4 is ISO-BMFF too, and is still not a report.
  expect(sniffAttachmentType(ftyp('isom'))).toBe('application/octet-stream');
  expect(sniffAttachmentType(Buffer.from('BM\0\0\0\0'))).toBe('application/octet-stream');
  // Every type the sniffer can name has an extension, so a sniffed file is
  // never filed under the caller's name.
  expect(Object.keys(ATTACHMENT_EXTENSIONS)).toContain('image/avif');
  expect('application/octet-stream' in ATTACHMENT_EXTENSIONS).toBe(false);
});

test.describe('4.4.10: the coach on the whistle files no form on the referee beside them', () => {
  const coach = refereeSet([{ svNumber: '9001', names: ['Carla Coach', 'Carla Muster'] }]);
  const coachees = new Set(['Ref One']);
  const isCoachee = (slot: { name?: unknown; sv?: unknown }) => coachees.has(String(slot.name));

  test('refused for the coachee on the other slot, whether matched by number or by name', () => {
    const byName: [{ name: string; sv: string }, { name: string; sv: string }] = [{ name: 'Carla Coach', sv: '' }, { name: 'Ref One', sv: '' }];
    expect(whistleBlocksForm('2. SR', byName, coach, isCoachee)).toBe(true);
    // An alias, and the SV number with a different spelling, are the same coach.
    expect(whistleBlocksForm('1. SR', [{ name: 'Ref One', sv: '' }, { name: 'Carla Muster', sv: '' }], coach, isCoachee)).toBe(true);
    expect(whistleBlocksForm('1. SR', [{ name: 'Ref One', sv: '' }, { name: 'C. Coach-Neu', sv: '9001' }], coach, isCoachee)).toBe(true);
  });

  test('a colleague in the stand, or a slot without a coachee, is untouched', () => {
    // Nobody from this coach on the whistle.
    expect(whistleBlocksForm('1. SR', [{ name: 'Ref One', sv: '' }, { name: 'Someone Else', sv: '' }], coach, isCoachee)).toBe(false);
    // The coach whistled, but the other referee is nobody's coachee — there
    // is no Rückmeldung owed, and nothing to refuse (the submit's other
    // guards decide).
    expect(whistleBlocksForm('2. SR', [{ name: 'Carla Coach', sv: '' }, { name: 'Not Listed', sv: '' }], coach, isCoachee)).toBe(false);
    // A session with no identity at all is never refused by this rule.
    expect(whistleBlocksForm('2. SR', [{ name: 'Carla Coach', sv: '' }, { name: 'Ref One', sv: '' }], refereeSet([]), isCoachee)).toBe(false);
  });
});

test('a mail cooldown holds a key for its window and forgets a released reservation', () => {
  let now = 1_000;
  const cd = createMailCooldown(60_000, () => now);
  expect(cd.left('g1|rc1')).toBe(0);
  cd.mark('g1|rc1');
  now += 10_000;
  expect(cd.left('g1|rc1')).toBe(50_000);
  // Another game, another coach: separate keys.
  expect(cd.left('g2|rc1')).toBe(0);
  expect(cd.left('g1|rc2')).toBe(0);
  now += 50_000;
  expect(cd.left('g1|rc1')).toBe(0);
  cd.mark('g1|rc1');
  cd.clear('g1|rc1');
  expect(cd.left('g1|rc1')).toBe(0);
});

test('rewrite mails coalesce: one per window, the latest version, nothing unchanged', () => {
  let now = 0;
  const sent: string[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const c = createCoalescer<{ note: string }>({
    cooldownMs: 600_000,
    send: (p) => sent.push(p.note),
    same: (a, b) => a.note === b.note,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
  });
  const runTimers = () => { for (const t of timers.splice(0)) { now = Math.max(now, t.at); t.fn(); } };

  expect(c.offer('n1', { note: 'a' })).toBe('sent');
  // A loop of alternating rewrites inside the window sends nothing now…
  now += 1_000;
  expect(c.offer('n1', { note: 'b' })).toBe('queued');
  expect(c.offer('n1', { note: 'a' })).toBe('queued');
  expect(c.offer('n1', { note: 'c' })).toBe('queued');
  expect(sent).toEqual(['a']);
  // …and exactly the latest version at the end of it.
  runTimers();
  expect(sent).toEqual(['a', 'c']);
  expect(timers).toHaveLength(0);

  // Back to what the last mail said, inside the next window: nothing to send.
  now += 1_000;
  c.offer('n1', { note: 'x' });
  c.offer('n1', { note: 'c' });
  runTimers();
  expect(sent).toEqual(['a', 'c']);

  // After the window, an unchanged resend (a dropped connection) is not mailed.
  now += 700_000;
  expect(c.offer('n1', { note: 'c' })).toBe('unchanged');
  // Other notes are not held up by this one.
  expect(c.offer('n2', { note: 'z' })).toBe('sent');
  expect(sent).toEqual(['a', 'c', 'z']);
});
