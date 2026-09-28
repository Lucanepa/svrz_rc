import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Orderings in the server's auth code that are easy to undo by accident and
 * invisible when undone — each one was a finding of the 2026-09 audit.
 *
 * Reading the source rather than running the server is the trade
 * redirects-config.spec.ts and attach-docs.spec.ts make: it cannot prove the
 * behaviour, but it proves the code still says what the fix said, and a quiet
 * revert is exactly how each of these would come back.
 */

const SERVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.ts'), 'utf8');

/** The source from `start` up to the next top-level `app.` route or function. */
function block(start: string): string {
  const at = SERVER.indexOf(start);
  expect(at, `${start} not found in server/index.ts`).toBeGreaterThan(-1);
  const rest = SERVER.slice(at + start.length);
  const end = rest.search(/\n(app\.(get|post|put|delete|use)\(|async function |function )/);
  return start + (end === -1 ? rest : rest.slice(0, end));
}

test('the credential 2FA code never reaches the activity log, and the console switch cannot print it', () => {
  const fn = block('async function sendCredentialCodeEmail(');
  // The admin-writable test_mode setting is what isEmailTestMode() reads.
  expect(fn).not.toContain('await isEmailTestMode()');
  expect(fn).toContain('if (TEST_MODE)');
  // captureConsole() files every console.* line in the log admins read.
  expect(fn).not.toMatch(/console\.(log|info|warn|error|debug)\(/);
  expect(fn).toContain('printUnlogged(');
});

test("the chair's 2FA code never falls back to the operators' mailbox", () => {
  const fn = block('function credential2faRecipient(');
  expect(fn).toMatch(/if \(slot === 'president'\) return perSlot;/);
});

test('the admin console login charges its budget before it awaits the credential check', () => {
  const fn = block("app.post('/api/admin/ui-login'");
  const charge = fn.indexOf("checkGateRateLimit(ctx.ip, 'admin-ui')");
  const firstAwait = fn.indexOf('await verifyCredential(');
  expect(charge).toBeGreaterThan(-1);
  expect(charge).toBeLessThan(firstAwait);
  // A success is refunded, so an honest sign-in never spends the allowance.
  expect(fn).toContain("refundGateRateLimit(ctx.ip, 'admin-ui')");
  expect(fn).not.toContain('peekGateRateLimit');
});

test('the team-login backstop only closes on addresses that have already failed', () => {
  const fn = block("app.post('/api/auth/shared/login'");
  expect(fn).toMatch(/if \(!globalRl\.allowed && failedHere\)/);
  expect(fn).toContain('checkRateLimit(sharedLoginIpFailures, ctx.ip');
});

test('the log-reader budget is checked before the token is compared', () => {
  const fn = block('function requireLogReader(');
  const peek = fn.indexOf('peekRateLimit(logReadRl');
  const compare = fn.indexOf('logTokenMatches(token)');
  expect(peek).toBeGreaterThan(-1);
  expect(peek).toBeLessThan(compare);
  expect(fn).toMatch(/budget\.allowed && logTokenMatches\(token\)/);
});

test('settings.changed is published after the last setting is saved', () => {
  const fn = block("app.put('/api/admin/settings'");
  const publish = fn.indexOf("publishLive({ type: 'settings.changed'");
  const lastSave = fn.lastIndexOf('await setSetting(');
  expect(publish).toBeGreaterThan(lastSave);
});

test('GET /api/ical/me changes nothing; rotation and the SR switch are JSON POSTs', () => {
  const get = block("app.get('/api/ical/me'");
  expect(get).toContain('answerIcalMe(req, res, { rotate: false })');
  const post = block("app.post('/api/ical/me'");
  expect(post).toContain("req.is('application/json')");
  // The handler reads its change from the argument, never the query string.
  const answer = block('async function answerIcalMe(');
  expect(answer).not.toMatch(/req\.query\.(rotate|sr)/);
});

test('identify carries the login time over instead of minting a fresh lease', () => {
  const fn = block("app.post('/api/auth/rc/identify'");
  expect(fn).toContain('loginAt: session.loginAt');
});
