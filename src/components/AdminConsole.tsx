import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Gauge, Lock, User, Eye, EyeOff, Loader2, LogOut, Upload, Plus, Trash2, Pencil, Check, X, Users, ShieldCheck, Settings as SettingsIcon, FlaskConical, Languages, ChevronDown, ChevronUp, Home, Target, Mail, RotateCcw, Send, ScrollText, Pause, Play, Copy, MessageSquare, UserX, ClipboardList } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { cn } from '../lib/utils';
import {
  getAdminAuthStatus, adminUiLogin, logoutAdmin, getAuthMe, getGamesSyncStatus,
  listCoachees, createCoachee, updateCoachee, deleteCoachee, importCoachees,
  listRcPeopleFull, createRcPerson, updateRcPerson, deleteRcPerson,
  getCredentials, setCredential, requestCredentialCode, type CredentialSlotInfo,
  getAdminShortcutRcs, setAdminShortcutRcs,
  loadRcOverview, listRefereeCoachPeople, assignRcToGame,
  getSettings, putSettings, loadEligibleGames,
  getEmailTemplates, putEmailTemplates, placeholdersFor, getReminderPreview, createGame, deleteGame, listManualGames,
  getSurveyConfig, putSurveyConfig,
  getAdminLogs, getAdminLogSessions, listSurveyResponses, syncCoacheeContacts, listPresidentNotes,
  syncGames, type GamesSyncStatus,
  type PresidentNote,
  type Coachee, type RcPerson, type ImportRow, type EmailTemplate, type EmailTemplateKind, type EmailTemplates, type ReminderPreview, type ManualGame,
  type LogEntry, type LogSession, type SurveyResponse,
} from '../lib/pocketbase';
import {
  levelKey, levelDisplay, hasNiveauRules, summarizeTarget, isTargetActive,
  resolveNiveauTable, niveauOverrides, sameNiveauRow, divisionsFor,
  NIVEAU_LEVELS, NIVEAU_TABLE,
  type CoacheeTarget, type CoacheeTargetMap, type TargetRole,
  type NiveauMatrix, type NiveauColumn,
} from '../lib/niveauTargets';
import {
  DEFAULT_SURVEY_CONFIG, SURVEY_SCALES, SURVEY_SCALE_IDS, SURVEY_LIMITS,
  answerLabel, questionLabel, surveyQuestionId,
  type SurveyConfig, type SurveyQuestion, type SurveyScaleId,
} from '../lib/survey';
import { bySurname } from '../lib/coacheeName';
import { confirmDialog, toast } from './ui';
import { OBSERVATION_GOAL, goalForMandate, type RcMandate, type RcMandateMap , type RcOverviewEntry, type EligibleGame } from '../types';
import LevelText from './LevelText';
import { Skeleton, SkeletonRows } from './Skeleton';
import { BUILD_INFO } from '../lib/buildInfo';

type Lang = 'DE' | 'EN';
const NOW = new Date();
const CUR_SEASON = NOW.getMonth() <= 7 ? NOW.getFullYear() - 1 : NOW.getFullYear();
const SEASONS = [CUR_SEASON, CUR_SEASON + 1, CUR_SEASON + 2];
const seasonLabel = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

// SR-Niveau & Stufe scale (svrz.ch), lowest -> highest
const STUFEN = ['N4-3', 'N4-2', 'N4-1', 'N3-3', 'N3-2', 'N3-1', 'N2-2', 'N2-1', 'N1'];
function joinStufe(level?: string, stage?: string): string { if (!level) return ''; return stage ? `${level}-${stage}` : level; }
function splitStufe(v: string): { referee_level: string; stage: string } {
  if (!v) return { referee_level: '', stage: '' };
  if (v.indexOf('-') < 0) return { referee_level: v, stage: '' };
  const [lvl, st] = v.split('-'); return { referee_level: lvl, stage: st || '' };
}

const GROUP_MAP: Record<string, string> = { 'B': 'Beförderung', 'B?': 'Beförderung?', 'RC': 'Referee Coaching', '2.SR': '2. Schiedsrichter', '2. SR': '2. Schiedsrichter', '1.SR': '1. Schiedsrichter', '1. SR': '1. Schiedsrichter', 'Neu-SR 24/25': 'Neu-Schiedsrichter 24/25', 'Neu-SR 25/26': 'Neu-Schiedsrichter 25/26', 'Neu-SR 26/27': 'Neu-Schiedsrichter 26/27', 'Neu26/27': 'Neu-Schiedsrichter 26/27' };
function mapGroups(s: string): string {
  const out: string[] = [];
  for (const p of s.split('/').map((x) => x.trim()).filter(Boolean)) { if (/^\d{2}$/.test(p) && out.length) out[out.length - 1] += '/' + p; else out.push(p); }
  return out.map((g) => GROUP_MAP[g] || g).join('/');
}

