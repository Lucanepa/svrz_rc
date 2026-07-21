import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Eye, EyeOff, Loader2, LogOut, Upload, Plus, Trash2, Pencil, Check, X, Users, ShieldCheck, Settings as SettingsIcon, FlaskConical, Languages, ChevronDown, Home, Target, KeyRound, Mail, RotateCcw, Send, ScrollText, Pause, Play, Copy, MessageSquare, UserX } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { cn } from '../lib/utils';
import {
  getAdminAuthStatus, adminUiLogin, logoutAdmin, getAuthMe,
  listCoachees, createCoachee, updateCoachee, deleteCoachee, importCoachees,
  listRcPeopleFull, createRcPerson, updateRcPerson, deleteRcPerson, generateRcPin,
  getSettings, putSettings, loadEligibleGames,
  getEmailTemplates, putEmailTemplates, getReminderPreview, createGame, deleteGame, listManualGames,
  getAdminLogs, getAdminLogSessions, listSurveyResponses, syncCoacheeContacts,
  type Coachee, type RcPerson, type ImportRow, type EmailTemplate, type EmailTemplates, type ReminderPreview, type ManualGame,
  type LogEntry, type LogSession, type SurveyResponse,
} from '../lib/pocketbase';
import {
  levelKey, levelDisplay, hasNiveauRules, summarizeTarget, isTargetActive,
  type CoacheeTarget, type CoacheeTargetMap, type TargetRole,
} from '../lib/niveauTargets';
import { SURVEY_QUESTIONS, questionLabel, type SurveyQuestion } from '../lib/survey';
import { OBSERVATION_GOAL, goalForMandate, type RcMandate, type RcMandateMap } from '../types';
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
    admin: 'Admin', logout: 'Abmelden', login: 'Anmelden', adminPw: 'Admin-Passwort', wrongPw: 'Falsches Passwort',
    noAdminRights: 'Dein Konto hat keine Admin-Rechte. Falls du Admin bist, melde dich mit dem Admin-Passwort an.',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Einstellungen', testBadge: 'Testmodus',
    emails: 'E-Mails', logs: 'Protokoll', survey: 'RC-Feedback',
    surveyHint: 'Rückmeldungen der Schiedsrichter:innen zum RC-Besuch — nur hier sichtbar. Alle Fragen sind freiwillig, leere Antworten fehlen entsprechend.',
    surveyEmpty: 'Noch keine Rückmeldungen.',
    surveyAnon: 'Anonym',
    logsHint: 'Alles, was passiert: jede Anfrage, jeder Klick in der App, jeder Fehler. Neueste zuletzt.',
    logsSearch: 'Suchen (E-Mail, Pfad, Text…)', logsLevel: 'Stufe', logsSource: 'Quelle', logsAll: 'Alle',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'Keine Einträge.',
    logsCopy: 'Kopieren', logsCopied: 'Kopiert ✓', logsSessions: 'Sitzungen', logsClear: 'Filter zurücksetzen',
    logsErrorsOnly: 'Nur Probleme',
    tplFeedback: 'Feedback-E-Mail (nach dem Spiel)',
    tplFeedbackHint: 'Wird nach dem Absenden eines Feedbacks an den Coachee gesendet (RC in Kopie, PDF im Anhang).',
    tplReminder: 'Erinnerung (Tag vor dem Spiel)',
    tplReminderHint: 'Wird am Vortag an jeden Coachee gesendet, dessen Spiel ein RC übernommen hat (RC in Kopie). Sind beide SR Coachees, erhält jeder eine eigene E-Mail.',
    tplSubject: 'Betreff', tplHeading: 'Titel (optional)', tplIntro: 'Text', tplOutro: 'Schluss / Grussformel',
    tplPlaceholders: 'Platzhalter (werden automatisch ersetzt):',
    tplReset: 'Standard wiederherstellen', tplSaved: 'Gespeichert ✓',
    reminderEnabled: 'Erinnerungen aktiv', reminderEnabledHint: 'Wenn aus, wird am Vortag nichts versendet. Der Testmodus unterdrückt den Versand zusätzlich.',
    reminderPreview: 'Vorschau: morgen', reminderPreviewHint: 'Zeigt exakt, was morgen versendet würde — es wird nichts gesendet.',
    reminderNone: 'Für morgen stehen keine Erinnerungen an.',
    importXlsx: 'xlsx importieren', importHint: (s: string) => `Import setzt die Saison ${s}. Bestehende (gleicher Name + Saison) werden aktualisiert.`,
    firstName: 'Vorname', lastName: 'Nachname', level: 'Niveau', stage: 'Niveau', group: 'Gruppe', email: 'E-Mail', phone: 'Telefon',
    add: 'Hinzufügen', count: (n: number, s: string) => `${n} Coachees · Saison ${s}`, loading: 'Lädt…',
    noCoachees: (s: string) => `Keine Coachees für ${s} — importiere eine xlsx.`,
    delCoachee: (n: string) => `Coachee „${n}" löschen?`, addRc: 'Referee Coach hinzufügen', rcCount: (n: number) => `${n} Referee Coaches`,
    noRcs: 'Keine Referee Coaches.', delRc: (n: string) => `RC „${n}" löschen?`, inactive: 'inaktiv',
    genPin: 'PIN erzeugen', hasPin: 'PIN gesetzt', noPin: 'kein PIN',
    colName: 'Name', colPin: 'PIN', colActions: 'Aktionen',
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
    syncFromGames: (u: number, f: number) => `Davon ${u} aus den Spielen (${f} SR auf Aufgeboten gefunden).`,
    syncGamesFailed: (e: string) => `Suche über die Spiele nicht möglich: ${e}`,
    syncFail: (e: string) => `Kontakt-Abgleich fehlgeschlagen: ${e}`,
    syncNotFoundList: 'Nicht in VolleyManager gefunden',
    syncMissingEmail: (n: number, total: number) => `${n} von ${total} Coachees haben keine E-Mail — für diese kann kein Feedback abgeschickt werden.`,
    mgExisting: 'Angelegte Testspiele', mgSearch: 'Spiel suchen …',
    mgNone: 'Keine Testspiele vorhanden.',
    mgConfirmDelete: (n: string) => `Spiel „${n}" wirklich löschen?`,
    genPinConfirm: (n: string) => `Neuen PIN für „${n}" erzeugen? Ein bestehender PIN wird ungültig und der neue PIN wird per E-Mail zugestellt.`,
    pinShownInfo: (p: string) => `PIN: ${p}`,
    pinEmailed: (e: string) => `Per E-Mail an ${e} gesendet.`,
    pinNotEmailed: 'Nicht per E-Mail gesendet (keine E-Mail/Testmodus) — bitte manuell übermitteln.',
    adminRole: 'Admin', toggleAdmin: 'Admin-Rechte umschalten',
    toggleAdminConfirm: (n: string, on: boolean) => on
      ? `„${n}" zum Admin machen? Admins haben vollen Zugriff — auch der PIN-Login gibt dann Admin-Rechte.`
      : `Admin-Rechte von „${n}" entfernen?`,
    defaultSeason: 'Standard-Saison', defaultSeasonHint: 'Die Saison, in der die App standardmässig startet (für neue Nutzer).',
    save: 'Speichern', saved: 'Gespeichert ✓', testTitle: 'Test-Modus (E-Mail)',
    testHint: 'Wenn aktiv, werden keine E-Mails versendet (Feedback wird trotzdem gespeichert). Zum Live-Betrieb ausschalten.',
    testOn: 'AN — es werden keine E-Mails versendet.', testOff: 'AUS — E-Mails werden versendet.',
    noRows: 'Keine Zeilen in der Datei gefunden.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} neu, ${u} aktualisiert (von ${t}).`,
    importFail: (e: string) => `Import fehlgeschlagen: ${e}`,
    groups: 'Gruppen', groupsHint: 'Gruppen für Coachees. Mehrfachauswahl wird mit „/" verbunden.', newGroup: 'Neue Gruppe', chooseGroups: 'Gruppe(n)', toApp: 'Zur App',
    target: 'Ziel-Spiele', targetHint: 'Welche Spiele für diesen SR relevant sind. Standard: automatisch aus dem Niveau (offizielle SVRZ-Tabelle).',
    targetAuto: 'Auto (Niveau)', targetAll: 'Alle Spiele', targetCustom: 'Eigen', targetRoles: 'Rolle(n)', targetLeagues: 'Ligen', chooseLeagues: 'Ligen wählen', edit: 'Bearbeiten', done: 'Fertig',
    colMandate: 'Mandat', mandateLabel: 'Mandat',
    mandateFull: (n: number) => `Ganz · ${n}`, mandateHalf: (n: number) => `Halb · ${n}`,
    mandateHint: (full: number, half: number) => `Ganzes Mandat = ${full} Beobachtungen pro Saison, halbes Mandat = ${half}.`,
    defaultGoal: 'Beobachtungsziel (ganzes Mandat)',
    defaultGoalHint: (half: number) => `Wie viele Beobachtungen ein ganzes Mandat pro Saison umfasst. Ein halbes Mandat ist die Hälfte davon (${half}) — wer ein halbes Mandat hat, wird im Tab „Referee Coaches" markiert.`,
  },
  EN: {
    admin: 'Admin', logout: 'Sign out', login: 'Sign in', adminPw: 'Admin password', wrongPw: 'Wrong password',
    noAdminRights: 'Your account has no admin rights. If you are an admin, sign in with the admin password.',
    coachees: 'Coachees', rcs: 'Referee Coaches', settings: 'Settings', testBadge: 'Test mode',
    emails: 'Emails', logs: 'Activity log', survey: 'RC feedback',
    surveyHint: 'Referees’ feedback on the RC visit — visible only here. Every question is optional, so blank answers are simply missing.',
    surveyEmpty: 'No responses yet.',
    surveyAnon: 'Anonymous',
    logsHint: 'Everything that happens: every request, every click in the app, every error. Newest last.',
    logsSearch: 'Search (email, path, text…)', logsLevel: 'Level', logsSource: 'Source', logsAll: 'All',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'No entries.',
    logsCopy: 'Copy', logsCopied: 'Copied ✓', logsSessions: 'Sessions', logsClear: 'Reset filters',
    logsErrorsOnly: 'Problems only',
    tplFeedback: 'Feedback email (after the match)',
    tplFeedbackHint: 'Sent to the coachee when a feedback is submitted (RC in CC, PDF attached).',
    tplReminder: 'Reminder (day before the match)',
    tplReminderHint: 'Sent the day before to every coachee whose game an RC has taken (RC in CC). If both referees are coachees, each gets their own email.',
    tplSubject: 'Subject', tplHeading: 'Title (optional)', tplIntro: 'Body', tplOutro: 'Closing / sign-off',
    tplPlaceholders: 'Placeholders (filled in automatically):',
    tplReset: 'Restore default', tplSaved: 'Saved ✓',
    reminderEnabled: 'Reminders active', reminderEnabledHint: 'When off, nothing is sent the day before. Test mode suppresses sending as well.',
    reminderPreview: 'Preview: tomorrow', reminderPreviewHint: 'Shows exactly what would be sent tomorrow — nothing is sent.',
    reminderNone: 'No reminders due for tomorrow.',
    importXlsx: 'Import xlsx', importHint: (s: string) => `Import targets season ${s}. Existing (same name + season) are updated.`,
    firstName: 'First name', lastName: 'Last name', level: 'Level', stage: 'Niveau', group: 'Group', email: 'Email', phone: 'Phone',
    add: 'Add', count: (n: number, s: string) => `${n} coachees · season ${s}`, loading: 'Loading…',
    noCoachees: (s: string) => `No coachees for ${s} — import an xlsx.`,
    delCoachee: (n: string) => `Delete coachee "${n}"?`, addRc: 'Add referee coach', rcCount: (n: number) => `${n} referee coaches`,
    noRcs: 'No referee coaches.', delRc: (n: string) => `Delete RC "${n}"?`, inactive: 'inactive',
    genPin: 'Generate PIN', hasPin: 'PIN set', noPin: 'no PIN',
    colName: 'Name', colPin: 'PIN', colActions: 'Actions',
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
    syncFromGames: (u: number, f: number) => `${u} of those came from the games (${f} referees found on convocations).`,
    syncGamesFailed: (e: string) => `Could not search the games: ${e}`,
    syncFail: (e: string) => `Contact sync failed: ${e}`,
    syncNotFoundList: 'Not found in VolleyManager',
    syncMissingEmail: (n: number, total: number) => `${n} of ${total} coachees have no email — feedback cannot be submitted for them.`,
    mgExisting: 'Test games created', mgSearch: 'Search game …',
    mgNone: 'No test games.',
    mgConfirmDelete: (n: string) => `Delete game "${n}"?`,
    genPinConfirm: (n: string) => `Generate a new PIN for "${n}"? Any existing PIN stops working and the new PIN is emailed to the RC.`,
    pinShownInfo: (p: string) => `PIN: ${p}`,
    pinEmailed: (e: string) => `Emailed to ${e}.`,
    pinNotEmailed: 'Not emailed (no address/test mode) — share it manually.',
    adminRole: 'Admin', toggleAdmin: 'Toggle admin rights',
    toggleAdminConfirm: (n: string, on: boolean) => on
      ? `Make "${n}" an admin? Admins get full access — their PIN login also grants admin.`
      : `Remove admin rights from "${n}"?`,
    defaultSeason: 'Default season', defaultSeasonHint: 'The season the app opens to by default (for new users).',
    save: 'Save', saved: 'Saved ✓', testTitle: 'Test mode (email)',
    testHint: 'When on, no emails are sent (feedback is still saved). Turn off for live operation.',
    testOn: 'ON — no emails are sent.', testOff: 'OFF — emails are sent.',
    noRows: 'No rows found in the file.',
    importResult: (s: string, c: number, u: number, t: number) => `Import ${s}: ${c} new, ${u} updated (of ${t}).`,
    importFail: (e: string) => `Import failed: ${e}`,
    groups: 'Groups', groupsHint: 'Groups for coachees. Multiple selections are joined with "/".', newGroup: 'New group', chooseGroups: 'Group(s)', toApp: 'To app',
    target: 'Target games', targetHint: 'Which games are relevant for this referee. Default: automatic from the Niveau (official SVRZ table).',
    targetAuto: 'Auto (level)', targetAll: 'All games', targetCustom: 'Custom', targetRoles: 'Role(s)', targetLeagues: 'Leagues', chooseLeagues: 'Choose leagues', edit: 'Edit', done: 'Done',
    colMandate: 'Mandate', mandateLabel: 'Mandate',
    mandateFull: (n: number) => `Full · ${n}`, mandateHalf: (n: number) => `Half · ${n}`,
    mandateHint: (full: number, half: number) => `A full mandate is ${full} observations per season, a half mandate ${half}.`,
    defaultGoal: 'Observation goal (full mandate)',
    defaultGoalHint: (half: number) => `How many observations a full mandate covers per season. A half mandate is half of that (${half}) — mark who is on one in the "Referee Coaches" tab.`,
  },
} as const;
type T = typeof STR['DE'];

