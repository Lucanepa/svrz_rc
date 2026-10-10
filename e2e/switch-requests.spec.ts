import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { handedOverIds, pickSwitch, switchExpiry, switchOpen, switchSettlement, type SlotBooking } from '../server/switchRequests';

// A coach asking another to hand a coachee over to an EARLIER game (asked
// 2026-10-10). The rules a request lives by; the endpoints around them need
// PocketBase and are pinned by their shape below.

test.describe('when a request lapses', () => {
  const now = '2026-10-10T10:00:00.000Z';

  test('two days to answer, when the game is further out than that', () => {
    expect(switchExpiry(now, '2026-10-20T18:00:00.000Z')).toBe('2026-10-12T10:00:00.000Z');
  });

  test('three hours before the earlier game, when that comes first', () => {
    expect(switchExpiry(now, '2026-10-11T18:00:00.000Z')).toBe('2026-10-11T15:00:00.000Z');
  });

  test('not at all, when less than half an hour would be left to answer', () => {
    expect(switchExpiry(now, '2026-10-10T13:20:00.000Z')).toBeNull();
    expect(switchExpiry(now, '2026-10-10T13:30:00.000Z')).toBe('2026-10-10T10:30:00.000Z');
    expect(switchExpiry(now, 'not a date')).toBeNull();
  });

  test('open means pending and not past its expiry', () => {
    expect(switchOpen({ status: 'pending', expires_at: '2026-10-11T10:00:00.000Z' }, now)).toBe(true);
    expect(switchOpen({ status: 'pending', expires_at: '2026-10-10T09:59:00.000Z' }, now)).toBe(false);
    expect(switchOpen({ status: 'accepted', expires_at: '2026-10-11T10:00:00.000Z' }, now)).toBe(false);
  });
});

test.describe('which coachee a request is about', () => {
  const me = { id: 'rcB', name: 'Bea Bittsteller' };
  const booking = (date: string, rcId = 'rcA', rc = 'Anna Halter') => ({ gameId: 'g2', matchNo: '400002', date, rc, rcId });
  const slot = (coacheeId: string, b: SlotBooking['booking']): SlotBooking => ({ coacheeId, name: `Coachee ${coacheeId}`, booking: b });
  const earlier = '2026-10-17T15:00:00.000Z';

  test("the coachee booked by another coach on a LATER game", () => {
    const pick = pickSwitch({ gameDate: earlier, slots: [slot('x', booking('2026-11-07T15:00:00.000Z'))], requester: me });
    expect(pick).toEqual({ ok: true, reason: '', coacheeId: 'x', name: 'Coachee x', booking: booking('2026-11-07T15:00:00.000Z') });
  });

  test('with two coachees booked, the one whose booking is later', () => {
    const pick = pickSwitch({
      gameDate: earlier,
      slots: [slot('x', booking('2026-10-12T15:00:00.000Z')), slot('y', booking('2026-11-07T15:00:00.000Z', 'rcC', 'Carl'))],
      requester: me,
    });
    expect(pick.coacheeId).toBe('y');
    expect(pick.booking?.rc).toBe('Carl');
  });

  test('a game with a free coachee needs no switch: it can be taken', () => {
    expect(pickSwitch({ gameDate: earlier, slots: [slot('x', null), slot('y', booking('2026-11-07T15:00:00.000Z'))], requester: me }).reason).toBe('free');
  });

  test('nobody to observe, the asker\'s own booking, or a game that is not earlier: no request', () => {
    expect(pickSwitch({ gameDate: earlier, slots: [], requester: me }).reason).toBe('no-coachee');
    expect(pickSwitch({ gameDate: earlier, slots: [slot('x', booking('2026-11-07T15:00:00.000Z', 'rcB', 'Bea Bittsteller'))], requester: me }).reason).toBe('own');
    expect(pickSwitch({ gameDate: earlier, slots: [slot('x', booking('2026-10-12T15:00:00.000Z'))], requester: me }).reason).toBe('not-earlier');
    expect(pickSwitch({ gameDate: earlier, slots: [slot('x', booking(earlier))], requester: me }).reason).toBe('not-earlier');
  });
});

test.describe('what accepting does to the later game', () => {
  test('released when the coachee was the only one left to observe; kept for the other one otherwise', () => {
    expect(switchSettlement(0)).toBe('release');
    expect(switchSettlement(1)).toBe('hand-over');
  });

  test('a handed-over coachee is read off the stored column, and a column that is not a list hands over nobody', () => {
    expect([...handedOverIds({ handed_over: [{ coacheeId: 'x', toGameId: 'g1' }, { coacheeId: '' }] })]).toEqual(['x']);
    expect(handedOverIds({ handed_over: null }).size).toBe(0);
    expect(handedOverIds({}).size).toBe(0);
  });
});

test('every reader of an open booking leaves a handed-over coachee out', () => {
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const planning = readFileSync(new URL('../server/planning.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // The one-open-booking rule, the release rule, the change mail's sides.
  expect(server).toMatch(/async function coacheeBookingsOn[\s\S]*?handedOverIds\(g\)/);
  expect(server).toMatch(/function openCoacheesOn[\s\S]*?handedOverIds\(game\)/);
  expect(server).toMatch(/function heldSideOf[\s\S]*?handedOverIds\(game\)/);
  // The coach's own list and the games list carry it; the chair's board skips it.
  expect(server).toMatch(/handedOver: \[\.\.\.handedOverIds\(game\)\]/);
  expect(planning).toMatch(/!\(g\.handedOver \?\? \[\]\)\.includes\(s\.coacheeId\)/);
  expect(app).toMatch(/\(g\.handedOver \?\? \[\]\)\.includes\(key\)/);
});

test('accepting re-checks everything under both games\' locks, in a fixed order', () => {
  const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const fn = server.slice(server.indexOf("app.post('/api/switch-requests/:id/:action'"), server.indexOf('async function sweepSwitchRequests'));
  expect(fn).toMatch(/const \[lockA, lockB\] = \[toId, fromId\]\.sort\(\)/);
  expect(fn).toMatch(/withGameLock\(lockA, \(\) => withGameLock\(lockB,[\s\S]*?switchBlocker\(r, g1, g2/);
});
