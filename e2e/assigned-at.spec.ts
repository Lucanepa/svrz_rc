import { test, expect } from '@playwright/test';
import { latestTakes, type LogLine } from '../server/assignedAt';

/**
 * When a held game was taken, read back from the request log for the games
 * held since before `assigned_at` existed. A req.in line carries the body,
 * the req.out line under the same reqId carries the status.
 */
const call = (reqId: string, t: string, gameId: string, body: Record<string, unknown>, status = 200): LogLine[] => [
  { t, evt: 'req.in', reqId, data: { method: 'PUT', path: `/api/games/${gameId}/assign-rc`, body } },
  { t, evt: 'req.out', reqId, data: { method: 'PUT', path: `/api/games/${gameId}/assign-rc`, status } },
];

test('the latest successful take is the moment', () => {
  const takes = latestTakes([
    ...call('a', '2026-09-20T10:00:00.000Z', 'g1', { assignedRc: 'Anna', assignedRcId: 'r1' }),
    ...call('b', '2026-09-21T10:00:00.000Z', 'g1', { assignedRc: '', assignedRcId: '' }),
    ...call('c', '2026-09-22T10:00:00.000Z', 'g1', { assignedRc: 'Beat', assignedRcId: 'r2' }),
  ]);
  expect(takes.get('g1')).toBe('2026-09-22T10:00:00.000Z');
});

test('a refused take does not count, and a game last given back has no moment', () => {
  const takes = latestTakes([
    ...call('a', '2026-09-20T10:00:00.000Z', 'g1', { assignedRc: 'Anna' }),
    ...call('b', '2026-10-01T10:00:00.000Z', 'g1', { assignedRc: 'Beat' }, 409),
    ...call('c', '2026-09-20T10:00:00.000Z', 'g2', { assignedRc: 'Anna' }),
    ...call('d', '2026-09-25T10:00:00.000Z', 'g2', { assignedRc: '' }),
  ]);
  expect(takes.get('g1')).toBe('2026-09-20T10:00:00.000Z');
  expect(takes.has('g2')).toBe(false);
});

test('a status line without its body line is not guessed at', () => {
  const [, out] = call('a', '2026-09-20T10:00:00.000Z', 'g1', { assignedRc: 'Anna' });
  expect(latestTakes([out]).size).toBe(0);
});
