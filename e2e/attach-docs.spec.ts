import { test, expect, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubSignedInApp, openFeedbackForm, fillWholeForm } from './support/app';
import {
  ATTACHABLE_DOCS, ATTACH_BUDGET_BYTES, USEFUL_DOCS, attachedBytes, normalizeAttachedDocs,
} from '../src/lib/usefulDocs';

/**
 * Enclosures: the documents a coach ticks under the observation form, which
 * the server then attaches to the report mail beside the PDF.
 *
 * "You should read the official protocol" is a sentence from the debrief that
 * lands better with the protocol in the same mail. The list is the PDF half of
 * "Nützliche Infos & Dokumente"; the ids travel in `formData.attachedDocs`, so
 * they ride the outbox, the draft store and `feedback_json` the way every other
 * field does, and the server fetches the bytes from its own two sources.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SERVER = readFileSync(join(ROOT, 'server', 'index.ts'), 'utf8');

// ---------------------------------------------------------------------------
// The catalogue's rules, pure
// ---------------------------------------------------------------------------

test.describe('Which documents can be enclosed', () => {
  test('every PDF we can fetch ourselves, and nothing else', () => {
    expect(ATTACHABLE_DOCS.length).toBeGreaterThan(5);
    for (const doc of ATTACHABLE_DOCS) {
      expect(doc.kind).toBe('pdf');
      expect(!!(doc.path || doc.proxyId), `${doc.id} has a source`).toBe(true);
      expect(doc.bytes, `${doc.id} carries a size for the budget`).toBeGreaterThan(0);
    }
    // The blank form is built in the browser, the links and contacts are not
    // files, and the video guide is not something anyone wants in an inbox.
    const ids = ATTACHABLE_DOCS.map((d) => d.id);
    for (const excluded of ['emptyForm', 'guide', 'readvolley', 'reglemente', 'srInfo', 'rsk', 'coaching']) {
      expect(ids, `${excluded} is not attachable`).not.toContain(excluded);
    }
    // Every PDF of the catalogue with a source is in — none is left out by
    // accident when the list on Home grows.
    const expected = USEFUL_DOCS.filter((d) => d.kind === 'pdf' && (d.path || d.proxyId)).map((d) => d.id);
    expect(ids).toEqual(expected);
  });

  test('the server can lay hands on each one', () => {
    // A proxied document has to be in the server's closed list, or the
    // enclosure loader throws and the submit is refused.
    const proxied = SERVER.slice(SERVER.indexOf('const PROXIED_DOCS'), SERVER.indexOf('};', SERVER.indexOf('const PROXIED_DOCS')));
    for (const doc of ATTACHABLE_DOCS) {
      if (doc.proxyId) expect(proxied, `${doc.proxyId} is proxied`).toContain(`'${doc.proxyId}':`);
      // A file of ours has to ship under public/, which the API image copies.
      if (doc.path) expect(existsSync(join(ROOT, 'public', doc.path)), `${doc.path} exists`).toBe(true);
    }
  });

  test('a stored list is reduced to known ids, once each, in catalogue order', () => {
    const [first, second, third] = ATTACHABLE_DOCS.map((d) => d.id);
    expect(normalizeAttachedDocs([third, 'nope', second, third, 42, second])).toEqual([second, third]);
    expect(normalizeAttachedDocs([first])).toEqual([first]);
    expect(normalizeAttachedDocs(undefined)).toEqual([]);
    expect(normalizeAttachedDocs('rulesDe')).toEqual([]);
    expect(normalizeAttachedDocs([])).toEqual([]);
  });

  test('the budget lets one rulebook through, not both', () => {
    // The two rulebooks are the only documents that come anywhere near the
    // limit; the ten megabytes exist so that a strict mailbox does not bounce
    // the whole report over them.
    const de = attachedBytes(['rulesDe']);
    const en = attachedBytes(['rulesEn']);
    expect(de).toBeGreaterThan(5e6);
    expect(de).toBeLessThan(ATTACH_BUDGET_BYTES);
    expect(en).toBeLessThan(ATTACH_BUDGET_BYTES);
    expect(de + en).toBeGreaterThan(ATTACH_BUDGET_BYTES);
    expect(attachedBytes(['rulesDe', 'rulesEn'])).toBe(de + en);
    // Every sheet that is not a rulebook fits in one mail together.
    const sheets = ATTACHABLE_DOCS.filter((d) => d.id !== 'rulesDe' && d.id !== 'rulesEn').map((d) => d.id);
    expect(attachedBytes(sheets)).toBeLessThan(ATTACH_BUDGET_BYTES);
  });
});

// ---------------------------------------------------------------------------
// The card under the form
// ---------------------------------------------------------------------------

const card = (page: Page) => page.getByTestId('attach-docs');
const total = (page: Page) => page.getByTestId('attach-docs-total');
const regionalProtocol = (page: Page) =>
  card(page).getByRole('checkbox', { name: /Spielprotokoll Regional|Regional & junior league match protocol/ });
/** The picker is folded to what is ticked; the whole catalogue is behind this. */
const openPicker = (page: Page) =>
  card(page).getByRole('button', { name: /Dokumente auswählen|Weitere Dokumente|Choose documents|More documents/ }).click();