const STR = {
  DE: {
    admin: 'Admin', logout: 'Abmelden', login: 'Anmelden', adminUser: 'Benutzername', adminPw: 'Admin-Passwort',
    // Which half was wrong is deliberately not said — the server does not tell
    // the client either.
    wrongCreds: 'Benutzername oder Passwort falsch',
    consoleIntro: 'Eigener Zugang für diese Seite — nicht der Team-Login der App.',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Einstellungen', testBadge: 'Testmodus',
    emails: 'E-Mails', logs: 'Protokoll', survey: 'RC-Feedback',
    surveyHint: 'Rückmeldungen der Schiedsrichter:innen zum RC-Besuch — nur hier sichtbar. Alle Fragen sind freiwillig, leere Antworten fehlen entsprechend.',
    surveyEmpty: 'Noch keine Rückmeldungen.',
    surveyAnon: 'Anonym',
    notes: 'RC-Notizen',
    notesHint: 'Vertrauliche Notizen der Referee Coaches zu bereits abgeschickten Feedbacks — nur hier sichtbar. Der Schiedsrichter erfährt nichts davon.',
    notesEmpty: 'Noch keine Notizen.',
    notesBy: (author: string, rc: string) => `${author} (zu ${rc}s Beobachtung)`,
    logsHint: 'Alles, was passiert: jede Anfrage, jeder Klick in der App, jeder Fehler. Neueste zuletzt.',
    logsSearch: 'Suchen (E-Mail, Pfad, Text…)', logsLevel: 'Stufe', logsSource: 'Quelle', logsAll: 'Alle',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'Keine Einträge.',
    logsCopy: 'Kopieren', logsCopied: 'Kopiert ✓', logsSessions: 'Sitzungen', logsClear: 'Filter zurücksetzen',
    logsErrorsOnly: 'Nur Probleme',
    tplFeedback: 'Feedback-E-Mail (nach dem Spiel)',
    tplFeedbackHint: 'Wird nach dem Absenden eines Feedbacks an den Coachee gesendet (RC in Kopie, PDF im Anhang).',
    tplReminder: 'Erinnerung (Tag vor dem Spiel)',
    tplReminderHint: 'Wird am Vortag an jeden Coachee gesendet, dessen Spiel ein RC übernommen hat (RC in Kopie). Sind beide SR Coachees, erhält jeder eine eigene E-Mail.',
    tplSurvey: 'RC-Feedback-Benachrichtigung',
    tplSurveyHint: 'Geht an die RC-Kommission, sobald jemand den Fragebogen abgeschickt hat. Die Antworten hängen automatisch darunter — anonyme Rückmeldungen ohne Namen.',
    tplSubject: 'Betreff', tplHeading: 'Titel (optional)', tplIntro: 'Text', tplOutro: 'Schluss / Grussformel',
    tplPlaceholders: 'Platzhalter (werden automatisch ersetzt):',
    tplUnknown: 'Orange markierte Platzhalter kennt diese E-Mail nicht — sie bleiben im Versand leer.',
    tplReset: 'Standard wiederherstellen', tplSaved: 'Gespeichert ✓',
    form: 'Fragebogen',
    formHint: 'Der Fragebogen, den Schiedsrichter:innen nach einem RC-Besuch ausfüllen (Link in der Feedback-E-Mail). Änderungen gelten ab dem nächsten Aufruf; die Antworten liest weiterhin nur die RC-Vorsitzende.',
    formIntroTitle: 'Titelzeile & Einleitung',
    formEyebrow: 'Titelzeile',
    formIntro: 'Einleitung',
    formQuestions: 'Fragen',
    formCount: (n: number) => `${n} Frage${n === 1 ? '' : 'n'}`,
    formAdd: 'Frage hinzufügen',
    formType: 'Antworttyp',
    formTypeText: 'Freitext',
    formQuestionDe: 'Frage (Deutsch)', formQuestionEn: 'Frage (Englisch)',
    formHintDe: 'Hinweis DE (optional)', formHintEn: 'Hinweis EN (optional)',
    formKey: 'Kennung',
    formKeyHint: 'Unter dieser Kennung werden die Antworten gespeichert. Sie bleibt fest, auch wenn du die Frage umformulierst — so bleiben alte Antworten zur Frage lesbar.',
    formUp: 'Nach oben', formDown: 'Nach unten',
    // Confirm dialogs take a short title and the consequence as the body — the
    // native confirm() had to cram both into one string.
    formDelete: (q: string) => `Frage «${q}» entfernen?`,
    formDeleteNote: 'Bereits gegebene Antworten bleiben gespeichert und erscheinen im RC-Feedback unter ihrer Kennung.',
    // The questionnaire only reaches the server via the Speichern button below,
    // so these two name the draft — a green "entfernt" for an edit that is still
    // one tab switch away from being thrown out would be a plain lie.
    formDeleteOk: 'Frage entfernt — noch nicht gespeichert.',
    formResetTitle: 'Alle Änderungen verwerfen?',
    formResetConfirm: 'Der Standard-Fragebogen wird wiederhergestellt.',
    formResetOk: 'Standard-Fragebogen wiederhergestellt — noch nicht gespeichert.',
    formNeedsText: 'Jede Frage braucht einen deutschen Text.',
    formSaved: 'Gespeichert ✓',
    formLangNote: 'Der Fragebogen ist zweisprachig — Schiedsrichter:innen wählen DE oder EN. Bleibt ein Feld leer, wird die andere Sprache angezeigt.',
    reminderEnabled: 'Erinnerungen aktiv', reminderEnabledHint: 'Wenn aus, wird am Vortag nichts versendet. Der Testmodus unterdrückt den Versand zusätzlich.',
    reminderPreview: 'Vorschau: morgen', reminderPreviewHint: 'Zeigt exakt, was morgen versendet würde — es wird nichts gesendet.',
    reminderNone: 'Für morgen stehen keine Erinnerungen an.',
    importXlsx: 'xlsx importieren', importHint: (s: string) => `Import setzt die Saison ${s}. Bestehende (gleicher Name + Saison) werden aktualisiert.`,
    firstName: 'Vorname', lastName: 'Nachname', level: 'Niveau', stage: 'Niveau', group: 'Gruppe', email: 'E-Mail', phone: 'Telefon',
    add: 'Hinzufügen', count: (n: number, s: string) => `${n} Coachees · Saison ${s}`, loading: 'Lädt…',
    noCoachees: (s: string) => `Keine Coachees für ${s} — importiere eine xlsx.`,
    delCoachee: (n: string) => `Coachee „${n}" löschen?`, delCoacheeOk: (n: string) => `Coachee „${n}" gelöscht.`, addRc: 'Referee Coach hinzufügen', rcCount: (n: number) => `${n} Referee Coaches`,
    noRcs: 'Keine Referee Coaches.', loadFailed: 'Laden fehlgeschlagen.',
    delGroup: (n: string) => `Gruppe „${n}" löschen?`,
    delGroupNote: 'Coachees behalten den Eintrag, bis er dort geändert wird.',
    delGroupOk: (n: string) => `Gruppe „${n}" gelöscht.`,
    renameGroupWarn: (o: string, n: string) => `„${o}" in „${n}" umbenennen?`,
    renameGroupNote: (o: string) => `Coachees mit „${o}" behalten die alte Schreibweise und erscheinen als eigene Gruppe.`,
    renameGroupOk: (o: string, n: string) => `„${o}" in „${n}" umbenannt.`,
    delRc: (n: string) => `RC „${n}" löschen?`, delRcOk: (n: string) => `RC „${n}" gelöscht.`, inactive: 'inaktiv',
    colName: 'Name', colActions: 'Aktionen',
    mgTitle: 'Manuelles Spiel / Testspiel',
    mgHint: 'Für Spiele, die nicht aus VolleyManager kommen. Die SR-Namen müssen exakt einem Coachee entsprechen, sonst findet das Feedback keinen Empfänger. Testspiele danach wieder löschen.',
    mgDate: 'Datum', mgMatchNo: 'Spiel-Nr. (optional)', mgLeague: 'Liga', mgLocation: 'Ort',
    mgHome: 'Heim', mgAway: 'Gast', mgRef1: '1. SR (= Coachee)', mgRef2: '2. SR', mgRc: 'Referee Coach',
    mgCreate: 'Spiel anlegen', mgDelete: 'Löschen',
    mgCreated: (n: string) => `Angelegt: ${n}`,
    noEmail: 'keine E-Mail',
    syncTitle: 'Kontaktdaten aus VolleyManager',
    syncHint: 'Holt E-Mail und Telefon aus der VolleyManager-Schiedsrichterliste. Wer dort fehlt, wird auf den Spielen des Saison gesucht (sobald diese aufgeschaltet sind). Ohne E-Mail lässt sich kein Feedback abschicken.',
    syncBtn: 'Kontakte holen',
    syncOverwrite: 'Vorhandene Einträge überschreiben (sonst werden nur leere Felder gefüllt)',
    syncResult: (u: number, a: number, n: number, f: number) => `${u} aktualisiert, ${a} bereits vollständig, ${n} nicht gefunden (${f} SR in VolleyManager).`,
    syncFail: (e: string) => `Kontakt-Abgleich fehlgeschlagen: ${e}`,
    syncNotFoundList: 'Nicht in VolleyManager gefunden',
    syncAmbiguous: 'Mehrdeutiger Name — nichts übernommen, bitte von Hand prüfen',
    syncMissingEmail: (n: number, total: number) => `${n} von ${total} Coachees haben keine E-Mail — für diese kann kein Feedback abgeschickt werden.`,
    mgExisting: 'Angelegte Testspiele', mgSearch: 'Spiel suchen …',
    mgNone: 'Keine Testspiele vorhanden.',
    mgConfirmDelete: (n: string) => `Spiel „${n}" wirklich löschen?`,
    mgDeleteOk: (n: string) => `Spiel „${n}" gelöscht.`,
    shortcutToggle: 'Admin-Link in der Toolbar zeigen (nur Anzeige — gibt keine Rechte)',
    games: 'Spiele', overview: 'Übersicht',
    niveau: 'Niveau',
    nvHint: 'Auf welche Spiele ein SR dieser Stufe im Fokus steht — pro Kategorie und Rolle. Angeklickt heisst: das Spiel erscheint in der Spielliste des Coachees. Nichts angeklickt heisst: in dieser Kategorie und Rolle keine Fokus-Spiele („x" in der offiziellen Tabelle).',
    nvOfficial: 'Offizielle Tabelle, Stand 9. April 2026',
    nvReset: 'Auf offizielle Tabelle zurücksetzen',
    nvResetTitle: 'Alle Abweichungen verwerfen?',
    nvResetConfirm: 'Die offizielle Tabelle wird wiederhergestellt.',
    nvResetOk: 'Offizielle Tabelle wiederhergestellt.',
    nvNoChanges: 'Keine Abweichung von der offiziellen Tabelle',
    nvFocus: 'Fokus-Spiele',
    nvNotBlocking: 'Der Fokus blendet nur aus, er sperrt nichts: RC schalten jederzeit auf „Alle Spiele" um und können auch ein Spiel ausserhalb des Fokus übernehmen und beurteilen.',
    nvChanged: (n: number) => `${n} Zelle${n === 1 ? '' : 'n'} weicht von der offiziellen Tabelle ab`,
    nvMen: 'Herren', nvWomen: 'Damen', nvU23: 'U23',
    nv1sr: '1. SR', nv2sr: '2. SR',
    nvU23Men: 'HU23', nvU23Women: 'DU23',
    nvU23MenNote: 'U23 Männer', nvU23WomenNote: 'U23 Frauen',
    nvLevel: 'Niveau · Stufe',
    nvLegend: 'NL = Nationalliga · Zahl = Liga · U23: 1.–3. Liga (im VolleyManager „Stärkeklasse")',
    nvFam: {
      N4: 'regionaler SR ohne Ausbildung zum 2. SR',
      N3: 'regionaler SR mit Ausbildung zum 2. SR',
      N2: 'regionaler SR für nationale Spiele 1. Liga',
      N1: 'Nationalkader',
    } as Record<string, string>,
    gamesHint: 'Ein Spiel einem Referee Coach zuteilen. Die RC übernehmen ihre Spiele sonst selbst — das hier ist der Weg, es für jemanden zu tun.',
    gamesSearch: 'Spiel, Team, Liga oder Halle suchen …',
    gamesNone: 'Keine Spiele gefunden.',
    gamesUnassigned: 'Nur ohne RC',
    ovHint: 'Saisonstand aller Referee Coaches. Die RC selbst sehen in der App nur ihre eigene Zeile.',
    ovName: 'Referee Coach', ovDone: 'Erledigt', ovPlanned: 'Geplant', ovOutstanding: 'Ausstehend',
    ovNone: 'Noch keine Daten für diese Saison.',
    credentials: 'Passwörter', credentialsHint: 'Diese Passwörter öffnen die App und diese Seite. Sie werden nur als Hash gespeichert — ein gesetztes Passwort kann nicht wieder angezeigt, sondern nur ersetzt werden. Notiere es dir jetzt.',
    credShared: 'Team-Login (App)', credSharedHint: 'Das Passwort, das alle Referee Coaches für die App benutzen.',
    credAdmin: 'Admin (diese Seite)', credAdminHint: 'Öffnet diese Konsole.',
    credPresident: 'RC-Präsidium', credPresidentHint: 'Öffnet nur die Umfrage- und Notiz-Tabs. Admin-Rechte öffnen diese nicht.',
    credUser: 'Benutzername', credNew: 'Neues Passwort', credSave: 'Passwort setzen',
    credSendCode: 'Bestätigungscode senden', credCode: '6-stelliger Code',
    credCodeSent: (to: string) => `Code an ${to} gesendet. 10 Minuten gültig.`,
    credCodeWhy: 'Eine Passwortänderung wird per E-Mail-Code bestätigt.',
    credChangeCancel: 'Abbrechen',
    credFeedsRevoked: 'Alle Kalender-Abos wurden ungültig — die RC brauchen einen neuen Link (Kalender-Dialog in der App).',
    credSaved: (u: string) => `Gespeichert. Ab sofort gilt: ${u} + das neue Passwort.`,
    credFromEnv: 'Noch aus der Server-Konfiguration',
    credNeverSet: 'Nicht gesetzt — dieser Zugang ist geschlossen',
    credChangedAt: (d: string, by: string) => `Zuletzt geändert ${d}${by ? ` von ${by}` : ''}`,
    credTooShort: (n: number) => `Mindestens ${n} Zeichen.`,
    defaultSeason: 'Standard-Saison', defaultSeasonHint: 'Die Saison, in der die App standardmässig startet (für neue Nutzer).',
    save: 'Speichern', saved: 'Gespeichert ✓', testTitle: 'Test-Modus (E-Mail)',
    testHint: 'Wenn aktiv, werden keine E-Mails versendet (Feedback wird trotzdem gespeichert). Zum Live-Betrieb ausschalten.',
    testOn: 'AN — es werden keine E-Mails versendet.', testOff: 'AUS — E-Mails werden versendet.',
    noRows: 'Keine Zeilen in der Datei gefunden.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} neu, ${u} aktualisiert (von ${t}).`,
    importFail: (e: string) => `Import fehlgeschlagen: ${e}`,
    groups: 'Gruppen', groupsHint: 'Gruppen für Coachees. Mehrfachauswahl wird mit „/" verbunden.', newGroup: 'Neue Gruppe', chooseGroups: 'Gruppe(n)', toApp: 'Zur App',
    target: 'Fokus-Spiele', targetHint: 'Auf welche Spiele dieser SR im Fokus steht. Standard: automatisch aus dem Niveau (offizielle SVRZ-Tabelle, Tab „Niveau").',
    targetAuto: 'Auto (Niveau)', targetAll: 'Alle Spiele', targetCustom: 'Eigen', targetRoles: 'Rolle(n)', targetLeagues: 'Ligen', chooseLeagues: 'Ligen wählen', edit: 'Bearbeiten', deleteLabel: 'Löschen', resetLabel: 'Zurücksetzen', renameLabel: 'Umbenennen', done: 'Fertig',
    // Body text for the confirms whose title already names what disappears.
    undoWarn: 'Das kann nicht rückgängig gemacht werden.',
    colMandate: 'Pensum', mandateLabel: 'Pensum (Beobachtungen pro Saison)',
    mandateHint: (fallback: number) => `Wie viele Beobachtungen dieser RC pro Saison übernimmt. Leer = Standard (${fallback}). 0 ist erlaubt und schränkt nichts ein — das Pensum ist rein informativ.`,
    defaultGoal: 'Standard-Pensum',
    defaultGoalHint: () => 'Beobachtungen pro Saison für alle RC, die kein eigenes Pensum haben. Einzelne Pensen (auch 0) werden im Tab „Referee Coaches" gesetzt.',
  },
  EN: {
    admin: 'Admin', logout: 'Sign out', login: 'Sign in', adminUser: 'Username', adminPw: 'Admin password',
    wrongCreds: 'Wrong username or password',
    consoleIntro: 'This page has its own login — not the team credential used for the app.',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Settings', testBadge: 'Test mode',
    emails: 'Emails', logs: 'Activity log', survey: 'RC feedback',
    surveyHint: 'Referees’ feedback on the RC visit — visible only here. Every question is optional, so blank answers are simply missing.',
    surveyEmpty: 'No responses yet.',
    surveyAnon: 'Anonymous',
    notes: 'RC notes',
    notesHint: 'Confidential notes referee coaches wrote on feedback they have already sent — visible only here. The referee is never told about them.',
    notesEmpty: 'No notes yet.',
    notesBy: (author: string, rc: string) => `${author} (on ${rc}'s observation)`,
    logsHint: 'Everything that happens: every request, every click in the app, every error. Newest last.',
    logsSearch: 'Search (email, path, text…)', logsLevel: 'Level', logsSource: 'Source', logsAll: 'All',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'No entries.',
    logsCopy: 'Copy', logsCopied: 'Copied ✓', logsSessions: 'Sessions', logsClear: 'Reset filters',
    logsErrorsOnly: 'Problems only',
    tplFeedback: 'Feedback email (after the match)',
    tplFeedbackHint: 'Sent to the coachee when a feedback is submitted (RC in CC, PDF attached).',
    tplReminder: 'Reminder (day before the match)',
    tplReminderHint: 'Sent the day before to every coachee whose game an RC has taken (RC in CC). If both referees are coachees, each gets their own email.',
    tplSurvey: 'RC feedback notification',
    tplSurveyHint: 'Goes to the RC commission as soon as somebody submits the questionnaire. The answers are appended automatically — anonymous responses without a name.',
    tplSubject: 'Subject', tplHeading: 'Title (optional)', tplIntro: 'Body', tplOutro: 'Closing / sign-off',
    tplPlaceholders: 'Placeholders (filled in automatically):',
    tplUnknown: 'Placeholders marked amber are unknown to this email — they render empty when it is sent.',
    tplReset: 'Restore default', tplSaved: 'Saved ✓',
    form: 'Questionnaire',
    formHint: 'The form referees fill in after an RC visit (linked from the feedback email). Changes take effect the next time it is opened; the responses are still read by the RC chair alone.',
    formIntroTitle: 'Eyebrow & intro',
    formEyebrow: 'Eyebrow',
    formIntro: 'Intro',
    formQuestions: 'Questions',
    formCount: (n: number) => `${n} question${n === 1 ? '' : 's'}`,
    formAdd: 'Add question',
    formType: 'Answer type',
    formTypeText: 'Free text',
    formQuestionDe: 'Question (German)', formQuestionEn: 'Question (English)',
    formHintDe: 'Hint DE (optional)', formHintEn: 'Hint EN (optional)',
    formKey: 'Key',
    formKeyHint: 'Answers are stored under this key. It stays fixed even when you reword the question, so older answers keep reading against it.',
    formUp: 'Move up', formDown: 'Move down',
    formDelete: (q: string) => `Remove the question “${q}”?`,
    formDeleteNote: 'Answers already given stay stored and show up under their key in RC feedback.',
    formDeleteOk: 'Question removed — not saved yet.',
    formResetTitle: 'Discard every change?',
    formResetConfirm: 'The default questionnaire is restored.',
    formResetOk: 'Default questionnaire restored — not saved yet.',
    formNeedsText: 'Every question needs German text.',
    formSaved: 'Saved ✓',
    formLangNote: 'The form is bilingual — referees pick DE or EN. A field left empty falls back to the other language.',
    reminderEnabled: 'Reminders active', reminderEnabledHint: 'When off, nothing is sent the day before. Test mode suppresses sending as well.',
    reminderPreview: 'Preview: tomorrow', reminderPreviewHint: 'Shows exactly what would be sent tomorrow — nothing is sent.',
    reminderNone: 'No reminders due for tomorrow.',
    importXlsx: 'Import xlsx', importHint: (s: string) => `Import targets season ${s}. Existing (same name + season) are updated.`,
    firstName: 'First name', lastName: 'Last name', level: 'Level', stage: 'Niveau', group: 'Group', email: 'Email', phone: 'Phone',
    add: 'Add', count: (n: number, s: string) => `${n} coachees · season ${s}`, loading: 'Loading…',
    noCoachees: (s: string) => `No coachees for ${s} — import an xlsx.`,
    delCoachee: (n: string) => `Delete coachee "${n}"?`, delCoacheeOk: (n: string) => `Coachee "${n}" deleted.`, addRc: 'Add referee coach', rcCount: (n: number) => `${n} referee coaches`,
    noRcs: 'No referee coaches.', loadFailed: 'Could not load.',
    delGroup: (n: string) => `Delete group "${n}"?`,
    delGroupNote: 'Coachees keep the value until it is changed on them.',
    delGroupOk: (n: string) => `Group "${n}" deleted.`,
    renameGroupWarn: (o: string, n: string) => `Rename "${o}" to "${n}"?`,
    renameGroupNote: (o: string) => `Coachees carrying "${o}" keep the old spelling and show up as a separate group.`,
    renameGroupOk: (o: string, n: string) => `Renamed "${o}" to "${n}".`,
    delRc: (n: string) => `Delete RC "${n}"?`, delRcOk: (n: string) => `RC "${n}" deleted.`, inactive: 'inactive',
    colName: 'Name', colActions: 'Actions',
    mgTitle: 'Manual game / test game',
    mgHint: 'For games VolleyManager does not carry. Referee names must match a coachee exactly, otherwise the feedback has no recipient. Delete test games afterwards.',
    mgDate: 'Date', mgMatchNo: 'Match no. (optional)', mgLeague: 'League', mgLocation: 'Venue',
    mgHome: 'Home', mgAway: 'Away', mgRef1: '1st referee (= coachee)', mgRef2: '2nd referee', mgRc: 'Referee coach',
    mgCreate: 'Create game', mgDelete: 'Delete',
    mgCreated: (n: string) => `Created: ${n}`,
    noEmail: 'no email',
    syncTitle: 'Contact details from VolleyManager',
    syncHint: 'Pulls email and phone from the VolleyManager referee list. Anyone missing there is looked up on the season\'s games (once those are published). Feedback cannot be submitted without an email.',
    syncBtn: 'Fetch contacts',
    syncOverwrite: 'Overwrite existing entries (otherwise only empty fields are filled)',
    syncResult: (u: number, a: number, n: number, f: number) => `${u} updated, ${a} already complete, ${n} not found (${f} referees in VolleyManager).`,
    syncFail: (e: string) => `Contact sync failed: ${e}`,
    syncNotFoundList: 'Not found in VolleyManager',
    syncAmbiguous: 'Ambiguous name — nothing written, please check by hand',
    syncMissingEmail: (n: number, total: number) => `${n} of ${total} coachees have no email — feedback cannot be submitted for them.`,
    mgExisting: 'Test games created', mgSearch: 'Search game …',
    mgNone: 'No test games.',
    mgConfirmDelete: (n: string) => `Delete game "${n}"?`,
    mgDeleteOk: (n: string) => `Game "${n}" deleted.`,
    shortcutToggle: 'Show the admin link in their toolbar (display only — grants nothing)',
    games: 'Games', overview: 'Overview',
    niveau: 'Levels',
    nvHint: 'Which games a referee at this level is focused on — per category and role. Lit means the game shows up in that coachee\'s game list. Nothing lit means no focused games in this category and role (an "x" in the official table).',
    nvOfficial: 'Official table, as of 9 April 2026',
    nvReset: 'Reset to the official table',
    nvResetTitle: 'Discard every deviation?',
    nvResetConfirm: 'The official table is restored.',
    nvResetOk: 'Official table restored.',
    nvNoChanges: 'No deviation from the official table',
    nvFocus: 'Focused games',
    nvNotBlocking: 'The focus only hides, it never blocks: coaches can switch to "All games" at any time, and take and assess a game outside the focus.',
    nvChanged: (n: number) => `${n} cell${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} from the official table`,
    nvMen: 'Men', nvWomen: 'Women', nvU23: 'U23',
    nv1sr: '1st ref', nv2sr: '2nd ref',
    nvU23Men: 'HU23', nvU23Women: 'DU23',
    nvU23MenNote: 'U23 men', nvU23WomenNote: 'U23 women',
    nvLevel: 'Niveau · Stufe',
    nvLegend: 'NL = national league · digit = Liga · U23: 1.–3. Liga (“Stärkeklasse” in VolleyManager)',
    nvFam: {
      N4: 'regional referee, not trained as 2nd ref',
      N3: 'regional referee, trained as 2nd ref',
      N2: 'regional referee for national 1. Liga games',
      N1: 'national squad',
    } as Record<string, string>,
    gamesHint: 'Assign a game to a referee coach. Coaches normally take their own games — this is how you do it for someone.',
    gamesSearch: 'Search game, team, league or venue …',
    gamesNone: 'No games found.',
    gamesUnassigned: 'Unassigned only',
    ovHint: 'Season progress for every referee coach. Coaches themselves only ever see their own row in the app.',
    ovName: 'Referee coach', ovDone: 'Done', ovPlanned: 'Planned', ovOutstanding: 'Outstanding',
    ovNone: 'No data for this season yet.',
    credentials: 'Passwords', credentialsHint: 'These passwords open the app and this page. Only a hash is stored — a password that has been set cannot be shown again, only replaced. Write it down now.',
    credShared: 'Team login (app)', credSharedHint: 'The password every referee coach uses for the app.',
    credAdmin: 'Admin (this page)', credAdminHint: 'Opens this console.',
    credPresident: 'RC chair', credPresidentHint: 'Opens the survey and notes tabs only. Admin rights do not open those.',
    credUser: 'Username', credNew: 'New password', credSave: 'Set password',
    credSendCode: 'Send confirmation code', credCode: '6-digit code',
    credCodeSent: (to: string) => `Code sent to ${to}. Valid for 10 minutes.`,
    credCodeWhy: 'A password change is confirmed with an emailed code.',
    credChangeCancel: 'Cancel',
    credFeedsRevoked: 'Every calendar subscription is now invalid — coaches need a fresh link (calendar dialog in the app).',
    credSaved: (u: string) => `Saved. From now on: ${u} + the new password.`,
    credFromEnv: 'Still from the server configuration',
    credNeverSet: 'Not set — this door is closed',
    credChangedAt: (d: string, by: string) => `Last changed ${d}${by ? ` by ${by}` : ''}`,
    credTooShort: (n: number) => `At least ${n} characters.`,
    defaultSeason: 'Default season', defaultSeasonHint: 'The season the app opens to by default (for new users).',
    save: 'Save', saved: 'Saved ✓', testTitle: 'Test mode (email)',
    testHint: 'When on, no emails are sent (feedback is still saved). Turn off for live operation.',
    testOn: 'ON — no emails are sent.', testOff: 'OFF — emails are sent.',
    noRows: 'No rows found in the file.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} new, ${u} updated (of ${t}).`,
    importFail: (e: string) => `Import failed: ${e}`,
    groups: 'Groups', groupsHint: 'Groups for coachees. Multiple selections are joined with "/".', newGroup: 'New group', chooseGroups: 'Group(s)', toApp: 'To app',
    target: 'Focused games', targetHint: 'Which games this referee is focused on. Default: automatic from the level (official SVRZ table, "Levels" tab).',
    targetAuto: 'Auto (level)', targetAll: 'All games', targetCustom: 'Custom', targetRoles: 'Role(s)', targetLeagues: 'Leagues', chooseLeagues: 'Choose leagues', edit: 'Edit', deleteLabel: 'Delete', resetLabel: 'Reset', renameLabel: 'Rename', done: 'Done',
    undoWarn: 'This cannot be undone.',
    colMandate: 'Target', mandateLabel: 'Season target (observations)',
    mandateHint: (fallback: number) => `How many observations this coach takes on per season. Empty = the default (${fallback}). 0 is allowed and restricts nothing — the target is informative only.`,
    defaultGoal: 'Default season target',
    defaultGoalHint: () => 'Observations per season for every coach without their own target. Individual targets (0 included) are set in the "Referee Coaches" tab.',
  },
} as const;
type T = typeof STR['DE'];

const input = 'h-9 w-full px-3 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors';
// Small caps field label. Always inside its <label>, so the control it names
// gets an accessible name from it rather than sitting anonymous next to it.
const fieldLabel = 'block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1';

// Bounds before the parser sees the bytes. `xlsx` is pinned at 0.18.5 — the last
// npm release, carrying CVE-2023-30533 (prototype pollution) and CVE-2024-22363
// (ReDoS), with no upgrade path on npm since SheetJS left the registry. The
// import rows are built from literal keys, so a polluted prototype has no route
// into them; the realistic outcome is a hung or crashed admin tab. A size and
// row cap keeps a malformed file from being one. Move to the SheetJS CDN build
// (>=0.20.2) or exceljs when convenient.
const XLSX_MAX_BYTES = 8 * 1024 * 1024;
const XLSX_MAX_ROWS = 5_000;

