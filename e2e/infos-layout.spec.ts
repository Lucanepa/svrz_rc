import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, pinClock } from './support/app';
import { USEFUL_DOCS } from '../src/lib/usefulDocs';
import {
  INFOS_PUBLIC_DOCS, defaultInfosLayout, normalizeInfosLayout, placeInfosDocs, settleInfosLayout,
  type InfosLayout,
} from '../src/lib/infosLayout';

// The public /infos page's sections, editable in Admin → Einstellungen (Luca,
// 2026-10-13; agreed 2026-10-09). The code's audience table stays the default:
// e2e/infos-audience.spec.ts covers the page with nothing stored.

const title = (id: string) => USEFUL_DOCS.find((d) => d.id === id)!.DE.title;
const allPlaced = (l: InfosLayout) => [...l.sections.flatMap((s) => s.docs), ...l.hidden].sort();
const PUBLIC_IDS = INFOS_PUBLIC_DOCS.map((d) => d.id).sort();

test.describe('the layout rules', () => {
  test('anything that is not a layout is none; a section needs a title and lends it to the other language', () => {
    expect(normalizeInfosLayout(null)).toBeNull();
    expect(normalizeInfosLayout({ sections: 'x' })).toBeNull();
    expect(normalizeInfosLayout({ sections: [{ DE: { title: ' ' }, EN: { title: '' }, docs: ['las'] }] })).toBeNull();
    const l = normalizeInfosLayout({ sections: [{ id: 'a', DE: { title: 'Nur Deutsch' }, docs: [] }] })!;
    expect(l.sections[0].EN.title).toBe('Nur Deutsch');
  });

  test('each document counts once, unknown ones are dropped, texts are one line and cut', () => {
    const l = normalizeInfosLayout({
      sections: [
        { id: 'a', DE: { title: 'A\nzwei', note: 'x'.repeat(400) }, EN: { title: 'A' }, docs: ['las', 'nope', 'las', 'rulesDe'] },
        { id: 'a', DE: { title: 'B' }, EN: { title: 'B' }, docs: ['las', 'rulesEn'] },
      ],
      hidden: ['rulesEn', 'srN3', 42],
    })!;
    expect(l.sections[0]).toMatchObject({ id: 'a', docs: ['las', 'rulesDe'], DE: { title: 'A zwei' } });
    expect(l.sections[0].DE.note).toHaveLength(300);
    expect(l.sections[1].id).not.toBe('a');
    expect(l.sections[1].docs).toEqual(['rulesEn']);
    expect(l.hidden).toEqual(['srN3']);
  });

  test('a document the layout does not name lands in its audience section, or the last — never nowhere', () => {
    const text = { title: 'T', note: '' };
    const layout: InfosLayout = {
      sections: [{ id: 'new', DE: text, EN: text, docs: [] }, { id: 'mine', DE: text, EN: text, docs: ['las'] }],
      hidden: ['spesenNl'],
    };
    const placed = placeInfosDocs(layout);
    const ids = (i: number) => placed[i].docs.map((d) => d.id);
    expect(ids(0)).toContain('rulesDe'); // audience "new"
    expect(ids(1)[0]).toBe('las'); // named: first, where it was put
    expect(ids(1)).toContain('srN3'); // audience "regional" has no section: the last one
    expect([...ids(0), ...ids(1)]).not.toContain('spesenNl');
    expect(allPlaced(settleInfosLayout(layout))).toEqual(PUBLIC_IDS);
  });

  test('the default is the code table, already settled', () => {
    const d = defaultInfosLayout();
    expect(d.sections.map((s) => s.id)).toEqual(['new', 'regional', 'all']);
    expect(settleInfosLayout(d)).toEqual(d);
    expect(allPlaced(d)).toEqual(PUBLIC_IDS);
  });
});

