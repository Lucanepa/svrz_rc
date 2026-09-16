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
 *
 * The rule cuts both ways, and the last test guards the other edge: a
 * paragraph a mail drops on purpose has to drop in both languages, or the
 * reader is left with the English half of a sentence the German never said.
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

/** Source text of the handler registered for `path`, to its top-level `});`. */
function routeBody(path: string): string {
  const start = SRC.indexOf(`app.post('${path}'`);
  expect(start, `${path} still exists`).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n});\n', start);
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

/**
 * The mirror of the rule: a paragraph dropped on purpose drops BOTH halves.
 *
 * The feedback template's outro is the survey's lead-in ("Wir freuen uns über
 * dein Feedback zum Coaching-Erlebnis:"), and the copy to the RC and the
 * commission has no survey button under it — the token is the referee's and
 * must not travel to anyone else. The copy blanked `outro` alone, so it ended
 * on the muted English half, "We would be glad to hear how you found the
 * coaching:", a colon promising a button that was not there. That is the mail
 * the RC found in his own inbox on 15.09.2026.
 *
 * Read from the source: the demo at #/demo composes ONE German mail with the
 * lead-in kept (`buildDemoEmail` in src/lib/demo.ts) and never the copy, so
 * there is no rendered message anywhere in this suite to read it from.
 */
test('the RC copy of the feedback mail drops the survey lead-in in both languages', () => {
  const submit = routeBody('/api/feedback/submit');
  // The copy is the render without a link; the referee's keeps the token.
  expect(submit).toContain('const built = renderFeedbackMail(surveyUrl);');
  expect(submit).toContain("const builtForCopies = surveyUrl ? renderFeedbackMail('') : built;");
  // The exact line, both fields — `outro: ''` on its own is the bug.
  expect(submit).toContain("tpl: linkForThisCopy ? feedbackTpl : { ...feedbackTpl, outro: '', outroEn: '' },");

  // And those two fields are what the renderer prints, in both parts of the
  // mail: a template that blanks both leaves no lead-in in either language.
  const renderer = SRC.slice(SRC.indexOf('function buildTemplatedEmail('), SRC.indexOf('function emailCodeBox('));
  expect(renderer).toContain("const outroEn = r(opts.tpl.outroEn ?? '');");
  expect(renderer).toContain('bilingualBlockHtml(outro, outroEn)');
  expect(renderer).toContain('bilingualText(outro, outroEn)');
});

test('the feedback intro points at the attachment, and the old "Hier ist" wording is retired', () => {
  // The body of the feedback mail carries the match rows and nothing of the
  // feedback itself — that is the PDF — so "Hier ist das Feedback" over those
  // rows pointed at nothing. The shipped text now names the attachment, in
  // both halves, and greets by first name.
  expect(SRC).toContain("intro: 'Hallo {{vorname}}\\n\\nIm Anhang findest du das Feedback zu deinem Einsatz als {{rolle}}.'");
  expect(SRC).toContain("introEn: 'Hello {{firstName}}\\n\\nAttached you will find the feedback on your appearance as {{role}}.'");
  // A stored copy of the previous wording must still count as "shipped", or
  // every console that ever pressed Save would keep the old sentence for good.
  expect(SRC).toMatch(/RETIRED_EMAIL_TEMPLATES_FEEDBACK_DE = \{[\s\S]*?intro: 'Hallo \{\{name\}\}\\n\\nHier ist das Feedback zu deinem Einsatz als \{\{rolle\}\}\. Der vollständige Bericht ist als PDF angehängt\.'/);
  expect(SRC).toMatch(/RETIRED_EMAIL_TEMPLATES[\s\S]*feedback: \[\{[\s\S]*?\.\.\.RETIRED_EMAIL_TEMPLATES_FEEDBACK_DE[\s\S]*?\}, \{[\s\S]*?\.\.\.RETIRED_EMAIL_TEMPLATES_FEEDBACK_DE[\s\S]*?introEn: 'Hello \{\{name\}\}\\n\\nHere is the feedback on your appearance as \{\{role\}\}/);
});
