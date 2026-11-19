import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The chair's RC-Notizen (19.11.2026): newest game first, the referee's level
// and what the coach ticked on every card, filters by motivation and
// Einstufung, a read tick, her own tags per referee, and an overview with one
// row per coachee.

const NOTE = (over: Record<string, unknown>) => ({
  id: 'fb1', note: 'Bereit für ein <b>Prüfspiel</b>.', gameId: 'g1', matchNo: '81234', teams: 'A vs B', league: '2L',
  gameDate: '2026-11-15T11:00:00.000000+00:00', coacheeName: 'Lea Brunner', refereeId: '123456', rcName: 'Marco Keller', rcId: 'rc1',
  authorName: 'Marco Keller', updatedAt: '2026-11-16T10:00:00Z',
  refereeKey: 'sv:123456', refereeLevel: 'N3', refereeStage: '2', groups: ['Beförderung?'], read: false,
  results: { role: '1. SR', motivation: 'up', einstufung: 'up', spielniveau: 'normal', srZiel: '2L', secondBesuch: 'Y', secondBesuchRole: '1SR', wantsPromotion: true, wantsCandidate: false },
  ...over,
});
const NOTES = [
  NOTE({}),
  NOTE({
    id: 'fb2', coacheeName: 'Thomas Meier', refereeKey: 'sv:222', refereeLevel: 'N4', refereeStage: '1', groups: ['Varia'], read: true,
    gameDate: '2026-11-09T11:00:00.000000+00:00', note: 'Passt so.',
    results: { role: '2. SR', motivation: 'check', einstufung: 'check', spielniveau: 'leicht', srZiel: 'Verbleib', secondBesuch: 'N', secondBesuchRole: '', wantsPromotion: false, wantsCandidate: false },
  }),
];
const SR_NOTES = [{
  id: 'n1', gameId: 'g9', rcId: 'rc2', rcName: 'Nina Frei', rcRole: '1. SR', coacheeId: 'c9', coacheeName: 'Sara Graf', coacheeRole: '2. SR',
  note: 'Ruhig und sicher.', submittedAt: '2026-11-10T20:00:00Z', matchNo: '81102', league: '4L', gameDate: '2026-11-09T18:00:00.000000+00:00', teams: 'C vs D',
  refereeKey: 'sv:333', refereeLevel: 'N4', refereeStage: 'active', groups: ['Neu-Schiedsrichter 26/27'], read: false,
}];

async function stubChair(page: Page) {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  const reads: unknown[] = [];
  const marks: unknown[] = [];
  await page.route('**/api/president-notes', (r) => r.fulfill({ json: NOTES }));
  await page.route('**/api/rc-game-notes', (r) => r.fulfill({ json: SR_NOTES }));
  await page.route('**/api/president-reads', async (r) => { reads.push(r.request().postDataJSON()); await r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/president-marks', async (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON();
      marks.push(body);
      await r.fulfill({ json: { ok: true, mark: { ...body, updatedAt: '2026-11-19T10:00:00Z' } } });
      return;
    }
    await r.fulfill({ json: [{ key: 'sv:222', name: 'Thomas Meier', tags: ['Kein Besuch nächste Saison'], memo: '', updatedAt: '' }] });
  });
  await page.route('**/api/president-overview*', (r) => r.fulfill({ json: { season: 2026, rows: [
    { coacheeId: 'c1', name: 'Lea Brunner', refereeKey: 'sv:123456', refereeLevel: 'N3', refereeStage: '2', groups: ['Beförderung?'], active: true, observations: 2, lastDate: '2026-11-15', lastMotivation: 'up', lastEinstufung: 'up', lastSrZiel: '2L', lastSecondBesuch: 'Y', wantsPromotion: true, wantsCandidate: false, rcs: ['Marco Keller'] },
    { coacheeId: 'c2', name: 'Thomas Meier', refereeKey: 'sv:222', refereeLevel: 'N4', refereeStage: '1', groups: ['Varia'], active: true, observations: 1, lastDate: '2026-11-09', lastMotivation: 'check', lastEinstufung: 'check', lastSrZiel: 'Verbleib', lastSecondBesuch: 'N', wantsPromotion: false, wantsCandidate: false, rcs: ['Nina Frei'] },
  ] } }));
  await page.goto('/admin/notes');
  return { reads, marks };
}

