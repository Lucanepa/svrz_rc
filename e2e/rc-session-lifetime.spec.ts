import { test, expect } from '@playwright/test';
import { judgeRcSession, rcSessionTimes, RC_TTL_MS, RC_MAX_SESSION_MS } from '../server/rcSession';

/**
 * How long an app session lives, and what ends it early.
 *
 * Picking a name (/api/auth/rc/identify) re-mints the session token. It used to
 * mint a fresh 30 days every time, so a holder who re-identified once a month
 * kept a session forever — through every rotation of the team password, which
 * is the one thing that was supposed to take a leaked password's users back
 * out. Now the login time rides every re-mint, the session ends 90 days after
 * it, and a rotation kills every session opened before it.
 *
 * What must NOT happen is a mass logout on deploy: tokens from before this
 * carry no `iat` and have to keep working to their own expiry. Phones already
 * lose their sign-in far too often (see the phone re-login diagnosis).
 *
 * No browser needed — the vm-lock / sw-reload-guard idiom.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

test('a fresh login gets 30 sliding days and records when it happened', () => {
  const { iat, exp } = rcSessionTimes(NOW);
  expect(iat).toBe(NOW);
  expect(exp).toBe(NOW + RC_TTL_MS);
  expect(judgeRcSession({ purpose: 'rc', rcId: 'rc1', iat, exp }, NOW, 0)).toEqual({ ok: true, rcId: 'rc1', loginAt: NOW });
});

test('re-identifying keeps the login time, so the session cannot slide past 90 days', () => {
  const login = NOW - 80 * DAY;
  const { iat, exp } = rcSessionTimes(NOW, login);
  expect(iat).toBe(login);
  // Ten days left on the cap, not thirty.
  expect(exp).toBe(login + RC_MAX_SESSION_MS);
  expect(exp - NOW).toBe(10 * DAY);
});

test('a session is dead once 90 days have passed since the login, whatever its exp says', () => {
  const login = NOW - RC_MAX_SESSION_MS - 1;
  // A forged-looking but correctly signed body with a far exp still dies on iat.
  expect(judgeRcSession({ purpose: 'rc', rcId: 'rc1', iat: login, exp: NOW + 20 * DAY }, NOW, 0).ok).toBe(false);
  expect(judgeRcSession({ purpose: 'rc', rcId: 'rc1', iat: NOW - 89 * DAY, exp: NOW + DAY }, NOW, 0).ok).toBe(true);
});

test('an expired token is dead', () => {
  expect(judgeRcSession({ purpose: 'rc', rcId: 'rc1', iat: NOW - 40 * DAY, exp: NOW - 1 }, NOW, 0).ok).toBe(false);
});

test('rotating the team password kills every session opened before it', () => {
  const rotatedAt = NOW - 2 * DAY;
  const before = { purpose: 'rc', rcId: 'rc1', iat: rotatedAt - 1, exp: NOW + 20 * DAY };
  const after = { purpose: 'rc', rcId: 'rc1', iat: rotatedAt + 1, exp: NOW + 28 * DAY };
  expect(judgeRcSession(before, NOW, rotatedAt).ok).toBe(false);
  expect(judgeRcSession(after, NOW, rotatedAt).ok).toBe(true);
});

test('a token from before this change keeps working to its own exp — no logout on deploy', () => {
  // Minted 5 days ago by the old code: exp only, no iat.
  const legacy = { purpose: 'rc', rcId: 'rc1', exp: NOW - 5 * DAY + RC_TTL_MS };
  // The live team password was last set well before it was minted.
  const claims = judgeRcSession(legacy, NOW, NOW - 30 * DAY);
  expect(claims.ok).toBe(true);
  // Its login is taken as its mint time, the latest it can have been…
  expect(claims.loginAt).toBe(NOW - 5 * DAY);
  // …so re-identifying caps it 90 days from then, not from now.
  expect(rcSessionTimes(NOW, claims.loginAt).exp).toBe(NOW + RC_TTL_MS);
  expect(rcSessionTimes(NOW + 80 * DAY, claims.loginAt).exp).toBe(NOW - 5 * DAY + RC_MAX_SESSION_MS);
});

test('a token from before this change still dies with the next rotation', () => {
  const legacy = { purpose: 'rc', rcId: 'rc1', exp: NOW - 5 * DAY + RC_TTL_MS };
  expect(judgeRcSession(legacy, NOW, NOW - DAY).ok).toBe(false);
});

test('an unknown generation (PocketBase not read yet) does not sign anybody out', () => {
  expect(judgeRcSession({ purpose: 'rc', rcId: '', iat: NOW - DAY, exp: NOW + DAY }, NOW, 0))
    .toEqual({ ok: true, rcId: '', loginAt: NOW - DAY });
});

test('only a session token is a session token', () => {
  expect(judgeRcSession({ purpose: 'admin', rcId: 'rc1', iat: NOW, exp: NOW + DAY }, NOW, 0).ok).toBe(false);
  expect(judgeRcSession({ rcId: 'rc1', iat: NOW, exp: NOW + DAY }, NOW, 0).ok).toBe(false);
});

test('a login time from the future is not honoured when re-minting', () => {
  expect(rcSessionTimes(NOW, NOW + DAY).iat).toBe(NOW);
});
