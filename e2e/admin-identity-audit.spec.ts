import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// The "Datenqualität" card on the console's Coachees tab: what the server's
// identity audit lists (GET /api/admin/identity-audit — the classifier is
// pinned in identity-rules.spec.ts), the three writes that put the ids where
// they are missing, and the hand-link for the rows those cannot decide. The
// network is stubbed; what is proven here is that the card draws the report,
// posts to the right endpoints and writes a link the way the edit form does.

const REGISTER = {
  source: 'roster',
  people: [
    { id: '90003', name: 'Rita Zwahlen', email: 'rita@example.ch', level: 'N4' },
    { id: '90004', name: 'Jürg Peter Müller', email: 'juerg@example.ch', level: 'N2' },
    { id: '90005', name: 'Doppel Name', email: 'd1@example.ch', level: 'N3' },
    { id: '90006', name: 'Doppel Name', email: 'd2@example.ch', level: 'N3' },
  ],
};

const status = { needsObservation: true, count: 0 };
const COACHEES = [
  { id: 'c1', full_name: 'Rita Zwahlen', first_name: 'Rita', last_name: 'Zwahlen', email: 'rita@example.ch', season: 2026, referee_id: '90003', observation_status: status },
  { id: 'c2', full_name: 'Jürg Müller', first_name: 'Jürg', last_name: 'Müller', email: 'juerg@example.ch', season: 2026, referee_id: '', observation_status: status },
];

/** A report with something in every list, as the server would send it. */
const AUDIT = {
  season: 2026,
  coacheesUnlinked: [
    { id: 'c2', name: 'Jürg Müller', season: 2026, reason: 'never-linked', candidates: [{ sv: '90004', name: 'Jürg Peter Müller' }] },
  ],
  duplicateSvPerSeason: [{ sv: '90007', season: 2026, rowIds: ['c7', 'c8'], names: ['Peter Pfeifer', 'Peter Pfeifer-Meier'] }],
  svDisagreesWithGame: [{ coacheeId: 'c1', coacheeName: 'Rita Zwahlen', rowSv: '90003', gameId: 'g3', matchNo: '1000003', label: '#1000003', slot: '1. SR', slotSv: '90099', name: 'Rita Zwahlen' }],
  gameSlotsByName: [
    { gameId: 'g2', matchNo: '1000002', label: '#1000002', slot: '1. SR', name: 'Jürg Müller', via: 'name', coacheeId: 'c2' },
    { gameId: 'g2', matchNo: '1000002', label: '#1000002', slot: '2. SR', name: 'Gast Ohne Akte', via: 'none', coacheeId: '', registerHits: 0 },
    // A blank number: the server's label names the game by teams and day.
    { gameId: 'k7x2m9p4q1w8e5r', matchNo: '', label: 'Heim – Gast · 2026-11-11', slot: '1. SR', name: 'Doppel Name', via: 'none', coacheeId: '', registerHits: 2 },
  ],
  // Four slots without a number this season; one of them the register spells once.
  gameSlotsNoSv: 4,
  gameSlotsNoSvInRegister: 1,
  duplicateMatchNos: [{ matchNo: '1000001', gameIds: ['g1', 'g4'], seasons: [2025, 2026] }],
  blankMatchNo: [{ gameId: 'g5', teams: 'Heim – Gast', date: '2026-11-11T19:00:00Z' }],
  rcRefsUnresolved: [
    { source: 'games', id: 'g2', label: '#1000002', rcName: 'Anna Muster', rcId: '', reason: 'blank', resolvable: true },
    { source: 'feedbacks', id: 'f2', label: '#1000001 · 2. SR', rcName: 'Gone Coach', rcId: 'rc-gone', reason: 'unknown', resolvable: false },
  ],
  rcsWithoutSv: [{ id: 'rc2', name: 'Bea Beispiel' }],
  assignByNameLast30d: { count: 3, since: '2026-09-01T06:00:00.000Z' },
};

const CLEAN = {
  ...AUDIT,
  coacheesUnlinked: [], duplicateSvPerSeason: [], svDisagreesWithGame: [], gameSlotsByName: [], gameSlotsNoSv: 0, gameSlotsNoSvInRegister: 0,
  duplicateMatchNos: [], blankMatchNo: [], rcRefsUnresolved: [], rcsWithoutSv: [],
  assignByNameLast30d: { count: 0, since: '2026-09-01T06:00:00.000Z' },
};