test('every card carries the level, the groups and the ticks of the form, newest game first', async ({ page }) => {
  await stubChair(page);
  const cards = page.getByTestId('chair-note');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Lea Brunner');
  await expect(cards.first()).toContainText('N3-2');
  await expect(cards.first()).toContainText('Beförderung?');
  await expect(cards.first().getByTestId('chair-results')).toContainText(/Motivation ↑ Hoch/);
  await expect(cards.first().getByTestId('chair-results')).toContainText(/Einstufung ↑ Beförderung/);
  await expect(cards.first().getByTestId('chair-results')).toContainText(/Weiterer Besuch: Ja, 1\. SR/);
  await expect(cards.first().locator('b')).toHaveText('Prüfspiel');
  await expect(page.getByTestId('chair-sr-note')).toContainText('Sara Graf');
  await expect(page.getByTestId('chair-counts')).toContainText(/2 von 2 Notizen/);
  // Two unread: Lea's note and Sara's Rückmeldung.
  await expect(page.getByTestId('chair-counts')).toContainText(/2 ungelesen/);
});

test('filtering by motivation narrows the notes and hides the Rückmeldungen, which have no form', async ({ page }) => {
  await stubChair(page);
  await page.getByRole('group', { name: 'Motivation' }).getByRole('button', { name: /In Ordnung/ }).click();
  await expect(page.getByTestId('chair-note')).toHaveCount(1);
  await expect(page.getByTestId('chair-note')).toContainText('Thomas Meier');
  await expect(page.getByTestId('chair-sr-note')).toHaveCount(0);
  await page.getByRole('button', { name: /Filter zurücksetzen|Reset filters/ }).click();
  await page.getByLabel('Nur ungelesene').check();
  await expect(page.getByTestId('chair-note')).toHaveCount(1);
  await expect(page.getByTestId('chair-note')).toContainText('Lea Brunner');
  // Her own tag is a filter too.
  await page.getByRole('button', { name: /Filter zurücksetzen|Reset filters/ }).click();
  await page.getByLabel('Tag', { exact: true }).selectOption('Kein Besuch nächste Saison');
  await expect(page.getByTestId('chair-note')).toHaveCount(1);
  await expect(page.getByTestId('chair-note')).toContainText('Thomas Meier');
});

test('the read tick is saved and the red dot goes', async ({ page }) => {
  const { reads } = await stubChair(page);
  const first = page.getByTestId('chair-note').first();
  await first.getByTestId('chair-read').click();
  await expect.poll(() => reads).toEqual([{ ref: 'fb:fb1', read: true }]);
  await expect(first.getByTestId('chair-read')).toHaveText(/Gelesen/);
  await expect(page.getByTestId('chair-counts')).toContainText(/1 ungelesen/);
});

test('a tag added on a card is saved for the person and shows on the card', async ({ page }) => {
  const { marks } = await stubChair(page);
  const first = page.getByTestId('chair-note').first();
  await first.getByTestId('chair-tags-edit').click();
  const dialog = page.getByRole('dialog', { name: /Tags für Lea Brunner/ });
  await dialog.getByRole('button', { name: 'N2-Kurs nächste Saison' }).click();
  await dialog.getByLabel('Eigener Tag').fill('Prüfspiel im Februar');
  await dialog.getByRole('button', { name: 'Hinzufügen' }).click();
  await dialog.getByLabel('Deine Notiz').fill('Nach der Saison anmelden.');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(() => marks).toEqual([{ key: 'sv:123456', name: 'Lea Brunner', tags: ['N2-Kurs nächste Saison', 'Prüfspiel im Februar'], memo: 'Nach der Saison anmelden.' }]);
  await expect(dialog).toHaveCount(0);
  await expect(first).toContainText('N2-Kurs nächste Saison');
  await expect(first).toContainText('Prüfspiel im Februar');
});

test('the overview has one row per coachee with the last form, and the filters apply', async ({ page }) => {
  await stubChair(page);
  await page.getByRole('tab', { name: /Übersicht pro SR/ }).click();
  const table = page.getByTestId('chair-overview');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row', { name: /Lea Brunner/ })).toContainText(/Will befördert werden/);
  await expect(table.getByRole('row', { name: /Thomas Meier/ })).toContainText('Kein Besuch nächste Saison');
  await page.getByRole('group', { name: 'Einstufung' }).getByRole('button', { name: /Beförderung/ }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Lea Brunner');
  await expect(table).not.toContainText('Thomas Meier');
});