/** What is on disk for the open form — the enclosures column only. */
function storedAttachedDocs(page: Page): Promise<string[][]> {
  return page.evaluate(() => new Promise<string[][]>((resolve, reject) => {
    const open = indexedDB.open('svrz-drafts', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('form-drafts')) {
        open.result.createObjectStore('form-drafts', { keyPath: 'id' });
      }
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('form-drafts', 'readonly').objectStore('form-drafts').getAll();
      req.onsuccess = () => {
        const rows = req.result as Array<{ status: string; attachedDocs?: string[] }>;
        db.close();
        resolve(rows.filter((r) => r.status === 'editing').map((r) => r.attachedDocs ?? []));
      };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  }));
}

test.describe('Attaching documents to a report', () => {
  test.beforeEach(async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
  });

  test('the card sits under Tips & Tricks and starts empty and folded', async ({ page }) => {
    await expect(card(page).getByRole('heading', { name: /Dokumente beilegen|Attach documents/ })).toBeVisible();
    await expect(total(page)).toHaveText(/Keine Beilagen|No enclosures/);
    // Nothing ticked, nothing listed: twenty-one rows on a phone are a long
    // way to scroll past on the way to Senden.
    await expect(card(page).getByRole('checkbox')).toHaveCount(0);
    await openPicker(page);
    expect(await card(page).getByRole('checkbox').count()).toBe(ATTACHABLE_DOCS.length);
    // Grouped the way Home groups them, so a coach finds the protocol where
    // they last saw it.
    await expect(card(page).getByRole('heading', { name: /^(Coaching)$/ })).toBeVisible();
    await expect(card(page).getByRole('heading', { name: /^(Regeln|Rules)$/ })).toBeVisible();
    // Nothing that is not a PDF.
    await expect(card(page).getByText(/Video-Anleitung|Video guide|Leeres Formular|Blank form|rsk@svrz\.ch/)).toHaveCount(0);
  });

  test('a ticked document is counted, sized, kept in the draft and shown folded', async ({ page }) => {
    await openPicker(page);
    await regionalProtocol(page).check();
    await expect(total(page)).toHaveText(/1 (Beilage|enclosure) · \d+ KB (von|of) 10 MB/);
    // On disk, keyed by id — the autosave commits within a couple of seconds.
    await expect.poll(() => storedAttachedDocs(page), { timeout: 10_000 }).toEqual([['spielprotokollRegional']]);

    // Folded again, the ticked one is all that is left on screen — and still
    // there to untick.
    await card(page).getByRole('button', { name: /Liste einklappen|Fold the list/ }).click();
    await expect(card(page).getByRole('checkbox')).toHaveCount(1);
    // click(), not uncheck(): the row leaves the folded list the moment it is
    // unticked, and uncheck() waits to read a state off an element that is gone.
    await regionalProtocol(page).click();
    await expect(total(page)).toHaveText(/Keine Beilagen|No enclosures/);
    await expect(card(page).getByRole('checkbox')).toHaveCount(0);
  });

  test('the second rulebook is greyed once the first is ticked', async ({ page }) => {
    await openPicker(page);
    const de = card(page).getByRole('checkbox', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ });
    const en = card(page).getByRole('checkbox', { name: /FIVB Volleyball Rules/ });
    await expect(en).toBeEnabled();
    await de.check();
    await expect(total(page)).toHaveText(/1 (Beilage|enclosure) · 7\.\d MB (von|of) 10 MB/);
    // 7.3 + 5.2 MB would bounce off a strict mailbox — refused here rather than
    // accepted and then refused by the server.
    await expect(en).toBeDisabled();
    // A small sheet still fits beside it.
    await expect(regionalProtocol(page)).toBeEnabled();
    await de.uncheck();
    await expect(en).toBeEnabled();
  });

  test('the confirmation names the enclosures and the submit carries their ids', async ({ page }) => {
    test.slow(); // fills the whole form and signs twice — past 30 s on a GitHub runner
    let body: { formData?: { attachedDocs?: string[] } } | null = null;
    await page.route('**/api/feedback/submit', async (r) => {
      body = r.request().postDataJSON();
      await r.fulfill({ status: 201, json: { id: 'fb1', emailSent: true } });
    });
    await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
      json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
    }));

    await fillWholeForm(page);
    await openPicker(page);
    await regionalProtocol(page).check();
    await card(page).getByRole('checkbox', { name: /^Sanktionen|^Sanctions/ }).check();

    await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
    const enclosures = page.getByTestId('confirm-enclosures');
    await expect(enclosures).toBeVisible();
    await expect(enclosures).toContainText(/Spielprotokoll Regional|Regional & junior league match protocol/);
    await expect(enclosures).toContainText(/Sanktionen|Sanctions/);

    await page.getByRole('dialog').getByRole('button', { name: /^(Save|Speichern)$/ }).click();
    await expect.poll(() => body).not.toBeNull();
    // Catalogue order, whatever order they were ticked in.
    expect(body!.formData!.attachedDocs).toEqual(['spielprotokollRegional', 'sanktionen']);
  });
});

