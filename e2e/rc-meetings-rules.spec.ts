import { test, expect } from '@playwright/test';
import {
  normalizeTime, normalizeLink, sanitizeMeeting, parseMeetings, legacyMeeting,
  meetingsOfSeason, upcomingMeetings, attendedMeetings, publicMeeting,
} from '../server/rcMeetings';
import { planExpenseRows } from '../server/expenses';

// RC-Sitzungen on their own, without a database: what a meeting may hold, how
// the single meeting of before carries over, which are still ahead, and what
// lands on an expense sheet.

test('times and links are kept only when they are what they claim', () => {
  expect(normalizeTime('19:00')).toBe('19:00');
  expect(normalizeTime('9.5')).toBe('09:05');
  expect(normalizeTime('24:00')).toBe('');
  expect(normalizeTime('abends')).toBe('');
  expect(normalizeLink('https://teams.microsoft.com/l/meetup-join/abc')).toBe('https://teams.microsoft.com/l/meetup-join/abc');
  // A link is a button on every coach's Home: nothing but https gets through.
  expect(normalizeLink('javascript:alert(1)')).toBe('');
  expect(normalizeLink('http://example.com')).toBe('');
  expect(normalizeLink('teams')).toBe('');
});

test('a meeting needs a date; the rest falls back sensibly', () => {
  expect(sanitizeMeeting({ title: 'X' }, 'm1')).toBeNull();
  expect(sanitizeMeeting({ date: '2026-02-30' }, 'm1')).not.toBeNull(); // JS rolls it, still a day
  const m = sanitizeMeeting({ date: '2026-10-09', start: '19:00', end: '18:00', rate: -5, attended: ['a', 'a', 'b'] }, 'm1')!;
  expect(m).toMatchObject({ title: 'RC-Sitzung', start: '19:00', end: '', rate: 60, attended: ['a', 'b'] });
  expect(sanitizeMeeting({ date: '2026-10-09', end: '20:00' }, 'm1')!.end).toBe(''); // an end without a start
});

test('the stored list: null when never written, [] when emptied, sorted', () => {
  expect(parseMeetings(undefined)).toBeNull();
  expect(parseMeetings('nonsense')).toBeNull();
  expect(parseMeetings('[]')).toEqual([]);
  const list = parseMeetings(JSON.stringify([
    { id: 'b', date: '2027-03-01' }, { id: 'a', date: '2026-10-09', start: '19:00' }, { id: 'a', date: '2026-11-01' }, { date: '2026-12-01' },
  ]))!;
  expect(list.map((m) => m.id)).toEqual(['a', 'b']);
});

test('the single meeting of before carries over with its rate and its ticks', () => {
  const m = legacyMeeting({ meetingDate: '2026-10-09', meeting: 60 }, new Set(['rc1', 'rc2']))!;
  expect(m).toMatchObject({ id: 'legacy-2026-10-09', date: '2026-10-09', rate: 60, attended: ['rc1', 'rc2'], title: 'RC-Sitzung' });
  expect(legacyMeeting({ meetingDate: '' }, [])).toBeNull();
});

test('seasons cut in September, like the games', () => {
  const list = parseMeetings(JSON.stringify([
    { id: 'aug', date: '2026-08-31' }, { id: 'sep', date: '2026-09-01' }, { id: 'jun', date: '2027-06-15' },
  ]))!;
  expect(meetingsOfSeason(list, 2026).map((m) => m.id)).toEqual(['sep', 'jun']);
  expect(meetingsOfSeason(list, 2025).map((m) => m.id)).toEqual(['aug']);
});

test('a meeting stays on Home until it is over', () => {
  const list = parseMeetings(JSON.stringify([
    { id: 'past', date: '2026-10-08', start: '19:00' },
    { id: 'tonight', date: '2026-10-09', start: '19:00', end: '19:45' },
    { id: 'allday', date: '2026-10-09' },
    { id: 'later', date: '2026-11-20', start: '19:00' },
  ]))!;
  expect(upcomingMeetings(list, '2026-10-09', '18:00').map((m) => m.id)).toEqual(['allday', 'tonight', 'later']);
  expect(upcomingMeetings(list, '2026-10-09', '19:30').map((m) => m.id)).toEqual(['allday', 'tonight', 'later']);
  expect(upcomingMeetings(list, '2026-10-09', '19:45').map((m) => m.id)).toEqual(['allday', 'later']);
  // Without an end, an hour after the start.
  const open = parseMeetings(JSON.stringify([{ id: 'x', date: '2026-10-09', start: '19:00' }]))!;
  expect(upcomingMeetings(open, '2026-10-09', '19:59').length).toBe(1);
  expect(upcomingMeetings(open, '2026-10-09', '20:00').length).toBe(0);
});

test('a coach sees no rates and no attendance', () => {
  const m = sanitizeMeeting({ date: '2026-10-09', rate: 60, attended: ['rc1'], link: 'https://x.ch/a' }, 'm1')!;
  expect(publicMeeting(m)).toEqual({ id: 'm1', title: 'RC-Sitzung', date: '2026-10-09', start: '', end: '', link: 'https://x.ch/a', notes: '' });
});

test('every meeting attended in the season is a line on the sheet', () => {
  const list = parseMeetings(JSON.stringify([
    { id: 'a', date: '2026-10-09', rate: 60, attended: ['rc1', 'rc2'] },
    { id: 'b', date: '2027-03-12', title: 'Zwischensitzung', rate: 40, attended: ['rc1'] },
    { id: 'c', date: '2025-10-01', rate: 60, attended: ['rc1'] }, // last season
  ]))!;
  const lines = attendedMeetings(list, 2026, 'rc1');
  expect(lines).toEqual([
    { date: '2026-10-09', title: 'RC-Sitzung', rate: 60 },
    { date: '2027-03-12', title: 'Zwischensitzung', rate: 40 },
  ]);
  expect(attendedMeetings(list, 2026, 'rc2')).toHaveLength(1);
  const plan = planExpenseRows({ rcName: 'X', season: 2026, visits: [], visitRate: 60, paidCap: null, meetings: lines, issuedOn: new Date() });
  expect(plan.meetingTotal).toBe(100);
  expect(plan.grandTotal).toBe(100);
});
