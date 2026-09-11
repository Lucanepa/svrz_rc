import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every mail this system sends carries German AND English — German first.
 *
 * Not a style rule: the referee list is Swiss-German, but a real share of the
 * region reads the English half more comfortably, and a mail that arrives in
 * only one of them is a mail somebody skips. The three admin-editable templates
 * (feedback, reminder, survey) have rendered both halves for a while; the mails
 * composed in code had drifted to German-only one at a time, each with a
 * comment explaining why *that* one was the exception.
 *
 * This test reads the source rather than a rendered message, because the mails
 * it guards need PocketBase, an SMTP transport and a signed-in RC to compose —
 * none of which exist here. What it can prove is the thing that actually
 * regressed: a new `sendMailResilient` call that never reaches for either
 * bilingual helper, which is what German-only looks like from the outside.
 */

// The specs run as ES modules, so `__dirname` is not defined — and a path
// relative to cwd would depend on where playwright was invoked from.
const HERE = dirname(fileURLToPath(import.meta.url));
const server = (file: string) => readFileSync(join(HERE, '..', 'server', file), 'utf8');
const SRC = server('index.ts');

/** Source text from `async function <name>(` to the next top-level `}`. */
function fnBody(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`);
  expect(start, `${name} still exists`).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start, end === -1 ? undefined : end);
}

// The mails composed in code, each named by the function that builds it. The
// three templated ones are covered separately below: their words live in the
// database, not here.
const COMPOSED = [
  'alertBoerseOffers',
  'sendRcGameNoteNotification',
  'sendCredentialCodeEmail',
];

for (const name of COMPOSED) {
  test(`${name} writes both languages`, () => {
    const body = fnBody(name);
    // Either helper counts: `bilingualBlockHtml` for prose, `bilingualText`
    // for the plain-text part. A mail using neither is German-only.
    expect(body, 'HTML half').toMatch(/bilingualBlockHtml\(/);
    expect(body, 'text half').toMatch(/bilingualText\(/);
  });
}

test('the survey notification labels its rows in both languages', () => {
  // This one composes no prose of its own — it fills the `survey` template,
  // which is already bilingual. Its own contribution is the detail table.
  const body = fnBody('sendSurveyNotification');
  expect(body).toMatch(/'Datum\|Date'/);
  expect(body).toMatch(/'Spiel Nr\.\|Match no\.'/);
});

test('a detail-row label splits on the pipe and mutes the English half', () => {
  // The convention the row labels rely on. If `detailRowsHtml` ever stopped
  // splitting, every `'Datum|Date'` above would print the pipe at the reader.
  const helper = SRC.slice(SRC.indexOf('function detailRowsHtml'));
  expect(helper).toMatch(/k\.split\('\|'\)/);
});

test('bilingualText separates the halves with a rule, not a blank line', () => {
  // A blank line is invisible to a screen reader and to anyone quoting the
  // mail back — the two languages run together into one paragraph.
  const helper = SRC.slice(SRC.indexOf('function bilingualText'), SRC.indexOf('function detailRowsHtml'));
  expect(helper).toContain('--');
});

/**
 * The one deliberate exception, pinned so it stays deliberate.
 *
 * The error digest goes to one developer mailbox and is a list of stack traces;
 * it was switched to English on purpose (commit "Write the error alert mail in
 * English"). If somebody makes it bilingual later that is a decision, not a
 * bug — but it should be made on purpose, and this test is where it surfaces.
 */
test('the error alert is English by design', () => {
  const alerts = server('erroralerts.ts');
  expect(alerts).not.toMatch(/bilingualBlockHtml|bilingualText/);
});
