import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// RC-Sitzungen in the app: the coach's Home card, and the console's own row
// with "+ RC-Sitzung hinzufügen" and one attendance tick per meeting.

const MEETING = {
  id: 'm1', title: 'RC-Saisonstartsitzung', date: '2099-10-09', start: '19:00', end: '19:45',
  link: 'https://teams.microsoft.com/l/meetup-join/abc', notes: '1. Austausch\n2. Regeln',
};

test('Home shows the next meeting with time, notes, link and a calendar button', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/rc-meetings', (r) => r.fulfill({ json: { meetings: [MEETING] } }));
  let icsAsked = false;
  await page.route('**/api/rc-meetings/m1/ics', async (r) => {
    icsAsked = true;
    await r.fulfill({ body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', contentType: 'text/calendar', headers: { 'Content-Disposition': 'attachment; filename="rc-sitzung-2099-10-09.ics"' } });
  });
  await page.goto('/home');
  const card = page.getByTestId('rc-meetings-home');
  await expect(card).toBeVisible();
  await expect(card).toContainText('RC-Saisonstartsitzung');
  await expect(card).toContainText('19:00–19:45');
  await expect(card).toContainText('2. Regeln');
  await expect(card.getByRole('link', { name: /Beitreten|Join/ })).toHaveAttribute('href', MEETING.link);
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: /Zum Kalender|Add to calendar/ }).click();
  expect((await download).suggestedFilename()).toBe('rc-sitzung-2099-10-09.ics');
  expect(icsAsked).toBe(true);
});

test('Home shows nothing when no meeting is ahead', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/rc-meetings', (r) => r.fulfill({ json: { meetings: [] } }));
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: /Hallo|Hello/ })).toBeVisible();
  await expect(page.getByTestId('rc-meetings-home')).toHaveCount(0);
});

test('the console: a meeting is added in its own row, and ticked per coach', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  let meetings: Array<Record<string, unknown>> = [];
  const created: unknown[] = [];
  const ticks: unknown[] = [];
  await page.route('**/api/admin/rc-meetings?*', (r) => r.fulfill({ json: { season: 2026, meetings } }));
  await page.route('**/api/admin/rc-meetings', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON();
    created.push(body);
    const m = { ...body, id: 'm9', attended: [] };
    meetings = [m];
    await r.fulfill({ status: 201, json: m });
  });
  await page.route('**/api/admin/rc-meetings/m9/attendance', async (r) => {
    ticks.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true, attended: true } });
  });
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
  await page.route(/\/api\/rc-overview\?season=\d+$/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 1, outstanding: 0, planned: 0, paidAt: null, paidBy: '', meetingsAttended: [] }],
  }));
  await page.goto('/admin/overview');
  const card = page.getByTestId('rc-meetings-admin');
  await expect(card).toContainText('Für diese Saison ist noch keine RC-Sitzung erfasst.');
  await card.getByRole('button', { name: 'RC-Sitzung hinzufügen' }).click();
  const form = card.getByTestId('rc-meeting-form');
  await form.getByLabel('Titel').fill('RC-Saisonstartsitzung');
  await form.getByLabel('Datum').fill('2026-10-09');
  await form.getByLabel('Beginn').fill('19:00');
  await form.getByLabel('Ende').fill('19:45');
  // A link that is not https is refused before it is sent.
  await form.getByLabel('Videocall-Link (optional)').fill('teams.microsoft.com/x');
  await form.getByRole('button', { name: 'Speichern' }).click();
  await expect(form).toContainText('https://');
  expect(created).toEqual([]);
  await form.getByLabel('Videocall-Link (optional)').fill('https://teams.microsoft.com/l/meetup-join/abc');
  await form.getByLabel('Notizen / Traktanden (optional)').fill('1. Austausch');
  await form.getByRole('button', { name: 'Speichern' }).click();

  await expect(card.getByTestId('rc-meeting-row')).toContainText('RC-Saisonstartsitzung');
  await expect(card.getByTestId('rc-meeting-row')).toContainText('19:00–19:45');
  expect(created).toEqual([{ title: 'RC-Saisonstartsitzung', date: '2026-10-09', start: '19:00', end: '19:45', link: 'https://teams.microsoft.com/l/meetup-join/abc', notes: '1. Austausch', rate: 60 }]);

  // The coach's row in the table above gets a tick for the new meeting.
  await page.getByRole('button', { name: RC.name }).first().click();
  const tick = page.getByLabel(/RC-Sitzung vom 09\.10\.2026 besucht/);
  await tick.check();
  await expect.poll(() => ticks).toEqual([{ rcId: RC.id, attended: true }]);
  await expect(card.getByTestId('rc-meeting-row')).toContainText('1 teilgenommen');
});
