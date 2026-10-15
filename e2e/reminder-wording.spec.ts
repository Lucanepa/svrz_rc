import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meetMinutesBefore } from '../src/lib/reminder';

// The day-before reminder, as the commission wants it read: the league on its
// own line, the meeting times spelt out (45' before for 1L, 30' for the rest,
// ~30' after), and the fact that the coach is in Cc and gets the reply. Read
// from the source, like mail-bilingual.spec.ts, because rendering it needs
// Postgres and SMTP.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');

/** The shipped reminder template, both halves, as one string: the two body
 *  builders and the template that calls them. */
const reminderDefault = (): string => {
  const start = SRC.indexOf('const reminderIntroDe = ');
  const tpl = SRC.indexOf('  reminder: {', SRC.indexOf('const DEFAULT_EMAIL_TEMPLATES'));
  const end = SRC.indexOf('\n  },\n', tpl);
  return start >= 0 && start < tpl ? SRC.slice(start, end) : '';
};

/** The German and English body as sent, the minutes placeholder filled. */
const reminderBody = (minutes: string): string => {
  const tpl = reminderDefault();
  return tpl.replace(/\$\{minutes\}/g, minutes);
};

test('the league sits on its own line, in both languages', () => {
  const tpl = reminderDefault();
  expect(tpl).toContain('Spiel: {{heim}} – {{gast}}\nLiga: {{liga}}');
  expect(tpl).toContain('Match: {{home}} – {{away}}\nLeague: {{league}}');
  expect(tpl).not.toContain('({{liga}})');
});

test('the mail says when to meet, that the coach is in Cc, and where a reply goes', () => {
  const tpl = reminderBody('45');
  for (const phrase of ['45 Minuten vor Spielbeginn', '30 Minuten', 'in Kopie (Cc)', 'Antwort geht direkt an {{coachVorname}}',
    '45 minutes before the game', '30 minutes', 'copied (Cc)', 'reply goes directly to {{coachFirstName}}']) {
    expect(tpl, phrase).toContain(phrase);
  }
});

test('the meeting time is a placeholder: 45 minutes for 1L, 30 for every other league', () => {
  const tpl = reminderDefault();
  expect(tpl).toContain("intro: reminderIntroDe('{{treffMinuten}}'),");
  expect(tpl).toContain("introEn: reminderIntroEn('{{meetMinutes}}'),");
  expect(tpl).toContain('{{coachVorname}} ${minutes} Minuten vor Spielbeginn');
  expect(tpl).toContain('at the hall ${minutes} minutes before the game');
  // Both names render, from the game's league, and the editor offers them.
  expect(SRC).toContain('treffMinuten: meetMinutes,');
  expect(SRC).toContain('colleagueFirstName: colleagueFirst, meetMinutes,');
  expect(SRC).toContain("const EMAIL_PLACEHOLDERS_REMINDER_EXTRA = ['kollege', 'kollegeVorname', 'treffMinuten'];");
  expect(SRC).toContain("const EMAIL_PLACEHOLDERS_REMINDER_EXTRA_EN = ['colleague', 'colleagueFirstName', 'meetMinutes'];");

  for (const league of ['1L ♀ C', '1L ♀ D', '1L ♂ D', '1L']) expect(meetMinutesBefore(league), league).toBe(45);
  for (const league of ['2L ♀', '3L ♂ A', '5L ♀ D', 'DU23 1. Liga', 'HU23 1. Liga', 'Mobiliar Volley Cup ♂', 'Züri Cup ♀', '', '11L'])
    expect(meetMinutesBefore(league), league).toBe(30);
});

test('a stored copy of a shipped wording follows the current default', () => {
  // The console's Speichern writes all three templates back verbatim, so a
  // stored template equal to what this file once shipped was never customised.
  expect(SRC).toContain('if (isShippedTemplate(kind, p)) return def;');
  expect(SRC).toMatch(/RETIRED_EMAIL_TEMPLATES[\s\S]*reminder: \[\{[\s\S]*Spiel: \{\{heim\}\} – \{\{gast\}\} \(\{\{liga\}\}\)/);
  // …and the text that said 45 minutes for every league, until 15.10.2026.
  expect(SRC).toMatch(/reminder: \[\{\s*\/\/ Until 15\.10\.2026[^\n]*\n\s*\.\.\.DEFAULT_EMAIL_TEMPLATES\.reminder,\s*intro: reminderIntroDe\('45'\),\s*introEn: reminderIntroEn\('45'\),/);
});

test('the reply address is the coach, not the sending mailbox', () => {
  // buildRemindersFor sets it on every plan; both senders pass it through.
  expect(SRC).toContain('replyTo: rcEmail,');
  expect(SRC.match(/replyTo: p(?:lan)?\.replyTo \|\| undefined/g)?.length).toBe(2);
});

test('running prose is justified; the detail rows keep their left edge', () => {
  expect(SRC).toContain('text-align:justify;${mailText(14, colour)}');
});