test.describe('/infos with a stored layout', () => {
  test.beforeEach(async ({ page }) => { await pinClock(page); });

  test('shows the sections as stored: renamed, reordered, moved and hidden', async ({ page }) => {
    await page.route('**/api/infos-layout', (r) => r.fulfill({ json: { updatedAt: '', layout: {
      sections: [
        { id: 'regional', DE: { title: 'Für die Region', note: 'Was in der SVRZ gilt.' }, EN: { title: 'For the region', note: '' }, docs: ['las', 'srN3'] },
        { id: 'new', DE: { title: 'Für Neue', note: '' }, EN: { title: 'For newcomers', note: '' }, docs: ['rulesDe'] },
      ],
      hidden: ['rulesEn'],
    } } }));
    await page.goto('/infos/de');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Für die Region', 'Für Neue']);
    const region = page.locator('section[data-audience="regional"]');
    await expect(region.getByText('Was in der SVRZ gilt.')).toBeVisible();
    await expect(region.getByRole('link', { name: new RegExp(title('las')) })).toBeVisible();
    await expect(page.locator('section[data-audience="new"]').getByRole('link', { name: new RegExp(title('rulesDe')) })).toBeVisible();
    // Off the page altogether.
    await expect(page.getByRole('link', { name: new RegExp(title('rulesEn')) })).toHaveCount(0);
    // A national document nobody placed: the last section, not gone.
    await expect(page.locator('section[data-audience="new"]').getByRole('link', { name: new RegExp(title('spesenNl').replace(/[()]/g, '\\$&')) })).toBeVisible();

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['For the region', 'For newcomers']);
  });
});

test.describe('/infos with a slow layout answer', () => {
  test.beforeEach(async ({ page }) => { await pinClock(page); });

  // 15:39 on 14.10.2026: an iPhone opening /infos cold waited the 3 s, got the
  // default, and the request the page cancelled was mailed as an API failure.
  test('draws the default after the wait, lets the request finish, and does not jump', async ({ page }) => {
    let answered = false;
    await page.route('**/api/infos-layout', async (r) => {
      await new Promise((done) => setTimeout(done, 4500));
      answered = true;
      await r.fulfill({ json: { updatedAt: '', layout: {
        sections: [{ id: 'regional', DE: { title: 'Spät gespeichert', note: '' }, EN: { title: 'Saved late', note: '' }, docs: ['las'] }],
        hidden: [],
      } } });
    });
    // Cancelled, it never arrives and this times out — the old page did that.
    const late = page.waitForResponse((res) => res.url().includes('/api/infos-layout'), { timeout: 8000 });
    await page.goto('/infos/de');
    const defaults = ['Neu als Schiedsrichter:in', 'Regionale Schiedsrichter:innen', 'Alle Schiedsrichter:innen · nationale Stufe'];
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(defaults, { timeout: 4000 });
    expect(answered).toBe(false);
    expect((await late).ok()).toBe(true);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(defaults);
  });
});

