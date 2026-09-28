import { test, expect } from '@playwright/test';
import { stubSignedInApp, openOptions } from './support/app';

/**
 * The calendar dialog READS its links with a GET and CHANGES them with a JSON
 * POST. A change on a GET (?rotate=1, ?sr=0|1, as it used to be) is what any
 * other website can make a signed-in browser send — an <img> tag is enough, and
 * every calendar the coach had subscribed silently stops updating. The server
 * now refuses a change on the GET; this pins that the app never sends one.
 */

const INFO = {
  name: 'Anna Muster', count: 3, srGames: false, srCount: 2,
  url: 'https://api.example/api/ical/tok.ics?lang=de',
  webcalUrl: 'webcal://api.example/api/ical/tok.ics?lang=de',
  downloadUrl: 'https://api.example/api/ical/tok.ics?lang=de&download=1',
};

type Seen = { method: string; url: string; body: Record<string, unknown> | null; contentType: string };

async function openCalendar(page: import('@playwright/test').Page, seen: Seen[]) {
  await stubSignedInApp(page);
  await page.route('**/api/ical/me*', (r) => {
    const req = r.request();
    seen.push({
      method: req.method(),
      url: req.url(),
      body: req.method() === 'POST' ? req.postDataJSON() : null,
      contentType: req.headers()['content-type'] || '',
    });
    return r.fulfill({ json: { ...INFO, srGames: req.method() === 'POST' ? Boolean(req.postDataJSON()?.sr) : false } });
  });
  await page.goto('/');
  await openOptions(page);
  await page.getByRole('button', { name: /Kalender-Abo|Calendar subscription/ }).click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
}

test('opening the dialog is a plain GET that changes nothing', async ({ page }) => {
  const seen: Seen[] = [];
  await openCalendar(page, seen);
  expect(seen[0].method).toBe('GET');
  expect(seen[0].url).not.toMatch(/[?&](rotate|sr)=/);
});

test('a new link is asked for with a JSON POST, never a GET', async ({ page }) => {
  const seen: Seen[] = [];
  await openCalendar(page, seen);
  await page.getByRole('button', { name: /Neuen Link erzeugen|Generate a new link/ }).click();
  await page.getByRole('button', { name: /^(Neu erzeugen|Regenerate)$/ }).click();

  await expect.poll(() => seen.filter((s) => s.method === 'POST').length).toBe(1);
  const post = seen.find((s) => s.method === 'POST')!;
  expect(post.contentType).toContain('application/json');
  expect(post.body).toMatchObject({ rotate: true });
  expect(seen.every((s) => !/[?&](rotate|sr)=/.test(s.url))).toBe(true);
});

test('the own-SR-games switch is a JSON POST too', async ({ page }) => {
  const seen: Seen[] = [];
  await openCalendar(page, seen);
  await page.getByRole('dialog').filter({ hasText: /Kalender-Abo|Calendar subscription/ }).getByRole('switch').click();

  await expect.poll(() => seen.filter((s) => s.method === 'POST').length).toBe(1);
  const post = seen.find((s) => s.method === 'POST')!;
  expect(post.contentType).toContain('application/json');
  expect(post.body).toMatchObject({ sr: true, rotate: false });
});