async function parseXlsx(file: File): Promise<ImportRow[]> {
  if (file.size > XLSX_MAX_BYTES) {
    throw new Error(`Die Datei ist zu gross (${Math.round(file.size / 1024 / 1024)} MB, max. 8 MB).`);
  }
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (allRows.length > XLSX_MAX_ROWS) {
    throw new Error(`Die Datei hat ${allRows.length} Zeilen (max. ${XLSX_MAX_ROWS}).`);
  }
  const rows = allRows;
  if (!rows.length) return [];
  const NAME_COLS = ['nachname', 'name', 'last', 'lastname'];
  const cells = (row: unknown) => (row as unknown[]).map((h) => String(h).trim().toLowerCase());
  // The header is not always the first row: VolleyManager's "Schiedsrichter
  // verwalten" export spends row 1 on its own title and puts the column names on
  // row 2, which read as a title-only header and imported zero rows. Take the
  // first row that actually carries a name column instead.
  const headerRow = rows.slice(0, 10).findIndex((row) => cells(row).some((h) => NAME_COLS.includes(h)));
  if (headerRow < 0) return [];
  const header = cells(rows[headerRow]);
  const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const ci = { last: col(NAME_COLS), first: col(['vorname', 'first', 'firstname']), email: col(['email', 'e-mail', 'mail', 'e-mail-adresse', 'emailadresse', 'e mail']), phone: col(['telefon', 'telefon-nr.', 'telefon-nr', 'telefonnummer', 'phone', 'mobile', 'natel', 'handy', 'tel', 'tel.']), level: col(['niveau', 'level']), stage: col(['niveaustufe', 'stufe', 'stage']), group: col(['gruppe', 'group', 'groups']), notes: col(['bemerkung', 'bemerkungen', 'notizen', 'notes', 'note', 'kommentar']) };
  // Notes often live in an unnamed column right after Gruppe.
  if (ci.notes < 0 && ci.group >= 0 && !header[ci.group + 1]) ci.notes = ci.group + 1;
  const out: ImportRow[] = [];
  for (const raw of rows.slice(headerRow + 1)) {
    const r = raw as unknown[];
    const last = String(r[ci.last] ?? '').trim();
    const first = String(r[ci.first] ?? '').trim();
    if (!first && !last) continue;
    out.push({ first_name: first, last_name: last, full_name: `${first} ${last}`.trim(), email: String(r[ci.email] ?? '').trim(), phone: String(r[ci.phone] ?? '').trim(), referee_level: String(r[ci.level] ?? '').trim(), stage: String(r[ci.stage] ?? '').trim().replace(/\.0$/, ''), groups: mapGroups(String(r[ci.group] ?? '').trim()), notes: String(r[ci.notes] ?? '').trim() });
  }
  return out;
}

// Console tabs live in the URL as #/admin/<tab>, so each one is linkable and
// the Back button steps between them.
const ADMIN_TABS = ['coachees', 'rcs', 'games', 'overview', 'niveau', 'emails', 'form', 'survey', 'notes', 'logs', 'settings'] as const;
type AdminTab = (typeof ADMIN_TABS)[number];
const adminTabFromHash = (): AdminTab => {
  const m = /^#\/?admin\/([a-z]+)/i.exec(window.location.hash);
  const found = ADMIN_TABS.find((x) => x === m?.[1]?.toLowerCase());
  return found ?? 'coachees';
};