test.describe('Admin → Einstellungen: the /infos sections', () => {
  const STAMP = '2026-10-13 14:40:00.000Z';

  async function openEditor(page: Page, initial: InfosLayout | null = null) {
    await stubSignedInApp(page, { admin: true });
    const state = { stored: initial as InfosLayout | null, puts: [] as InfosLayout[], deletes: 0 };
    await page.route('**/api/infos-layout', (r) => r.fulfill({ json: { layout: state.stored, updatedAt: state.stored ? STAMP : '' } }));
    await page.route('**/api/admin/infos-layout', async (r) => {
      const method = r.request().method();
      if (method === 'PUT') {
        const { layout } = r.request().postDataJSON() as { layout: InfosLayout };
        state.puts.push(layout);
        state.stored = layout;
        return r.fulfill({ json: { layout, updatedAt: STAMP } });
      }
      if (method === 'DELETE') {
        state.deletes += 1;
        state.stored = null;
        return r.fulfill({ json: { layout: null, updatedAt: '' } });
      }
      return r.fallback();
    });
    await page.goto('/admin/settings');
    const editor = page.getByTestId('infos-layout-admin');
    await expect(editor.getByTestId('infos-section').first()).toBeVisible();
    return { editor, state };
  }

  test('rename, move and add, then save exactly what the page will show', async ({ page }) => {
    const { editor, state } = await openEditor(page);
    await expect(editor.getByTestId('infos-layout-state')).toHaveText('Standard aus dem Code');
    await expect(editor.getByTestId('infos-section')).toHaveCount(3);
    const save = editor.getByRole('button', { name: 'Speichern' });
    await expect(save).toBeDisabled();

    await editor.getByTestId('infos-section').first().getByLabel('Titel (DE)').fill('Für Neue');
    await editor.getByLabel('Dokument suchen…').fill(title('las'));
    await editor.getByLabel(`Verschieben nach: ${title('las')}`).selectOption('new');
    await editor.getByLabel('Dokument suchen…').fill('');
    await editor.getByRole('button', { name: 'Abschnitt hinzufügen' }).click();
    await expect(editor.getByTestId('infos-section')).toHaveCount(4);

    await save.click();
    await expect.poll(() => state.puts.length).toBe(1);
    const saved = state.puts[0];
    expect(saved.sections.map((s) => s.DE.title)).toEqual(['Für Neue', 'Regionale Schiedsrichter:innen', 'Alle Schiedsrichter:innen · nationale Stufe', 'Neuer Abschnitt']);
    expect(saved.sections[0].docs.at(-1)).toBe('las');
    expect(saved.sections[2].docs).not.toContain('las');
    expect(allPlaced(saved)).toEqual(PUBLIC_IDS);
    await expect(editor.getByTestId('infos-layout-state')).toHaveText('Angepasst · gespeichert 13.10.2026, 16:40');
    await expect(save).toBeDisabled();
  });

  test('a section with documents cannot be removed; emptied, it can', async ({ page }) => {
    const text = (t: string) => ({ title: t, note: '' });
    const { editor, state } = await openEditor(page, {
      sections: [
        { id: 'a', DE: text('A'), EN: text('A'), docs: INFOS_PUBLIC_DOCS.filter((d) => d.id !== 'las').map((d) => d.id) },
        { id: 'b', DE: text('B'), EN: text('B'), docs: ['las'] },
      ],
      hidden: [],
    });
    const remove = editor.getByRole('button', { name: 'Abschnitt entfernen: Abschnitt 2' });
    await expect(remove).toBeDisabled();
    await editor.getByLabel('Dokument suchen…').fill(title('las'));
    await editor.getByLabel(`Verschieben nach: ${title('las')}`).selectOption('a');
    await expect(remove).toBeEnabled();
    await remove.click();
    await expect(editor.getByTestId('infos-section')).toHaveCount(1);
    // The last section stays: the page needs somewhere to put things.
    await expect(editor.getByRole('button', { name: 'Abschnitt entfernen: Abschnitt 1' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => state.puts.length).toBe(1);
    expect(state.puts[0].sections.map((s) => s.id)).toEqual(['a']);
  });

  test('a hidden document is listed apart and can be brought back', async ({ page }) => {
    const { editor, state } = await openEditor(page);
    await editor.getByLabel('Dokument suchen…').fill(title('rulesEn'));
    await editor.getByLabel(`Verschieben nach: ${title('rulesEn')}`).selectOption({ label: 'Nicht auf /infos zeigen' });
    const hidden = editor.getByTestId('infos-hidden');
    await expect(hidden.locator('[data-doc="rulesEn"]')).toBeVisible();
    await editor.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => state.puts.length).toBe(1);
    expect(state.puts[0].hidden).toEqual(['rulesEn']);

    await hidden.getByLabel(`Verschieben nach: ${title('rulesEn')}`).selectOption('regional');
    await expect(hidden.locator('[data-doc="rulesEn"]')).toHaveCount(0);
    await editor.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => state.puts.length).toBe(2);
    expect(state.puts[1].hidden).toEqual([]);
    expect(state.puts[1].sections[1].docs.at(-1)).toBe('rulesEn');
  });

  test('unsaved changes can be discarded; the default comes back only after confirming', async ({ page }) => {
    const { editor, state } = await openEditor(page, settleInfosLayout(defaultInfosLayout()));
    await expect(editor.getByTestId('infos-layout-state')).toContainText('Angepasst');
    const first = editor.getByTestId('infos-section').first().getByLabel('Titel (DE)');
    await first.fill('Etwas anderes');
    await editor.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(first).toHaveValue('Neu als Schiedsrichter:in');

    await editor.getByRole('button', { name: 'Standard wiederherstellen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Abbrechen/ }).click();
    expect(state.deletes).toBe(0);
    await editor.getByRole('button', { name: 'Standard wiederherstellen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Standard wiederherstellen' }).click();
    await expect.poll(() => state.deletes).toBe(1);
    await expect(editor.getByTestId('infos-layout-state')).toHaveText('Standard aus dem Code');
  });
});
