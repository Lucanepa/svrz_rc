import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The day-before reminder, as the commission wants it read: the league on its
// own line, the meeting times spelt out (45' before, ~30' after), and the fact
// that the coach is in Cc and gets the reply. Read from the source, like
// mail-bilingual.spec.ts, because rendering it needs PocketBase and SMTP.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');

/** The shipped reminder template, both halves, as one string. */
const reminderDefault = (): string => {
  const start = SRC.indexOf('  reminder: {', SRC.indexOf('const DEFAULT_EMAIL_TEMPLATES'));
  const end = SRC.indexOf('\n  },\n', start);
  return SRC.slice(start, end);
};

test('the league sits on its own line, in both languages', () => {
  const tpl = reminderDefault();
  expect(tpl).toContain('Spiel: {{heim}} – {{gast}}\nLiga: {{liga}}');
  expect(tpl).toContain('Match: {{heim}} – {{gast}}\nLeague: {{liga}}');
  expect(tpl).not.toContain('({{liga}})');
});

test('the mail says when to meet, that the coach is in Cc, and where a reply goes', () => {
  const tpl = reminderDefault();
  for (const phrase of ['45 Minuten vor Spielbeginn', '30 Minuten', 'in Kopie (Cc)', 'Antwort geht direkt an {{coachVorname}}',
    '45 minutes before the game', '30 minutes', 'copied (Cc)', 'reply goes directly to {{coachVorname}}']) {
    expect(tpl, phrase).toContain(phrase);
  }
});

test('a stored copy of a shipped wording follows the current default', () => {
  // The console's Speichern writes all three templates back verbatim, so a
  // stored template equal to what this file once shipped was never customised.
  expect(SRC).toContain('if (isShippedTemplate(kind, p)) return def;');
  expect(SRC).toMatch(/RETIRED_EMAIL_TEMPLATES[\s\S]*reminder: \[\{[\s\S]*Spiel: \{\{heim\}\} – \{\{gast\}\} \(\{\{liga\}\}\)/);
});

test('the reply address is the coach, not the sending mailbox', () => {
  // buildRemindersFor sets it on every plan; both senders pass it through.
  expect(SRC).toContain('replyTo: rcEmail,');
  expect(SRC.match(/replyTo: p(?:lan)?\.replyTo \|\| undefined/g)?.length).toBe(2);
});

test('running prose is justified; the detail rows keep their left edge', () => {
  expect(SRC).toContain('text-align:justify;${mailText(14, colour)}');
});
