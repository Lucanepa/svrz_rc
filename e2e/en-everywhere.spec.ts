import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { stubSignedInApp, GAME } from './support/app';
import { say, langOf, inLanguage, englishFor } from '../server/say';

// Everything the API says to a person, in their language (asked 2026-10-14: a
// coach reading the app in English got "Davide Carina hat schon eine geplante
// Beobachtung …" back from a refused take). The app sends its language as
// Accept-Language; each message is written in both languages where it is
// written (say()), and the response hook picks one.

test.describe('the language a request asks for', () => {
  test('the app\'s own values', () => {
    expect(langOf('en')).toBe('EN');
    expect(langOf('de')).toBe('DE');
  });
  test('a browser\'s list: the more wanted of German and English', () => {
    expect(langOf('en-GB,en;q=0.9,de;q=0.8')).toBe('EN');
    expect(langOf('de-CH,de;q=0.9,en;q=0.8')).toBe('DE');
    expect(langOf('fr-CH,fr;q=0.9,en;q=0.7')).toBe('EN');
    expect(langOf('fr-CH, de;q=0.5, en;q=0.6')).toBe('EN');
  });
  test('nothing usable is German, the language every message is written in first', () => {
    expect(langOf(undefined)).toBe('DE');
    expect(langOf('')).toBe('DE');
    expect(langOf('fr-CH,it;q=0.8')).toBe('DE');
    expect(langOf('en;q=0')).toBe('DE');
  });
});

test.describe('a message in both languages', () => {
  test('say() hands back the German and remembers the English', () => {
    const de = say('Spiel nicht gefunden.', 'Game not found.');
    expect(de).toBe('Spiel nicht gefunden.');
    expect(englishFor(de)).toBe('Game not found.');
  });
  test('the response carries the English only when English was asked for', () => {
    const body = { error: say('Anfrage nicht gefunden.', 'Request not found.'), code: 7 };
    expect(inLanguage(body, 'EN')).toEqual({ error: 'Request not found.', code: 7 });
    expect(inLanguage(body, 'DE')).toBe(body);
  });
  test('a message nobody wrote in English, and anything that is not one, go out as they are', () => {
    const plain = { error: 'Nie übersetzt.' };
    expect(inLanguage(plain, 'EN')).toBe(plain);
    const list = [{ error: 'x' }];
    expect(inLanguage(list, 'EN')).toBe(list);
    expect(inLanguage({ ok: true }, 'EN')).toEqual({ ok: true });
    expect(inLanguage(null, 'EN')).toBe(null);
  });
});

// The ratchet: no handler may answer a person in one language only. A message
// is either said in both (say()), or is one the app translates itself
// (localizeRuntimeError's table in App.tsx).
test('every message the API answers with has both languages', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const tableStart = app.indexOf('const map: Record<string, { DE: string; EN: string }> = {');
  const table = app.slice(tableStart, app.indexOf('\n  };', tableStart));
  const appTranslates = new Set([...table.matchAll(/^\s{4}'?([^':\n]+?)'?: \{/gm)].map((m) => m[1]));
  expect(appTranslates.has('Internal server error')).toBe(true);

  const oneLanguage: string[] = [];
  const dir = new URL('../server/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/\berror:\s*(['"`])((?:(?!\1)[^\\]|\\.)+)\1/g)) {
      const text = m[2];
      // The log store's level table maps the console method `error` to its level.
      if (file === 'logstore.ts' && text === 'error') continue;
      if (appTranslates.has(text)) continue;
      oneLanguage.push(`${file}:${src.slice(0, m.index).split('\n').length}: ${text.slice(0, 80)}`);
    }
  }
  expect(oneLanguage).toEqual([]);
});

test('every call to the API says which language is on screen', async ({ page }) => {
  const asked: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/rc-meetings*', async (r) => {
    asked.push(r.request().headers()['accept-language'] ?? '');
    await r.fulfill({ json: [] });
  });
  await page.goto('/home');
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  // The suite's browser reads English, so the app does.
  expect(asked.every((a) => a === 'en')).toBe(true);
});

// The greyed take button explains itself in a toast it gives no language to;
// its close button said "Meldung schliessen" on an English screen.
test('a toast with no language of its own speaks the screen\'s', async ({ page }) => {
  await stubSignedInApp(page);
  const booked = { ...GAME, assignedRc: 'Carlos Castro', assignedRcId: 'rc-other' };
  const later = { ...GAME, id: 'g-later', matchNo: '2400777', date: '2026-11-26T19:30:00.000Z', assignedRc: '', assignedRcId: '' };
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [booked, later] }));
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  await page.goto('/games');
  await page.getByRole('button', { name: /Hide planned|Ohne Geplante/ }).click();
  await page.getByRole('button', { name: new RegExp(later.matchNo) }).first().click();
  await page.getByTestId('take-booked').dispatchEvent('click');
  await expect(page.getByTestId('toast-dismiss')).toHaveAttribute('aria-label', 'Dismiss notification');
});

// The hook in a real Express app — including a route behind its own body
// parser, which runs its handler from the parser's stream callback: the case a
// per-request context would have lost, and the reason the hook reads the
// header itself.
test('an Express answer comes back in the language asked for', async () => {
  const express = (await import('express')).default;
  const { answerInAskersLanguage } = await import('../server/say');
  const app = express();
  app.use(answerInAskersLanguage);
  app.put('/api/take', express.json(), (_req, res) => {
    res.status(409).json({ error: say('Dieses Spiel wurde bereits von einem anderen RC übernommen.', 'Another RC has already taken this game.') });
  });
  const server = app.listen(0);
  try {
    const port = (server.address() as { port: number }).port;
    const ask = async (lang?: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/take`, {
        method: 'PUT', body: '{}',
        headers: { 'Content-Type': 'application/json', ...(lang ? { 'Accept-Language': lang } : {}) },
      });
      return { status: r.status, error: ((await r.json()) as { error: string }).error };
    };
    expect(await ask('en')).toEqual({ status: 409, error: 'Another RC has already taken this game.' });
    expect(await ask('de')).toEqual({ status: 409, error: 'Dieses Spiel wurde bereits von einem anderen RC übernommen.' });
    expect((await ask()).error).toBe('Dieses Spiel wurde bereits von einem anderen RC übernommen.');
  } finally {
    server.close();
  }
});