const input = 'h-9 w-full px-3 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors';

async function parseXlsx(file: File): Promise<ImportRow[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (!rows.length) return [];
  const header = (rows[0] as unknown[]).map((h) => String(h).trim().toLowerCase());
  const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const ci = { last: col(['nachname', 'name', 'last', 'lastname']), first: col(['vorname', 'first', 'firstname']), email: col(['email', 'e-mail', 'mail', 'e-mail-adresse', 'emailadresse', 'e mail']), level: col(['niveau', 'level']), stage: col(['stufe', 'stage']), group: col(['gruppe', 'group', 'groups']), notes: col(['bemerkung', 'bemerkungen', 'notizen', 'notes', 'note', 'kommentar']) };
  // Notes often live in an unnamed column right after Gruppe.
  if (ci.notes < 0 && ci.group >= 0 && !header[ci.group + 1]) ci.notes = ci.group + 1;
  const out: ImportRow[] = [];
  for (const raw of rows.slice(1)) {
    const r = raw as unknown[];
    const last = String(r[ci.last] ?? '').trim();
    const first = String(r[ci.first] ?? '').trim();
    if (!first && !last) continue;
    out.push({ first_name: first, last_name: last, full_name: `${first} ${last}`.trim(), email: String(r[ci.email] ?? '').trim(), referee_level: String(r[ci.level] ?? '').trim(), stage: String(r[ci.stage] ?? '').trim().replace(/\.0$/, ''), groups: mapGroups(String(r[ci.group] ?? '').trim()), notes: String(r[ci.notes] ?? '').trim() });
  }
  return out;
}