// ---------------------------------------------------------------------------
// The server's half, pinned from its source: the route needs PocketBase and
// SMTP, and neither exists here.
// ---------------------------------------------------------------------------

test.describe('Enclosures on the server (source)', () => {
  const start = SERVER.indexOf("app.post('/api/feedback/submit'");
  const submit = SERVER.slice(start, SERVER.indexOf('\n});\n', start));

  test('ids are validated against the catalogue and an unknown one is refused, not dropped', () => {
    expect(submit).toContain('normalizeAttachedDocs(requestedDocs)');
    expect(submit).toContain('Unbekannte Beilage:');
    // The cleaned list is what the record stores.
    expect(submit).toContain('formData.attachedDocs = attachedDocs');
  });

  test('the bytes are fetched before the game lock and measured against the budget', () => {
    const load = submit.indexOf('await loadEnclosures(attachedDocs)');
    const lock = submit.indexOf('await acquireGameLock(');
    expect(load).toBeGreaterThan(-1);
    expect(load).toBeLessThan(lock);
    expect(submit).toContain('enclosedBytes > ATTACH_BUDGET_BYTES');
    // A document that cannot be had fails the submit with a message naming
    // the problem, so nothing goes out without what the coach chose.
    expect(submit).toContain('Eine Beilage konnte gerade nicht geladen werden');
  });

  test('they are attached to the mail, after the report, and named in the body', () => {
    const attachments = submit.slice(submit.indexOf('const attachments = emailAttachments(['), submit.indexOf(']);', submit.indexOf('const attachments = emailAttachments([')));
    expect(attachments.indexOf('filename: attachmentName')).toBeLessThan(attachments.indexOf('...enclosures.map'));
    expect(attachments).toContain("contentType: 'application/pdf'");
    // The one send (referee To:, RC Cc:, commission Bcc:) carries the array.
    const send = submit.slice(submit.indexOf('const sendOutcome = await sendMailResilient({'), submit.indexOf('}) as { messageId'));
    expect(send).toContain('attachments,');
    // The body lists them, in both languages, in the same panel idiom as the tips.
    expect(submit).toContain('enclosures: enclosures.map((e) => [e.doc.DE.title, e.doc.EN.title]');
    const builder = SERVER.slice(SERVER.indexOf('function buildTemplatedEmail'), SERVER.indexOf('function emailCodeBox'));
    expect(builder).toContain('Beilagen · Enclosures');
    expect(builder).toContain("text += `\\n--- Beilagen · Enclosures ---\\n");
  });

  test('the attachment keeps its German title as a name, umlauts included', () => {
    const fn = SERVER.slice(SERVER.indexOf('function enclosureFilename'), SERVER.indexOf('async function loadEnclosure('));
    expect(fn).toContain('doc.DE.title');
    // Only what a filesystem or a mail header cannot carry is replaced — no
    // `\w`-class sweep that turns Gebührenordnung into Geb_hrenordnung.
    expect(fn).not.toContain('[^\\w');
    expect(fn).toContain('.pdf');
  });
});