export default function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<AdminTab>(adminTabFromHash);
  // Which credential opened this session. null while unknown: a deep link to
  // #/admin/survey must not bounce the one person allowed to be there just
  // because the check hasn't come back yet.
  const [role, setRole] = useState<'admin' | 'president' | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);
  const [coacheeTargets, setCoacheeTargets] = useState<CoacheeTargetMap>({});
  // Season observation goal: the number a full mandate owes, plus the RCs (by
  // id) who are on a half mandate and owe half of it.
  const [rcMandates, setRcMandates] = useState<RcMandateMap>({});
  const [defaultGoal, setDefaultGoal] = useState<number>(OBSERVATION_GOAL);
  // The SR-Niveau table in force — official values with the admin's edits on top.
  const [niveauTable, setNiveauTable] = useState<NiveauMatrix>(() => resolveNiveauTable(null));
  const [leagueOptions, setLeagueOptions] = useState<string[]>([]);
  const [defaultSeason, setDefaultSeason] = useState<number>(CUR_SEASON);
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('svrz_admin_lang') as Lang) || 'DE'; } catch { return 'DE'; }
  });
  const t = STR[lang];
  const toggleLang = () => setLang((l) => { const n = l === 'DE' ? 'EN' : 'DE'; try { localStorage.setItem('svrz_admin_lang', n); } catch { /* ignore */ } return n; });

  useEffect(() => {
    getAdminAuthStatus()
      // A session with no role on it is an admin one: that is what the server
      // reads a role-less (pre-deploy) cookie as, and answering differently
      // here would strand a signed-in admin on a console that loads nothing.
      .then((s) => { setAuthed(Boolean(s.authenticated)); setRole(s.authenticated ? (s.role ?? 'admin') : null); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  // The chair's two tabs and the admin's five are disjoint sets, so a deep link
  // into the other half lands on that role's own first tab rather than on a
  // page whose every request would 401.
  useEffect(() => {
    if (role === 'president' && tab !== 'survey' && tab !== 'notes') setTab('survey');
    if (role === 'admin' && (tab === 'survey' || tab === 'notes')) setTab('coachees');
    // 'form' edits the questionnaire and is admin-only, even though its
    // subject — the survey — belongs to the chair's half of the console.
  }, [role, tab]);
  // Console-wide data, fetched once and in parallel as soon as the session is
  // known; each tab loads its own rows at the same time (all tabs are mounted).
  useEffect(() => {
    // Console-wide settings are admin-gated; the chair's session would only
    // collect 401s for data none of her two tabs render.
    if (!authed || role !== 'admin') return;
    getSettings()
      .then((s) => {
        setTestMode(Boolean(s.test_mode)); setGroups(s.groups || []); setCoacheeTargets(s.coachee_targets || {});
        setRcMandates(s.rc_mandates || {}); if (s.default_goal) setDefaultGoal(s.default_goal);
        setNiveauTable(resolveNiveauTable(s.niveau_table || null));
        if (s.default_season) setDefaultSeason(s.default_season);
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    loadEligibleGames()
      .then((games) => { setLeagueOptions(Array.from(new Set(games.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort()); })
      .catch(() => {});
  }, [authed, role]);
  // Optimistic with a rollback, like the test-mode toggle next to them. Left
  // silent, a rejected save (expired admin session, 500) showed the new mandate
  // or target as stored while the RC's season goal quietly stayed as it was.
  const [settingsError, setSettingsError] = useState('');
  const saveTargets = useCallback(async (next: CoacheeTargetMap) => {
    let previous: CoacheeTargetMap = {};
    setCoacheeTargets((current) => { previous = current; return next; });
    setSettingsError('');
    try { await putSettings({ coachee_targets: next }); }
    catch (e) { setCoacheeTargets(previous); setSettingsError(e instanceof Error ? e.message : String(e)); }
  }, []);
  // Stored as overrides only: a row that still matches the published table is
  // left out, so a future correction to it reaches this console untouched.
  // Returns whether the write stuck, the same way saveGroups does: the reset
  // button toasts a success, and a rolled-back save must not earn one.
  const saveNiveau = useCallback(async (next: NiveauMatrix) => {
    let previous: NiveauMatrix = {};
    setNiveauTable((current) => { previous = current; return next; });
    setSettingsError('');
    try { await putSettings({ niveau_table: niveauOverrides(next) }); return true; }
    catch (e) { setNiveauTable(previous); setSettingsError(e instanceof Error ? e.message : String(e)); return false; }
  }, []);
  const saveMandates = useCallback(async (next: RcMandateMap) => {
    let previous: RcMandateMap = {};
    setRcMandates((current) => { previous = current; return next; });
    setSettingsError('');
    try { await putSettings({ rc_mandates: next }); }
    catch (e) { setRcMandates(previous); setSettingsError(e instanceof Error ? e.message : String(e)); }
  }, []);
  // Optimistic, but not silent: its two neighbours (groups, mandates) were fixed
  // for exactly this — a rejected save left the new number on screen with no
  // error and no ✓, so it looked stored until the next reload disagreed.
  const saveDefaultGoal = useCallback(async (next: number) => {
    let previous = 0;
    setDefaultGoal((current) => { previous = current; return next; });
    try {
      await putSettings({ default_goal: next });
    } catch (e) {
      setDefaultGoal(previous);
      setSettingsError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  // Tab ↔ URL. pushState keeps the hashchange listener in main.tsx (which
  // reloads on a root change) out of it; popstate handles Back/Forward.
  const didSyncHash = useRef(false);
  const isAdminHash = () => /^#\/?admin(\/|$)/i.test(window.location.hash);
  useEffect(() => {
    if (!isAdminHash()) return; // leaving the console — main.tsx takes over
    const target = `#/admin/${tab}`;
    if (window.location.hash !== target) {
      if (didSyncHash.current) window.history.pushState(null, '', target);
      else window.history.replaceState(null, '', target);
    }
    didSyncHash.current = true;
  }, [tab]);
  useEffect(() => {
    const onPop = () => { if (isAdminHash()) setTab(adminTabFromHash()); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const login = async (e: React.FormEvent) => {
    e.preventDefault(); setSubmitting(true); setError('');
    // The name is trimmed but not lower-cased here — the server does that, so
    // one rule decides it rather than two that can drift apart.
    try {
      const signedInAs = await adminUiLogin(username.trim(), password.trim());
      setRole(signedInAs); setAuthed(true); setPassword('');
    }
    catch { setError(t.wrongCreds); setPassword(''); }
    finally { setSubmitting(false); }
  };
  const logout = async () => { try { await logoutAdmin(); } catch { /* ignore */ } setAuthed(false); };

  if (checking) return <div className="min-h-screen flex items-center justify-center bg-stone-100"><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>;

  if (!authed) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />
            <button onClick={toggleLang} className="absolute right-3 top-3 inline-flex items-center gap-1 text-[11px] font-semibold text-stone-400 hover:text-stone-600"><Languages size={13} />{lang}</button>
            <div className="flex flex-col items-center text-center mb-7">
              <SvrzLogo className="h-11 w-auto" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">{t.admin}</p>
            </div>
            {/* This page has its own password and is not reached by signing
                in to the app — two credentials open it, and which one you type
                decides what you see. */}
            <p className="text-xs text-stone-500 text-center mb-4">{t.consoleIntro}</p>
            <form onSubmit={login} className="space-y-4">
              {/* autoComplete username/current-password, and both fields inside
                  one form: that is the shape a password manager recognises, so
                  the console can be saved and filled like any other login. */}
              <div className="relative">
                <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input id="admin-user" type="text" value={username} autoFocus disabled={submitting}
                  autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  onChange={(e) => setUsername(e.target.value)} placeholder={t.adminUser}
                  className={`w-full pl-10 pr-3 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`} />
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input id="admin-pw" type={showPw ? 'text' : 'password'} value={password} disabled={submitting}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)} placeholder={t.adminPw}
                  className={`w-full pl-10 pr-10 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`} />
                <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button type="submit" disabled={!username.trim() || !password.trim() || submitting} className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}{t.login}</button>
            </form>
          </div>
          <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">Swiss Volley Region Zürich</p>
        </div>
      </div>
    );
  }

  // The chair gets her two tabs and nothing else. She is not a lesser admin —
  // she is a different person with a different password, and the admin half of
  // this console is closed to her exactly as her half is closed to the admin.
  const isPresident = role === 'president';
  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = isPresident ? [
    { id: 'survey', label: t.survey, icon: <MessageSquare size={15} /> },
    { id: 'notes', label: t.notes, icon: <Lock size={15} /> },
  ] : [
    { id: 'coachees', label: t.coachees, icon: <Users size={15} /> },
    { id: 'rcs', label: t.rcs, icon: <ShieldCheck size={15} /> },
    { id: 'games', label: t.games, icon: <CalendarDays size={15} /> },
    { id: 'overview', label: t.overview, icon: <Target size={15} /> },
    { id: 'niveau', label: t.niveau, icon: <Gauge size={15} /> },
    { id: 'emails', label: t.emails, icon: <Mail size={15} /> },
    { id: 'form', label: t.form, icon: <ClipboardList size={15} /> },
    { id: 'logs', label: t.logs, icon: <ScrollText size={15} /> },
    { id: 'settings', label: t.settings, icon: <SettingsIcon size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 pb-16">
      <header className="bg-white border-b border-stone-200/70 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <SvrzLogo className="h-7 w-auto" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">{t.admin}</span>
          {testMode && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5"><FlaskConical size={12} /> {t.testBadge}</span>}
          <button onClick={() => { window.location.href = window.location.pathname + window.location.search; }} aria-label={t.toApp} className="ml-auto inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Home size={14} /><span className="hidden sm:inline">{t.toApp}</span></button>
          <button onClick={toggleLang} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Languages size={14} />{lang}</button>
          <button onClick={logout} aria-label={t.logout} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"><LogOut size={15} /> <span className="hidden sm:inline">{t.logout}</span></button>
        </div>
        {/* All nine across this container leaves ~90px each and every second
            label truncates, so the admin bar wraps — three rows of three,
            rather than four-four-and-a-lonely-ninth. */}
        <div className={cn('max-w-4xl mx-auto px-4 pb-3 grid gap-2', isPresident ? 'grid-cols-2' : 'grid-cols-3')}>
          {tabs.map((tb) => (
            // min-w-0 + truncate: the label is hidden below sm, leaving an icon
            // with no accessible name — so the button carries the name itself.
            <button key={tb.id} onClick={() => setTab(tb.id)} aria-label={tb.label} aria-current={tab === tb.id ? 'page' : undefined} className={`h-11 min-w-0 px-1.5 inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl transition-colors ${tab === tb.id ? 'bg-slate-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
              <span className="shrink-0">{tb.icon}</span>
              <span className="hidden sm:inline truncate">{tb.label}</span>
            </button>
          ))}
        </div>
      </header>
      {/* Tabs stay mounted: their data is fetched in one parallel batch on the
          first render after login, so switching tabs shows the finished page
          instead of starting that tab's request right then. Logs are the
          exception — they only poll while their tab is on screen. */}
      <main className="max-w-4xl mx-auto px-4 pt-5">
        {/* Mandate/target saves are optimistic; when one is rejected the state
            rolls back and this is what says so. */}
        {settingsError && (
          <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</p>
        )}
        {!isPresident && <>
        <div hidden={tab !== 'coachees'}><CoacheesAdmin t={t} lang={lang} groups={groups} defaultSeason={defaultSeason} targets={coacheeTargets} onTargets={saveTargets} leagueOptions={leagueOptions} niveauTable={niveauTable} /></div>
        <div hidden={tab !== 'rcs'}><RcsAdmin t={t} lang={lang} mandates={rcMandates} defaultGoal={defaultGoal} onMandates={saveMandates} /></div>
        <div hidden={tab !== 'emails'}><EmailsAdmin t={t} /></div>
        <div hidden={tab !== 'form'}><SurveyFormAdmin t={t} lang={lang} /></div>
        <div hidden={tab !== 'games'}><GamesAdmin t={t} lang={lang} /></div>
        <div hidden={tab !== 'overview'}><OverviewAdmin t={t} /></div>
        <div hidden={tab !== 'niveau'}><NiveauAdmin t={t} lang={lang} table={niveauTable} onTable={saveNiveau} loading={settingsLoading} /></div>
        </>}
        {isPresident && <div hidden={tab !== 'survey'}><SurveyAdmin t={t} lang={lang} /></div>}
        {isPresident && <div hidden={tab !== 'notes'}><PresidentNotesAdmin t={t} lang={lang} /></div>}
        {!isPresident && <>
        <div hidden={tab !== 'logs'}><LogsAdmin t={t} active={tab === 'logs'} /></div>
        <div hidden={tab !== 'settings'}>
          <SettingsAdmin t={t} lang={lang} testMode={testMode} onTestMode={setTestMode} defaultSeason={defaultSeason} settingsLoading={settingsLoading} groups={groups} onGroups={setGroups} defaultGoal={defaultGoal} onDefaultGoal={saveDefaultGoal} />
          <ManualGameAdmin t={t} lang={lang} />
          <CredentialsAdmin t={t} />
        </div>
        </>}
        <p className="mt-6 pb-3 text-center text-[10px] text-stone-400">Build {BUILD_INFO}</p>
      </main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">{children}</div>;
}

function GroupMultiSelect({ groups, value, onChange, placeholder }: { groups: string[]; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = value ? value.split('/').map((x) => x.trim()).filter(Boolean) : [];
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (g: string) => { const next = selected.includes(g) ? selected.filter((x) => x !== g) : [...selected, g]; onChange(next.join('/')); };
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${input} text-left flex items-center justify-between gap-1`}>
        {/* `truncate` on both branches — a selected value ellipsized but the
            placeholder wrapped to two lines and pushed the row out of line. */}
        <span className={cn('truncate', selected.length ? 'text-stone-800' : 'text-stone-400')}>{selected.length ? selected.join('/') : placeholder}</span>
        <ChevronDown size={14} className="text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg p-1">
          {groups.length === 0 && <p className="px-2 py-2 text-xs text-stone-400">—</p>}
          {groups.map((g) => (
            <label key={g} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-stone-50 cursor-pointer">
              <input type="checkbox" checked={selected.includes(g)} onChange={() => toggle(g)} className="accent-red-600" />
              <span>{g}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function CheckMultiSelect({ options, value, onChange, placeholder }: { options: string[]; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className={`${input} text-left flex items-center justify-between gap-1`}>
        <span className={value.length ? 'text-stone-800 truncate' : 'text-stone-400'}>{value.length ? value.join(', ') : placeholder}</span>
        <ChevronDown size={14} className="text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-52 overflow-auto rounded-lg border border-stone-200 bg-white shadow-lg p-1">
          {options.length === 0 && <p className="px-2 py-2 text-xs text-stone-400">—</p>}
          {options.map((o) => (
            <label key={o} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-stone-50 cursor-pointer">
              <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} className="accent-red-600" />
              <span className="truncate">{o}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetEditor({ t, target, onChange, leagueOptions }: { t: T; target: CoacheeTarget; onChange: (next: CoacheeTarget) => void; leagueOptions: string[] }) {
  const mode = target.mode;
  const roles = target.roles ?? [];
  const leagues = target.leagues ?? [];
  const toggleRole = (r: TargetRole) => onChange({ ...target, roles: roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r] });
  return (
    <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50/60 p-2.5 space-y-2">
      <p className="text-[11px] text-stone-400">{t.targetHint}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {(([['auto', t.targetAuto], ['all', t.targetAll], ['custom', t.targetCustom]]) as [CoacheeTarget['mode'], string][]).map(([m, lbl]) => (
          <button key={m} type="button" onClick={() => onChange({ ...target, mode: m })} className={`h-7 px-2.5 rounded-md border text-xs font-medium ${mode === m ? 'bg-slate-900 text-white border-transparent' : 'bg-white border-stone-300 text-stone-600 hover:bg-stone-100'}`}>{lbl}</button>
        ))}
      </div>
      {mode === 'custom' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <p className="text-[11px] font-semibold text-stone-500 mb-1">{t.targetRoles}</p>
            <div className="flex gap-1.5">
              {(['1SR', '2SR'] as TargetRole[]).map((r) => (
                <button key={r} type="button" onClick={() => toggleRole(r)} className={`h-7 px-2.5 rounded-md border text-xs font-medium ${roles.includes(r) ? 'bg-red-600 text-white border-transparent' : 'bg-white border-stone-300 text-stone-600 hover:bg-stone-100'}`}>{r === '1SR' ? '1. SR' : '2. SR'}</button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-stone-500 mb-1">{t.targetLeagues}</p>
            <CheckMultiSelect options={leagueOptions} value={leagues} onChange={(v) => onChange({ ...target, leagues: v })} placeholder={t.chooseLeagues} />
          </div>
        </div>
      )}
    </div>
  );
}

// Admin → Niveau. The official SVRZ table "Übersicht SR-Niveau und Stufe" as an
// editable matrix: nine levels down, six cells across (Herren/Damen × 1./2. SR,
// plus HU23/DU23 as 1. SR). A cell is a SET of leagues, because the paper writes
// "DU23 2. + 3. Liga" — see NIVEAU_TABLE.
//
// Two layouts, and neither ever scrolls sideways: the table needs ~750px of the
// container, so it appears from lg up; below that — every phone, and a narrow
// window — each level becomes a card with one labelled row per cell. The league
// chips sit in a grid that reflows with the layout, so nothing overflows at any
// width in between.
function NiveauAdmin({ t, lang, table, onTable, loading }: { t: T; lang: Lang; table: NiveauMatrix; onTable: (next: NiveauMatrix) => Promise<boolean>; loading: boolean }) {
  const columns: { id: NiveauColumn; label: string }[] = [
    { id: 'H1', label: `${t.nvMen} ${t.nv1sr}` },
    { id: 'H2', label: `${t.nvMen} ${t.nv2sr}` },
    { id: 'D1', label: `${t.nvWomen} ${t.nv1sr}` },
    { id: 'D2', label: `${t.nvWomen} ${t.nv2sr}` },
    { id: 'JH', label: `${t.nvU23Men} ${t.nv1sr}` },
    { id: 'JD', label: `${t.nvU23Women} ${t.nv1sr}` },
  ];
  const changedCells = NIVEAU_LEVELS.reduce((n, key) => n + columns.filter((c) => !sameCell(table[key][c.id], NIVEAU_TABLE[key][c.id])).length, 0);
  const changedRows = NIVEAU_LEVELS.filter((key) => !sameNiveauRow(table[key], NIVEAU_TABLE[key]));

  const toggle = (key: string, column: NiveauColumn, division: string) => {
    const current = table[key][column];
    const next = current.includes(division)
      ? current.filter((d) => d !== division)
      : divisionsFor(column).filter((d) => d === division || current.includes(d));
    onTable({ ...table, [key]: { ...table[key], [column]: next } });
  };

  const reset = async () => {
    if (changedCells > 0 && !(await confirmDialog({ title: t.nvResetTitle, message: t.nvResetConfirm, confirmLabel: t.resetLabel, tone: 'danger', lang }))) return;
    // Awaited, not fire-and-forget: onTable is an optimistic save that rolls the
    // matrix back on a rejected PUT, and a green toast over a restored deviation
    // is the one lie the whole migration was meant to avoid.
    if (await onTable(resolveNiveauTable(null))) toast.success(t.nvResetOk, { lang });
  };

  // A grid, not a wrapping row: six leagues land as one row of six on a phone
  // (where the cell has the card's full width) and as a tidy 3 + 3 block in the
  // narrow table columns, instead of the ragged "NL 1 2 3 4 / 5" a flex wrap
  // produces. U23 has three, so it is one row everywhere.
  const cell = (key: string, column: NiveauColumn) => {
    const values = table[key][column];
    const changed = !sameCell(values, NIVEAU_TABLE[key][column]);
    const u23 = column === 'JH' || column === 'JD';
    return (
      <span className={cn('grid w-fit gap-1 rounded-lg p-1', u23 ? 'grid-cols-3' : 'grid-cols-6 lg:grid-cols-3', changed && 'bg-amber-50 ring-1 ring-amber-300')}>
        {divisionsFor(column).map((d) => {
          const on = values.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={`${key} · ${columns.find((c) => c.id === column)?.label} · ${d === 'NL' ? 'NL' : `${d}. Liga`}`}
              onClick={() => toggle(key, column, d)}
              className={cn(
                'h-6 min-w-[26px] px-1 rounded-md border text-[11px] font-medium tabular-nums leading-none transition-colors',
                on ? 'bg-slate-900 text-white border-transparent' : 'bg-white border-stone-300 text-stone-400 hover:bg-stone-100 hover:text-stone-600',
              )}
            >{d}</button>
          );
        })}
      </span>
    );
  };

  const family = (key: string) => key.split('-')[0];
  const familyNote = (key: string) => t.nvFam[family(key)] || '';

  return (
    <div className="bg-white rounded-2xl border border-stone-200/70 shadow-sm p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-2 mb-1">
        <h2 className="text-base font-semibold text-stone-800">{t.niveau} · {t.nvFocus}</h2>
        <span className="ml-auto text-[11px] text-stone-400 border border-stone-200 rounded-full px-2.5 py-1">{t.nvOfficial}</span>
      </div>
      <p className="text-xs text-stone-500 max-w-2xl">{t.nvHint}</p>
      {/* Asked out loud the first time somebody read this table: an unlit cell
          looks like a ban. It is not — it decides the default view, nothing
          else — and that belongs next to the grid, not in a wiki. */}
      <p className="text-xs text-stone-400 mb-3 mt-1 max-w-2xl">{t.nvNotBlocking}</p>

      {loading ? <SkeletonRows rows={9} /> : (
        <>
          {/* Desktop: the whole table at a glance. It needs ~750px of the
              container, which arrives at lg — below that the cards take over. */}
          <div className="hidden lg:block border border-stone-200 rounded-xl overflow-hidden">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead>
                {/* Two header rows that line up column by column: the category
                    on top, the role directly under it — HU23 and DU23 included,
                    which is why they are groups of their own rather than a
                    shared "U23" whose second row would carry genders where the
                    others carry roles. */}
                <tr className="bg-stone-50 text-xs text-stone-600">
                  <th rowSpan={2} className="w-[132px] text-left font-semibold px-3 py-2 border-b border-stone-200 align-top">{t.nvLevel}</th>
                  <th colSpan={2} className="font-semibold px-2 pt-2 pb-1">{t.nvMen}</th>
                  <th colSpan={2} className="font-semibold px-2 pt-2 pb-1 border-l border-stone-200">{t.nvWomen}</th>
                  <th className="font-semibold px-2 pt-2 pb-1 border-l border-stone-200">
                    {t.nvU23Men}<span className="block text-[10px] font-normal text-stone-400">{t.nvU23MenNote}</span>
                  </th>
                  <th className="font-semibold px-2 pt-2 pb-1">
                    {t.nvU23Women}<span className="block text-[10px] font-normal text-stone-400">{t.nvU23WomenNote}</span>
                  </th>
                </tr>
                <tr className="bg-stone-50 text-[11px] text-stone-400">
                  <th className="font-normal px-2 pb-2 border-b border-stone-200">{t.nv1sr}</th>
                  <th className="font-normal px-2 pb-2 border-b border-stone-200">{t.nv2sr}</th>
                  <th className="font-normal px-2 pb-2 border-b border-l border-stone-200">{t.nv1sr}</th>
                  <th className="font-normal px-2 pb-2 border-b border-stone-200">{t.nv2sr}</th>
                  <th className="font-normal px-2 pb-2 border-b border-l border-stone-200">{t.nv1sr}</th>
                  <th className="font-normal px-2 pb-2 border-b border-stone-200">{t.nv1sr}</th>
                </tr>
              </thead>
              <tbody>
                {NIVEAU_LEVELS.map((key, i) => {
                  // The four Niveau families each carry one explanation, on the
                  // row that opens them — repeating it on every Stufe is noise.
                  const opensFamily = i === 0 || family(key) !== family(NIVEAU_LEVELS[i - 1]);
                  return (
                  <tr key={key} className={cn('border-b border-stone-100 last:border-0', i > 0 && opensFamily && 'border-t-2 border-t-stone-200')}>
                    <td className="px-3 py-2 align-middle">
                      <span className="font-mono text-xs font-medium text-stone-800">{key}</span>
                      {opensFamily && familyNote(key) && (
                        <span className="block text-[10px] leading-tight text-stone-400">{familyNote(key)}</span>
                      )}
                    </td>
                    {columns.map((c) => (
                      <td key={c.id} className={cn('px-2 py-2 text-center align-middle', (c.id === 'H1' || c.id === 'D1' || c.id === 'JH') && 'border-l border-stone-100')}>
                        {cell(key, c.id)}
                      </td>
                    ))}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Phones and narrow windows: one card per level. */}
          <div className="lg:hidden space-y-2.5">
            {NIVEAU_LEVELS.map((key, i) => (
              <div key={key} className="border border-stone-200 rounded-xl p-3">
                <div className="mb-2">
                  <span className="font-mono text-xs font-semibold text-stone-800">{key}</span>
                  {(i === 0 || family(key) !== family(NIVEAU_LEVELS[i - 1])) && familyNote(key) && (
                    <span className="block text-[10px] leading-tight text-stone-400">{familyNote(key)}</span>
                  )}
                </div>
                {/* 5.5rem for the label leaves a phone enough room for all six
                    leagues on one line — see the grid in cell(). */}
                <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 items-center">
                  {columns.map((c) => (
                    <React.Fragment key={c.id}>
                      <span className="text-[10px] text-stone-500 truncate">{c.label}</span>
                      <span className="min-w-0">{cell(key, c.id)}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3 pt-3 border-t border-stone-100">
            <span className={cn('text-[11px]', changedCells > 0 ? 'text-amber-700 font-medium' : 'text-stone-400')}>
              {changedCells > 0 ? t.nvChanged(changedCells) : t.nvNoChanges}
            </span>
            {changedRows.length > 0 && (
              <span className="text-[11px] text-stone-400 font-mono truncate">{changedRows.join(', ')}</span>
            )}
            <button
              type="button"
              onClick={() => { void reset(); }}
              disabled={changedCells === 0}
              className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            ><RotateCcw size={13} /> {t.nvReset}</button>
          </div>
          <p className="mt-2 text-[10px] text-stone-400">{t.nvLegend}</p>
        </>
      )}
    </div>
  );
}

function sameCell(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => b[i] === v);
}

function CoacheesAdmin({ t, lang, groups, defaultSeason, targets, onTargets, leagueOptions, niveauTable }: { t: T; lang: Lang; groups: string[]; defaultSeason: number; targets: CoacheeTargetMap; onTargets: (next: CoacheeTargetMap) => void; leagueOptions: string[]; niveauTable: NiveauMatrix }) {
  const [targetEditId, setTargetEditId] = useState<string | null>(null);
  const [season, setSeason] = useState(defaultSeason);
  const seasonTouched = useRef(false);
  useEffect(() => { if (!seasonTouched.current) setSeason(defaultSeason); }, [defaultSeason]);
  const [all, setAll] = useState<Coachee[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  const [syncMissing, setSyncMissing] = useState<string[]>([]);
  const [syncAmbiguous, setSyncAmbiguous] = useState<string[]>([]);
  const [overwriteContacts, setOverwriteContacts] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', referee_level: '', stage: '', groups: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ first_name: '', last_name: '', email: '', phone: '', referee_level: '', stage: '', groups: '' });

  const reload = useCallback(async () => { setLoading(true); try { setAll(await listCoachees()); } catch (e) { setNotice(String(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const rows = all.filter((c) => (typeof c.season === 'number' ? c.season === season : false)).sort(bySurname);

  // Same reason as RcsAdmin: a failed write left the console looking like it
  // had worked.
  const guard = async (action: () => Promise<void>) => {
    setNotice('');
    try { await action(); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const add = async () => { const full_name = `${form.first_name} ${form.last_name}`.trim(); if (!full_name) return; await guard(async () => { await createCoachee({ ...form, full_name, season } as Partial<Coachee>); setForm({ first_name: '', last_name: '', email: '', phone: '', referee_level: '', stage: '', groups: '' }); await reload(); }); };
  const saveEdit = async (id: string) => { const full_name = `${editForm.first_name} ${editForm.last_name}`.trim(); await guard(async () => { await updateCoachee(id, { ...editForm, full_name } as Partial<Coachee>); setEditId(null); await reload(); }); };
  const remove = async (c: Coachee) => {
    if (!(await confirmDialog({ title: t.delCoachee(c.full_name), message: t.undoWarn, confirmLabel: t.deleteLabel, tone: 'danger', lang }))) return;
    // guard() puts a failure in `notice`, which is on screen right below the
    // list — only a clean run gets a toast, so nothing is reported twice.
    let done = false;
    await guard(async () => { await deleteCoachee(c.id); await reload(); done = true; });
    if (done) toast.success(t.delCoacheeOk(c.full_name), { lang });
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); setNotice('');
    try { const parsed = await parseXlsx(file); if (!parsed.length) { setNotice(t.noRows); return; } const res = await importCoachees(parsed, season); setNotice(t.importResult(seasonLabel(season), res.created, res.updated, res.total)); await reload(); }
    catch (err) { setNotice(t.importFail(String(err))); } finally { setImporting(false); e.target.value = ''; }
  };
  const syncContacts = async () => {
    setSyncing(true); setNotice(''); setSyncNote('');
    try {
      const r = await syncCoacheeContacts(season, overwriteContacts);
      setSyncNote([
        t.syncResult(r.updated, r.alreadySet, r.notFound, r.refereesFetched),
      ].filter(Boolean).join(' '));
      setSyncMissing(r.missing);
      setSyncAmbiguous(r.ambiguous ?? []);
      await reload();
    // The message, not String(err): that prefixed every failure with a bare
    // "Error:" in front of the sentence the server took care to write.
    } catch (err) { setNotice(t.syncFail(err instanceof Error ? err.message : String(err))); } finally { setSyncing(false); }
  };

  const missingEmail = rows.filter((c) => !c.email).length;

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h2 className="text-sm font-semibold text-stone-700">{t.coachees}</h2>
          <select value={season} onChange={(e) => { seasonTouched.current = true; setSeason(Number(e.target.value)); }} className="ml-auto h-9 rounded-lg border border-stone-200 bg-stone-50 text-stone-700 text-xs font-medium px-2.5">{[...new Set([season, ...SEASONS])].sort().map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}</select>
          <label className={`${btnPrimary} cursor-pointer ${importing ? 'opacity-60 pointer-events-none' : ''}`}>{importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}<span>{t.importXlsx}</span><input type="file" accept=".xlsx" className="hidden" onChange={onFile} /></label>
        </div>
        <p className="text-xs text-stone-400">{t.importHint(seasonLabel(season))}</p>
        {notice && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{notice}</p>}

        {/* Step 2 of the import: the XLSX has no email column, and without an
            address the feedback submit fails at the very end. */}
        <div className="mt-3 pt-3 border-t border-stone-100">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-stone-700">{t.syncTitle}</h3>
              <p className="text-xs text-stone-400">{t.syncHint}</p>
            </div>
            <button onClick={() => void syncContacts()} disabled={syncing} className={cn(btnPrimary, 'ml-auto')}>
              {syncing ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
              <span>{t.syncBtn}</span>
            </button>
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-stone-500">
            <input type="checkbox" checked={overwriteContacts} onChange={(e) => setOverwriteContacts(e.target.checked)} className="accent-red-600" />
            {t.syncOverwrite}
          </label>
          {missingEmail > 0 && <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{t.syncMissingEmail(missingEmail, rows.length)}</p>}
          {syncNote && <p className="mt-2 text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">{syncNote}</p>}
          {/* Ambiguous first, and in amber: it is the one outcome that needs a
              person to decide, where "not found" is merely a gap to fill. */}
          {syncAmbiguous.length > 0 && (
            <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              {t.syncAmbiguous}: {syncAmbiguous.join(', ')}
            </p>
          )}
          {syncMissing.length > 0 && (
            <p className="mt-2 text-xs text-stone-500">{t.syncNotFoundList}: {syncMissing.join(', ')}</p>
          )}
        </div>
      </Card>
      <Card>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-12">
          <input className={cn(input, 'sm:col-span-3')} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={cn(input, 'sm:col-span-3')} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input type="email" className={cn(input, 'col-span-2 sm:col-span-3')} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          {/* Phone had no field anywhere: it arrived only from the VolleyManager
              sync, so the coachees VM does not carry could never be given one,
              and a wrong number could not be corrected. The app shows it as a
              tel: link on the coachee sheet, which is the point of having it. */}
          <input type="tel" className={cn(input, 'sm:col-span-3')} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <select
            className={cn(input, 'sm:col-span-3', !joinStufe(form.referee_level, form.stage) && 'text-stone-400')}
            value={joinStufe(form.referee_level, form.stage)}
            onChange={(e) => setForm({ ...form, ...splitStufe(e.target.value) })}
          >
            <option value="">{t.stage}</option>
            {STUFEN.map((v) => <option key={v} value={v} className="text-stone-900">{v}</option>)}
          </select>
          <div className="sm:col-span-4"><GroupMultiSelect groups={groups} value={form.groups} onChange={(v) => setForm({ ...form, groups: v })} placeholder={t.chooseGroups} /></div>
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={cn(btnPrimary, 'justify-center sm:col-span-5 sm:justify-self-end')}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? t.loading : t.count(rows.length, seasonLabel(season))}</p>
        <div className="divide-y divide-stone-100">
          {rows.map((c) => editId === c.id ? (
            <div key={c.id} className="py-2 grid grid-cols-2 gap-2 sm:grid-cols-12 items-center">
              <input className={cn(input, 'sm:col-span-3')} value={editForm.first_name} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={cn(input, 'sm:col-span-3')} value={editForm.last_name} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <input type="email" className={cn(input, 'col-span-2 sm:col-span-3')} placeholder={t.email} value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              <input type="tel" className={cn(input, 'sm:col-span-3')} placeholder={t.phone} value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              <select
                className={cn(input, 'sm:col-span-3', !joinStufe(editForm.referee_level, editForm.stage) && 'text-stone-400')}
                value={joinStufe(editForm.referee_level, editForm.stage)}
                onChange={(e) => setEditForm({ ...editForm, ...splitStufe(e.target.value) })}
              >
                <option value="">{t.stage}</option>
                {STUFEN.map((v) => <option key={v} value={v} className="text-stone-900">{v}</option>)}
              </select>
              <div className="sm:col-span-4"><GroupMultiSelect groups={groups} value={editForm.groups} onChange={(v) => setEditForm({ ...editForm, groups: v })} placeholder={t.chooseGroups} /></div>
              <div className="flex gap-1.5 sm:col-span-5 sm:justify-self-end"><button onClick={() => saveEdit(c.id)} className={btnPrimary}><Check size={15} /></button><button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button></div>
            </div>
          ) : (
            <div key={c.id} className="py-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800 truncate">{c.full_name}</p>
                  <p className="text-xs text-stone-400 truncate"><LevelText level={c.referee_level} stage={c.stage} />{c.groups ? ` · ${c.groups}` : ''}</p>
                  {/* Without an address the feedback submit fails at the very
                      end, after the whole form is filled in — flag it early. */}
                  <p className={cn('text-xs truncate', c.email ? 'text-stone-400' : 'text-amber-600 font-medium')}>
                    {c.email || t.noEmail}
                    {/* Shown, not just editable: the coach's detail sheet offers
                        this as a tel: link, so a missing or wrong number is
                        worth seeing from the list. Absence is not flagged —
                        unlike the address, feedback does not need it. */}
                    {c.phone && <span className="text-stone-400"> · {c.phone}</span>}
                  </p>
                </div>
                <button onClick={() => setTargetEditId(targetEditId === c.id ? null : c.id)} className={cn(btnGhost, targetEditId === c.id && 'bg-stone-100')} title={t.target}><Target size={13} /></button>
                <button onClick={() => { setEditId(c.id); setEditForm({ first_name: c.first_name || '', last_name: c.last_name || '', email: c.email || '', phone: c.phone || '', referee_level: c.referee_level || '', stage: c.stage || '', groups: c.groups || '' }); }} className={btnGhost} aria-label={t.edit} title={t.edit}><Pencil size={13} /></button>
                <button onClick={() => remove(c)} aria-label={t.deleteLabel} title={t.deleteLabel} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
              </div>
              <div className="flex items-center gap-1.5 mt-1 pl-0.5">
                <span className="text-[11px] text-stone-400">{t.target}:</span>
                <span className={cn('text-[11px] font-medium', isTargetActive(targets[c.id], levelKey(c.referee_level, c.stage), niveauTable) ? 'text-emerald-700' : 'text-stone-400')}>{(() => {
                  const key = levelKey(c.referee_level, c.stage);
                  const tgt = targets[c.id];
                  // Auto mode with no derivable rules because the Niveau/Stufe is still TBD
                  if ((!tgt || tgt.mode === 'auto') && !hasNiveauRules(key, niveauTable) && levelDisplay(c.referee_level, c.stage).tbd) {
                    return <>Auto (<span className="text-red-600 font-semibold">TBD</span>)</>;
                  }
                  return summarizeTarget(tgt, key, lang, niveauTable);
                })()}</span>
              </div>
              {targetEditId === c.id && (
                <TargetEditor t={t} target={targets[c.id] ?? { mode: 'auto' }} onChange={(next) => onTargets({ ...targets, [c.id]: next })} leagueOptions={leagueOptions} />
              )}
            </div>
          ))}
          {loading && all.length === 0 && <SkeletonRows rows={6} />}
          {!loading && rows.length === 0 && <p className="py-8 text-center text-sm text-stone-400">{t.noCoachees(seasonLabel(season))}</p>}
        </div>
      </Card>
    </>
  );
}

function RcsAdmin({ t, lang, mandates, defaultGoal, onMandates }: { t: T; lang: Lang; mandates: RcMandateMap; defaultGoal: number; onMandates: (next: RcMandateMap) => void }) {
  const [rcs, setRcs] = useState<RcPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RcPerson>({ id: '' });
  // Every write here used to fail in silence: the row stayed, no message
  // appeared, and a failed initial load was indistinguishable from "there are
  // no referee coaches".
  const [notice, setNotice] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  // Who gets the #/admin shortcut drawn in their toolbar. NOT a permission —
  // see the comment on the button in App.tsx. Ticking somebody here shows them
  // a link; the console behind it still asks for the admin password.
  const [shortcutRcs, setShortcutRcs] = useState<string[]>([]);
  const guard = async (action: () => Promise<void>) => {
    setNotice('');
    try { await action(); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const reload = useCallback(async () => {
    setLoading(true);
    try { setRcs(await listRcPeopleFull()); setLoadFailed(false); }
    catch (e) { setLoadFailed(true); setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { getAdminShortcutRcs().then(setShortcutRcs).catch(() => setShortcutRcs([])); }, []);
  const toggleShortcut = async (r: RcPerson) => {
    const next = shortcutRcs.includes(r.id) ? shortcutRcs.filter((x) => x !== r.id) : [...shortcutRcs, r.id];
    const previous = shortcutRcs;
    setShortcutRcs(next); // optimistic; a rejected save rolls back and says so
    try { await setAdminShortcutRcs(next); }
    catch (e) { setShortcutRcs(previous); setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const add = async () => { if (!form.first_name && !form.last_name) return; await guard(async () => { await createRcPerson({ ...form, active: true }); setForm({ first_name: '', last_name: '', email: '', phone: '' }); await reload(); }); };
  const saveEdit = async (id: string) => { await guard(async () => { await updateRcPerson(id, editForm); setEditId(null); await reload(); }); };
  const remove = async (r: RcPerson) => {
    const name = `${r.first_name} ${r.last_name}`;
    if (!(await confirmDialog({ title: t.delRc(name), message: t.undoWarn, confirmLabel: t.deleteLabel, tone: 'danger', lang }))) return;
    // As above: guard() surfaces the failure in `notice`, so the toast only
    // fires when the delete actually went through.
    let done = false;
    await guard(async () => { await deleteRcPerson(r.id); await reload(); done = true; });
    if (done) toast.success(t.delRcOk(name), { lang });
  };
  // The season goal ("Pensum") per RC, as a plain number of observations.
  //
  // It was a Full/Half switch, which had no way to describe the coaches who owe
  // neither — and a third fixed option would have hit the same wall the moment
  // somebody owed a fourth thing. A number says what was meant. 0 is a real
  // answer and does not restrict anyone: the Pensum is informative, so an RC on
  // 0 still picks up and observes games like everybody else.
  //
  // Only deviations are stored, so clearing the box drops the entry and the RC
  // follows the default goal again. Legacy 'half' entries keep working until
  // they are next edited — see goalForMandate.
  const setMandate = (id: string, mandate: RcMandate | undefined) => {
    const next = { ...mandates };
    if (mandate === undefined) delete next[id];
    else next[id] = mandate;
    onMandates(next);
  };
  const mandateToggle = (r: RcPerson) => {
    const current = mandates[r.id];
    // An empty box means "no deviation": show the default as a placeholder
    // rather than pre-filling it, so saving is always a deliberate act.
    const shown = current === undefined ? '' : String(goalForMandate(defaultGoal, current));
    return (
      <input
        type="number"
        min={0}
        max={200}
        inputMode="numeric"
        value={shown}
        aria-label={t.mandateLabel}
        title={t.mandateHint(defaultGoal)}
        placeholder={String(defaultGoal)}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') { setMandate(r.id, undefined); return; }
          const n = Math.trunc(Number(raw));
          if (!Number.isFinite(n) || n < 0 || n > 200) return;
          // Storing the number even when it equals the default is deliberate:
          // "explicitly 10" and "whatever the default happens to be" are
          // different statements, and the second changes under your feet when
          // the season goal is edited.
          setMandate(r.id, n);
        }}
        className="h-8 w-20 rounded-lg border border-stone-200 bg-white px-2 text-sm text-stone-800 text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-red-500/60"
      />
    );
  };
  // Shared by the desktop table and the mobile cards so the two can't drift.
  const rowActions = (r: RcPerson) => (
    <>
      <button onClick={() => void toggleShortcut(r)}
        className={cn(btnGhost, shortcutRcs.includes(r.id) && 'text-slate-900 border-slate-300')}
        title={t.shortcutToggle}>
        {shortcutRcs.includes(r.id) ? <ShieldCheck size={13} /> : <Lock size={13} />}
      </button>
      <button onClick={() => { setEditId(r.id); setEditForm(r); }} className={btnGhost} title={t.edit}><Pencil size={13} /></button>
      <button onClick={() => remove(r)} aria-label={t.deleteLabel} title={t.deleteLabel} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
    </>
  );
  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-2">{t.addRc}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <input className={input} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input className={input} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? t.loading : t.rcCount(rcs.length)}</p>
        {/* Phones: one card per coach. The table needs ~720px, so on a phone it
            clipped the e-mail and pushed the actions off-screen entirely. */}
        <div className="sm:hidden space-y-2">
          {rcs.map((r) => editId === r.id ? (
            <div key={r.id} className="rounded-xl border border-stone-200 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder={t.firstName} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
                <input className={input} placeholder={t.lastName} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              </div>
              <input className={input} placeholder={t.email} value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              <input className={input} placeholder={t.phone} value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
              <div className="flex items-center gap-1.5">
                <button onClick={() => saveEdit(r.id)} className={btnPrimary}><Check size={15} /></button>
                <button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button>
              </div>
            </div>
          ) : (
            <div key={r.id} className="rounded-xl border border-stone-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-stone-800 break-words">
                    {r.first_name} {r.last_name}
                    {r.active === false && <span className="ml-1.5 text-xs font-normal text-stone-400">· {t.inactive}</span>}
                  </p>
                </div>
              </div>
              {r.email && <p className="mt-1.5 text-xs text-stone-500 break-all">{r.email}</p>}
              {r.phone && <p className="text-xs text-stone-500">{r.phone}</p>}
              <div className="mt-2.5 flex items-center gap-2">
                <span className="text-xs text-stone-500">{t.mandateLabel}</span>
                {mandateToggle(r)}
              </div>
              <div className="mt-2.5 flex items-center justify-end gap-1.5">{rowActions(r)}</div>
            </div>
          ))}
        </div>
        {/* Desktop: the table keeps 12+ coaches scannable at a glance. */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full min-w-[800px] text-sm border-collapse">
            <thead>
              <tr className="text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200">
                <th className="text-left font-bold py-2 pr-3">{t.colName}</th>
                <th className="text-left font-bold py-2 pr-3">{t.email}</th>
                <th className="text-left font-bold py-2 pr-3">{t.phone}</th>
                <th className="text-left font-bold py-2 pr-3" title={t.mandateHint(defaultGoal)}>{t.colMandate}</th>
                <th className="text-right font-bold py-2">{t.colActions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rcs.map((r) => editId === r.id ? (
                <tr key={r.id}>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1.5">
                      <input className={`${input} w-full`} placeholder={t.firstName} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
                      <input className={`${input} w-full`} placeholder={t.lastName} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
                    </div>
                  </td>
                  <td className="py-2 pr-3"><input className={`${input} w-full`} value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></td>
                  <td className="py-2 pr-3"><input className={`${input} w-full`} value={editForm.phone || ''} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></td>
                  <td className="py-2 pr-3">{mandateToggle(r)}</td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => saveEdit(r.id)} className={btnPrimary}><Check size={15} /></button>
                      <button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button>
                    </div>
                  </td>
                </tr>
              ) : (
                <React.Fragment key={r.id}>
                  <tr className="hover:bg-stone-50/70 transition-colors">
                    <td className="py-2.5 pr-3">
                      <span className="font-medium text-stone-800 whitespace-nowrap">{r.first_name} {r.last_name}</span>
                      {r.active === false && <span className="ml-1.5 text-xs text-stone-400">· {t.inactive}</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-stone-500">{r.email}</td>
                    <td className="py-2.5 pr-3 text-stone-500 whitespace-nowrap">{r.phone}</td>
                    <td className="py-2.5 pr-3">{mandateToggle(r)}</td>
                    <td className="py-2.5">
                      {/* rowActions, not a copy of it. This cell held its own
                          duplicate of the same two buttons, which is precisely
                          the drift the helper exists to prevent — and it had
                          already drifted once. */}
                      <div className="flex items-center justify-end gap-1.5">{rowActions(r)}</div>
                    </td>
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {notice && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{notice}</p>}
        {loading && rcs.length === 0 && <SkeletonRows rows={6} />}
        {!loading && rcs.length === 0 && (
          <p className="py-8 text-center text-sm text-stone-400">{loadFailed ? t.loadFailed : t.noRcs}</p>
        )}
      </Card>
    </>
  );
}

// ── Placeholder-aware text fields ─────────────────────────────────────
// A textarea cannot colour its own content, so the value is mirrored into a
// layer behind it and the textarea's own text is made transparent. Both layers
// carry FIELD_METRICS: one differing pixel of padding, font or line-height and
// the colours drift off the words they belong to.
const FIELD_METRICS = 'px-3 py-2 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words';
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function hasUnknownPlaceholder(text: string, known: Set<string>): boolean {
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text || ''))) if (!known.has(m[1])) return true;
  return false;
}

// Blue = this mail will fill it in. Amber = it will not, and the spot goes out
// blank — the failure mode this colouring exists to catch.
function placeholderParts(value: string, known: Set<string>): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(value))) {
    if (m.index > last) out.push(value.slice(last, m.index));
    out.push(
      <span key={m.index} className={known.has(m[1]) ? 'text-blue-600 font-semibold' : 'text-amber-600 underline decoration-dotted'}>{m[0]}</span>,
    );
    last = m.index + m[0].length;
  }
  out.push(value.slice(last));
  // A block box swallows a trailing newline. Without this the mirror is a line
  // shorter than the textarea and the bottom of a long text sits off by a row.
  out.push('\n');
  return out;
}

function TemplateField({ value, onChange, rows, singleLine, known }: {
  value: string; onChange: (v: string) => void; rows: number; singleLine?: boolean; known: Set<string>;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // A fixed one-row box clips a subject that wraps on a narrow screen, and a
  // scrollbar on a single line reads worse than a second line does. Grow to
  // fit instead — the mirror is sized by this wrapper, so it follows.
  useEffect(() => {
    const el = field.current;
    if (!singleLine || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value, singleLine]);
  return (
    <div className="relative bg-white rounded-lg">
      <div
        ref={mirror}
        aria-hidden
        className={cn(FIELD_METRICS, 'tpl-field pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-stone-800')}
      >{placeholderParts(value, known)}</div>
      <textarea
        ref={field}
        value={value}
        rows={rows}
        // The mirror has no scrollbar of its own, so it follows this one.
        onScroll={() => { if (mirror.current && field.current) mirror.current.scrollTop = field.current.scrollTop; }}
        // Subject and title are textareas too, so a single overlay serves all
        // four fields. A newline in a subject line is a mail-header split, so
        // Enter is simply not a character there.
        onKeyDown={singleLine ? (e) => { if (e.key === 'Enter') e.preventDefault(); } : undefined}
        onChange={(e) => onChange(singleLine ? e.target.value.replace(/[\r\n]+/g, ' ') : e.target.value)}
        className={cn(
          FIELD_METRICS,
          'tpl-field relative w-full rounded-lg border border-stone-300 bg-transparent text-transparent caret-stone-900 focus:outline-none focus:ring-2 focus:ring-red-400',
          singleLine ? 'resize-none overflow-hidden' : 'resize-y',
        )}
      />
    </div>
  );
}

// Guided template editor: admins edit subject/title/body/closing with
// {{placeholders}}; the branded layout, detail rows and attachments are fixed,
// so an edit can never break rendering.
function EmailsAdmin({ t }: { t: T }) {
  const [data, setData] = useState<EmailTemplates | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => { getEmailTemplates().then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);

  const patch = (kind: EmailTemplateKind, p: Partial<EmailTemplate>) =>
    setData((d) => (d ? { ...d, [kind]: { ...d[kind], ...p } } : d));

  const save = async () => {
    if (!data) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      await putEmailTemplates({
        feedback: data.feedback, reminder: data.reminder, survey: data.survey,
        reminder_enabled: data.reminder_enabled,
      });
      setSaved(true); window.setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const loadPreview = async () => {
    setPreviewLoading(true); setErr('');
    try { setPreview(await getReminderPreview()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setPreviewLoading(false); }
  };

  if (!data) return (
    <Card>
      {err ? <p className="text-sm text-red-600">{err}</p> : (
        <div className="space-y-3" role="status" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      )}
    </Card>
  );

  const editor = (kind: EmailTemplateKind, title: string, hint: string) => {
    // A server that predates this template kind simply has no entry for it.
    const blank: EmailTemplate = { subject: '', heading: '', intro: '', outro: '' };
    const tpl = data[kind] ?? data.defaults?.[kind] ?? blank;
    const known = new Set(placeholdersFor(data, kind));
    const unknownUsed = [tpl.subject, tpl.heading, tpl.intro, tpl.outro].some((v) => hasUnknownPlaceholder(v, known));
    return (
      <Card>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-sm font-semibold text-stone-700">{title}</h2>
          <button
            onClick={() => patch(kind, data.defaults[kind])}
            className={cn(btnGhost, 'shrink-0')}
            title={t.tplReset}
          ><RotateCcw size={13} /> <span className="hidden sm:inline">{t.tplReset}</span></button>
        </div>
        <p className="text-xs text-stone-400 mb-3">{hint}</p>
        <div className="space-y-2.5">
          <label className="block">
            <span className={fieldLabel}>{t.tplSubject}</span>
            <TemplateField value={tpl.subject} onChange={(v) => patch(kind, { subject: v })} rows={1} singleLine known={known} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplHeading}</span>
            <TemplateField value={tpl.heading} onChange={(v) => patch(kind, { heading: v })} rows={1} singleLine known={known} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplIntro}</span>
            <TemplateField value={tpl.intro} onChange={(v) => patch(kind, { intro: v })} rows={kind === 'reminder' ? 14 : 6} known={known} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplOutro}</span>
            <TemplateField value={tpl.outro} onChange={(v) => patch(kind, { outro: v })} rows={3} known={known} />
          </label>
        </div>
        <p className="mt-3 text-[11px] text-stone-400">
          {t.tplPlaceholders}{' '}
          {[...known].map((p) => (
            <code key={p} className="inline-block mx-0.5 rounded bg-blue-50 border border-blue-100 px-1 py-0.5 text-[10px] text-blue-600">{`{{${p}}}`}</code>
          ))}
        </p>
        {unknownUsed && <p className="mt-1.5 text-[11px] text-amber-600">{t.tplUnknown}</p>}
      </Card>
    );
  };

  return (
    <>
      {editor('reminder', t.tplReminder, t.tplReminderHint)}
      <Card>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-red-600" checked={data.reminder_enabled}
            onChange={(e) => setData({ ...data, reminder_enabled: e.target.checked })} />
          <span>
            <span className="block text-sm font-medium text-stone-700">{t.reminderEnabled}</span>
            <span className="block text-xs text-stone-400">{t.reminderEnabledHint}</span>
          </span>
        </label>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={loadPreview} disabled={previewLoading} className={btnGhost}>
            {previewLoading ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} {t.reminderPreview}
          </button>
          <span className="text-[11px] text-stone-400">{t.reminderPreviewHint}</span>
        </div>
        {preview && (
          <div className="mt-3 space-y-2">
            {preview.reminders.length === 0 ? (
              <p className="text-sm text-stone-400">{t.reminderNone}</p>
            ) : preview.reminders.map((r, i) => (
              <div key={i} className="rounded-lg border border-stone-200 overflow-hidden">
                <div className="bg-stone-50 px-3 py-2 text-[11px] text-stone-600 border-b border-stone-200">
                  <div><span className="font-semibold">An:</span> {r.to} <span className="font-semibold ml-2">Cc:</span> {r.cc.join(', ') || '—'}</div>
                  <div><span className="font-semibold">Betreff:</span> {r.subject}</div>
                  <div className="text-stone-400">{r.match} · {r.role} · {r.coachee} · RC {r.rc}</div>
                </div>
                <pre className="px-3 py-2 text-[11px] text-stone-700 whitespace-pre-wrap font-sans leading-relaxed">{r.text}</pre>
              </div>
            ))}
          </div>
        )}
      </Card>
      {editor('feedback', t.tplFeedback, t.tplFeedbackHint)}
      {editor('survey', t.tplSurvey, t.tplSurveyHint)}
      <Card>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t.save}
          </button>
          {saved && <span className="text-sm text-green-600 font-medium">{t.tplSaved}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </Card>
    </>
  );
}

// ── The survey form (admin) ───────────────────────────────────────────
// Shapes what referees are ASKED after an RC visit. What they answered is the
// chair's to read and lives behind her own password, one tab over — an admin
// can rewrite the questionnaire and still never see a response.
//
// The scale of a choice question is picked from a fixed set rather than typed:
// the option VALUES are what lands in the database, so an editable scale would
// silently split every historical answer off from the new ones.
function SurveyFormAdmin({ t, lang }: { t: T; lang: Lang }) {
  const [cfg, setCfg] = useState<SurveyConfig | null>(null);
  const [defaults, setDefaults] = useState<SurveyConfig>(DEFAULT_SURVEY_CONFIG);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    getSurveyConfig()
      .then((r) => { setCfg(r.config); setDefaults(r.defaults); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const patchQ = (i: number, p: Partial<SurveyQuestion>) => setCfg((c) => (c
    ? { ...c, questions: c.questions.map((q, n) => (n === i ? { ...q, ...p } : q)) }
    : c));

  const move = (i: number, delta: number) => setCfg((c) => {
    if (!c) return c;
    const j = i + delta;
    if (j < 0 || j >= c.questions.length) return c;
    const qs = c.questions.slice();
    [qs[i], qs[j]] = [qs[j], qs[i]];
    return { ...c, questions: qs };
  });

  const remove = async (i: number) => {
    const q = cfg?.questions[i];
    if (!q) return;
    if (!(await confirmDialog({ title: t.formDelete(q.DE || q.EN || q.id), message: t.formDeleteNote, confirmLabel: t.deleteLabel, tone: 'danger', lang }))) return;
    setCfg((c) => (c ? { ...c, questions: c.questions.filter((_, n) => n !== i) } : c));
    // info, not success: nothing was written — save() below is what persists.
    toast.info(t.formDeleteOk, { lang });
  };

  const resetForm = async () => {
    if (!(await confirmDialog({ title: t.formResetTitle, message: t.formResetConfirm, confirmLabel: t.resetLabel, tone: 'danger', lang }))) return;
    setCfg(defaults);
    toast.info(t.formResetOk, { lang });
  };

  const add = () => setCfg((c) => (c
    // No id yet: it is minted from the German wording on save, so it reads like
    // the question it stores rather than like a counter.
    ? { ...c, questions: [...c.questions, { id: '', kind: 'choice', scale: 'yesno', DE: '', EN: '' }] }
    : c));

  const save = async () => {
    if (!cfg) return;
    if (cfg.questions.some((q) => !q.DE.trim() && !q.EN.trim())) { setErr(t.formNeedsText); return; }
    const taken = new Set<string>(cfg.questions.map((q) => q.id).filter((id) => Boolean(id)));
    const next: SurveyConfig = {
      ...cfg,
      questions: cfg.questions.map((q) => {
        if (q.id) return q; // frozen once assigned — it is the answers' key
        const id = surveyQuestionId(q.DE || q.EN, taken);
        taken.add(id);
        return { ...q, id };
      }),
    };
    setSaving(true); setErr(''); setSaved(false);
    try {
      await putSurveyConfig(next);
      setCfg(next);
      setSaved(true); window.setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  if (!cfg) return (
    <Card>
      {err ? <p className="text-sm text-red-600">{err}</p> : (
        <div className="space-y-3" role="status" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      )}
    </Card>
  );

  const pairInput = (label: string, value: string, onChange: (v: string) => void, max: number) => (
    <label className="block">
      <span className={fieldLabel}>{label}</span>
      <input className={input} value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    </label>
  );

  return (
    <>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.formIntroTitle}</h2>
        <p className="text-xs text-stone-400 mb-3">{t.formHint}</p>
        <div className="grid sm:grid-cols-2 gap-2.5">
          {pairInput(`${t.formEyebrow} · DE`, cfg.eyebrow.DE, (v) => setCfg({ ...cfg, eyebrow: { ...cfg.eyebrow, DE: v } }), SURVEY_LIMITS.label)}
          {pairInput(`${t.formEyebrow} · EN`, cfg.eyebrow.EN, (v) => setCfg({ ...cfg, eyebrow: { ...cfg.eyebrow, EN: v } }), SURVEY_LIMITS.label)}
          <label className="block">
            <span className={fieldLabel}>{t.formIntro} · DE</span>
            <textarea
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-red-400"
              rows={8} maxLength={SURVEY_LIMITS.intro} value={cfg.intro.DE}
              onChange={(e) => setCfg({ ...cfg, intro: { ...cfg.intro, DE: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.formIntro} · EN</span>
            <textarea
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-red-400"
              rows={8} maxLength={SURVEY_LIMITS.intro} value={cfg.intro.EN}
              onChange={(e) => setCfg({ ...cfg, intro: { ...cfg.intro, EN: e.target.value } })}
            />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-stone-400">{t.formLangNote}</p>
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-stone-700">
            {t.formQuestions} <span className="font-normal text-stone-400">· {t.formCount(cfg.questions.length)}</span>
          </h2>
          <button
            onClick={() => { void resetForm(); }}
            className={cn(btnGhost, 'shrink-0')} title={t.tplReset}
          ><RotateCcw size={13} /> <span className="hidden sm:inline">{t.tplReset}</span></button>
        </div>

        <div className="flex flex-col gap-3">
          {cfg.questions.map((q, i) => (
            <div key={q.id || `new-${i}`} className="rounded-xl border border-stone-200 p-3">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-xs font-semibold text-stone-400 w-5 shrink-0">{i + 1}.</span>
                <select
                  className="h-8 px-2 text-xs rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
                  value={q.kind === 'text' ? 'text' : (q.scale ?? 'yesno')}
                  onChange={(e) => (e.target.value === 'text'
                    ? patchQ(i, { kind: 'text' })
                    : patchQ(i, { kind: 'choice', scale: e.target.value as SurveyScaleId }))}
                  aria-label={t.formType}
                >
                  <option value="text">{t.formTypeText}</option>
                  {SURVEY_SCALE_IDS.map((id) => <option key={id} value={id}>{SURVEY_SCALES[id][lang]}</option>)}
                </select>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} title={t.formUp} aria-label={t.formUp}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-100 disabled:opacity-30"><ChevronUp size={14} /></button>
                  <button onClick={() => move(i, 1)} disabled={i === cfg.questions.length - 1} title={t.formDown} aria-label={t.formDown}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-100 disabled:opacity-30"><ChevronDown size={14} /></button>
                  <button onClick={() => { void remove(i); }} title={t.deleteLabel} aria-label={t.deleteLabel}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-stone-200 text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {pairInput(t.formQuestionDe, q.DE, (v) => patchQ(i, { DE: v }), SURVEY_LIMITS.label)}
                {pairInput(t.formQuestionEn, q.EN, (v) => patchQ(i, { EN: v }), SURVEY_LIMITS.label)}
                {pairInput(t.formHintDe, q.hintDE ?? '', (v) => patchQ(i, { hintDE: v }), SURVEY_LIMITS.hint)}
                {pairInput(t.formHintEn, q.hintEN ?? '', (v) => patchQ(i, { hintEN: v }), SURVEY_LIMITS.hint)}
              </div>
              <p className="mt-2 text-[10px] text-stone-400">
                {t.formKey}: <code className="rounded bg-stone-100 border border-stone-200 px-1 py-0.5 text-stone-500">{q.id || '—'}</code>
              </p>
            </div>
          ))}
        </div>

        <button onClick={add} disabled={cfg.questions.length >= SURVEY_LIMITS.questions} className={cn(btnGhost, 'mt-3')}>
          <Plus size={13} /> {t.formAdd}
        </button>
        <p className="mt-2 text-[11px] text-stone-400">{t.formKeyHint}</p>
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t.save}
          </button>
          {saved && <span className="text-sm text-green-600 font-medium">{t.formSaved}</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </Card>
    </>
  );
}

// ── Activity log ──────────────────────────────────────────────────────
// Reads the API's in-memory ring: server request lines and browser events
// (clicks, fetches, crashes) shipped by every session, interleaved in time.
// This is the tab you open when someone reports something you can't reproduce.
const LEVEL_STYLE: Record<string, string> = {
  error: 'bg-red-50 text-red-700 border-red-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  info: 'bg-stone-50 text-stone-600 border-stone-200',
  debug: 'bg-stone-50 text-stone-400 border-stone-200',
};

function logLine(e: LogEntry): string {
  return `${e.t} ${e.lvl.toUpperCase()} ${e.src} ${e.evt} ${e.msg || ''}${e.user ? ` user=${e.user}` : ''}${e.ip ? ` ip=${e.ip}` : ''}${e.data ? ` ${JSON.stringify(e.data)}` : ''}`;
}

// The coachee's side of a visit. Read-only by design: this is somebody's candid
// opinion of their RC, not a record to be tidied up.
function SurveyAdmin({ t, lang }: { t: T; lang: Lang }) {
  const [rows, setRows] = useState<SurveyResponse[] | null>(null);
  const [err, setErr] = useState('');

  // The questions travel with the responses: this session is the chair's, not an
  // admin's, so it cannot read the questionnaire from the admin endpoint.
  const [form, setForm] = useState<SurveyConfig>(DEFAULT_SURVEY_CONFIG);

  useEffect(() => {
    listSurveyResponses()
      .then((r) => { setForm(r.form); setRows(r.responses); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Answers are stored as stable values, so a response written in English still
  // reads in the admin's chosen language — only free text stays as typed.
  const blocks = (answers: Record<string, string>): Array<{ key: string; label: string; value: string }> => {
    const out: Array<{ key: string; label: string; value: string }> = [];
    const known = new Set<string>();
    for (const q of form.questions) {
      known.add(q.id);
      if (!answers[q.id]) continue;
      out.push({ key: q.id, label: questionLabel(q, lang), value: answerLabel(q, answers[q.id], lang) });
    }
    // Answers to a question that has since been reworded away or deleted. Shown
    // under their raw key rather than dropped — a silently shortened response
    // reads exactly like a complete one.
    for (const key of Object.keys(answers)) {
      if (known.has(key) || !answers[key]) continue;
      out.push({ key, label: key, value: answers[key] });
    }
    return out;
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-stone-500 leading-snug">{t.surveyHint}</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!rows && !err && <SkeletonRows />}
      {rows?.length === 0 && <p className="text-sm text-stone-400 py-8 text-center">{t.surveyEmpty}</p>}
      {rows?.map((r) => (
        <div key={r.id} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 mb-3 border-b border-stone-100">
            {r.anonymous ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-400"><UserX size={14} /> {t.surveyAnon}</span>
            ) : (
              <span className="text-sm font-semibold text-stone-800">{r.referee}</span>
            )}
            <span className="text-xs text-stone-400">{r.date}</span>
            <span className="text-xs text-stone-400">#{r.matchNo}</span>
            <span className="ml-auto text-xs text-stone-500">{r.rc}</span>
          </div>
          {/* The coachee's own words about their coach — never into the log. */}
          <dl data-log-redact className="flex flex-col gap-3">
            {blocks(r.answers).map((b) => (
              <div key={b.key}>
                <dt className="text-xs text-stone-400 leading-snug">{b.label}</dt>
                <dd className="text-sm text-stone-800 whitespace-pre-wrap mt-0.5">{b.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

// What a coach wanted the chair to know but not the referee. Read-only here on
// purpose — same as the survey tab, this is somebody's candid word, not a
// record to be edited. Only the note's author can change it, back in the app.
function PresidentNotesAdmin({ t, lang }: { t: T; lang: Lang }) {
  const [rows, setRows] = useState<PresidentNote[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    listPresidentNotes().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const fmtDate = (value: string) => {
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? value
      : d.toLocaleDateString(lang === 'DE' ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-stone-500 leading-snug">{t.notesHint}</p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {!rows && !err && <SkeletonRows />}
      {rows?.length === 0 && <p className="text-sm text-stone-400 py-8 text-center">{t.notesEmpty}</p>}
      {rows?.map((r) => (
        <div key={r.id} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 mb-3 border-b border-stone-100">
            <span className="text-sm font-semibold text-stone-800">{r.coacheeName || '—'}</span>
            {r.gameDate && <span className="text-xs text-stone-400">{fmtDate(r.gameDate)}</span>}
            {r.league && <span className="text-xs text-stone-400">{r.league}</span>}
            {r.teams && <span className="text-xs text-stone-500 truncate">{r.teams}</span>}
            {/* Usually the same person; when they differ an admin wrote on a
                coach's observation, and reading it as the coach's would mislead. */}
            <span className="ml-auto text-xs text-stone-500">
              {r.authorName && r.authorName !== r.rcName ? t.notesBy(r.authorName, r.rcName) : r.rcName}
            </span>
          </div>
          {/* Confidential to the chair; the server already keeps it out of its
              own request log, and the click logger must do the same. */}
          <p data-log-redact className="text-sm text-stone-800 whitespace-pre-wrap">{r.note}</p>
        </div>
      ))}
    </div>
  );
}

function LogsAdmin({ t, active }: { t: T; active: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [sessions, setSessions] = useState<LogSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [live, setLive] = useState(true);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('');
  const [src, setSrc] = useState('');
  const [sid, setSid] = useState('');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await getAdminLogs({ limit: 800, q, level, src, sid });
      setEntries(res.entries);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [q, level, src, sid]);

  // Poll only while the tab is visible and Live is on — an admin console left
  // open on another tab shouldn't hit the API every 3 seconds forever.
  useEffect(() => {
    if (!active) return;
    void load();
    if (!live) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3000);
    return () => clearInterval(id);
  }, [active, live, load]);

  useEffect(() => { if (active) getAdminLogSessions().then(setSessions).catch(() => {}); }, [active, entries.length]);

  // Newest at the bottom, like a terminal — stick to it unless the reader has
  // scrolled up to look at something.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !live) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [entries, live]);

  const copyAll = async () => {
    try { await navigator.clipboard.writeText(entries.map(logLine).join('\n')); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };

  const reset = () => { setQ(''); setLevel(''); setSrc(''); setSid(''); };

  return (
    <Card>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <h2 className="text-sm font-semibold text-stone-800 mr-auto">{t.logs}</h2>
        <button onClick={() => setLive((v) => !v)} className={cn('inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border transition-colors', live ? 'bg-green-50 border-green-200 text-green-700' : 'bg-stone-100 border-stone-200 text-stone-500')}>
          {live ? <Pause size={13} /> : <Play size={13} />}{t.logsLive}
        </button>
        <button onClick={copyAll} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border border-stone-200 text-stone-600 hover:bg-stone-100 transition-colors">
          <Copy size={13} />{copied ? t.logsCopied : t.logsCopy}
        </button>
      </div>
      <p className="text-xs text-stone-500 mb-3">{t.logsHint}</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.logsSearch} className={cn(input, 'flex-1 min-w-[180px]')} />
        <select value={level} onChange={(e) => setLevel(e.target.value)} className={cn(input, 'w-auto')}>
          {/* The API treats level as a MINIMUM, so each option widens/narrows. */}
          <option value="">{t.logsLevel}: {t.logsAll}</option>
          <option value="info">info+</option>
          <option value="warn">{t.logsErrorsOnly}</option>
          <option value="error">error</option>
        </select>
        <select value={src} onChange={(e) => setSrc(e.target.value)} className={cn(input, 'w-auto')}>
          <option value="">{t.logsSource}: {t.logsAll}</option>
          <option value="server">{t.logsServer}</option>
          <option value="client">{t.logsClient}</option>
        </select>
        <select value={sid} onChange={(e) => setSid(e.target.value)} className={cn(input, 'w-auto max-w-[220px]')}>
          <option value="">{t.logsSessions}: {t.logsAll}</option>
          {sessions.map((s) => (
            <option key={s.sid} value={s.sid}>
              {(s.user || 'anonym')} · {new Date(s.last).toLocaleTimeString()} · {s.count}{s.errors ? ` ⚠${s.errors}` : ''}
            </option>
          ))}
        </select>
        {(q || level || src || sid) && (
          <button onClick={reset} className="h-9 px-3 rounded-lg text-xs font-medium border border-stone-200 text-stone-600 hover:bg-stone-100">{t.logsClear}</button>
        )}
      </div>

      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      {loading ? <SkeletonRows rows={8} /> : entries.length === 0 ? (
        <p className="text-sm text-stone-400 py-6 text-center">{t.logsEmpty}</p>
      ) : (
        <div ref={scroller} className="max-h-[62vh] overflow-y-auto rounded-xl border border-stone-200 divide-y divide-stone-100 bg-white">
          {entries.map((e) => (
            <div key={e.seq} className="px-2.5 py-1.5 hover:bg-stone-50 cursor-pointer" onClick={() => setExpanded(expanded === e.seq ? null : e.seq)}>
              {/* One line per entry on a desktop, two on a phone. Everything
                  around the message is shrink-0, so on a narrow screen the
                  message was the only thing left to squeeze: it ended up a
                  column two characters wide, one letter per line. `w-full`
                  drops it onto its own full-width line below the metadata
                  instead, and `sm:w-auto sm:flex-1` puts the terminal-style
                  single line back as soon as there is room for it. */}
              <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5 font-mono text-[11px] leading-relaxed">
                <span className="text-stone-400 shrink-0 tabular-nums">{new Date(e.t).toLocaleTimeString('de-CH', { hour12: false })}</span>
                <span className={cn('shrink-0 px-1.5 rounded border text-[10px] font-semibold uppercase', LEVEL_STYLE[e.lvl] || LEVEL_STYLE.info)}>{e.lvl}</span>
                <span className={cn('shrink-0 text-[10px] uppercase font-semibold', e.src === 'client' ? 'text-indigo-500' : 'text-stone-400')}>{e.src === 'client' ? 'app' : 'srv'}</span>
                <span className="shrink-0 text-stone-500 break-all">{e.evt}</span>
                <span className="order-last sm:order-none w-full sm:w-auto sm:flex-1 min-w-0 text-stone-800 break-words">{e.msg}</span>
                {e.user && <span className="ml-auto shrink-0 text-stone-400 truncate max-w-[45%]">{e.user}</span>}
              </div>
              {expanded === e.seq && (
                <pre className="mt-1.5 p-2 rounded-lg bg-stone-900 text-stone-100 text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify({ ...e }, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Settings are fetched once by the console shell and handed down — this tab
// never issues its own /api/settings request.
// Create (and delete) a one-off game. VolleyManager is the normal source; this
// covers fixtures it doesn't carry and throwaway games used to exercise the
// whole observation → PDF → e-mail flow against the real backend.
function ManualGameAdmin({ t, lang }: { t: T; lang: Lang }) {
  const today = new Date().toISOString().slice(0, 10);
  const empty = { match_no: '', league: '', match_date: today, location: '', home_team: '', away_team: '', first_referee: '', second_referee: '', assigned_rc: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; match_no?: string } | null>(null);
  const [err, setErr] = useState('');
  const [list, setList] = useState<ManualGame[]>([]);
  const [q, setQ] = useState('');
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const reload = useCallback(async (search = '') => {
    try { setList(await listManualGames(search)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const create = async () => {
    setBusy(true); setErr('');
    try {
      // The games collection stores a datetime — pin a plausible kick-off.
      const created = await createGame({ ...f, match_date: `${f.match_date} 20:00:00.000Z` });
      setMade({ id: created.id, match_no: created.match_no });
      setF(empty);
      await reload(q);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string, label: string) => {
    if (!(await confirmDialog({ title: t.mgConfirmDelete(label), message: t.undoWarn, confirmLabel: t.deleteLabel, tone: 'danger', lang }))) return;
    setBusy(true); setErr('');
    // The failure keeps its inline `err` line; the toast only marks the success.
    try { await deleteGame(id); if (made?.id === id) setMade(null); await reload(q); toast.success(t.mgDeleteOk(label), { lang }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.mgTitle}</h2>
      <p className="text-xs text-stone-400 mb-3">{t.mgHint}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgDate}</span>
          <input type="date" className={input} value={f.match_date} onChange={set('match_date')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgLeague}</span>
          <input className={input} placeholder="3L ♂" value={f.league} onChange={set('league')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgMatchNo}</span>
          <input className={input} value={f.match_no} onChange={set('match_no')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgHome}</span>
          <input className={input} value={f.home_team} onChange={set('home_team')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgAway}</span>
          <input className={input} value={f.away_team} onChange={set('away_team')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgLocation}</span>
          <input className={input} value={f.location} onChange={set('location')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRef1}</span>
          <input className={input} value={f.first_referee} onChange={set('first_referee')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRef2}</span>
          <input className={input} value={f.second_referee} onChange={set('second_referee')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRc}</span>
          <input className={input} value={f.assigned_rc} onChange={set('assigned_rc')} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={create} disabled={busy || !f.match_date} className={btnPrimary}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} {t.mgCreate}
        </button>
        {made && <span className="text-sm text-green-600 font-medium">{t.mgCreated(made.match_no || made.id)}</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>

      {/* Cleanup list — a throwaway fixture is only obvious right after it is
          created, so keep every TEST- game reachable for deletion. */}
      <div className="mt-5 pt-4 border-t border-stone-100">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-stone-700">{t.mgExisting}</h3>
          <input
            className={cn(input, 'ml-auto w-full sm:w-56')}
            placeholder={t.mgSearch}
            value={q}
            onChange={(e) => { setQ(e.target.value); void reload(e.target.value); }}
          />
        </div>
        {list.length === 0 ? (
          <p className="text-xs text-stone-400">{t.mgNone}</p>
        ) : (
          <div className="divide-y divide-stone-100">
            {list.map((g) => (
              <div key={g.id} className="py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800 truncate">
                    {g.match_no}{g.home_team || g.away_team ? ` · ${g.home_team} vs ${g.away_team}` : ''}
                  </p>
                  <p className="text-xs text-stone-400 truncate">
                    {g.match_date ? new Date(g.match_date).toLocaleDateString(lang === 'DE' ? 'de-CH' : 'en-GB') : ''}
                    {g.league ? ` · ${g.league}` : ''}{g.assigned_rc ? ` · ${g.assigned_rc}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => void remove(g.id, g.match_no || g.id)}
                  disabled={busy}
                  className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={13} /> {t.mgDelete}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

// The nightly VolleyManager import: whether it still works, and the button that
// runs it now. Both belong on the same card — the readout used to be the only
// thing here, so the one question it provokes ("then run it again") had no
// answer anywhere in the console and meant waiting for tomorrow's cron.
function GameImportCard({ lang }: { lang: Lang }) {
  const [sync, setSync] = useState<GamesSyncStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const de = lang === 'DE';

  const load = useCallback(() => {
    getGamesSyncStatus()
      // Anything that is not the object we expect (an array, a string) is no
      // status at all: reading .cron off it printed "schedule undefined".
      .then((s) => setSync(s && typeof s === 'object' && !Array.isArray(s) ? s : null))
      .catch(() => setSync(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setRunning(true); setNote(''); setError('');
    try {
      const r = await syncGames();
      setNote(de
        ? `${r.imported} Spiele importiert (${r.totalFetched} geprüft).`
        : `${r.imported} games imported (${r.totalFetched} checked).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      // The run records its own outcome server-side, so re-read it rather than
      // patching the card from the response: this way a manual run and the
      // nightly one leave the same, single source of truth on screen.
      load();
    }
  };

  // What matters is whether the importer still RUNS, not whether games
  // changed: the season is September to April, so from May to August
  // nothing changes for months and a "nothing new lately" alarm would cry
  // wolf all summer. The cron is daily, so a run recorded within 36 hours
  // is healthy; the newest game is shown as information, not as a test.
  const lastRun = sync?.status ? new Date(sync.status.at) : null;
  const stale = !lastRun || Number.isNaN(lastRun.getTime())
    || (Date.now() - lastRun.getTime()) / 3_600_000 > 36;
  // `sync.status` is null before the first run and undefined if the
  // payload is not what we expect — `!== null` was true for both, and
  // then reading .ok threw and took the whole console down with it.
  const bad = (sync?.status ? !sync.status.ok : false) || stale;
  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    // mb-4 to match Card(): the gap between cards comes from each card's own
    // bottom margin, not from a parent, so a card that forgets it sits flush
    // against the next one.
    <div className={cn('rounded-xl border px-4 py-3 text-xs mb-4',
      bad ? 'border-red-300 bg-red-50 text-red-800' : 'border-stone-200 bg-white text-stone-600')}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0">
          <div className="font-semibold mb-0.5">{de ? 'Spiel-Import (VolleyManager)' : 'Game import (VolleyManager)'}</div>
          {sync ? (
            <>
              <div>
                {de ? 'Neuestes Spiel aktualisiert: ' : 'Newest game updated: '}
                <strong>{sync.newestGame ? when(sync.newestGame) : '–'}</strong>
                {` · ${de ? 'Zeitplan' : 'schedule'} ${sync.cron}`}
              </div>
              {sync.status && (
                <div className="mt-0.5">
                  {de ? 'Letzter Lauf: ' : 'Last run: '}{when(sync.status.at)}
                  {sync.status.ok
                    ? ` · ${sync.status.imported ?? 0} ${de ? 'importiert' : 'imported'}`
                    : ` · ${de ? 'FEHLER' : 'FAILED'}: ${sync.status.error ?? ''}`}
                </div>
              )}
            </>
          ) : (
            <div>{de ? 'Status nicht abrufbar.' : 'Status unavailable.'}</div>
          )}
        </div>
        {/* Runs the same import the cron runs, over the same window. Slow (a
            VolleyManager login and a season of games), hence the spinner. */}
        <button onClick={() => void run()} disabled={running} className={cn(btnPrimary, 'ml-auto shrink-0')}>
          {running ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          <span>{running
            ? (de ? 'Importiert …' : 'Importing…')
            : (de ? 'Jetzt importieren' : 'Import now')}</span>
        </button>
      </div>
      {/* Only when there is a status to judge: with none, "Status unavailable"
          above already says everything that is known. */}
      {sync && bad && (
        <div className="mt-1 font-medium">
          {de
            ? 'Der nächtliche Import hat zuletzt nicht erfolgreich gelaufen. Prüfe die VolleyManager-Verbindung (Rolle des Sync-Kontos).'
            : 'The nightly import did not last run successfully. Check the VolleyManager connection (the sync account\u2019s role).'}
        </div>
      )}
      {note && <p className="mt-2 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-green-700">{note}</p>}
      {error && <p className="mt-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-red-700">{error}</p>}
    </div>
  );
}

// Passwords are write-only from here on purpose: the server stores a scrypt
// hash, so there is nothing to read back. Replacing one IS the recovery path,
// which is the same operation as rotating it — and the value shows once, right
// after saving, because whoever changes the team password has to go and tell
// twenty coaches what it is now.
// Season progress across every referee coach. This lived in the coach app
// behind an "is this an admin" check, which meant the app had two personalities
// depending on who was looking. Admin reporting belongs with the other admin
// reporting; the coach app now shows a coach their own row and nothing else.
function OverviewAdmin({ t }: { t: T }) {
  const [rows, setRows] = useState<RcOverviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    loadRcOverview()
      .then((r) => setRows(Array.isArray(r) ? r : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700">{t.overview}</h2>
      <p className="mt-1 text-xs text-stone-500">{t.ovHint}</p>
      {error && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /></div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">{t.ovNone}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-stone-400 border-b border-stone-200">
                <th className="py-2 pr-3 font-semibold">{t.ovName}</th>
                <th className="py-2 pr-3 font-semibold text-right">{t.ovDone}</th>
                <th className="py-2 pr-3 font-semibold text-right">{t.ovPlanned}</th>
                <th className="py-2 font-semibold text-right">{t.ovOutstanding}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/70">
                  <td className="py-2 pr-3 font-medium text-stone-800 whitespace-nowrap">{r.fullName}</td>
                  <td className="py-2 pr-3 text-right text-green-700 font-semibold">{r.done}</td>
                  <td className="py-2 pr-3 text-right text-blue-700 font-semibold">{r.planned}</td>
                  {/* Outstanding is the number worth acting on, so it is the one that shouts. */}
                  <td className={cn('py-2 text-right font-semibold', r.outstanding > 0 ? 'text-amber-700' : 'text-stone-400')}>{r.outstanding}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Assigning a game to a coach. The coach app only ever lets someone take a game
// FOR THEMSELVES — the server refuses anything else (see /api/games/:id/assign-rc)
// unless the request carries an admin session. This is that exception, moved
// out of the coach app and into the console where it is obviously an admin act.
function GamesAdmin({ t, lang }: { t: T; lang: Lang }) {
  const [games, setGames] = useState<EligibleGame[]>([]);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  const [q, setQ] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [g, p] = await Promise.all([loadEligibleGames(), listRefereeCoachPeople()]);
      setGames(Array.isArray(g) ? g : []);
      setPeople(Array.isArray(p) ? p : []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const assign = async (game: EligibleGame, rcName: string) => {
    setError(''); setBusy(game.id);
    const previous = games;
    // Optimistic, then reconciled by the reload. A rejected assign rolls the
    // row back and says why rather than leaving a name that never landed.
    setGames((cur) => cur.map((x) => (x.id === game.id ? { ...x, assignedRc: rcName } : x)));
    try { await assignRcToGame(game.id, rcName); await reload(); }
    catch (e) { setGames(previous); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const needle = q.trim().toLowerCase();
  const shown = games.filter((g) => {
    if (unassignedOnly && g.assignedRc) return false;
    if (!needle) return true;
    return [g.matchNo, g.league, g.location, g.homeTeam, g.awayTeam, g.firstReferee, g.secondReferee, g.assignedRc]
      .some((v) => (v || '').toLowerCase().includes(needle));
  });

  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700">{t.games}</h2>
      <p className="mt-1 text-xs text-stone-500">{t.gamesHint}</p>
      {error && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={cn(input, 'flex-1 min-w-[16rem]')} placeholder={t.gamesSearch} value={q} onChange={(e) => setQ(e.target.value)} />
        <button onClick={() => setUnassignedOnly((v) => !v)} className={cn(btnGhost, unassignedOnly && 'text-red-600 border-red-200')}>
          {t.gamesUnassigned}
        </button>
      </div>
      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /></div>
      ) : shown.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">{t.gamesNone}</p>
      ) : (
        <div className="mt-3 space-y-2 max-h-[70vh] overflow-y-auto">
          {shown.slice(0, 300).map((g) => (
            <div key={g.id} className="rounded-xl border border-stone-200 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                <span className="font-medium text-stone-800">{g.homeTeam} – {g.awayTeam}</span>
                <span className="text-xs text-stone-500">{g.league} · #{g.matchNo}</span>
              </div>
              <p className="mt-0.5 text-xs text-stone-500">
                {new Date(g.date).toLocaleDateString(lang === 'DE' ? 'de-CH' : 'en-GB')} · {g.location}
                {g.firstReferee ? ` · 1SR ${g.firstReferee}` : ''}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs font-medium text-stone-500">RC:</label>
                <select
                  className={cn(input, 'flex-1 min-w-[12rem] max-w-sm cursor-pointer')}
                  value={g.assignedRc || ''}
                  disabled={busy === g.id}
                  onChange={(e) => void assign(g, e.target.value)}
                >
                  <option value="">–</option>
                  {people.map((p) => <option key={p.id} value={p.fullName}>{p.fullName}</option>)}
                </select>
                {busy === g.id && <Loader2 size={14} className="animate-spin text-stone-400" />}
              </div>
            </div>
          ))}
          {shown.length > 300 && (
            // Said out loud rather than silently truncated: a list that stops at
            // 300 without mentioning it reads as "that is all of them".
            <p className="text-xs text-stone-400">… {shown.length - 300} more — narrow the search.</p>
          )}
        </div>
      )}
    </Card>
  );
}

function CredentialsAdmin({ t }: { t: T }) {
  const [slots, setSlots] = useState<CredentialSlotInfo[]>([]);
  const [minLength, setMinLength] = useState(10);
  const [drafts, setDrafts] = useState<Record<string, { username: string; password: string; code: string }>>({});
  const [busy, setBusy] = useState('');
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  // Which slot has a live code out, and where it went. Only one at a time: the
  // server binds the code to this session AND to one slot, so a second request
  // replaces the first rather than running beside it.
  const [challenge, setChallenge] = useState<{ slot: string; sentTo: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await getCredentials();
      // Defensive: every tab is mounted at once, so a malformed body here does
      // not just break this card — it throws during render and the console's
      // ErrorBoundary replaces the whole page, coachees and all.
      setSlots(Array.isArray(data?.slots) ? data.slots : []);
      if (Number.isFinite(data?.minLength)) setMinLength(data.minLength);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const labels: Record<string, { title: string; hint: string }> = {
    shared: { title: t.credShared, hint: t.credSharedHint },
    admin: { title: t.credAdmin, hint: t.credAdminHint },
    president: { title: t.credPresident, hint: t.credPresidentHint },
  };

  const sendCode = async (slot: CredentialSlotInfo) => {
    setError(''); setSaved(''); setBusy(slot.slot);
    try {
      const { sentTo } = await requestCredentialCode(slot.slot);
      setChallenge({ slot: slot.slot, sentTo });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const save = async (slot: CredentialSlotInfo) => {
    const draft = drafts[slot.slot] ?? { username: slot.username, password: '', code: '' };
    setError(''); setSaved('');
    if (draft.password.length < minLength) { setError(t.credTooShort(minLength)); return; }
    setBusy(slot.slot);
    try {
      const username = draft.username.trim() || slot.username;
      const result = await setCredential(slot.slot, username, draft.password, draft.code.trim());
      setDrafts((d) => ({ ...d, [slot.slot]: { username, password: '', code: '' } }));
      setChallenge(null);
      setSaved(t.credSaved(username) + (result?.feedsRevoked ? ` ${t.credFeedsRevoked}` : ''));
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700">{t.credentials}</h2>
      <p className="mt-1 text-xs text-stone-500">{t.credentialsHint}</p>
      {error && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
      {saved && <p className="mt-2 text-xs text-green-800 bg-green-50 border border-green-100 rounded-lg px-3 py-2">{saved}</p>}
      <div className="mt-3 space-y-4">
        {slots.map((slot) => {
          const draft = drafts[slot.slot] ?? { username: slot.username, password: '', code: '' };
          const set = (patch: Partial<{ username: string; password: string; code: string }>) =>
            setDrafts((d) => ({ ...d, [slot.slot]: { ...draft, ...patch } }));
          const armed = challenge?.slot === slot.slot;
          return (
            <div key={slot.slot} className="rounded-xl border border-stone-200 p-3">
              <p className="text-sm font-medium text-stone-800">{labels[slot.slot]?.title ?? slot.slot}</p>
              <p className="mt-0.5 text-xs text-stone-500">{labels[slot.slot]?.hint}</p>
              <p className="mt-1 text-[11px] text-stone-400">
                {slot.source === 'env' ? t.credFromEnv
                  : slot.source === 'unset' ? t.credNeverSet
                  : t.credChangedAt(new Date(slot.updatedAt ?? '').toLocaleDateString(), slot.updatedBy ?? '')}
              </p>
              {!armed ? (
                // Nothing is editable until a code has been asked for: a change
                // starts by proving you can read the mailbox, not by typing.
                <div className="mt-2 flex items-center gap-2">
                  <button className={btnGhost} disabled={busy === slot.slot} onClick={() => void sendCode(slot)}>
                    {busy === slot.slot ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />} {t.credSendCode}
                  </button>
                  <span className="text-[11px] text-stone-400">{t.credCodeWhy}</span>
                </div>
              ) : (
                <>
                  <p className="mt-2 text-[11px] text-green-800">{t.credCodeSent(challenge.sentTo)}</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,7rem)_auto]">
                    <input className={input} value={draft.username} aria-label={t.credUser} placeholder={t.credUser}
                      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      onChange={(e) => set({ username: e.target.value })} />
                    <input className={input} value={draft.password} type="text" aria-label={t.credNew} placeholder={t.credNew}
                      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                      onChange={(e) => set({ password: e.target.value })} />
                    <input className={input} value={draft.code} aria-label={t.credCode} placeholder={t.credCode}
                      inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                      onChange={(e) => set({ code: e.target.value.replace(/\D/g, '') })} />
                    <button className={btnPrimary}
                      disabled={busy === slot.slot || draft.password.length < minLength || draft.code.trim().length !== 6}
                      onClick={() => void save(slot)}>
                      {busy === slot.slot ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} {t.credSave}
                    </button>
                  </div>
                  <button className="mt-2 text-[11px] text-stone-400 hover:text-stone-600"
                    onClick={() => { setChallenge(null); set({ password: '', code: '' }); }}>
                    {t.credChangeCancel}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function SettingsAdmin({ t, lang, testMode, onTestMode, defaultSeason, settingsLoading, groups, onGroups, defaultGoal, onDefaultGoal }: { t: T; lang: Lang; testMode: boolean; onTestMode: (v: boolean) => void; defaultSeason: number; settingsLoading: boolean; groups: string[]; onGroups: (g: string[]) => void; defaultGoal: number; onDefaultGoal: (n: number) => Promise<void> }) {
  const [season, setSeason] = useState<number>(defaultSeason);
  const seasonTouched = useRef(false);
  useEffect(() => { if (!seasonTouched.current) setSeason(defaultSeason); }, [defaultSeason]);
  const [saved, setSaved] = useState(false);
  const [goal, setGoal] = useState<string>(String(defaultGoal));
  const goalTouched = useRef(false);
  useEffect(() => { if (!goalTouched.current) setGoal(String(defaultGoal)); }, [defaultGoal]);
  const [goalSaved, setGoalSaved] = useState(false);
  const saveGoal = async () => {
    const n = Math.round(Number(goal));
    if (!Number.isFinite(n) || n <= 0) { setGoal(String(defaultGoal)); return; }
    await onDefaultGoal(n);
    setGoalSaved(true); setTimeout(() => setGoalSaved(false), 2500);
  };
  const loading = settingsLoading;
  const [ng, setNg] = useState('');
  const [gi, setGi] = useState<number | null>(null);
  // The name the open edit row started on — the index alone is not stable across
  // a re-sort. See saveEditGroup.
  const [giName, setGiName] = useState('');
  const [gv, setGv] = useState('');
  const [groupsError, setGroupsError] = useState('');
  // Optimistic, but no longer silent: a rejected save (expired session, 500)
  // used to leave the new list on screen as if it had been stored.
  // Returns whether the write stuck, so a caller can toast the success without
  // claiming one for a save that rolled back.
  // `groups` is a prop captured at render, and every group write now spans an
  // awaited dialog — long enough for an optimistic add to roll back underneath
  // it. Rebuilding the list from a render-time snapshot would silently resurrect
  // a group whose save the server had already rejected, so both writers read
  // the latest list through this ref instead.
  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  const saveGroups = async (next: string[]) => {
    const previous = groupsRef.current;
    onGroups(next);
    setGroupsError('');
    try { await putSettings({ groups: next }); return true; }
    catch (e) { onGroups(previous); setGroupsError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const addGroup = () => { const v = ng.trim(); if (!v || groups.includes(v)) return; setNg(''); void saveGroups([...groups, v].sort()); };
  // Filtered by NAME, not by the index: the dialog is awaited, and the list can
  // be re-sorted under an open dialog the same way it can under an open edit row
  // (see saveEditGroup). Names are unique here — addGroup and the rename both
  // refuse a duplicate.
  const delGroup = async (i: number) => {
    const name = groups[i];
    if (!(await confirmDialog({ title: t.delGroup(name), message: t.delGroupNote, confirmLabel: t.deleteLabel, tone: 'danger', lang }))) return;
    const current: string[] = groupsRef.current;
    if (!current.includes(name)) return; // deleted, or rolled back, under the dialog
    if (await saveGroups(current.filter((g) => g !== name))) toast.success(t.delGroupOk(name), { lang });
  };
  const saveEditGroup = async (i: number) => {
    const v = gv.trim();
    // Re-resolved by NAME, not by the index the edit started at: the list is
    // re-sorted on every save, so adding or deleting a group while this row was
    // open retargeted the rename onto a different group. The confirm dialog names
    // the real victim, which is the only reason it was survivable.
    const original = gi != null ? giName : groups[i];
    const at = groups.indexOf(original);
    if (at < 0) { setGi(null); return; } // renamed or deleted underneath us
    // Coachees carry the group name as a string, so a rename splits the cohort
    // into two spellings that every filter treats as different groups.
    if (v && v !== original && !(await confirmDialog({ title: t.renameGroupWarn(original, v), message: t.renameGroupNote(original), confirmLabel: t.renameLabel, lang }))) return;
    // The save stays fire-and-forget so the editor closes on the same tick it
    // always did; only the toast waits to hear that the write stuck.
    // Re-resolved AFTER the dialog, against the freshest list, for the same
    // reason `at` was resolved by name rather than by index.
    const current: string[] = groupsRef.current;
    const nowAt = current.indexOf(original);
    if (nowAt < 0) { setGi(null); return; }
    if (v) { const next = current.slice(); next[nowAt] = v; void saveGroups(Array.from(new Set(next)).sort()).then((ok) => { if (ok && v !== original) toast.success(t.renameGroupOk(original, v), { lang }); }); }
    setGi(null);
  };
  const save = async () => { await putSettings({ default_season: season }); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const toggleTest = async () => { const next = !testMode; onTestMode(next); try { await putSettings({ test_mode: next }); } catch { onTestMode(!next); } };
  return (
    <>
      <GameImportCard lang={lang} />
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.defaultSeason}</h2>
        <p className="text-xs text-stone-400 mb-3">{t.defaultSeasonHint}</p>
        <div className="flex items-center gap-2">
          <select value={season} disabled={loading} onChange={(e) => setSeason(Number(e.target.value))} className="h-9 rounded-lg border border-stone-300 bg-white text-sm px-3">{[...new Set([season, ...SEASONS])].sort().map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}</select>
          <button onClick={save} className={btnPrimary}><Check size={15} /> {t.save}</button>
          {saved && <span className="text-xs text-green-600 font-medium">{t.saved}</span>}
        </div>
      </Card>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.defaultGoal}</h2>
        {/* The saved goal drives the hint, not the field being typed in — the
            half only becomes real once it is saved. */}
        <p className="text-xs text-stone-400 mb-3">{t.defaultGoalHint()}</p>
        <div className="flex items-center gap-2">
          <input
            type="number" min={1} inputMode="numeric" disabled={loading}
            className="h-9 w-20 px-3 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
            value={goal}
            onChange={(e) => { goalTouched.current = true; setGoal(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveGoal(); }}
          />
          <button onClick={() => void saveGoal()} className={btnPrimary}><Check size={15} /> {t.save}</button>
          {goalSaved && <span className="text-xs text-green-600 font-medium">{t.saved}</span>}
        </div>
      </Card>
      <Card>
        <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.groups}</h2>
        <p className="text-xs text-stone-400 mb-3">{t.groupsHint}</p>
        <div className="flex gap-2 mb-3">
          <input className={input} placeholder={t.newGroup} value={ng} onChange={(e) => setNg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }} />
          <button onClick={addGroup} className={btnPrimary}><Plus size={15} /> {t.add}</button>
        </div>
        <div className="divide-y divide-stone-100">
          {groups.map((g, i) => gi === i ? (
            <div key={g} className="py-2 flex items-center gap-2">
              <input className={input} value={gv} onChange={(e) => setGv(e.target.value)} />
              <button onClick={() => { void saveEditGroup(i); }} className={btnPrimary}><Check size={15} /></button>
              <button onClick={() => setGi(null)} className={btnGhost}><X size={14} /></button>
            </div>
          ) : (
            <div key={g} className="py-2 flex items-center gap-3">
              <span className="flex-1 text-sm text-stone-800">{g}</span>
              <button onClick={() => { setGi(i); setGiName(g); setGv(g); }} className={btnGhost} aria-label={t.edit} title={t.edit}><Pencil size={13} /></button>
              <button onClick={() => { void delGroup(i); }} aria-label={t.deleteLabel} title={t.deleteLabel} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {groups.length === 0 && <p className="py-4 text-center text-xs text-stone-400">—</p>}
        </div>
        {groupsError && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{groupsError}</p>}
      </Card>
      <Card>
        <div className="flex items-start gap-3">
          <FlaskConical size={18} className={testMode ? 'text-amber-600 mt-0.5' : 'text-stone-400 mt-0.5'} />
          <div className="flex-1"><h2 className="text-sm font-semibold text-stone-700">{t.testTitle}</h2><p className="text-xs text-stone-400">{t.testHint}</p></div>
          <button onClick={toggleTest} disabled={loading} role="switch" aria-checked={testMode} className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors ${testMode ? 'bg-amber-500' : 'bg-stone-300'}`}><span className={`inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform mt-0.5 ${testMode ? 'translate-x-5' : 'translate-x-0.5'}`} /></button>
        </div>
        <p className={`mt-2 text-xs font-medium ${testMode ? 'text-amber-700' : 'text-green-600'}`}>{testMode ? t.testOn : t.testOff}</p>
      </Card>
    </>
  );
}