// Console tabs live in the URL as #/admin/<tab>, so each one is linkable and
// the Back button steps between them.
const ADMIN_TABS = ['coachees', 'rcs', 'emails', 'survey', 'logs', 'settings'] as const;
type AdminTab = (typeof ADMIN_TABS)[number];
const adminTabFromHash = (): AdminTab => {
  const m = /^#\/?admin\/([a-z]+)/i.exec(window.location.hash);
  const found = ADMIN_TABS.find((x) => x === m?.[1]?.toLowerCase());
  return found ?? 'coachees';
};

export default function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<AdminTab>(adminTabFromHash);
  // null while unknown: a deep link to #/admin/survey must not bounce the one
  // person allowed to be there just because the check hasn't come back yet.
  const [surveyReader, setSurveyReader] = useState<boolean | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);
  const [coacheeTargets, setCoacheeTargets] = useState<CoacheeTargetMap>({});
  // Season observation goal: the number a full mandate owes, plus the RCs (by
  // id) who are on a half mandate and owe half of it.
  const [rcMandates, setRcMandates] = useState<RcMandateMap>({});
  const [defaultGoal, setDefaultGoal] = useState<number>(OBSERVATION_GOAL);
  const [leagueOptions, setLeagueOptions] = useState<string[]>([]);
  const [defaultSeason, setDefaultSeason] = useState<number>(CUR_SEASON);
  const [lang, setLang] = useState<Lang>(() => {
    try { return (localStorage.getItem('svrz_admin_lang') as Lang) || 'DE'; } catch { return 'DE'; }
  });
  const t = STR[lang];
  const toggleLang = () => setLang((l) => { const n = l === 'DE' ? 'EN' : 'DE'; try { localStorage.setItem('svrz_admin_lang', n); } catch { /* ignore */ } return n; });

  useEffect(() => { getAdminAuthStatus().then((s) => setAuthed(Boolean(s.authenticated))).catch(() => {}).finally(() => setChecking(false)); }, []);
  // The RC-feedback tab is not an admin-role tab: only the reader named in the
  // server env sees it, so being an admin here tells us nothing.
  useEffect(() => { getAuthMe().then((m) => setSurveyReader(Boolean(m.surveyReader))).catch(() => setSurveyReader(false)); }, []);
  useEffect(() => { if (surveyReader === false && tab === 'survey') setTab('coachees'); }, [surveyReader, tab]);
  // Console-wide data, fetched once and in parallel as soon as the session is
  // known; each tab loads its own rows at the same time (all tabs are mounted).
  useEffect(() => {
    if (!authed) return;
    getSettings()
      .then((s) => {
        setTestMode(Boolean(s.test_mode)); setGroups(s.groups || []); setCoacheeTargets(s.coachee_targets || {});
        setRcMandates(s.rc_mandates || {}); if (s.default_goal) setDefaultGoal(s.default_goal);
        if (s.default_season) setDefaultSeason(s.default_season);
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    loadEligibleGames()
      .then((games) => { setLeagueOptions(Array.from(new Set(games.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort()); })
      .catch(() => {});
  }, [authed]);
  const saveTargets = useCallback(async (next: CoacheeTargetMap) => { setCoacheeTargets(next); try { await putSettings({ coachee_targets: next }); } catch { /* ignore */ } }, []);
  const saveMandates = useCallback(async (next: RcMandateMap) => { setRcMandates(next); try { await putSettings({ rc_mandates: next }); } catch { /* ignore */ } }, []);
  const saveDefaultGoal = useCallback(async (next: number) => { setDefaultGoal(next); await putSettings({ default_goal: next }); }, []);

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
    try { await adminUiLogin(password.trim()); setAuthed(true); setPassword(''); }
    catch { setError(t.wrongPw); setPassword(''); }
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
            {/* Reaching this means you ARE signed in but your account has no
                admin rights — the password below is the bootstrap fallback. */}
            <p className="text-xs text-stone-500 text-center mb-4">{t.noAdminRights}</p>
            <form onSubmit={login} className="space-y-4">
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input id="admin-pw" type={showPw ? 'text' : 'password'} value={password} autoFocus disabled={submitting}
                  onChange={(e) => setPassword(e.target.value)} placeholder={t.adminPw}
                  className={`w-full pl-10 pr-10 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`} />
                <button type="button" onClick={() => setShowPw((v) => !v)} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">{showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button type="submit" disabled={!password.trim() || submitting} className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20">{submitting && <Loader2 className="h-4 w-4 animate-spin" />}{t.login}</button>
            </form>
          </div>
          <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">Swiss Volley Region Zürich</p>
        </div>
      </div>
    );
  }

  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = [
    { id: 'coachees', label: t.coachees, icon: <Users size={15} /> },
    { id: 'rcs', label: t.rcs, icon: <ShieldCheck size={15} /> },
    { id: 'emails', label: t.emails, icon: <Mail size={15} /> },
    ...(surveyReader ? [{ id: 'survey' as const, label: t.survey, icon: <MessageSquare size={15} /> }] : []),
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
          <button onClick={() => { window.location.href = window.location.pathname + window.location.search; }} className="ml-auto inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Home size={14} /><span className="hidden sm:inline">{t.toApp}</span></button>
          <button onClick={toggleLang} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Languages size={14} />{lang}</button>
          <button onClick={logout} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"><LogOut size={15} /> <span className="hidden sm:inline">{t.logout}</span></button>
        </div>
        <div className={cn('max-w-4xl mx-auto px-4 pb-3 grid gap-2', surveyReader ? 'grid-cols-6' : 'grid-cols-5')}>
          {tabs.map((tb) => (
            <button key={tb.id} onClick={() => setTab(tb.id)} className={`h-11 inline-flex items-center justify-center gap-1.5 text-sm font-medium rounded-xl transition-colors ${tab === tb.id ? 'bg-slate-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>{tb.icon}<span className="hidden sm:inline">{tb.label}</span></button>
          ))}
        </div>
      </header>
      {/* Tabs stay mounted: their data is fetched in one parallel batch on the
          first render after login, so switching tabs shows the finished page
          instead of starting that tab's request right then. Logs are the
          exception — they only poll while their tab is on screen. */}
      <main className="max-w-4xl mx-auto px-4 pt-5">
        <div hidden={tab !== 'coachees'}><CoacheesAdmin t={t} lang={lang} groups={groups} defaultSeason={defaultSeason} targets={coacheeTargets} onTargets={saveTargets} leagueOptions={leagueOptions} /></div>
        <div hidden={tab !== 'rcs'}><RcsAdmin t={t} mandates={rcMandates} defaultGoal={defaultGoal} onMandates={saveMandates} /></div>
        <div hidden={tab !== 'emails'}><EmailsAdmin t={t} /></div>
        {surveyReader && <div hidden={tab !== 'survey'}><SurveyAdmin t={t} lang={lang} /></div>}
        <div hidden={tab !== 'logs'}><LogsAdmin t={t} active={tab === 'logs'} /></div>
        <div hidden={tab !== 'settings'}>
          <SettingsAdmin t={t} testMode={testMode} onTestMode={setTestMode} defaultSeason={defaultSeason} settingsLoading={settingsLoading} groups={groups} onGroups={setGroups} defaultGoal={defaultGoal} onDefaultGoal={saveDefaultGoal} />
          <ManualGameAdmin t={t} lang={lang} />
        </div>
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

function CoacheesAdmin({ t, lang, groups, defaultSeason, targets, onTargets, leagueOptions }: { t: T; lang: Lang; groups: string[]; defaultSeason: number; targets: CoacheeTargetMap; onTargets: (next: CoacheeTargetMap) => void; leagueOptions: string[] }) {
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
  const [overwriteContacts, setOverwriteContacts] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', referee_level: '', stage: '', groups: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ first_name: '', last_name: '', email: '', referee_level: '', stage: '', groups: '' });

  const reload = useCallback(async () => { setLoading(true); try { setAll(await listCoachees()); } catch (e) { setNotice(String(e)); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const rows = all.filter((c) => (typeof c.season === 'number' ? c.season === season : false)).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));

  const add = async () => { const full_name = `${form.first_name} ${form.last_name}`.trim(); if (!full_name) return; await createCoachee({ ...form, full_name, season } as Partial<Coachee>); setForm({ first_name: '', last_name: '', email: '', referee_level: '', stage: '', groups: '' }); await reload(); };
  const saveEdit = async (id: string) => { const full_name = `${editForm.first_name} ${editForm.last_name}`.trim(); await updateCoachee(id, { ...editForm, full_name } as Partial<Coachee>); setEditId(null); await reload(); };
  const remove = async (c: Coachee) => { if (!confirm(t.delCoachee(c.full_name))) return; await deleteCoachee(c.id); await reload(); };
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
        r.updatedFromGames > 0 ? t.syncFromGames(r.updatedFromGames, r.gameRefereesFound) : '',
        r.gamesError ? t.syncGamesFailed(r.gamesError) : '',
      ].filter(Boolean).join(' '));
      setSyncMissing(r.missing);
      await reload();
    } catch (err) { setNotice(t.syncFail(String(err))); } finally { setSyncing(false); }
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
          {syncMissing.length > 0 && (
            <p className="mt-2 text-xs text-stone-500">{t.syncNotFoundList}: {syncMissing.join(', ')}</p>
          )}
        </div>
      </Card>
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
          <input className={input} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          <input type="email" className={input} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select
            className={cn(input, !joinStufe(form.referee_level, form.stage) && 'text-stone-400')}
            value={joinStufe(form.referee_level, form.stage)}
            onChange={(e) => setForm({ ...form, ...splitStufe(e.target.value) })}
          >
            <option value="">{t.stage}</option>
            {STUFEN.map((v) => <option key={v} value={v} className="text-stone-900">{v}</option>)}
          </select>
          <GroupMultiSelect groups={groups} value={form.groups} onChange={(v) => setForm({ ...form, groups: v })} placeholder={t.chooseGroups} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        <p className="text-xs text-stone-400 mb-2">{loading ? t.loading : t.count(rows.length, seasonLabel(season))}</p>
        <div className="divide-y divide-stone-100">
          {rows.map((c) => editId === c.id ? (
            <div key={c.id} className="py-2 grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
              <input className={input} value={editForm.first_name} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
              <input className={input} value={editForm.last_name} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              <input type="email" className={input} placeholder={t.email} value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
              <select
                className={cn(input, !joinStufe(editForm.referee_level, editForm.stage) && 'text-stone-400')}
                value={joinStufe(editForm.referee_level, editForm.stage)}
                onChange={(e) => setEditForm({ ...editForm, ...splitStufe(e.target.value) })}
              >
                <option value="">{t.stage}</option>
                {STUFEN.map((v) => <option key={v} value={v} className="text-stone-900">{v}</option>)}
              </select>
              <GroupMultiSelect groups={groups} value={editForm.groups} onChange={(v) => setEditForm({ ...editForm, groups: v })} placeholder={t.chooseGroups} />
              <div className="flex gap-1.5"><button onClick={() => saveEdit(c.id)} className={btnPrimary}><Check size={15} /></button><button onClick={() => setEditId(null)} className={btnGhost}><X size={14} /></button></div>
            </div>
          ) : (
            <div key={c.id} className="py-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-stone-800 truncate">{c.full_name}</p>
                  <p className="text-xs text-stone-400 truncate"><LevelText level={c.referee_level} stage={c.stage} />{c.groups ? ` · ${c.groups}` : ''}</p>
                  {/* Without an address the feedback submit fails at the very
                      end, after the whole form is filled in — flag it early. */}
                  <p className={cn('text-xs truncate', c.email ? 'text-stone-400' : 'text-amber-600 font-medium')}>{c.email || t.noEmail}</p>
                </div>
                <button onClick={() => setTargetEditId(targetEditId === c.id ? null : c.id)} className={cn(btnGhost, targetEditId === c.id && 'bg-stone-100')} title={t.target}><Target size={13} /></button>
                <button onClick={() => { setEditId(c.id); setEditForm({ first_name: c.first_name || '', last_name: c.last_name || '', email: c.email || '', referee_level: c.referee_level || '', stage: c.stage || '', groups: c.groups || '' }); }} className={btnGhost}><Pencil size={13} /></button>
                <button onClick={() => remove(c)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
              </div>
              <div className="flex items-center gap-1.5 mt-1 pl-0.5">
                <span className="text-[11px] text-stone-400">{t.target}:</span>
                <span className={cn('text-[11px] font-medium', isTargetActive(targets[c.id], levelKey(c.referee_level, c.stage)) ? 'text-emerald-700' : 'text-stone-400')}>{(() => {
                  const key = levelKey(c.referee_level, c.stage);
                  const tgt = targets[c.id];
                  // Auto mode with no derivable rules because the Niveau/Stufe is still TBD
                  if ((!tgt || tgt.mode === 'auto') && !hasNiveauRules(key) && levelDisplay(c.referee_level, c.stage).tbd) {
                    return <>Auto (<span className="text-red-600 font-semibold">TBD</span>)</>;
                  }
                  return summarizeTarget(tgt, key, lang);
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

function RcsAdmin({ t, mandates, defaultGoal, onMandates }: { t: T; mandates: RcMandateMap; defaultGoal: number; onMandates: (next: RcMandateMap) => void }) {
  const [rcs, setRcs] = useState<RcPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RcPerson>({ id: '' });
  const reload = useCallback(async () => { setLoading(true); try { setRcs(await listRcPeopleFull()); } finally { setLoading(false); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const [pinShown, setPinShown] = useState<{ id: string; pin: string; emailed: boolean; email: string } | null>(null);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  const add = async () => { if (!form.first_name && !form.last_name) return; await createRcPerson({ ...form, active: true }); setForm({ first_name: '', last_name: '', email: '', phone: '' }); await reload(); };
  const saveEdit = async (id: string) => { await updateRcPerson(id, editForm); setEditId(null); await reload(); };
  const remove = async (r: RcPerson) => { if (!confirm(t.delRc(`${r.first_name} ${r.last_name}`))) return; await deleteRcPerson(r.id); await reload(); };
  const toggleAdmin = async (r: RcPerson) => {
    const makingAdmin = !r.is_admin;
    if (!confirm(t.toggleAdminConfirm(`${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), makingAdmin))) return;
    await updateRcPerson(r.id, { is_admin: makingAdmin });
    await reload();
  };
  const genPin = async (r: RcPerson) => {
    if (r.has_pin && !confirm(t.genPinConfirm(`${r.first_name} ${r.last_name}`))) return;
    setPinBusy(r.id);
    try {
      const res = await generateRcPin(r.id);
      setPinShown({ id: r.id, pin: res.pin, emailed: res.emailed, email: res.email });
      await reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setPinBusy(null);
    }
  };
  // Full or half mandate per RC — the season goal follows from it. Only the
  // half mandates are stored, so switching back to full drops the entry.
  const halfGoal = goalForMandate(defaultGoal, 'half');
  const setMandate = (id: string, mandate: RcMandate) => {
    if ((mandates[id] ?? 'full') === mandate) return;
    const next = { ...mandates };
    if (mandate === 'half') next[id] = 'half';
    else delete next[id];
    onMandates(next);
  };
  const mandateToggle = (r: RcPerson) => {
    const half = mandates[r.id] === 'half';
    const btn = (on: boolean) => cn(
      'h-8 px-2.5 text-xs font-medium whitespace-nowrap transition-colors',
      on ? 'bg-slate-900 text-white' : 'bg-white text-stone-600 hover:bg-stone-100',
    );
    return (
      <div className="inline-flex rounded-lg border border-stone-200 overflow-hidden" role="group" aria-label={t.mandateLabel} title={t.mandateHint(defaultGoal, halfGoal)}>
        <button onClick={() => setMandate(r.id, 'full')} aria-pressed={!half} className={btn(!half)}>{t.mandateFull(defaultGoal)}</button>
        <button onClick={() => setMandate(r.id, 'half')} aria-pressed={half} className={cn(btn(half), 'border-l border-stone-200')}>{t.mandateHalf(halfGoal)}</button>
      </div>
    );
  };
  // Shared by the desktop table and the mobile cards so the two can't drift.
  const rowActions = (r: RcPerson) => (
    <>
      <button onClick={() => toggleAdmin(r)} className={cn(btnGhost, r.is_admin && 'text-red-600')} title={t.toggleAdmin}>
        <ShieldCheck size={13} />
      </button>
      <button onClick={() => genPin(r)} disabled={pinBusy === r.id} className={btnGhost} title={t.genPin}>
        {pinBusy === r.id ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
      </button>
      <button onClick={() => { setEditId(r.id); setEditForm(r); }} className={btnGhost} title={t.edit}><Pencil size={13} /></button>
      <button onClick={() => remove(r)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
    </>
  );
  const pinBanner = (r: RcPerson) => pinShown?.id === r.id ? (
    <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
      <p className="text-xs text-amber-800 flex-1">
        <span className="font-mono font-semibold tracking-widest">{t.pinShownInfo(pinShown.pin)}</span>
        {' — '}
        {pinShown.emailed ? t.pinEmailed(pinShown.email) : t.pinNotEmailed}
      </p>
      <button onClick={() => setPinShown(null)} className="text-amber-700 hover:text-amber-900"><X size={13} /></button>
    </div>
  ) : null;
  const adminBadge = (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 align-middle">
      <ShieldCheck size={10} />{t.adminRole}
    </span>
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
                  {r.is_admin && <div className="mt-1">{adminBadge}</div>}
                </div>
                <span className={cn('shrink-0 text-xs font-medium whitespace-nowrap', r.has_pin ? 'text-green-600' : 'text-amber-600')}>
                  {r.has_pin ? t.hasPin : t.noPin}
                </span>
              </div>
              {r.email && <p className="mt-1.5 text-xs text-stone-500 break-all">{r.email}</p>}
              {r.phone && <p className="text-xs text-stone-500">{r.phone}</p>}
              <div className="mt-2.5 flex items-center gap-2">
                <span className="text-xs text-stone-500">{t.mandateLabel}</span>
                {mandateToggle(r)}
              </div>
              <div className="mt-2.5 flex items-center justify-end gap-1.5">{rowActions(r)}</div>
              {pinShown?.id === r.id && <div className="mt-2">{pinBanner(r)}</div>}
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
                <th className="text-left font-bold py-2 pr-3">{t.colPin}</th>
                <th className="text-left font-bold py-2 pr-3" title={t.mandateHint(defaultGoal, halfGoal)}>{t.colMandate}</th>
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
                  <td className="py-2 pr-3 text-stone-400 text-xs">{r.has_pin ? t.hasPin : t.noPin}</td>
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
                      {r.is_admin && <span className="ml-2">{adminBadge}</span>}
                    </td>
                    <td className="py-2.5 pr-3 text-stone-500">{r.email}</td>
                    <td className="py-2.5 pr-3 text-stone-500 whitespace-nowrap">{r.phone}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <span className={cn('text-xs font-medium', r.has_pin ? 'text-green-600' : 'text-amber-600')}>
                        {r.has_pin ? t.hasPin : t.noPin}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">{mandateToggle(r)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => toggleAdmin(r)} className={cn(btnGhost, r.is_admin && 'text-red-600')} title={t.toggleAdmin}>
                          <ShieldCheck size={13} />
                        </button>
                        <button onClick={() => genPin(r)} disabled={pinBusy === r.id} className={btnGhost} title={t.genPin}>
                          {pinBusy === r.id ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />}
                        </button>
                        <button onClick={() => { setEditId(r.id); setEditForm(r); }} className={btnGhost} title={t.edit}><Pencil size={13} /></button>
                        <button onClick={() => remove(r)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                  {pinShown?.id === r.id && (
                    <tr>
                      <td colSpan={6} className="pb-2">
                        <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                          <p className="text-xs text-amber-800 flex-1">
                            <span className="font-mono font-semibold tracking-widest">{t.pinShownInfo(pinShown.pin)}</span>
                            {' — '}
                            {pinShown.emailed ? t.pinEmailed(pinShown.email) : t.pinNotEmailed}
                          </p>
                          <button onClick={() => setPinShown(null)} className="text-amber-700 hover:text-amber-900"><X size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {loading && rcs.length === 0 && <SkeletonRows rows={6} />}
        {!loading && rcs.length === 0 && <p className="py-8 text-center text-sm text-stone-400">{t.noRcs}</p>}
      </Card>
    </>
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

  const patch = (kind: 'feedback' | 'reminder', p: Partial<EmailTemplate>) =>
    setData((d) => (d ? { ...d, [kind]: { ...d[kind], ...p } } : d));

  const save = async () => {
    if (!data) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      await putEmailTemplates({ feedback: data.feedback, reminder: data.reminder, reminder_enabled: data.reminder_enabled });
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

  const editor = (kind: 'feedback' | 'reminder', title: string, hint: string) => {
    const tpl = data[kind];
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
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1">{t.tplSubject}</label>
            <input className={input + ' w-full'} value={tpl.subject} onChange={(e) => patch(kind, { subject: e.target.value })} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1">{t.tplHeading}</label>
            <input className={input + ' w-full'} value={tpl.heading} onChange={(e) => patch(kind, { heading: e.target.value })} />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1">{t.tplIntro}</label>
            <textarea
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-red-400"
              rows={kind === 'reminder' ? 14 : 6}
              value={tpl.intro}
              onChange={(e) => patch(kind, { intro: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1">{t.tplOutro}</label>
            <textarea
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-red-400"
              rows={3}
              value={tpl.outro}
              onChange={(e) => patch(kind, { outro: e.target.value })}
            />
          </div>
        </div>
        <p className="mt-3 text-[11px] text-stone-400">
          {t.tplPlaceholders}{' '}
          {data.placeholders.map((p) => (
            <code key={p} className="inline-block mx-0.5 rounded bg-stone-100 border border-stone-200 px-1 py-0.5 text-[10px] text-stone-600">{`{{${p}}}`}</code>
          ))}
        </p>
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

  useEffect(() => {
    listSurveyResponses().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Answers are stored as stable values, so a response written in English still
  // reads in the admin's chosen language — only free text stays as typed.
  const label = (q: SurveyQuestion, value: string): string => {
    if (q.kind !== 'choice') return value;
    return q.options.find((o) => o.value === value)?.[lang] ?? value;
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
          <dl className="flex flex-col gap-3">
            {SURVEY_QUESTIONS.filter((q) => r.answers[q.id]).map((q) => (
              <div key={q.id}>
                <dt className="text-xs text-stone-400 leading-snug">{questionLabel(q, lang)}</dt>
                <dd className="text-sm text-stone-800 whitespace-pre-wrap mt-0.5">{label(q, r.answers[q.id])}</dd>
              </div>
            ))}
          </dl>
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
              <div className="flex items-start gap-2 font-mono text-[11px] leading-relaxed">
                <span className="text-stone-400 shrink-0 tabular-nums">{new Date(e.t).toLocaleTimeString('de-CH', { hour12: false })}</span>
                <span className={cn('shrink-0 px-1.5 rounded border text-[10px] font-semibold uppercase', LEVEL_STYLE[e.lvl] || LEVEL_STYLE.info)}>{e.lvl}</span>
                <span className={cn('shrink-0 text-[10px] uppercase font-semibold', e.src === 'client' ? 'text-indigo-500' : 'text-stone-400')}>{e.src === 'client' ? 'app' : 'srv'}</span>
                <span className="shrink-0 text-stone-500">{e.evt}</span>
                <span className="text-stone-800 break-all">{e.msg}</span>
                {e.user && <span className="ml-auto shrink-0 text-stone-400">{e.user}</span>}
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
    if (!confirm(t.mgConfirmDelete(label))) return;
    setBusy(true); setErr('');
    try { await deleteGame(id); if (made?.id === id) setMade(null); await reload(q); }
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

function SettingsAdmin({ t, testMode, onTestMode, defaultSeason, settingsLoading, groups, onGroups, defaultGoal, onDefaultGoal }: { t: T; testMode: boolean; onTestMode: (v: boolean) => void; defaultSeason: number; settingsLoading: boolean; groups: string[]; onGroups: (g: string[]) => void; defaultGoal: number; onDefaultGoal: (n: number) => Promise<void> }) {
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
  const [gv, setGv] = useState('');
  const saveGroups = async (next: string[]) => { onGroups(next); try { await putSettings({ groups: next }); } catch { /* ignore */ } };
  const addGroup = () => { const v = ng.trim(); if (!v || groups.includes(v)) return; setNg(''); void saveGroups([...groups, v].sort()); };
  const delGroup = (i: number) => void saveGroups(groups.filter((_, idx) => idx !== i));
  const saveEditGroup = (i: number) => { const v = gv.trim(); if (v) { const next = groups.slice(); next[i] = v; void saveGroups(Array.from(new Set(next)).sort()); } setGi(null); };
  const save = async () => { await putSettings({ default_season: season }); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  const toggleTest = async () => { const next = !testMode; onTestMode(next); try { await putSettings({ test_mode: next }); } catch { onTestMode(!next); } };
  return (
    <>
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
        <p className="text-xs text-stone-400 mb-3">{t.defaultGoalHint(goalForMandate(defaultGoal, 'half'))}</p>
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
              <button onClick={() => saveEditGroup(i)} className={btnPrimary}><Check size={15} /></button>
              <button onClick={() => setGi(null)} className={btnGhost}><X size={14} /></button>
            </div>
          ) : (
            <div key={g} className="py-2 flex items-center gap-3">
              <span className="flex-1 text-sm text-stone-800">{g}</span>
              <button onClick={() => { setGi(i); setGv(g); }} className={btnGhost}><Pencil size={13} /></button>
              <button onClick={() => delGroup(i)} className="inline-flex items-center h-8 px-2.5 rounded-lg border border-red-100 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"><Trash2 size={13} /></button>
            </div>
          ))}
          {groups.length === 0 && <p className="py-4 text-center text-xs text-stone-400">—</p>}
        </div>
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
