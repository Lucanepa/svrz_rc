import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialReader, CredentialsUnavailableError, sameLoginName } from '../server/credentialStore';

/**
 * 22.10.2026 (log audit, R3): one unreadable credentials row used to be cached
 * as "nothing set in the console" for a minute — and a slot with nothing set
 * falls back to the container's env password. So during a database hiccup the
 * old bootstrap passwords opened the app and the console, and the ones set in
 * the console were refused.
 *
 * The store here is a stub whose read can be made to throw; no `page` fixture,
 * so these run in milliseconds.
 */

type Creds = Record<string, { username: string }>;

function stubStore(initial: Creds | null) {
  let row: Creds | null = initial;
  let failing = false;
  let reads = 0;
  let clock = 1_000_000;
  const errors: Array<{ servedLastGood: boolean }> = [];
  const reader = createCredentialReader<Creds>({
    load: async () => {
      reads += 1;
      if (failing) throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      return row ?? {};
    },
    ttlMs: 60_000,
    now: () => clock,
    onError: (_e, servedLastGood) => errors.push({ servedLastGood }),
  });
  return {
    reader,
    errors,
    get reads() { return reads; },
    fail(on: boolean) { failing = on; },
    set(next: Creds) { row = next; },
    advance(ms: number) { clock += ms; },
  };
}

const STORED: Creds = { shared: { username: 'Referee-Coaching' } };

test('a missing row is a successful empty read — first-run setup still uses the env bootstrap', async () => {
  const s = stubStore(null);
  expect(await s.reader.read()).toEqual({});
  // Cached like any other answer.
  expect(await s.reader.read()).toEqual({});
  expect(s.reads).toBe(1);
  expect(s.errors).toEqual([]);
});

test('a store that cannot be read on the first ask throws — never an empty map', async () => {
  const s = stubStore(STORED);
  s.fail(true);
  await expect(s.reader.read()).rejects.toBeInstanceOf(CredentialsUnavailableError);
  expect(s.errors).toEqual([{ servedLastGood: false }]);
});

test('a failed read is not cached: the next ask goes to the store again', async () => {
  const s = stubStore(STORED);
  s.fail(true);
  await expect(s.reader.read()).rejects.toBeInstanceOf(CredentialsUnavailableError);
  s.fail(false);
  // No time has passed — a cached failure would still be answering.
  expect(await s.reader.read()).toEqual(STORED);
  expect(s.reads).toBe(2);
});

test('once read, an outage answers with the last copy read, and asks again every time', async () => {
  const s = stubStore(STORED);
  expect(await s.reader.read()).toEqual(STORED);
  s.advance(61_000);
  s.fail(true);
  expect(await s.reader.read()).toEqual(STORED);
  expect(await s.reader.read()).toEqual(STORED);
  expect(s.reads).toBe(3);
  expect(s.errors).toEqual([{ servedLastGood: true }, { servedLastGood: true }]);
});

test('after a write, the fallback is what was written — never the password rotated away', async () => {
  const s = stubStore(STORED);
  await s.reader.read();
  const rotated: Creds = { shared: { username: 'Team-2027' } };
  s.set(rotated);
  s.reader.remember(rotated);
  s.fail(true);
  expect(await s.reader.read()).toEqual(rotated);
});

test('a read still in flight when the store is written does not put its older answer back', async () => {
  let release: () => void = () => {};
  let first = true;
  const reader = createCredentialReader<Creds>({
    load: () => (first
      ? (first = false, new Promise<Creds>((resolve) => { release = () => resolve(STORED); }))
      : Promise.reject(new Error('down'))),
    ttlMs: 60_000,
  });
  const inFlight = reader.read();
  const rotated: Creds = { shared: { username: 'Team-2027' } };
  reader.remember(rotated);
  release();
  expect(await inFlight).toEqual(STORED);
  // The store is down now; the fallback must be the write, not the stale read.
  expect(await reader.read()).toEqual(rotated);
});

// The wiring in server/index.ts, read as source — the auth-hardening.spec.ts
// trade: it cannot prove the behaviour, but a quiet revert is exactly how the
// fail-open would come back.
const SERVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'index.ts'), 'utf8');

function block(start: string): string {
  const at = SERVER.indexOf(start);
  expect(at, `${start} not found in server/index.ts`).toBeGreaterThan(-1);
  const rest = SERVER.slice(at + start.length);
  const end = rest.search(/\n(app\.(get|post|put|delete|use)\(|async function |function )/);
  return start + (end === -1 ? rest : rest.slice(0, end));
}

test('a failed read aborts a credential write instead of writing one slot over an empty map', () => {
  const fn = block('async function writeCredentials(');
  expect(fn).not.toMatch(/catch\s*\{\s*current\s*=\s*\{\}/);
  expect(fn).toContain('throw new CredentialsUnavailableError(error)');
});

test('both logins and the credential routes answer 503 when the store cannot be read', () => {
  for (const route of [
    "app.post('/api/admin/ui-login'",
    "app.post('/api/auth/shared/login'",
    "app.get('/api/admin/credentials'",
    "app.put('/api/admin/credentials'",
  ]) {
    const fn = block(route);
    expect(fn, route).toContain('instanceof CredentialsUnavailableError');
    expect(fn, route).toContain('answerCredentialsUnavailable(');
  }
  const answer = block('function answerCredentialsUnavailable(');
  expect(answer).toContain('res.status(503)');
  expect(answer).toContain("'Anmeldung vorübergehend nicht möglich.'");
  expect(answer).toContain('log.error(');
});

// 27.09–06.10.2026 (log audit, R4): the browser filled the app's team login
// into the admin console, and the chair failed eight times in 92 s against a
// bare "Invalid credentials.". The console now names the team login — by the
// NAME alone, the way a person types it.
test.describe('the team login typed into the admin console', () => {
  test('is recognised by its name, trimmed and in any case', () => {
    expect(sameLoginName('Referee-Coaching', 'Referee-Coaching')).toBe(true);
    expect(sameLoginName('  referee-coaching ', 'Referee-Coaching')).toBe(true);
    expect(sameLoginName('admin', 'Referee-Coaching')).toBe(false);
    // An unset name matches nothing, not every empty field.
    expect(sameLoginName('', '')).toBe(false);
    expect(sameLoginName('  ', ' ')).toBe(false);
  });

  test('is answered without the team password ever being checked, and still costs an attempt', () => {
    const fn = block("app.post('/api/admin/ui-login'");
    const named = fn.indexOf('sameLoginName(');
    expect(named).toBeGreaterThan(-1);
    // Inside the failure branch — after the charge, and never refunded there.
    expect(fn.indexOf("checkGateRateLimit(ctx.ip, 'admin-ui')")).toBeLessThan(named);
    expect(fn.indexOf('if (!role) {')).toBeLessThan(named);
    expect(fn).not.toContain("verifyCredential('shared'");
    expect(fn).toContain('Das ist der Team-Login der App. Hier braucht es den Admin-Zugang (admin bzw. praesidium).');
    const branch = fn.slice(named, fn.indexOf('return;', named));
    expect(branch).not.toContain('refundGateRateLimit');
    expect(branch).toContain('res.status(401)');
  });
});
