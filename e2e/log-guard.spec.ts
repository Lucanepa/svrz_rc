import { test, expect } from '@playwright/test';
import {
  redactCapabilityTokens, clientTimestamp, boundedKeys, clientLogUser,
  isUnverifiedEntry, digestAdmission, SHAPE_MAX_KEYS, SHAPE_MAX_KEY_CHARS,
} from '../server/logguard';

/**
 * The bounds that keep the activity log from being a way in. Two doors feed it
 * without a session — /api/client-logs and the request logger — and the log is
 * read by every admin, so what matters is: nothing anyone writes there can be
 * large, no capability token survives in it, and nobody can be filed under a
 * name their session does not carry.
 */

test.describe('capability tokens are stripped by value', () => {
  test('the iCal feed token in a webcal href', () => {
    const href = 'webcal://svrz-rc-api.openvolley.app/api/ical/abc123DEF456.ics?lang=de';
    expect(redactCapabilityTokens(href)).toBe('webcal://svrz-rc-api.openvolley.app/api/ical/<token>?lang=de');
  });

  test('survey and signature paths, as a 429 logs them', () => {
    expect(redactCapabilityTokens('/api/survey/0f9e8d7c6b5a')).toBe('/api/survey/<token>');
    expect(redactCapabilityTokens('POST /api/signature/aa11bb22cc33 → 429')).toBe('POST /api/signature/<token> → 429');
  });

  test('the app pages that carry the same tokens in the fragment', () => {
    expect(redactCapabilityTokens('https://svrz-rc.openvolley.app/#/sign/deadbeef')).toBe('https://svrz-rc.openvolley.app/#/sign/<token>');
    expect(redactCapabilityTokens('/#/survey/cafe01')).toBe('/#/survey/<token>');
  });

  test('routes that are not tokens are left alone', () => {
    expect(redactCapabilityTokens('/api/ical/me')).toBe('/api/ical/me');
    expect(redactCapabilityTokens('/api/signature/start')).toBe('/api/signature/start');
    expect(redactCapabilityTokens('/api/survey-responses?form=1')).toBe('/api/survey-responses?form=1');
    expect(redactCapabilityTokens('GET /api/games → 200')).toBe('GET /api/games → 200');
  });

  test('redacting twice reads the same as once', () => {
    const once = redactCapabilityTokens('/api/ical/xyz.ics');
    expect(redactCapabilityTokens(once)).toBe(once);
  });
});

test.describe('fields an anonymous caller writes are bounded', () => {
  test('a client timestamp is kept only when it is a short date', () => {
    expect(clientTimestamp('2026-09-28T10:00:00.000Z')).toBe('2026-09-28T10:00:00.000Z');
    expect(clientTimestamp('A'.repeat(250_000))).toBeUndefined();
    expect(clientTimestamp('not a date')).toBeUndefined();
    expect(clientTimestamp(12345)).toBeUndefined();
  });

  test('a body shape keeps a bounded list of clipped key names', () => {
    const keys = Array.from({ length: 60 }, (_, i) => `${i}-${'k'.repeat(2_000)}`);
    const shape = boundedKeys(keys);
    expect(shape.keys).toHaveLength(SHAPE_MAX_KEYS);
    expect(shape.more).toBe(60 - SHAPE_MAX_KEYS);
    for (const k of shape.keys) expect(k.length).toBeLessThanOrEqual(SHAPE_MAX_KEY_CHARS + 1);
    expect(boundedKeys(['formData', 'pdfBase64'])).toEqual({ keys: ['formData', 'pdfBase64'] });
  });
});

test.describe('who a client batch is filed under', () => {
  test('verified only when the session names that very person', () => {
    expect(clientLogUser('Anna Muster', { rcName: 'Anna Muster' })).toBe('Anna Muster');
    expect(clientLogUser('admin-ui', { consoleEmail: 'admin-ui' })).toBe('admin-ui');
  });

  test("another coach's cookie does not vouch for this name", () => {
    expect(clientLogUser('Anna Muster', { rcName: 'Beat Beispiel' })).toBe('unverified:Anna Muster');
  });

  test('a cookie that no longer resolves (deactivated coach) vouches for nobody', () => {
    expect(clientLogUser('Anna Muster', { rcName: null })).toBe('unverified:Anna Muster');
  });

  test('no claim, no user', () => {
    expect(clientLogUser('', { rcName: 'Anna Muster' })).toBeUndefined();
  });

  test('only client lines can be unverified', () => {
    expect(isUnverifiedEntry({ src: 'client', user: 'unverified:Anna' })).toBe(true);
    expect(isUnverifiedEntry({ src: 'client' })).toBe(true);
    expect(isUnverifiedEntry({ src: 'client', user: 'Anna' })).toBe(false);
    expect(isUnverifiedEntry({ src: 'server' })).toBe(false);
  });
});

test.describe('the error-alert digest cannot be filled by anonymous lines', () => {
  const limits = { maxGroups: 60, maxUnverifiedGroups: 5 };
  const pendingOf = (verified: number, unverified: number) => {
    const m = new Map<string, { unverified: boolean }>();
    for (let i = 0; i < unverified; i++) m.set(`u${i}`, { unverified: true });
    for (let i = 0; i < verified; i++) m.set(`v${i}`, { unverified: false });
    return m;
  };

  test('anonymous classes get their own small share', () => {
    expect(digestAdmission(pendingOf(0, 4), true, limits)).toEqual({ admit: true });
    expect(digestAdmission(pendingOf(0, 5), true, limits)).toEqual({ admit: false });
  });

  test('a server error still gets in when the digest is full, evicting an anonymous class', () => {
    expect(digestAdmission(pendingOf(55, 5), false, limits)).toEqual({ admit: true, evict: 'u0' });
  });

  test('a digest full of real errors stays full', () => {
    expect(digestAdmission(pendingOf(60, 0), false, limits)).toEqual({ admit: false });
  });
});