async function openCoacheeTab(page: Page, audit: Record<string, unknown> = AUDIT) {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.route('**/api/admin/referees', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ json: REGISTER });
  });
  await page.route('**/api/admin/identity-audit*', (r) => r.fulfill({ json: audit }));
  await page.goto('/admin');
  await expect(page.getByTestId('data-quality')).toBeVisible();
}

/** The tile for one count, by its label. */
const tile = (page: Page, label: RegExp) => page.getByTestId('audit-count').filter({ hasText: label });

test('the report renders: a tile per count, green at zero and amber above, and the lists behind them', async ({ page }) => {
  await openCoacheeTab(page);
  const card = page.getByTestId('data-quality');

  // The season is asked for — the card follows the tab's selector.
  // (Route stub answered whatever was asked; the assertion is on the draw.)
  await expect(tile(page, /Coachees nicht verknüpft|Coachees not linked/)).toContainText('1');
  await expect(tile(page, /Coachees nicht verknüpft|Coachees not linked/)).toHaveClass(/amber/);
  await expect(tile(page, /SV-Nr. doppelt|SV number twice/)).toContainText('1');
  await expect(tile(page, /widerspricht Spiel|contradicts game/)).toContainText('1');
  // Only the coachee slots the name found count as "by name"; the strangers
  // without a number are a separate list under their own heading. The tile
  // counts every slot without a number and says how many of them the
  // backfill button would number.
  await expect(tile(page, /SR nur über den Namen|Referees by name only/)).toContainText('1');
  const noSv = tile(page, /SR-Einträge ohne SV-Nr|Referee slots without SV number/);
  await expect(noSv).toContainText('4');
  await expect(noSv).toContainText(/1 davon|1 of them/);
  await expect(tile(page, /Spielnummer doppelt|Match number twice/)).toContainText('1');
  await expect(tile(page, /Spiele ohne Nummer|Games without a number/)).toContainText('1');
  await expect(tile(page, /RC-Einträge ohne ID|RC entries without id/)).toContainText('2');
  await expect(tile(page, /RCs ohne SV-Nr|RCs without SV number/)).toContainText('1');
  // The log-ring count says since when it counts.
  const takes = tile(page, /Übernahmen ohne ID|Takes without id/);
  await expect(takes).toContainText('3');
  await expect(takes).toContainText('2026-09-01');

  // Each list opens on its heading. The unlinked row carries its one
  // register hit pre-selected and the reason in words.
  await card.getByText(/Coachees nicht verknüpft|Coachees not linked/).last().click();
  const row = page.getByTestId('audit-unlinked');
  await expect(row).toContainText('Jürg Müller');
  await expect(row).toContainText(/noch nicht verknüpft|not linked yet/);
  await expect(page.locator('#audit-sv-c2')).toHaveValue('Jürg Peter Müller');
  await expect(page.locator('#audit-sv-c2 ~ span')).toHaveText(/SV-Nr\. 90004|SV no\. 90004/);

  await card.getByText(/SV-Nr. doppelt|SV number twice/).last().click();
  await expect(card.getByText(/Peter Pfeifer, Peter Pfeifer-Meier/)).toBeVisible();
  await card.getByText(/widerspricht Spiel|contradicts game/).last().click();
  await expect(card.getByText(/#1000003/)).toBeVisible();
  await expect(card.getByText(/90099/)).toBeVisible();
  // The strangers: named by the game's label, and told apart by what the
  // register says — not held at all, or held twice. Never the record id.
  await card.getByText(/SR ohne SV-Nr\. und ohne Coachee|nobody's coachee/).click();
  await expect(card.getByText(/Gast Ohne Akte — (niemand — keine SV-Nr\., nicht im Register|nobody — no SV number, not in the register)/)).toBeVisible();
  await expect(card.getByText(/Heim – Gast · 2026-11-11 · 1\. SR Doppel Name — .*(2-mal|2 times)/)).toBeVisible();
  await expect(card.getByText(/k7x2m9p4q1w8e5r/)).toHaveCount(0);
  await card.getByText(/Spielnummer doppelt|Match number twice/).last().click();
  await expect(card.getByText(/#1000001/).first()).toBeVisible();
  await expect(card.getByText(/2025\/26, 2026\/27/)).toBeVisible();
  // A game without a number is named by its teams and day, never its id.
  await card.getByText(/Spiele ohne Nummer|Games without a number/).last().click();
  await expect(card.getByText(/Heim – Gast · 11\.11\.2026/)).toBeVisible();
  await expect(card.getByText(/\bg5\b/)).toHaveCount(0);
  await card.getByText(/RC-Einträge ohne ID|RC entries without id/).last().click();
  await expect(card.getByText(/Gone Coach/)).toBeVisible();
  await expect(card.getByText(/RC-IDs nachtragen" behebt|"Add RC ids" fixes/)).toBeVisible();
  await card.getByText(/RCs ohne SV-Nr|RCs without SV number/).last().click();
  await expect(card.getByText('Bea Beispiel')).toBeVisible();
});

test('a clean report is all green and says so; no list is drawn', async ({ page }) => {
  await openCoacheeTab(page, CLEAN);
  const card = page.getByTestId('data-quality');
  await expect(card.getByText(/Alles verknüpft|Everything linked/)).toBeVisible();
  for (const t of await page.getByTestId('audit-count').all()) await expect(t).toHaveClass(/green/);
  await expect(card.locator('details')).toHaveCount(0);
});

test('"nothing to do" never stands beside an amber tile', async ({ page }) => {
  // Every list empty, but the slots without a number are the backfill's to
  // do and the takes without an id say a client still sends names: the
  // tiles are amber, and the green line would contradict them.
  await openCoacheeTab(page, { ...CLEAN, gameSlotsNoSv: 400, gameSlotsNoSvInRegister: 380, assignByNameLast30d: { count: 3, since: '2026-09-01T06:00:00.000Z' } });
  const card = page.getByTestId('data-quality');
  await expect(tile(page, /SR-Einträge ohne SV-Nr|Referee slots without SV number/)).toHaveClass(/amber/);
  await expect(card.getByText(/Alles verknüpft|Everything linked/)).toHaveCount(0);
});

test('the three buttons post to their endpoints and report; the audit re-reads after each', async ({ page }) => {
  await openCoacheeTab(page);
  const posted: string[] = [];
  const stubPost = (path: string, json: Record<string, unknown>) => page.route(`**${path}`, (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    posted.push(path);
    return r.fulfill({ json });
  });
  await stubPost('/api/admin/coachees/link-referees', { linked: 2, alreadyLinked: 5, unmatched: ['Nie Registriert'], ambiguousNames: [] });
  await stubPost('/api/admin/games/backfill-referee-ids', { games: 300, filled: 41, already: 190, blank: 12, unresolved: ['Gast Ohne Akte'], ambiguous: ['Doppel Name'] });
  await stubPost('/api/admin/migrate-rc-ids', {
    ok: true,
    games: { total: 600, filled: 12, already: 580, unresolved: 3, blank: 5 },
    feedbacks: { total: 200, filled: 7, already: 190, unresolved: 1, blank: 2 },
    rcNotes: { total: 4, filled: 1, already: 3, unresolved: 0, blank: 0 },
    presidentNotes: { total: 3, filled: 2, already: 1, unresolved: 0, blank: 0 },
  });
  let audits = 0;
  await page.route('**/api/admin/identity-audit*', (r) => { audits += 1; return r.fulfill({ json: AUDIT }); });
  // The first read has landed (the tiles are drawn); everything after this
  // is a re-read. Counted from here because the dev server's StrictMode
  // mounts twice and may issue the first read twice.
  await expect(tile(page, /Coachees nicht verknüpft|Coachees not linked/)).toContainText('1');
  const before = audits;

  await page.getByRole('button', { name: /Coachees jetzt verknüpfen|Link coachees now/ }).click();
  await expect(page.getByText(/2 Coachees neu mit ihrer SV-Nr\. verknüpft, 5|2 coachees newly linked to their SV number, 5/)).toBeVisible();
  await expect(page.getByText(/Nie Registriert/)).toBeVisible();
  // One re-read per write — the counts say what is left, not what was.
  await expect.poll(() => audits).toBe(before + 1);

  await page.getByRole('button', { name: /SV-Nr\. auf Spielen nachtragen|Add SV numbers to games/ }).click();
  await expect(page.getByText(/41 SR-Einträge|41 referee slots/)).toBeVisible();
  await expect(page.getByText(/Doppel Name/).first()).toBeVisible();
  await expect.poll(() => audits).toBe(before + 2);

  await page.getByRole('button', { name: /RC-IDs nachtragen|Add RC ids/ }).click();
  await expect(page.getByText(/12 Spielen, 7 Feedbacks, 1 Rückmeldungen, 2 Notizen · 4|12 games, 7 feedbacks, 1 Rückmeldungen, 2 notes · 4/)).toBeVisible();
  await expect.poll(() => audits).toBe(before + 3);

  expect(posted).toEqual(['/api/admin/coachees/link-referees', '/api/admin/games/backfill-referee-ids', '/api/admin/migrate-rc-ids']);
});

test('the link on a row PUTs referee_id, and the counts drop', async ({ page }) => {
  await openCoacheeTab(page);
  const bodies: Record<string, unknown>[] = [];
  // After the write the server's answer changes: the row is linked, the
  // audit lists nobody, and the list's own badge has nobody to count.
  await page.route('**/api/coachees/c2', (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ json: { id: 'c2' } });
  });
  await page.route('**/api/coachees*', (r) => r.fulfill({
    json: bodies.length ? COACHEES.map((c) => (c.id === 'c2' ? { ...c, referee_id: '90004' } : c)) : COACHEES,
  }));
  await page.route('**/api/admin/identity-audit*', (r) => r.fulfill({ json: bodies.length ? CLEAN : AUDIT }));

  const badge = page.getByRole('button', { name: /1 Coachee ohne SV-Nr\.|1 coachee without an SV number/ });
  await expect(badge).toBeVisible();
  const unlinked = tile(page, /Coachees nicht verknüpft|Coachees not linked/);
  await expect(unlinked).toContainText('1');

  const card = page.getByTestId('data-quality');
  await card.getByText(/Coachees nicht verknüpft|Coachees not linked/).last().click();
  await page.getByRole('button', { name: /^(Verknüpfen|Link) Jürg Müller$/ }).click();

  await expect.poll(() => bodies.length).toBe(1);
  expect(bodies[0]).toEqual({ referee_id: '90004' });
  await expect(unlinked).toContainText('0');
  await expect(unlinked).toHaveClass(/green/);
  await expect(badge).toHaveCount(0);
});

test('an ambiguous row offers each candidate as a click and pre-selects none', async ({ page }) => {
  await openCoacheeTab(page, {
    ...CLEAN,
    coacheesUnlinked: [
      { id: 'c2', name: 'Doppel Name', season: 2026, reason: 'ambiguous', candidates: [{ sv: '90005', name: 'Doppel Name' }, { sv: '90006', name: 'Doppel Name' }] },
    ],
  });
  const card = page.getByTestId('data-quality');
  await card.getByText(/Coachees nicht verknüpft|Coachees not linked/).last().click();
  const row = page.getByTestId('audit-unlinked');
  await expect(row).toContainText(/mehrdeutig|ambiguous/);
  await expect(page.locator('#audit-sv-c2')).toHaveValue('');
  const link = page.getByRole('button', { name: /^(Verknüpfen|Link) Doppel Name$/ });
  await expect(link).toBeDisabled();
  await row.getByRole('button', { name: /90006/ }).click();
  await expect(page.locator('#audit-sv-c2 ~ span')).toHaveText(/SV-Nr\. 90006|SV no\. 90006/);
  await expect(link).toBeEnabled();
});

test('a decision on one row survives a write on another', async ({ page }) => {
  // Every write re-reads the audit; the picks are merged, not replaced, so
  // the chip chosen on the ambiguous row stays chosen while the row above
  // is linked — the same decision must not have to be made twice.
  const twoRows = {
    ...CLEAN,
    coacheesUnlinked: [
      { id: 'c2', name: 'Jürg Müller', season: 2026, reason: 'never-linked', candidates: [{ sv: '90004', name: 'Jürg Peter Müller' }] },
      { id: 'c3', name: 'Doppel Name', season: 2026, reason: 'ambiguous', candidates: [{ sv: '90005', name: 'Doppel Name' }, { sv: '90006', name: 'Doppel Name' }] },
    ],
  };
  await openCoacheeTab(page, twoRows);
  await page.route('**/api/coachees/c2', (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    return r.fulfill({ json: { id: 'c2' } });
  });
  const card = page.getByTestId('data-quality');
  await card.getByText(/Coachees nicht verknüpft|Coachees not linked/).last().click();
  const ambiguous = page.getByTestId('audit-unlinked').filter({ hasText: 'Doppel Name' });
  await ambiguous.getByRole('button', { name: /90006/ }).click();
  await expect(page.locator('#audit-sv-c3 ~ span')).toHaveText(/SV-Nr\. 90006|SV no\. 90006/);

  await page.getByRole('button', { name: /^(Verknüpfen|Link) Jürg Müller$/ }).click();
  await expect(page.getByText(/Jürg Müller mit der SV-Nr\. 90004|Jürg Müller linked to SV number 90004/)).toBeVisible();
  // The re-read landed (the stub answers the same report); the pick stands.
  await expect(page.locator('#audit-sv-c3 ~ span')).toHaveText(/SV-Nr\. 90006|SV no\. 90006/);
  await expect(page.getByRole('button', { name: /^(Verknüpfen|Link) Doppel Name$/ })).toBeEnabled();
});

test('the server\'s refusal of a link is shown as its sentence', async ({ page }) => {
  await openCoacheeTab(page);
  await page.route('**/api/coachees/c2', (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    return r.fulfill({ status: 409, json: { error: 'Die SV-Nr. 90004 ist in der Saison 2026/27 bereits „Jürg Alt" zugeordnet.' } });
  });
  const card = page.getByTestId('data-quality');
  await card.getByText(/Coachees nicht verknüpft|Coachees not linked/).last().click();
  await page.getByRole('button', { name: /^(Verknüpfen|Link) Jürg Müller$/ }).click();
  await expect(card.getByText(/bereits „Jürg Alt" zugeordnet/)).toBeVisible();
  await expect(card.getByText(/{"error"/)).toHaveCount(0);
});

// ── The games tab ──────────────────────────────────────────────────────
// A slot the number did not settle wears a grey "nur Name" mark beside the
// amber Coachee one, from the tier the server reports (firstCoacheeVia).

test('the games tab marks a coachee the name alone found', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [
    { ...GAME, id: 'g1', firstReferee: 'Rita Zwahlen', firstCoacheeId: 'c1', firstCoacheeVia: 'sv', secondReferee: 'Jürg Müller', secondCoacheeId: 'c2', secondCoacheeVia: 'name' },
    // A stranger the name did not find either carries no mark at all.
    { ...GAME, id: 'g2', matchNo: '2345679', firstReferee: 'Gast Ohne Akte', firstCoacheeId: '', firstCoacheeVia: 'none', secondReferee: '', secondCoacheeId: '', secondCoacheeVia: 'none' },
  ] }));
  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();

  // The marks sit under the name inside the slot's chip (the shared crew
  // chip: the name on one line, its marks on the next), so the chip is the
  // name's parent. getByText answers the innermost element, so the mark row
  // around a mark is not counted twice. The Coachee mark carries the Niveau.
  const chip = (text: string) => page.getByText(text).locator('xpath=..');
  const byNumber = chip('1SR Rita Zwahlen');
  await expect(byNumber).toBeVisible();
  await expect(byNumber.getByText(/^Coachee( · .+)?$/)).toHaveCount(1);
  await expect(byNumber.getByText(/nur Name|name only/)).toHaveCount(0);
  const byName = chip('2SR Jürg Müller');
  await expect(byName).toBeVisible();
  await expect(byName.getByText(/^Coachee( · .+)?$/)).toHaveCount(1);
  await expect(byName.getByText(/nur Name|name only/)).toHaveCount(1);
  const stranger = chip('1SR Gast Ohne Akte');
  await expect(stranger).toBeVisible();
  await expect(stranger.getByText(/nur Name|name only|^Coachee/)).toHaveCount(0);
});
