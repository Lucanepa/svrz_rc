import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Gauge, Lock, User, Eye, EyeOff, Loader2, LogOut, Upload, Plus, Trash2, Pencil, Check, X, Users, ShieldCheck, Settings as SettingsIcon, FlaskConical, Languages, ChevronDown, ChevronUp, Home, Target, Mail, RotateCcw, Send, ScrollText, Pause, Play, Copy, MessageSquare, UserX, ClipboardList, Star, Download, BellOff, CheckCheck, Layers, AlertTriangle, Coins, BarChart3, FolderOpen, ExternalLink, Search } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { cn } from '../lib/utils';
import { adminTabFromPath, adminLogModeFromPath } from '../lib/routes';
import {
  getAdminAuthStatus, adminUiLogin, logoutAdmin, getAuthMe, getGamesSyncStatus,
  listCoachees, createCoachee, updateCoachee, deleteCoachee, importCoachees,
  listRcPeopleFull, createRcPerson, updateRcPerson, deleteRcPerson,
  getCredentials, setCredential, requestCredentialCode, type CredentialSlotInfo,
  getAdminShortcutRcs, setAdminShortcutRcs,
  loadRcOverview, loadrcCoachSummary, listRefereeCoachPeople, assignRcToGame, setGameStarred, setRcPaid, setRcMeeting,
  downloadRcExpenses, downloadAllRcExpenses, DEFAULT_EXPENSE_RATES, type ExpenseRates,
  getSettings, putSettings, loadEligibleGames,
  getEmailTemplates, putEmailTemplates, placeholdersFor, acceptedPlaceholdersFor, getReminderPreview, createGame, deleteGame, listManualGames,
  listReferees, importReferees, type RefereeRoster, type RosterReferee, type RefereeImportRow,
  getSurveyConfig, putSurveyConfig,
  getAdminLogs, getAdminLogSessions, listSurveyResponses, syncCoacheeContacts, listPresidentNotes,
  getErrorLogs, getErrorLogDates, annotateLogEntries,
  getLogMuteRules, createLogMuteRule, setLogMuteRuleEnabled, deleteLogMuteRule,
  loadRcGameNotes, downloadFeedbackArchive,
  loadFormsIndex, downloadRefereeForms, feedbackFileUrl, type FormsFolder,
  syncGames, type GamesSyncStatus,
  getBoerseStatus, runBoerseSync, type BoerseSyncStatus,
  type PresidentNote,
  type RcGameNote,
  type Coachee, type RefereeCoachPerson, type RcPerson, type ImportRow, type EmailTemplate, type EmailTemplateKind, type EmailTemplates, type ReminderPreview, type ManualGame,
  type LogEntry, type LogSession, type SurveyResponse,
  type StoredLogEntry, type LogGroup, type LogMuteRule, type LogDay,
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
import { subscribeLive } from '../lib/liveEvents';
import { groupLabel } from '../lib/coacheeGroup';
import { bySurname, surnameFirstLabel, foldName, coacheeIndex } from '../lib/coacheeName';
import { confirmDialog, toast } from './ui';
import { OBSERVATION_GOAL, PAID_CAP, goalForMandate, type RcMandate, type RcMandateMap , type RcOverviewEntry, type EligibleGame, type rcCoachSummary, type rcCoachSummaryGame } from '../types';
import LevelText from './LevelText';
import StatisticsAdmin from './StatisticsAdmin';
import { CoacheeChip, GroupChip } from './CoacheeChips';
import { GameList, GameRow, MetaChip, SectionHead, type RowTone } from './GameRow';
import { Skeleton, SkeletonRows } from './Skeleton';
import { dayLabel, dayTimeLabel, clockLabel, dayKey, todayKey, instantOf } from '../lib/appTime';
import { inSeasonOrManual, currentSeason, seasonLabel } from '../lib/season';
import { APP_VERSION, BUILD_INFO } from '../lib/buildInfo';

type Lang = 'DE' | 'EN';
const CUR_SEASON = currentSeason();
const SEASONS = [CUR_SEASON, CUR_SEASON + 1, CUR_SEASON + 2];

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
    srNotes: 'Rückmeldungen aus SR-Spielen (4.4.10)',
    srNotesHint: 'Hat ein Referee Coach neben einem Coachee gepfiffen, wird kein Feedbackformular ausgefüllt — stattdessen diese kurze Rückmeldung. Sie geht nur ans RC-Präsidium und zählt nicht ans Saisonziel.',
    srNotesEmpty: 'Noch keine Rückmeldungen.',
    forms: 'Formulare',
    formsHint: 'Jedes abgeschickte Feedbackformular, pro Schiedsrichter:in abgelegt — über alle Saisons und alle Referee Coaches. «Öffnen» zeigt das PDF so, wie es verschickt wurde; «Ordner als ZIP» lädt alle Formulare einer Person auf einmal.',
    formsSearch: 'Schiedsrichter:in suchen (Name oder SV-Nr.) …',
    formsEmpty: 'Noch keine Formulare abgeschickt.',
    formsNoMatch: 'Niemand passt zur Suche.',
    formsCount: (n: number) => `${n} Formular${n === 1 ? '' : 'e'}`,
    formsPeople: (n: number) => `${n} Schiedsrichter:in${n === 1 ? '' : 'nen'}`,
    formsOpen: 'Öffnen',
    formsNoFile: 'keine Datei',
    formsScan: 'Scan',
    formsFolderZip: 'Ordner als ZIP',
    formsFolderDone: (n: number) => `${n} Formular${n === 1 ? '' : 'e'} heruntergeladen.`,
    formsDate: 'Datum', formsRole: 'Rolle', formsGame: 'Spiel', formsRc: 'RC',
    formsUnnamed: 'Ohne Namen',
    archive: 'Saison-Archiv',
    archiveHint: 'Alle abgeschickten Feedbackformulare einer Saison als ZIP — für die Ablage, die zwei Jahre aufbewahrt wird (Infoschreiben 4.4). Eine PDF-Datei pro Formular, benannt nach Datum, Schiedsrichter:in und Rolle.',
    archiveDownload: 'Saison herunterladen',
    archiveBusy: 'Wird zusammengestellt…',
    archiveDone: (n: number) => `${n} Formular${n === 1 ? '' : 'e'} heruntergeladen.`,
    archiveEmpty: 'Für diese Saison sind keine Formulare erfasst.',
    srNotesSwapped: '1. und 2. SR wurden getauscht (Ziff. 7.3) — die Rollen oben sind die tatsächlich gepfiffenen. Im VolleyManager ist es noch andersherum erfasst.',
    logsHint: 'Alles, was passiert: jede Anfrage, jeder Klick in der App, jeder Fehler. Neueste zuletzt.',
    logsSearch: 'Suchen (E-Mail, Pfad, Text…)', logsLevel: 'Stufe', logsSource: 'Quelle', logsAll: 'Alle',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'Keine Einträge.',
    logsCopy: 'Kopieren', logsCopied: 'Kopiert ✓', logsSessions: 'Sitzungen', logsClear: 'Filter zurücksetzen',
    logsErrorsOnly: 'Nur Probleme',
    // Verlauf/Fehler-Ansicht (liest die Tagesdateien, nicht den Live-Puffer)
    logsTabLive: 'Live', logsTabHistory: 'Verlauf & Fehler',
    logsHistoryHint: 'Die gespeicherten Tagesprotokolle — 30 Tage rückwirkend, auch nach einem Neustart. Standard: nur Probleme.',
    logsDate: 'Tag', logsToday: 'heute', logsGrouped: 'Gruppiert', logsSingle: 'Einzeln',
    logsShowSolved: 'Erledigte zeigen', logsShowMuted: 'Stummgeschaltete zeigen',
    logsSolve: 'Erledigt', logsSolveGroup: 'Alle erledigt', logsImportant: 'Wichtig', logsReopen: 'Wieder offen',
    logsMute: 'Art stummschalten', logsMuted: 'stumm',
    logsMuteTitle: (evt: string) => `„${evt}" dauerhaft stummschalten?`,
    logsMuteBody: 'Solche Einträge verschwinden aus dieser Ansicht und lösen keine Fehler-E-Mail mehr aus. Gelöscht wird nichts — mit „Stummgeschaltete zeigen" sind sie wieder da.',
    logsMuteConfirm: 'Stummschalten',
    logsRules: 'Stummschaltungen', logsRulesNone: 'Keine Stummschaltungen.',
    logsRuleOn: 'Aktiv', logsRuleOff: 'Pausiert',
    logsSummary: (shown: number, scanned: number) => `${shown} von ${scanned} Einträgen`,
    logsHiddenNote: (solved: number, muted: number) => `${solved} erledigt, ${muted} stumm ausgeblendet`,
    logsOccurrences: (n: number) => `${n}×`,
    logsFirstLast: (first: string, last: string) => `zuerst ${first} · zuletzt ${last}`,
    logsAnnotated: (status: string) => status === 'solved' ? 'erledigt' : status === 'important' ? 'wichtig' : 'offen',
    logsSaved: 'Gespeichert ✓', logsNoteAsk: 'Notiz (optional)',
    tplFeedback: 'Feedback-E-Mail (nach dem Spiel)',
    tplFeedbackHint: 'Wird nach dem Absenden eines Feedbacks an den Coachee gesendet (RC in Kopie, PDF im Anhang).',
    tplReminder: 'Erinnerung (Tag vor dem Spiel)',
    tplReminderHint: 'Wird am Vortag an jeden Coachee gesendet, dessen Spiel ein RC übernommen hat (RC in Kopie). Sind beide SR Coachees, erhält jeder eine eigene E-Mail.',
    tplSurvey: 'RC-Feedback-Benachrichtigung',
    tplSurveyHint: 'Geht an die RC-Kommission, sobald jemand den Fragebogen abgeschickt hat. Die Antworten hängen automatisch darunter — anonyme Rückmeldungen ohne Namen.',
    tplSubject: 'Betreff', tplHeading: 'Titel (optional)', tplIntro: 'Text', tplOutro: 'Schluss / Grussformel',
    tplEnglish: 'Englische Fassung',
    tplEnglishHint: 'Steht in der E-Mail unter dem deutschen Text. Leer lassen = nur Deutsch. Der Betreff bleibt einer für beide.',
    tplHeadingEn: 'Titel (EN, optional)', tplIntroEn: 'Text (EN)', tplOutroEn: 'Schluss (EN)',
    tplPlaceholders: 'Platzhalter — anklicken zum Einfügen, oder {{ tippen:',
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
    formLangNote: 'Der Fragebogen zeigt beide Sprachen — zuerst Deutsch, darunter Englisch. Bleibt eine Seite leer, steht nur die andere da.',
    reminderEnabled: 'Erinnerungen aktiv', reminderEnabledHint: 'Wenn aus, wird am Vortag nichts versendet. Der Testmodus unterdrückt den Versand zusätzlich.',
    reminderPreview: 'Vorschau: morgen', reminderPreviewHint: 'Zeigt exakt, was morgen versendet würde — es wird nichts gesendet.',
    reminderNone: 'Für morgen stehen keine Erinnerungen an.',
    importXlsx: 'xlsx importieren', importHint: (s: string) => `Import setzt die Saison ${s}. Bestehende (gleicher Name + Saison) werden aktualisiert.`,
    firstName: 'Vorname', lastName: 'Nachname', svNumber: 'SV-Nummer', aliases: 'Frühere Namen', level: 'Niveau', stage: 'Niveau', group: 'Gruppe', email: 'E-Mail', phone: 'Telefon',
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
    mgDate: 'Datum / Anpfiff', mgTime: 'Anpfiff (Schweizer Zeit)', mgGender: 'Geschlecht', mgMatchNo: 'Spiel-Nr. (optional)', mgLeague: 'Liga', mgLocation: 'Ort',
    mgHome: 'Heim', mgAway: 'Gast', mgRef1: '1. SR (= Coachee)', mgRef2: '2. SR', mgRc: 'Referee Coach',
    mgCreate: 'Spiel anlegen', mgDelete: 'Löschen',
    mgCreated: (n: string) => `Angelegt: ${n}`,
    mgPickSearch: 'Name suchen …',
    mgPickNone: 'Kein Treffer.',
    mgPickMore: (n: number) => `… ${n} weitere — Suche eingrenzen.`,
    mgPickUnknown: 'Nicht in der Liste — freier Text.',
    mgPickNoCoachee: 'kein Coachee',
    mgDirFail: (e: string) => `Schiedsrichterliste aus VolleyManager nicht erreichbar — die Auswahl zeigt nur Coachees. (${e})`,
    noEmail: 'Keine E-Mail',
    syncTitle: 'Kontaktdaten aus VolleyManager',
    syncHint: 'Holt E-Mail und Telefon aus der VolleyManager-Schiedsrichterliste. Wer dort fehlt, wird auf den Spielen des Saison gesucht (sobald diese aufgeschaltet sind). Ohne E-Mail lässt sich kein Feedback abschicken.',
    syncBtn: 'Kontakte holen',
    syncOverwrite: 'Vorhandene Einträge überschreiben (sonst werden nur leere Felder gefüllt)',
    syncResult: (u: number, a: number, n: number, f: number) => `${u} aktualisiert, ${a} bereits vollständig, ${n} nicht gefunden (${f} SR in VolleyManager).`,
    syncFail: (e: string) => `Kontakt-Abgleich fehlgeschlagen: ${e}`,
    syncNotFoundList: 'Nicht in VolleyManager gefunden',
    syncAmbiguous: 'Mehrdeutiger Name — nichts übernommen, bitte von Hand prüfen',
    syncMissingEmail: (n: number, total: number) => `${n} von ${total} Coachees haben keine E-Mail — für diese kann kein Feedback abgeschickt werden.`,
    rosterTitle: 'Schiedsrichter-Register (SV-Nr.)',
    rosterHint: 'Die SVRZ-Liste „Schiedsrichter verwalten" als xlsx — alle lizenzierten SR, nicht nur die Coachees. Schlüssel ist die SV-Nr.: Namen ändern sich, Nummern nicht. Der Import verknüpft jeden Coachee einmalig mit seiner Nummer; ab dann zählt die Nummer, nicht die Schreibweise.',
    rosterImport: 'Register importieren',
    rosterCount: (n: number) => `${n} Schiedsrichter im Register`,
    rosterEmpty: 'Register noch leer — die Auswahl im Testspiel-Formular zeigt bis dahin die VolleyManager-Liste (ohne Nummern).',
    rosterResult: (created: number, updated: number, linked: number) => `${created} neu, ${updated} aktualisiert · ${linked} Coachees mit ihrer SV-Nr. verknüpft.`,
    rosterAmbiguous: 'Mehrdeutiger Name — keine Nummer gesetzt, bitte von Hand prüfen',
    rosterUnmatched: 'Coachees ohne Eintrag im Register',
    rosterFail: (e: string) => `Import fehlgeschlagen: ${e}`,
    mgExisting: 'Angelegte Testspiele', mgSearch: 'Spiel suchen …',
    mgNone: 'Keine Testspiele vorhanden.',
    mgConfirmDelete: (n: string) => `Spiel „${n}" wirklich löschen?`,
    mgDeleteOk: (n: string) => `Spiel „${n}" gelöscht.`,
    shortcutToggle: 'Admin-Link in der Toolbar zeigen (nur Anzeige — gibt keine Rechte)',
    games: 'Spiele', overview: 'Übersicht', stats: 'Statistik',
    niveau: 'Niveau',
    nvHint: 'Auf welche Spiele ein SR dieser Stufe im Fokus steht — pro Kategorie und Rolle. Angeklickt heisst: das Spiel erscheint in der Spielliste des Coachees. Nichts angeklickt heisst: in dieser Kategorie und Rolle keine Fokus-Spiele („x" in der offiziellen Tabelle).',
    nvOfficial: 'Offizielle Tabelle, Stand 9. April 2026',
    nvReset: 'Auf offizielle Tabelle zurücksetzen',
    nvResetTitle: 'Alle Abweichungen verwerfen?',
    nvResetConfirm: 'Die offizielle Tabelle wird wiederhergestellt.',
    nvResetOk: 'Offizielle Tabelle wiederhergestellt.',
    nvNoChanges: 'Keine Abweichung von der offiziellen Tabelle',
    nvFocus: 'Fokus-Spiele',
    nvNotBlocking: 'Der Fokus blendet nur aus, er sperrt nichts: RC schalten jederzeit auf „Alle Spiele" um und können auch ein Spiel ausserhalb des Fokus übernehmen und beurteilen. Ein Spiel, das die Tabelle nicht einordnen kann (Cup, Quali, U16–U20), bleibt sichtbar — ausser bei Coachees der Gruppen „Beförderung?" und „Beförderung": für sie zählen nur Spiele, die die Tabelle eindeutig ihrem Niveau zuordnet.',
    nvChanged: (n: number) => `${n} Zelle${n === 1 ? '' : 'n'} weicht von der offiziellen Tabelle ab`,
    nvMen: 'Herren', nvWomen: 'Damen', nvU23: 'U23',
    nv1sr: '1. SR', nv2sr: '2. SR',
    nvU23Men: 'HU23', nvU23Women: 'DU23',
    nvU23MenNote: 'U23 Männer', nvU23WomenNote: 'U23 Frauen',
    nvLevel: 'Niveau · Stufe',
    nvLegend: 'NL = Nationalliga · Zahl = Liga · U23: 1.–3. Liga (im VolleyManager „Stärkeklasse")',
    nvFam: {
      N4: 'Regionaler SR ohne Ausbildung zum 2. SR',
      N3: 'Regionaler SR mit Ausbildung zum 2. SR',
      N2: 'Regionaler SR für nationale Spiele 1. Liga',
      N1: 'Nationalkader',
    } as Record<string, string>,
    gamesHint: 'Ein Spiel einem Referee Coach zuteilen oder für eine Beobachtung vormerken. Die RC übernehmen ihre Spiele sonst selbst — das hier ist der Weg, es für jemanden zu tun.',
    gamesCount: (n: number, s: string) => `${n} Spiele · Saison ${s} (Testspiele immer dabei)`,
    gamesSearch: 'Spiel, Team, Liga oder Halle suchen …',
    gamesNone: 'Keine Spiele gefunden.',
    gamesUnassigned: 'Nur ohne RC',
    gamesPast: 'Auch vergangene',
    gamesMore: (n: number) => `Weitere ${n} Spiele anzeigen`,
    gamesFlag: 'Vormerken', gamesFlagged: 'Vorgemerkt', gamesFlaggedVm: 'Vorgemerkt (VM)',
    gamesFlagHint: 'Für eine Beobachtung vormerken — die RC sehen das Spiel dann unter „Vorgemerkt".',
    gamesFlagVmHint: 'Aus VolleyManager übernommen (RD/RSV-Markierung) — hier nicht änderbar.',
    ovHint: 'Saisonstand aller Referee Coaches. Die RC selbst sehen in der App nur ihre eigene Zeile.',
    ovName: 'Referee Coach', ovDone: 'Erledigt', ovPlanned: 'Geplant', ovOutstanding: 'Ausstehend',
    ovNone: 'Noch keine Daten für diese Saison.',
    ovShow: 'Details anzeigen', ovHide: 'Details ausblenden',
    ovOutstandingHint: 'Gespielt, dem RC zugewiesen, aber noch keine Beobachtung erfasst — diese Spiele sind noch zu erledigen.',
    ovPlannedHint: 'Vom RC übernommen, noch nicht gespielt.',
    ovDoneHint: 'Beobachtung erfasst und versendet.',
    ovEmpty: 'Keine.',
    ovPaidOn: 'Bezahlt am', ovPaidBy: 'von', ovMarkPaid: 'Als bezahlt markieren', ovUnmarkPaid: 'Bezahlt-Markierung entfernen',
    ovPaidHint: 'Spesen dieser Saison ausbezahlt. Ändert keine Zahl — „Vergütet" bleibt der Anspruch; das hier ist der Haken, wenn er beglichen ist.',
    ovPaidOk: 'Als bezahlt markiert.', ovUnpaidOk: 'Markierung entfernt.', ovPaidCol: 'Bezahlt am',
    ovSheet: 'Spesenabrechnung (PDF)', ovSheetAll: 'Alle Spesenabrechnungen (ZIP)',
    ovSheetHint: 'Das Blatt der Kommission, aus den erfassten Beobachtungen gezeichnet: ein Einsatz pro Spiel, die RC-Sitzung, das Total, die Unterschrift.',
    ovSheetAllHint: 'Ein PDF pro RC mit mindestens einem Besuch oder Sitzungsbesuch in dieser Saison.',
    ovMeeting: (d: string) => `RC-Sitzung${d ? ` vom ${d}` : ''} besucht`,
    ovMeetingHint: 'Erscheint als Zeile auf der Spesenabrechnung. Datum und Ansatz stehen unten in der Karte „Spesen“.',
    ovMeetingOk: 'Sitzungsbesuch erfasst.', ovMeetingOff: 'Sitzungsbesuch entfernt.',
    expenses: 'Spesen', expensesHint: 'Was eine Saison zahlt — die Zahlen auf der Spesenabrechnung. Gebührenordnung Art. 14 Abs. 3: pauschal pro Einsatz, Fahrkosten inbegriffen.',
    expVisit: 'Ansatz pro Besuch (CHF)', expMeeting: 'RC-Sitzung: Ansatz (CHF)', expMeetingDate: 'RC-Sitzung: Datum',
    credentials: 'Passwörter', credentialsHint: 'Diese Passwörter öffnen die App und diese Seite. Sie werden nur als Hash gespeichert — ein gesetztes Passwort kann nicht wieder angezeigt, sondern nur ersetzt werden. Notiere es dir jetzt.',
    credShared: 'Team-Login (App)', credSharedHint: 'Das Passwort, das alle Referee Coaches für die App benutzen.',
    credAdmin: 'Admin (diese Seite)', credAdminHint: 'Öffnet diese Konsole.',
    credPresident: 'RC-Präsidium', credPresidentHint: 'Öffnet die Tabs Umfrage, RC-Notizen und Formulare. Umfrage und Notizen bleiben Admin-Rechten verschlossen.',
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
    defaultGoalHint: () => 'Beobachtungen pro Saison für alle RC, die kein eigenes Pensum haben. Einzelne Pensen (auch 0) stehen in der Liste oben (Spalte „Pensum“).',
    paidCap: 'Vergütete Spiele (max.)',
    paidCapHint: 'Infoschreiben 6.2: mehr Spiele darf ein RC coachen, vergütet werden sie nicht. Wird dem RC auf der Startseite angezeigt und in der Spesen-Datei mitgerechnet. Leer = keine Obergrenze.',
    ovCsv: 'Spesen-CSV',
    ovCsvHint: 'Erledigte Beobachtungen pro RC, plus die vergütete Anzahl nach der Obergrenze. Grundlage für die Spesenabrechnung nach Saisonende.',
    ovPaid: 'Vergütet',
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
    srNotes: 'Notes from games a coach refereed (4.4.10)',
    srNotesHint: 'When a referee coach whistled next to a coachee no feedback form is filled in — this short note takes its place. It reaches the RC chair only and never counts toward a season target.',
    srNotesEmpty: 'No notes yet.',
    forms: 'Forms',
    formsHint: 'Every submitted feedback form, filed per referee — across all seasons and all referee coaches. "Open" shows the PDF as it was sent; "Folder as ZIP" downloads everything about one person at once.',
    formsSearch: 'Find a referee (name or SV no.) …',
    formsEmpty: 'No forms submitted yet.',
    formsNoMatch: 'Nobody matches the search.',
    formsCount: (n: number) => `${n} form${n === 1 ? '' : 's'}`,
    formsPeople: (n: number) => `${n} referee${n === 1 ? '' : 's'}`,
    formsOpen: 'Open',
    formsNoFile: 'no file',
    formsScan: 'Scan',
    formsFolderZip: 'Folder as ZIP',
    formsFolderDone: (n: number) => `${n} form${n === 1 ? '' : 's'} downloaded.`,
    formsDate: 'Date', formsRole: 'Role', formsGame: 'Game', formsRc: 'RC',
    formsUnnamed: 'Unnamed',
    archive: 'Season archive',
    archiveHint: 'Every submitted feedback form of one season as a ZIP — for the records kept for two years (RC information sheet 4.4). One PDF per form, named by date, referee and role.',
    archiveDownload: 'Download season',
    archiveBusy: 'Collecting…',
    archiveDone: (n: number) => `${n} form${n === 1 ? '' : 's'} downloaded.`,
    archiveEmpty: 'No forms recorded for this season.',
    srNotesSwapped: '1st and 2nd referee were swapped (section 7.3) — the roles above are the ones actually whistled. VolleyManager still has it the other way round.',
    logsHint: 'Everything that happens: every request, every click in the app, every error. Newest last.',
    logsSearch: 'Search (email, path, text…)', logsLevel: 'Level', logsSource: 'Source', logsAll: 'All',
    logsServer: 'Server', logsClient: 'Browser', logsLive: 'Live', logsEmpty: 'No entries.',
    logsCopy: 'Copy', logsCopied: 'Copied ✓', logsSessions: 'Sessions', logsClear: 'Reset filters',
    logsErrorsOnly: 'Problems only',
    logsTabLive: 'Live', logsTabHistory: 'History & errors',
    logsHistoryHint: 'The stored daily logs — 30 days back, and they survive a restart. Problems only by default.',
    logsDate: 'Day', logsToday: 'today', logsGrouped: 'Grouped', logsSingle: 'Single',
    logsShowSolved: 'Show resolved', logsShowMuted: 'Show muted',
    logsSolve: 'Resolved', logsSolveGroup: 'Resolve all', logsImportant: 'Important', logsReopen: 'Reopen',
    logsMute: 'Mute this kind', logsMuted: 'muted',
    logsMuteTitle: (evt: string) => `Mute “${evt}” for good?`,
    logsMuteBody: 'Entries like this disappear from this view and stop triggering error e-mails. Nothing is deleted — “Show muted” brings them back.',
    logsMuteConfirm: 'Mute',
    logsRules: 'Mute rules', logsRulesNone: 'No mute rules.',
    logsRuleOn: 'Active', logsRuleOff: 'Paused',
    logsSummary: (shown: number, scanned: number) => `${shown} of ${scanned} entries`,
    logsHiddenNote: (solved: number, muted: number) => `${solved} resolved, ${muted} muted hidden`,
    logsOccurrences: (n: number) => `${n}×`,
    logsFirstLast: (first: string, last: string) => `first ${first} · last ${last}`,
    logsAnnotated: (status: string) => status === 'solved' ? 'resolved' : status === 'important' ? 'important' : 'open',
    logsSaved: 'Saved ✓', logsNoteAsk: 'Note (optional)',
    tplFeedback: 'Feedback email (after the match)',
    tplFeedbackHint: 'Sent to the coachee when a feedback is submitted (RC in CC, PDF attached).',
    tplReminder: 'Reminder (day before the match)',
    tplReminderHint: 'Sent the day before to every coachee whose game an RC has taken (RC in CC). If both referees are coachees, each gets their own email.',
    tplSurvey: 'RC feedback notification',
    tplSurveyHint: 'Goes to the RC commission as soon as somebody submits the questionnaire. The answers are appended automatically — anonymous responses without a name.',
    tplSubject: 'Subject', tplHeading: 'Title (optional)', tplIntro: 'Body', tplOutro: 'Closing / sign-off',
    tplEnglish: 'English version',
    tplEnglishHint: 'Shown under the German text in the mail. Leave empty for German only. The subject is one for both.',
    tplHeadingEn: 'Title (EN, optional)', tplIntroEn: 'Body (EN)', tplOutroEn: 'Closing (EN)',
    tplPlaceholders: 'Placeholders — click to insert, or type {{:',
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
    formLangNote: 'The form shows both languages, German first and English underneath. Leave one side empty and only the other is printed.',
    reminderEnabled: 'Reminders active', reminderEnabledHint: 'When off, nothing is sent the day before. Test mode suppresses sending as well.',
    reminderPreview: 'Preview: tomorrow', reminderPreviewHint: 'Shows exactly what would be sent tomorrow — nothing is sent.',
    reminderNone: 'No reminders due for tomorrow.',
    importXlsx: 'Import xlsx', importHint: (s: string) => `Import targets season ${s}. Existing (same name + season) are updated.`,
    firstName: 'First name', lastName: 'Last name', svNumber: 'SV number', aliases: 'Former names', level: 'Level', stage: 'Niveau', group: 'Group', email: 'Email', phone: 'Phone',
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
    mgDate: 'Date / kick-off', mgTime: 'Kick-off (Swiss time)', mgGender: 'Gender', mgMatchNo: 'Match no. (optional)', mgLeague: 'League', mgLocation: 'Venue',
    mgHome: 'Home', mgAway: 'Away', mgRef1: '1st referee (= coachee)', mgRef2: '2nd referee', mgRc: 'Referee coach',
    mgCreate: 'Create game', mgDelete: 'Delete',
    mgCreated: (n: string) => `Created: ${n}`,
    mgPickSearch: 'Search name …',
    mgPickNone: 'No match.',
    mgPickMore: (n: number) => `… ${n} more — narrow the search.`,
    mgPickUnknown: 'Not in the list — free text.',
    mgPickNoCoachee: 'not a coachee',
    mgDirFail: (e: string) => `The VolleyManager referee list could not be reached — the pickers show coachees only. (${e})`,
    noEmail: 'No email',
    syncTitle: 'Contact details from VolleyManager',
    syncHint: 'Pulls email and phone from the VolleyManager referee list. Anyone missing there is looked up on the season\'s games (once those are published). Feedback cannot be submitted without an email.',
    syncBtn: 'Fetch contacts',
    syncOverwrite: 'Overwrite existing entries (otherwise only empty fields are filled)',
    syncResult: (u: number, a: number, n: number, f: number) => `${u} updated, ${a} already complete, ${n} not found (${f} referees in VolleyManager).`,
    syncFail: (e: string) => `Contact sync failed: ${e}`,
    syncNotFoundList: 'Not found in VolleyManager',
    syncAmbiguous: 'Ambiguous name — nothing written, please check by hand',
    syncMissingEmail: (n: number, total: number) => `${n} of ${total} coachees have no email — feedback cannot be submitted for them.`,
    rosterTitle: 'Referee register (SV no.)',
    rosterHint: 'The SVRZ "Schiedsrichter verwalten" list as xlsx — every licensed referee, not only the coachees. The SV number is the key: names change, numbers do not. The import links each coachee to their number once; after that the number decides, not the spelling.',
    rosterImport: 'Import register',
    rosterCount: (n: number) => `${n} referees in the register`,
    rosterEmpty: 'Register still empty — until it is filled, the test-game pickers show the VolleyManager list (which carries no numbers).',
    rosterResult: (created: number, updated: number, linked: number) => `${created} new, ${updated} updated · ${linked} coachees linked to their SV number.`,
    rosterAmbiguous: 'Ambiguous name — no number written, please check by hand',
    rosterUnmatched: 'Coachees with no entry in the register',
    rosterFail: (e: string) => `Import failed: ${e}`,
    mgExisting: 'Test games created', mgSearch: 'Search game …',
    mgNone: 'No test games.',
    mgConfirmDelete: (n: string) => `Delete game "${n}"?`,
    mgDeleteOk: (n: string) => `Game "${n}" deleted.`,
    shortcutToggle: 'Show the admin link in their toolbar (display only — grants nothing)',
    games: 'Games', overview: 'Overview', stats: 'Statistics',
    niveau: 'Levels',
    nvHint: 'Which games a referee at this level is focused on — per category and role. Lit means the game shows up in that coachee\'s game list. Nothing lit means no focused games in this category and role (an "x" in the official table).',
    nvOfficial: 'Official table, as of 9 April 2026',
    nvReset: 'Reset to the official table',
    nvResetTitle: 'Discard every deviation?',
    nvResetConfirm: 'The official table is restored.',
    nvResetOk: 'Official table restored.',
    nvNoChanges: 'No deviation from the official table',
    nvFocus: 'Focused games',
    nvNotBlocking: 'The focus only hides, it never blocks: coaches can switch to "All games" at any time, and take and assess a game outside the focus. A game the table cannot place (a cup, a qualifier, U16–U20) stays visible — except for coachees in the "Promotion?" and "Promoted" groups: for them only games the table clearly assigns to their level count.',
    nvChanged: (n: number) => `${n} cell${n === 1 ? '' : 's'} differ${n === 1 ? 's' : ''} from the official table`,
    nvMen: 'Men', nvWomen: 'Women', nvU23: 'U23',
    nv1sr: '1st ref', nv2sr: '2nd ref',
    nvU23Men: 'HU23', nvU23Women: 'DU23',
    nvU23MenNote: 'U23 men', nvU23WomenNote: 'U23 women',
    nvLevel: 'Niveau · Stufe',
    nvLegend: 'NL = national league · digit = Liga · U23: 1.–3. Liga (“Stärkeklasse” in VolleyManager)',
    nvFam: {
      N4: 'Regional referee, not trained as 2nd ref',
      N3: 'Regional referee, trained as 2nd ref',
      N2: 'Regional referee for national 1. Liga games',
      N1: 'National squad',
    } as Record<string, string>,
    gamesHint: 'Assign a game to a referee coach, or flag it for observation. Coaches normally take their own games — this is how you do it for someone.',
    gamesCount: (n: number, s: string) => `${n} games · season ${s} (test games always included)`,
    gamesSearch: 'Search game, team, league or venue …',
    gamesNone: 'No games found.',
    gamesUnassigned: 'Unassigned only',
    gamesPast: 'Include past',
    gamesMore: (n: number) => `Show ${n} more games`,
    gamesFlag: 'Flag', gamesFlagged: 'Flagged', gamesFlaggedVm: 'Flagged (VM)',
    gamesFlagHint: 'Flag for observation — coaches then find the game under "Flagged".',
    gamesFlagVmHint: 'Taken from VolleyManager (RD/RSV marking) — not editable here.',
    ovHint: 'Season progress for every referee coach. Coaches themselves only ever see their own row in the app.',
    ovName: 'Referee coach', ovDone: 'Done', ovPlanned: 'Planned', ovOutstanding: 'Outstanding',
    ovNone: 'No data for this season yet.',
    ovShow: 'Show details', ovHide: 'Hide details',
    ovOutstandingHint: 'Played, assigned to the coach, but no observation filed yet — these are the games still to be done.',
    ovPlannedHint: 'Taken by the coach, not played yet.',
    ovDoneHint: 'Observation filed and sent.',
    ovEmpty: 'None.',
    ovPaidOn: 'Paid on', ovPaidBy: 'by', ovMarkPaid: 'Mark as paid', ovUnmarkPaid: 'Remove the paid mark',
    ovPaidHint: 'This season\'s expenses paid out. Changes no number — "Paid" stays the claim; this is the tick once it is settled.',
    ovPaidOk: 'Marked as paid.', ovUnpaidOk: 'Mark removed.', ovPaidCol: 'Paid on',
    ovSheet: 'Expense sheet (PDF)', ovSheetAll: 'All expense sheets (ZIP)',
    ovSheetHint: 'The commission\'s sheet, drawn from the filed observations: one claim per game, the RC meeting, the total, the signature.',
    ovSheetAllHint: 'One PDF per coach with at least one visit or meeting this season.',
    ovMeeting: (d: string) => `Attended the RC meeting${d ? ` of ${d}` : ''}`,
    ovMeetingHint: 'Shows as a line on the expense sheet. Date and rate are in the “Expenses” card below.',
    ovMeetingOk: 'Meeting attendance recorded.', ovMeetingOff: 'Meeting attendance removed.',
    expenses: 'Expenses', expensesHint: 'What a season pays — the figures on the expense sheet. Fee regulations art. 14 par. 3: a flat rate per assignment, travel included.',
    expVisit: 'Rate per visit (CHF)', expMeeting: 'RC meeting: rate (CHF)', expMeetingDate: 'RC meeting: date',
    credentials: 'Passwords', credentialsHint: 'These passwords open the app and this page. Only a hash is stored — a password that has been set cannot be shown again, only replaced. Write it down now.',
    credShared: 'Team login (app)', credSharedHint: 'The password every referee coach uses for the app.',
    credAdmin: 'Admin (this page)', credAdminHint: 'Opens this console.',
    credPresident: 'RC chair', credPresidentHint: 'Opens the Survey, RC notes and Forms tabs. Survey and notes stay closed to admin rights.',
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
    defaultGoalHint: () => 'Observations per season for every coach without their own target. Individual targets (0 included) are set per coach in the list above (“Pensum” column).',
    paidCap: 'Paid games (max.)',
    paidCapHint: 'Infoschreiben 6.2: a coach may take on more, but they are not reimbursed. Shown to the coach on the dashboard and applied in the expenses file. Empty = no ceiling.',
    ovCsv: 'Expenses CSV',
    ovCsvHint: 'Completed observations per coach, plus the reimbursed count after the ceiling. The basis for the end-of-season expense claim.',
    ovPaid: 'Paid',
  },
} as const;
type T = typeof STR['DE'];

/** Take the freshest answer, drop the rest.
 *
 *  A list that reloads on a keystroke can be answered out of order: the fetch
 *  for "can" starts before the fetch for "ca" and lands after it, and the reader
 *  is left looking at results for a query they have already moved past. The log
 *  tail has the same problem from the other side — its three-second poll
 *  overtakes a filter that was typed a moment ago and puts the unfiltered tail
 *  back on screen.
 *
 *  Each request takes a ticket; an answer is applied only while its ticket is
 *  still the newest one. */
function useFreshest() {
  const seq = useRef(0);
  // One object for the life of the component. Returning a fresh literal changes
  // the identity of every `useCallback` that lists it as a dependency, which
  // changes the identity of the effect that calls it — and a list that reloads
  // itself on every render is a worse race than the one this fixes.
  return useMemo(() => ({
    take: () => { seq.current += 1; return seq.current; },
    isCurrent: (ticket: number) => ticket === seq.current,
  }), []);
}

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

const NAME_COLS = ['nachname', 'name', 'last', 'lastname'];

/** The sheet, its header row, and a way to ask where a column is.
 *
 *  The header is not always the first row: VolleyManager's "Schiedsrichter
 *  verwalten" export spends row 1 on its own title and puts the column names on
 *  row 3, which reads as a title-only header and imported zero rows. Take the
 *  first row that actually carries a name column instead. */
async function readSheet(file: File): Promise<{ rows: unknown[][]; headerRow: number; col: (names: string[]) => number; header: string[] } | null> {
  if (file.size > XLSX_MAX_BYTES) {
    throw new Error(`Die Datei ist zu gross (${Math.round(file.size / 1024 / 1024)} MB, max. 8 MB).`);
  }
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
  if (rows.length > XLSX_MAX_ROWS) {
    throw new Error(`Die Datei hat ${rows.length} Zeilen (max. ${XLSX_MAX_ROWS}).`);
  }
  if (!rows.length) return null;
  const cells = (row: unknown) => (row as unknown[]).map((h) => String(h).trim().toLowerCase());
  const headerRow = rows.slice(0, 10).findIndex((row) => cells(row).some((h) => NAME_COLS.includes(h)));
  if (headerRow < 0) return null;
  const header = cells(rows[headerRow]);
  const col = (names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  return { rows, headerRow, col, header };
}

const cellText = (row: unknown[], i: number) => (i < 0 ? '' : String(row[i] ?? '').trim());
// "Ja"/"Nein" is how the export writes a boolean.
const cellYes = (row: unknown[], i: number) => /^(ja|yes|true|1)$/i.test(cellText(row, i));

/** The SVRZ "Schiedsrichter verwalten" export, read for the roster: the SV-Nr.
 *  first of all, since a list of referees keyed by name is the problem the
 *  roster exists to end. Birthdate, address and Pensum are in the file and are
 *  deliberately not read — the app has no use for them. */
async function parseRefereeXlsx(file: File): Promise<RefereeImportRow[]> {
  const sheet = await readSheet(file);
  if (!sheet) return [];
  const { rows, headerRow, col } = sheet;
  const ci = {
    sv: col(['sv-nr.', 'sv-nr', 'sv nr.', 'sv nr', 'svnr', 'sv-nummer', 'lizenznummer', 'lizenz-nr.']),
    last: col(NAME_COLS),
    first: col(['vorname', 'first', 'firstname']),
    email: col(['e-mail-adresse', 'email', 'e-mail', 'mail', 'emailadresse', 'e mail']),
    phone: col(['telefon-nr.', 'telefon-nr', 'telefon', 'telefonnummer', 'phone', 'mobile', 'natel', 'handy', 'tel', 'tel.']),
    gender: col(['geschlecht', 'gender']),
    level: col(['niveau', 'level']),
    stage: col(['niveaustufe', 'stufe', 'stage']),
    lr: col(['lr-niveau', 'lr niveau', 'linienrichter-niveau']),
    association: col(['lizenzverband', 'verband']),
    active: col(['aktive lizenz', 'lizenz aktiv', 'aktiv']),
    retired: col(['zurückgetreten', 'zurueckgetreten', 'retired']),
    dispensed: col(['dispensiert', 'dispensed']),
    language: col(['korrespondenz-sprache', 'korrespondenzsprache', 'sprache', 'language']),
  };
  // Without the number this file is just another name list, and importing it
  // would fill the roster with rows nothing can key on.
  if (ci.sv < 0) throw new Error('Der Datei fehlt die Spalte „SV-Nr." — das ist der Schlüssel des Registers.');
  const out: RefereeImportRow[] = [];
  for (const raw of rows.slice(headerRow + 1)) {
    const r = raw as unknown[];
    const sv = cellText(r, ci.sv).replace(/\.0$/, '');
    const first = cellText(r, ci.first);
    const last = cellText(r, ci.last);
    if (!sv || (!first && !last)) continue;
    out.push({
      sv_number: sv,
      first_name: first,
      last_name: last,
      full_name: `${first} ${last}`.trim(),
      email: cellText(r, ci.email),
      phone: cellText(r, ci.phone),
      gender: cellText(r, ci.gender),
      level: cellText(r, ci.level),
      stage: cellText(r, ci.stage).replace(/\.0$/, ''),
      lr_level: cellText(r, ci.lr),
      license_association: cellText(r, ci.association),
      // A missing column must not read as "licence withdrawn", so an absent
      // column is an active licence and only an explicit "Nein" is not.
      license_active: ci.active < 0 ? true : cellYes(r, ci.active),
      retired: cellYes(r, ci.retired),
      dispensed: cellYes(r, ci.dispensed),
      language: cellText(r, ci.language),
    });
  }
  return out;
}

async function parseXlsx(file: File): Promise<ImportRow[]> {
  const sheet = await readSheet(file);
  if (!sheet) return [];
  const { rows, headerRow, col, header } = sheet;
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

// Console tabs live in the URL as /admin/<tab>, so each one is linkable and
// the Back button steps between them. The Protokoll tab's own two views are
// one level down: /admin/logs and /admin/logs/history.
const ADMIN_TABS = ['coachees', 'rcs', 'games', 'overview', 'forms', 'stats', 'niveau', 'emails', 'form', 'survey', 'notes', 'logs', 'settings'] as const;
type AdminTab = (typeof ADMIN_TABS)[number];
// /admin/archive was the chair's season-ZIP tab before the forms database
// absorbed it; a bookmark of it still lands where the ZIP now lives.
const adminTabFromUrl = (): AdminTab => {
  if (/^\/admin\/archive\b/i.test(window.location.pathname)) return 'forms';
  return adminTabFromPath(window.location.pathname, ADMIN_TABS) as AdminTab;
};

export default function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tab, setTab] = useState<AdminTab>(adminTabFromUrl);
  const [logMode, setLogMode] = useState<'live' | 'history'>(() => adminLogModeFromPath(window.location.pathname));
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
  // Infoschreiben 6.2's ceiling: what the season reimburses, which is not the
  // same number as what a mandate owes.
  const [paidCap, setPaidCap] = useState<number>(PAID_CAP);
  const [expenseRates, setExpenseRates] = useState<ExpenseRates>(DEFAULT_EXPENSE_RATES);
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
    if (role === 'president' && tab !== 'survey' && tab !== 'notes' && tab !== 'forms') setTab('survey');
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
        if (s.paid_cap) setPaidCap(s.paid_cap);
        if (s.expense_rates) setExpenseRates(s.expense_rates);
        setNiveauTable(resolveNiveauTable(s.niveau_table || null));
        if (s.default_season) setDefaultSeason(s.default_season);
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    loadEligibleGames()
      .then((games) => { setLeagueOptions(Array.from(new Set(games.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort()); })
      .catch(() => {});
  }, [authed, role]);
  // Guards the subscription below: while one of our own saves is in flight the
  // pushed copy is older than what is on screen.
  const settingsSavesInFlight = useRef(0);
  // The console is its own React root, so it subscribes to /api/events for
  // itself. Two admins editing the Niveau matrix at the same time each worked
  // from the copy they had loaded, and the second save silently won.
  useEffect(() => {
    if (!authed || role !== 'admin') return;
    return subscribeLive((event) => {
      if (event.type !== 'settings.changed') return;
      if (settingsSavesInFlight.current > 0) return;
      getSettings()
        .then((s) => {
          setGroups(s.groups || []);
          setCoacheeTargets(s.coachee_targets || {});
          setRcMandates(s.rc_mandates || {});
          setNiveauTable(resolveNiveauTable(s.niveau_table || null));
          if (s.default_goal) setDefaultGoal(s.default_goal);
          if (s.paid_cap) setPaidCap(s.paid_cap);
          if (s.expense_rates) setExpenseRates(s.expense_rates);
          if (s.default_season) setDefaultSeason(s.default_season);
          setTestMode(Boolean(s.test_mode));
        })
        .catch(() => { /* the next save or reload brings it back */ });
    });
  }, [authed, role]);
  // Optimistic with a rollback, like the test-mode toggle next to them. Left
  // silent, a rejected save (expired admin session, 500) showed the new mandate
  // or target as stored while the RC's season goal quietly stayed as it was.
  const [settingsError, setSettingsError] = useState('');
  const saveTargets = useCallback(async (next: CoacheeTargetMap) => {
    let previous: CoacheeTargetMap = {};
    setCoacheeTargets((current) => { previous = current; return next; });
    setSettingsError('');
    settingsSavesInFlight.current += 1;
    try { await putSettings({ coachee_targets: next }); }
    catch (e) { setCoacheeTargets(previous); setSettingsError(e instanceof Error ? e.message : String(e)); }
    finally { settingsSavesInFlight.current -= 1; }
  }, []);
  // Stored as overrides only: a row that still matches the published table is
  // left out, so a future correction to it reaches this console untouched.
  // Returns whether the write stuck, the same way saveGroups does: the reset
  // button toasts a success, and a rolled-back save must not earn one.
  const saveNiveau = useCallback(async (next: NiveauMatrix) => {
    let previous: NiveauMatrix = {};
    setNiveauTable((current) => { previous = current; return next; });
    setSettingsError('');
    settingsSavesInFlight.current += 1;
    try { await putSettings({ niveau_table: niveauOverrides(next) }); return true; }
    catch (e) { setNiveauTable(previous); setSettingsError(e instanceof Error ? e.message : String(e)); return false; }
    finally { settingsSavesInFlight.current -= 1; }
  }, []);
  const saveMandates = useCallback(async (next: RcMandateMap) => {
    let previous: RcMandateMap = {};
    setRcMandates((current) => { previous = current; return next; });
    setSettingsError('');
    settingsSavesInFlight.current += 1;
    try { await putSettings({ rc_mandates: next }); }
    catch (e) { setRcMandates(previous); setSettingsError(e instanceof Error ? e.message : String(e)); }
    finally { settingsSavesInFlight.current -= 1; }
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

  const saveExpenseRates = useCallback(async (next: ExpenseRates) => {
    let previous = DEFAULT_EXPENSE_RATES;
    setExpenseRates((current) => { previous = current; return next; });
    try {
      await putSettings({ expense_rates: next });
    } catch (e) {
      setExpenseRates(previous);
      setSettingsError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);
  const savePaidCap = useCallback(async (next: number) => {
    let previous = 0;
    setPaidCap((current) => { previous = current; return next; });
    try {
      await putSettings({ paid_cap: next });
    } catch (e) {
      setPaidCap(previous);
      setSettingsError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  // Tab ↔ URL. pushState, so each tab is a Back step; popstate handles
  // Back/Forward. The Logs sub-tab REPLACES rather than pushes: Live/Verlauf
  // is a toggle inside one tab, and Back through it should leave Logs, not
  // step through the toggle first.
  const didSyncPath = useRef(false);
  const isAdminPath = () => /^\/admin(\/|$)/i.test(window.location.pathname);
  useEffect(() => {
    if (!isAdminPath()) return; // leaving the console — main.tsx takes over
    const target = tab === 'logs' && logMode === 'history' ? '/admin/logs/history' : `/admin/${tab}`;
    if (window.location.pathname !== target) {
      const sameTab = adminTabFromUrl() === tab;
      if (didSyncPath.current && !sameTab) window.history.pushState(null, '', target);
      else window.history.replaceState(null, '', target);
    }
    didSyncPath.current = true;
  }, [tab, logMode]);
  useEffect(() => {
    const onPop = () => {
      if (!isAdminPath()) return;
      setTab(adminTabFromUrl());
      setLogMode(adminLogModeFromPath(window.location.pathname));
    };
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

  // The chair gets her tabs and nothing else. She is not a lesser admin —
  // she is a different person with a different password, and the admin half of
  // this console is closed to her exactly as her half is closed to the admin.
  // The one shared door is Formulare: the filed forms are the commission's
  // records, and the server opens them to either password on purpose, so a
  // lost console password never strands two years of them.
  const isPresident = role === 'president';
  const tabs: { id: typeof tab; label: string; icon: React.ReactNode }[] = isPresident ? [
    { id: 'survey', label: t.survey, icon: <MessageSquare size={15} /> },
    { id: 'notes', label: t.notes, icon: <Lock size={15} /> },
    { id: 'forms', label: t.forms, icon: <FolderOpen size={15} /> },
  ] : [
    { id: 'coachees', label: t.coachees, icon: <Users size={15} /> },
    { id: 'rcs', label: t.rcs, icon: <ShieldCheck size={15} /> },
    { id: 'games', label: t.games, icon: <CalendarDays size={15} /> },
    { id: 'overview', label: t.overview, icon: <Target size={15} /> },
    { id: 'forms', label: t.forms, icon: <FolderOpen size={15} /> },
    { id: 'stats', label: t.stats, icon: <BarChart3 size={15} /> },
    { id: 'niveau', label: t.niveau, icon: <Gauge size={15} /> },
    { id: 'emails', label: t.emails, icon: <Mail size={15} /> },
    { id: 'form', label: t.form, icon: <ClipboardList size={15} /> },
    { id: 'logs', label: t.logs, icon: <ScrollText size={15} /> },
    { id: 'settings', label: t.settings, icon: <SettingsIcon size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 pb-24 lg:pb-16">
      <header className="bg-white border-b border-stone-200/70 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <SvrzLogo className="h-7 w-auto" />
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-400">{t.admin}</span>
          {testMode && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 text-[11px] font-semibold px-2 py-0.5"><FlaskConical size={12} /> {t.testBadge}</span>}
          <button onClick={() => { window.location.assign('/'); }} aria-label={t.toApp} className="ml-auto inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Home size={14} /><span className="hidden sm:inline">{t.toApp}</span></button>
          <button onClick={toggleLang} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"><Languages size={14} />{lang}</button>
          <button onClick={logout} aria-label={t.logout} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"><LogOut size={15} /> <span className="hidden sm:inline">{t.logout}</span></button>
        </div>
      </header>
      {/* Tabs stay mounted: their data is fetched in one parallel batch on the
          first render after login, so switching tabs shows the finished page
          instead of starting that tab's request right then. Logs are the
          exception — they only poll while their tab is on screen. */}
      {/* Nine destinations in a wrapped grid read as a wall of equal buttons —
          nothing said which of them you were in without reading all nine. On a
          wide screen they belong in a rail beside the page; on a phone there is
          no room beside anything, so the same list sits along the bottom, where
          a thumb is, and scrolls sideways rather than stealing three rows of
          height from the page it is navigating. */}
      {/* The statistics are a dashboard: seven tiles and three-up chart rows
          want the whole screen, where a list of coachees does not. */}
      <div className={cn('mx-auto px-4 flex gap-6', tab === 'stats' ? 'max-w-[1800px]' : 'max-w-6xl')}>
        <nav
          aria-label={t.admin}
          className="hidden lg:block w-56 shrink-0 sticky top-[68px] self-start pt-5 pb-8 space-y-1"
        >
          {tabs.map((tb) => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              aria-current={tab === tb.id ? 'page' : undefined}
              className={cn(
                'w-full h-10 px-3 inline-flex items-center gap-2.5 text-sm font-medium rounded-xl transition-colors text-left',
                tab === tb.id ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-200/70',
              )}
            >
              <span className="shrink-0">{tb.icon}</span>
              <span className="truncate">{tb.label}</span>
            </button>
          ))}
        </nav>

        <main className="flex-1 min-w-0 pt-5">
        {/* Mandate/target saves are optimistic; when one is rejected the state
            rolls back and this is what says so. */}
        {settingsError && (
          <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</p>
        )}
        {/* Each setting sits under the tab whose content it changes; the daily
            work (lists, forms) comes first in every panel, the number or switch
            that shapes it closes the panel. Einstellungen keeps only what no
            tab owns. */}
        {!isPresident && <>
        <div hidden={tab !== 'coachees'}>
          <CoacheesAdmin t={t} lang={lang} groups={groups} defaultSeason={defaultSeason} settingsLoading={settingsLoading} targets={coacheeTargets} onTargets={saveTargets} leagueOptions={leagueOptions} niveauTable={niveauTable} />
          <GroupsCard t={t} lang={lang} groups={groups} onGroups={setGroups} loading={settingsLoading} />
        </div>
        <div hidden={tab !== 'rcs'}>
          <RcsAdmin t={t} lang={lang} mandates={rcMandates} defaultGoal={defaultGoal} settingsLoading={settingsLoading} onMandates={saveMandates} />
          <DefaultGoalCard t={t} defaultGoal={defaultGoal} onDefaultGoal={saveDefaultGoal} loading={settingsLoading} />
        </div>
        <div hidden={tab !== 'emails'}>
          {/* The mail switches head the tab — the templates below are long. */}
          <TestModeCard t={t} testMode={testMode} onTestMode={setTestMode} loading={settingsLoading} />
          <EmailsAdmin t={t} lang={lang} />
        </div>
        <div hidden={tab !== 'form'}><SurveyFormAdmin t={t} lang={lang} /></div>
        <div hidden={tab !== 'games'}>
          {/* Import status strip first: it turns red exactly when the list
              below looks wrong. Börse and the test-game form are rare work. */}
          <GameImportCard lang={lang} />
          <GamesAdmin t={t} lang={lang} season={defaultSeason} settingsLoading={settingsLoading} active={tab === 'games'} />
          <BoerseCard lang={lang} />
          <ManualGameAdmin t={t} lang={lang} active={tab === 'games'} />
        </div>
        <div hidden={tab !== 'overview'}>
          <OverviewAdmin t={t} lang={lang} paidCap={paidCap} season={defaultSeason} settingsLoading={settingsLoading} meetingDate={expenseRates.meetingDate} />
          <PaidCapCard t={t} paidCap={paidCap} onPaidCap={savePaidCap} loading={settingsLoading} />
          <ExpenseRatesCard t={t} expenseRates={expenseRates} onExpenseRates={saveExpenseRates} loading={settingsLoading} />
        </div>
        <div hidden={tab !== 'stats'}><StatisticsAdmin lang={lang} defaultSeason={defaultSeason} settingsLoading={settingsLoading} active={tab === 'stats'} /></div>
        <div hidden={tab !== 'niveau'}><NiveauAdmin t={t} lang={lang} table={niveauTable} onTable={saveNiveau} loading={settingsLoading} /></div>
        </>}
        {isPresident && <div hidden={tab !== 'survey'}><SurveyAdmin t={t} lang={lang} /></div>}
        {isPresident && <div hidden={tab !== 'notes'}><PresidentNotesAdmin t={t} lang={lang} /></div>}
        <div hidden={tab !== 'forms'}>
          <FormsAdmin t={t} active={tab === 'forms'} />
          <ArchiveAdmin t={t} defaultSeason={defaultSeason} />
        </div>
        {!isPresident && <>
        <div hidden={tab !== 'logs'}><LogsAdmin t={t} lang={lang} active={tab === 'logs'} mode={logMode} onMode={setLogMode} /></div>
        <div hidden={tab !== 'settings'}>
          <SettingsAdmin t={t} defaultSeason={defaultSeason} settingsLoading={settingsLoading} />
          <CredentialsAdmin t={t} />
        </div>
        </>}
        <p className="mt-6 pb-3 text-center text-[10px] text-stone-400">v{APP_VERSION} · Build {BUILD_INFO}</p>
        </main>
      </div>

      {/* Phones and tablets: the same nav along the bottom. Scrolls sideways so
          a ninth destination costs no height, and the page keeps room for it. */}
      <nav
        aria-label={t.admin}
        className="lg:hidden fixed bottom-0 inset-x-0 z-20 bg-white/95 backdrop-blur border-t border-stone-200 overflow-x-auto"
      >
        <div className="flex gap-1 px-2 py-1.5 w-max min-w-full">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              // A deep link can land on a destination the scroller has parked
              // off-screen, and then nothing on the bar says where you are.
              ref={tb.id === tab ? (el) => el?.scrollIntoView({ inline: 'center', block: 'nearest' }) : undefined}
              onClick={() => setTab(tb.id)}
              aria-current={tab === tb.id ? 'page' : undefined}
              className={cn(
                'shrink-0 min-w-[68px] px-2.5 py-1.5 inline-flex flex-col items-center gap-1 rounded-xl text-[10px] font-medium leading-none transition-colors',
                tab === tb.id ? 'bg-slate-900 text-white' : 'text-stone-500 hover:bg-stone-100',
              )}
            >
              <span className="shrink-0">{tb.icon}</span>
              <span className="whitespace-nowrap">{tb.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

function Card({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div data-testid={testId} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">{children}</div>;
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

/** The referee register: import the SVRZ XLSX, see what it holds, and see which
 *  coachees it could not put a number on.
 *
 *  The number is the point. Every other list in this app is keyed by a name —
 *  and a name is spelled two ways in two exports, changes on marriage, and is
 *  shared by two people often enough that the contact sync has to refuse those
 *  cases outright. */
function RefereeRosterAdmin({ t, onLinked }: { t: T; onLinked: () => void }) {
  const [roster, setRoster] = useState<RefereeRoster | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [ambiguous, setAmbiguous] = useState<string[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try { setRoster(await listReferees()); } catch { setRoster({ people: [] }); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setNote(''); setErr(''); setAmbiguous([]); setUnmatched([]);
    try {
      const rows = await parseRefereeXlsx(file);
      if (!rows.length) { setErr(t.noRows); return; }
      const res = await importReferees(rows);
      setNote(t.rosterResult(res.created, res.updated, res.linked));
      setAmbiguous(res.ambiguousNames ?? []);
      setUnmatched(res.unmatched ?? []);
      await reload();
      // The import wrote referee_id onto coachee rows; the list above is now
      // one version behind what it is showing.
      onLinked();
    } catch (e) { setErr(t.rosterFail(e instanceof Error ? e.message : String(e))); }
    finally { setBusy(false); }
  };

  const count = roster?.people.length ?? 0;
  const hasRegister = roster?.source === 'roster' && count > 0;
  // Until the first read comes back there is nothing true to say — "Register
  // noch leer" while it loads is a sentence that is wrong more often than right.
  const status = roster === null ? '' : hasRegister ? t.rosterCount(count) : t.rosterEmpty;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-sm font-semibold text-stone-700">{t.rosterTitle}</h2>
        <label className={cn(btnPrimary, 'ml-auto cursor-pointer', busy && 'opacity-60 pointer-events-none')}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          <span>{t.rosterImport}</span>
          <input type="file" accept=".xlsx" className="hidden" onChange={(e) => void onFile(e)} />
        </label>
      </div>
      <p className="text-xs text-stone-400">{t.rosterHint}</p>
      {status && <p className="mt-2 text-xs text-stone-500">{status}</p>}
      {note && <p className="mt-2 text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2">{note}</p>}
      {err && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
      {/* Ambiguous first, and in amber: it is the one outcome that needs a
          person to decide, where "not in the register" is merely a gap. */}
      {ambiguous.length > 0 && (
        <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          {t.rosterAmbiguous}: {ambiguous.join(', ')}
        </p>
      )}
      {unmatched.length > 0 && (
        <p className="mt-2 text-xs text-stone-500">{t.rosterUnmatched}: {unmatched.join(', ')}</p>
      )}
    </Card>
  );
}

function CoacheesAdmin({ t, lang, groups, defaultSeason, settingsLoading, targets, onTargets, leagueOptions, niveauTable }: { t: T; lang: Lang; groups: string[]; defaultSeason: number; settingsLoading: boolean; targets: CoacheeTargetMap; onTargets: (next: CoacheeTargetMap) => void; leagueOptions: string[]; niveauTable: NiveauMatrix }) {
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

  // Reloaded after every write, so two quick edits can have their answers cross
  // — and the older list would then put a deleted coachee back on screen.
  const list = useFreshest();
  const reload = useCallback(async () => {
    const ticket = list.take();
    setLoading(true);
    try {
      const rows = await listCoachees();
      if (list.isCurrent(ticket)) setAll(rows);
    } catch (e) { if (list.isCurrent(ticket)) setNotice(String(e)); }
    finally { if (list.isCurrent(ticket)) setLoading(false); }
  }, [list]);
  useEffect(() => { void reload(); }, [reload]);
  // The rows are filtered by season, and the season comes from settings, which
  // arrive after the coachees do. Rendering in between showed last season's
  // list under this season's heading for as long as that took — the local
  // fallback (`CUR_SEASON`) is August's guess, not the stored answer.
  const settling = loading || (settingsLoading && !seasonTouched.current);
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
      {/* The roster the coachee list is a subset of. It sits under the coachee
          import because that is the order the work happens in — register first,
          then who is being coached this season out of it — and because the
          import's second half writes into the coachees above. */}
      <RefereeRosterAdmin t={t} onLinked={() => void reload()} />
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
        <p className="text-xs text-stone-400 mb-2">{settling ? t.loading : t.count(rows.length, seasonLabel(season))}</p>
        <div className="divide-y divide-stone-100">
          {/* Held whole: a row list filtered by a season that is still being
              read is last season's people under this season's heading. */}
          {!settling && rows.map((c) => editId === c.id ? (
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
                  <p className="text-sm font-medium text-stone-800 truncate">{surnameFirstLabel(c)}</p>
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
          {settling && <SkeletonRows rows={6} />}
          {!settling && rows.length === 0 && <p className="py-8 text-center text-sm text-stone-400">{t.noCoachees(seasonLabel(season))}</p>}
        </div>
      </Card>
    </>
  );
}

function RcsAdmin({ t, lang, mandates, defaultGoal, settingsLoading, onMandates }: { t: T; lang: Lang; mandates: RcMandateMap; defaultGoal: number; settingsLoading: boolean; onMandates: (next: RcMandateMap) => void }) {
  const [rcs, setRcs] = useState<RcPerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ first_name: '', last_name: '', sv_number: '', name_aliases: '', email: '', phone: '' });
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
  // Same as the coachee list: reloaded after every write, so an older answer
  // must not be allowed to land on top of a newer one.
  const roster = useFreshest();
  const reload = useCallback(async () => {
    const ticket = roster.take();
    setLoading(true);
    try {
      const rows = await listRcPeopleFull();
      if (!roster.isCurrent(ticket)) return;
      setRcs(rows); setLoadFailed(false);
    } catch (e) {
      if (!roster.isCurrent(ticket)) return;
      setLoadFailed(true); setNotice(e instanceof Error ? e.message : String(e));
    } finally { if (roster.isCurrent(ticket)) setLoading(false); }
  }, [roster]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { getAdminShortcutRcs().then(setShortcutRcs).catch(() => setShortcutRcs([])); }, []);
  const toggleShortcut = async (r: RcPerson) => {
    const next = shortcutRcs.includes(r.id) ? shortcutRcs.filter((x) => x !== r.id) : [...shortcutRcs, r.id];
    const previous = shortcutRcs;
    setShortcutRcs(next); // optimistic; a rejected save rolls back and says so
    try { await setAdminShortcutRcs(next); }
    catch (e) { setShortcutRcs(previous); setNotice(e instanceof Error ? e.message : String(e)); }
  };
  const add = async () => { if (!form.first_name && !form.last_name) return; await guard(async () => { await createRcPerson({ ...form, active: true }); setForm({ first_name: '', last_name: '', sv_number: '', name_aliases: '', email: '', phone: '' }); await reload(); }); };
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
        <div className="grid grid-cols-2 sm:grid-cols-7 gap-2">
          <input className={input} placeholder={t.firstName} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          <input className={input} placeholder={t.lastName} value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          {/* The one field a rename does not invalidate. A game names its
              referees as text, so a coach who changes surname stops matching
              their own fixtures; the number keeps matching them. */}
          <input className={input} placeholder={t.svNumber} value={form.sv_number} onChange={(e) => setForm({ ...form, sv_number: e.target.value })} />
          <input className={input} placeholder={t.aliases} value={form.name_aliases} onChange={(e) => setForm({ ...form, name_aliases: e.target.value })} />
          <input className={input} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder={t.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <button onClick={add} disabled={!form.first_name && !form.last_name} className={`${btnPrimary} justify-center`}><Plus size={15} /> {t.add}</button>
        </div>
      </Card>
      <Card>
        {/* Each row prints a season goal, and a goal is a mandate times the
            default — both of which arrive with the settings, after this list. */}
        <p className="text-xs text-stone-400 mb-2">{loading || settingsLoading ? t.loading : t.rcCount(rcs.length)}</p>
        {/* Phones: one card per coach. The table needs ~720px, so on a phone it
            clipped the e-mail and pushed the actions off-screen entirely. */}
        <div className="sm:hidden space-y-2">
          {!loading && !settingsLoading && rcs.map((r) => editId === r.id ? (
            <div key={r.id} className="rounded-xl border border-stone-200 p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder={t.firstName} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
                <input className={input} placeholder={t.lastName} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
              </div>
              <input className={input} placeholder={t.svNumber} value={editForm.sv_number || ''} onChange={(e) => setEditForm({ ...editForm, sv_number: e.target.value })} />
              <input className={input} placeholder={t.aliases} value={editForm.name_aliases || ''} onChange={(e) => setEditForm({ ...editForm, name_aliases: e.target.value })} />
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
                    {surnameFirstLabel(r)}
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
              {!loading && !settingsLoading && rcs.map((r) => editId === r.id ? (
                <tr key={r.id}>
                  <td className="py-2 pr-3">
                    <div className="flex gap-1.5">
                      <input className={`${input} w-full`} placeholder={t.firstName} value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} />
                      <input className={`${input} w-full`} placeholder={t.lastName} value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} />
                      <input className={`${input} w-24 shrink-0`} placeholder={t.svNumber} value={editForm.sv_number || ''} onChange={(e) => setEditForm({ ...editForm, sv_number: e.target.value })} />
                      <input className={`${input} w-full`} placeholder={t.aliases} value={editForm.name_aliases || ''} onChange={(e) => setEditForm({ ...editForm, name_aliases: e.target.value })} />
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
                      <span className="font-medium text-stone-800 whitespace-nowrap">{surnameFirstLabel(r)}</span>
                      {r.active === false && <span className="ml-1.5 text-xs text-stone-400">· {t.inactive}</span>}
                      {r.sv_number && <span className="ml-1.5 text-xs tabular-nums text-stone-400">· {r.sv_number}</span>}
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
        {(loading || settingsLoading) && <SkeletonRows rows={6} />}
        {!loading && !settingsLoading && rcs.length === 0 && (
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
//
// Drawn as a pill showing the bare name — in the console's language, whatever
// name the text holds: {{datum}} reads "date" to an English admin and
// {{firstName}} reads "vorname" to a German one, and the text is not touched.
// The original `{{name}}` stays in the DOM invisible, because the mirror must
// trace the textarea character for character or the caret drifts; the label is
// painted over it, centred. Every name fits inside its twin's braces (the
// braces are four characters of room), so the pill never grows.
//
// `markerAt` plants a zero-width span at that text offset (inside plain text,
// never inside a placeholder), which the suggestion list is anchored to.
function placeholderParts(
  value: string, known: Set<string>, markerAt?: number, markerRef?: React.RefObject<HTMLSpanElement | null>,
  label: (name: string) => string = (n) => n,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const plain = (from: number, to: number) => {
    if (markerAt !== undefined && markerAt >= from && markerAt <= to) {
      if (markerAt > from) out.push(value.slice(from, markerAt));
      out.push(<span key={`m${markerAt}`} ref={markerRef} data-caret-marker className="inline-block w-0 align-baseline" />);
      if (to > markerAt) out.push(value.slice(markerAt, to));
    } else if (to > from) {
      out.push(value.slice(from, to));
    }
  };
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(value))) {
    plain(last, m.index);
    const name = m[1];
    out.push(
      <span key={m.index} data-placeholder={name} className={cn('relative inline-block rounded align-baseline font-semibold', known.has(name) ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700')}>
        <span className="invisible">{m[0]}</span>
        <span aria-hidden className="absolute inset-0 text-center">{known.has(name) ? label(name) : name}</span>
      </span>,
    );
    last = m.index + m[0].length;
  }
  plain(last, value.length);
  // A block box swallows a trailing newline. Without this the mirror is a line
  // shorter than the textarea and the bottom of a long text sits off by a row.
  out.push('\n');
  return out;
}

/** The unfinished placeholder the caret sits in, if any: the `{{` behind it
 *  with only name characters between, and no `}}` closing it right after —
 *  that would be an existing placeholder being edited, not a new one typed. */
function openPlaceholderAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = /\{\{\s*([a-zA-Z0-9_]*)$/.exec(before);
  if (!m) return null;
  if (/^[a-zA-Z0-9_]*\s*\}\}/.test(value.slice(caret))) return null;
  return { start: before.length - m[0].length, query: m[1] };
}

/** The field that last had the caret — where a chip click inserts. */
let lastTemplateField: { el: HTMLTextAreaElement; kind: EmailTemplateKind; field: keyof EmailTemplate } | null = null;

function TemplateField({ value, onChange, rows, singleLine, known, suggest, label, kind, field: fieldName }: {
  value: string; onChange: (v: string) => void; rows: number; singleLine?: boolean; known: Set<string>;
  /** The names offered while typing `{{`, in the console's language. */
  suggest: string[];
  /** The name a pill shows for the name in the text — the console's language. */
  label: (name: string) => string;
  kind: EmailTemplateKind; field: keyof EmailTemplate;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  // Typing `{{` opens the list; every keystroke narrows it; Enter, Tab or a
  // click completes the name and closes it, Escape just closes it. Recomputed
  // from the caret, never from the keystroke, so a click into the middle of an
  // unfinished `{{na` opens it too.
  const [open, setOpen] = useState<{ start: number; query: string } | null>(null);
  const [pick, setPick] = useState(0);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const matches = open
    ? suggest.filter((n) => n.toLowerCase().startsWith(open.query.toLowerCase()))
    : [];
  const syncOpen = () => {
    const el = field.current;
    if (!el) return;
    const next = openPlaceholderAt(el.value, el.selectionStart);
    setOpen((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
    if (!next) return;
    setPick(0);
  };
  // The marker is rendered at the `{{`; read where it landed after that render.
  useEffect(() => {
    if (!open || !marker.current || !mirror.current) { setAnchor(null); return; }
    const m = marker.current;
    // Under the caret, clamped so the list never leaves the field's right edge.
    const left = Math.max(0, Math.min(m.offsetLeft, mirror.current.clientWidth - 184));
    setAnchor({ top: m.offsetTop + m.offsetHeight - mirror.current.scrollTop, left });
  }, [open, value]);
  const complete = (name: string) => {
    const el = field.current;
    if (!el || !open) return;
    const caret = el.selectionStart;
    const next = `${value.slice(0, open.start)}{{${name}}}${value.slice(caret)}`;
    const pos = open.start + name.length + 4;
    onChange(next);
    setOpen(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos, pos); });
  };
  // A fixed one-row box clips a subject that wraps on a narrow screen, and a
  // scrollbar on a single line reads worse than a second line does. Grow to
  // fit instead — the mirror is sized by this wrapper, so it follows.
  //
  // Measured on a ResizeObserver, not on value alone: the console mounts every
  // tab and hides the inactive ones with `hidden`, and an element in a
  // display:none subtree reports scrollHeight 0. The first measurement
  // therefore collapsed the box to its two borders, nothing re-measured it when
  // the tab was finally shown, and the subject sat below a 2px sliver of a
  // field. The observer fires when it gets a size, which is exactly then.
  useEffect(() => {
    const el = field.current;
    if (!singleLine || !el) return;
    const fit = () => {
      // Still hidden: measuring now would write that collapsed height back.
      if (el.scrollHeight === 0 && el.clientHeight === 0) return;
      const next = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
      if (el.style.height === next) return; // guard: our own write re-triggers the observer
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, singleLine]);
  return (
    <div className="relative bg-white rounded-lg">
      <div
        ref={mirror}
        aria-hidden
        className={cn(FIELD_METRICS, 'tpl-field pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-stone-800')}
      >{placeholderParts(value, known, open?.start, marker, label)}</div>
      <textarea
        ref={field}
        value={value}
        rows={rows}
        data-tpl-kind={kind}
        data-tpl-field={fieldName}
        onFocus={() => { if (field.current) lastTemplateField = { el: field.current, kind, field: fieldName }; }}
        onBlur={() => window.setTimeout(() => setOpen(null), 150)} // after a click on the list lands
        onClick={syncOpen}
        onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) syncOpen(); }}
        // The mirror has no scrollbar of its own, so it follows this one.
        onScroll={() => { if (mirror.current && field.current) mirror.current.scrollTop = field.current.scrollTop; }}
        // Subject and title are textareas too, so a single overlay serves all
        // four fields. A newline in a subject line is a mail-header split, so
        // Enter is simply not a character there.
        onKeyDown={(e) => {
          if (open && matches.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => (p + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => (p - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); complete(matches[pick]); return; }
          }
          if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(null); return; }
          if (singleLine && e.key === 'Enter') e.preventDefault();
        }}
        onChange={(e) => onChange(singleLine ? e.target.value.replace(/[\r\n]+/g, ' ') : e.target.value)}
        className={cn(
          FIELD_METRICS,
          // block: a textarea is inline by default, and the line box under it
          // left the wrapper — and with it the absolutely-positioned mirror —
          // six pixels taller than the field it is supposed to trace.
          'tpl-field relative block w-full rounded-lg border border-stone-300 bg-transparent text-transparent caret-stone-900 focus:outline-none focus:ring-2 focus:ring-red-400',
          singleLine ? 'resize-none overflow-hidden' : 'resize-y',
        )}
      />
      {open && matches.length > 0 && anchor && (
        <ul
          role="listbox"
          data-testid="tpl-suggest"
          className="absolute z-20 min-w-[10rem] max-h-44 overflow-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
          style={{ top: anchor.top + 2, left: anchor.left }}
        >
          {matches.map((n, i) => (
            <li
              key={n}
              role="option"
              aria-selected={i === pick}
              // mousedown, not click: the field blurs on mousedown and the
              // list would be gone before a click could land.
              onMouseDown={(e) => { e.preventDefault(); complete(n); }}
              onMouseEnter={() => setPick(i)}
              className={cn('px-2.5 py-1 cursor-pointer text-xs font-mono', i === pick ? 'bg-stone-100' : '')}
            >
              <span className="rounded bg-blue-100 px-1.5 py-0.5 font-semibold text-blue-700">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Guided template editor: admins edit subject/title/body/closing with
// {{placeholders}}; the branded layout, detail rows and attachments are fixed,
// so an edit can never break rendering.
function EmailsAdmin({ t, lang }: { t: T; lang: Lang }) {
  const [data, setData] = useState<EmailTemplates | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [flagErr, setFlagErr] = useState('');

  useEffect(() => { getEmailTemplates().then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);

  const patch = (kind: EmailTemplateKind, p: Partial<EmailTemplate>) =>
    setData((d) => (d ? { ...d, [kind]: { ...d[kind], ...p } } : d));

  // The switch saves itself on toggle, like Test-Modus above it: a switch at
  // the top that only persists via the Save button at the bottom is how it got
  // lost in the first place. Optimistic, rolled back with a line in the card
  // when the write is rejected. The rollback uses the functional form so a
  // template edit typed meanwhile is not thrown away with it.
  const toggleReminder = async (next: boolean) => {
    if (!data) return;
    const previous = data.reminder_enabled;
    setData({ ...data, reminder_enabled: next });
    setFlagErr('');
    try { await putEmailTemplates({ reminder_enabled: next }); }
    catch (e) {
      setData((d) => (d ? { ...d, reminder_enabled: previous } : d));
      setFlagErr(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!data) return;
    setSaving(true); setErr(''); setSaved(false);
    try {
      await putEmailTemplates({
        feedback: data.feedback, reminder: data.reminder, survey: data.survey,
        // The switch already saved itself; sending it again is idempotent and
        // keeps a toggle-then-Speichern from ever disagreeing with the server.
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
    // Two different questions: which names to offer as chips, and which ones
    // render. Warning about the second using the first told admins that the
    // app's own default template would send empty values.
    // In the console's language: a German admin gets {{vorname}}, an English
    // one {{firstName}}. Both render, in either half of the mail.
    const offered = placeholdersFor(data, kind, lang);
    const known = new Set(acceptedPlaceholdersFor(data, kind));
    // The two lists are twins in the same order, so a name in the text shows
    // as its twin when the console is in the other language. An older server
    // sends no English list — then a name is shown as it is.
    const de = placeholdersFor(data, kind, 'DE');
    const en = placeholdersFor(data, kind, 'EN');
    const twin = new Map<string, string>();
    if (en !== de && en.length === de.length) {
      de.forEach((d, i) => { twin.set(d, en[i]); twin.set(en[i], d); });
    }
    const label = (name: string) => {
      const other = twin.get(name);
      if (!other) return name;
      const isDe = de.includes(name);
      return lang === 'EN' ? (isDe ? other : name) : (isDe ? name : other);
    };
    // A chip click writes {{name}} where the caret last was in THIS card —
    // or at the end of the body when no field of it has been touched yet.
    const insert = (name: string) => {
      const target = lastTemplateField && lastTemplateField.kind === kind ? lastTemplateField : null;
      const fieldKey: keyof EmailTemplate = target ? target.field : 'intro';
      const current = String(tpl[fieldKey] ?? '');
      const at = target ? target.el.selectionStart : current.length;
      const end = target ? target.el.selectionEnd : current.length;
      const next = `${current.slice(0, at)}{{${name}}}${current.slice(end)}`;
      patch(kind, { [fieldKey]: next });
      const pos = at + name.length + 4;
      const el = target?.el ?? document.querySelector<HTMLTextAreaElement>(`textarea[data-tpl-kind="${kind}"][data-tpl-field="${fieldKey}"]`);
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
    };
    const fieldProps = (field: keyof EmailTemplate) => ({ known, suggest: offered, label, kind, field });
    const unknownUsed = [tpl.subject, tpl.heading, tpl.intro, tpl.outro, tpl.headingEn ?? '', tpl.introEn ?? '', tpl.outroEn ?? '']
      .some((v) => hasUnknownPlaceholder(v, known));
    // A mail that ships with an English half is edited in both halves. The
    // survey notification goes to the commission in German only, and offering
    // it English fields would only invite a translation nobody reads.
    const bilingual = data.defaults?.[kind]?.introEn !== undefined;
    return (
      <Card testId={`tpl-editor-${kind}`}>
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
            <TemplateField value={tpl.subject} onChange={(v) => patch(kind, { subject: v })} rows={1} singleLine {...fieldProps('subject')} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplHeading}</span>
            <TemplateField value={tpl.heading} onChange={(v) => patch(kind, { heading: v })} rows={1} singleLine {...fieldProps('heading')} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplIntro}</span>
            <TemplateField value={tpl.intro} onChange={(v) => patch(kind, { intro: v })} rows={kind === 'reminder' ? 14 : 6} {...fieldProps('intro')} />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t.tplOutro}</span>
            <TemplateField value={tpl.outro} onChange={(v) => patch(kind, { outro: v })} rows={3} {...fieldProps('outro')} />
          </label>
          {bilingual && (
            <div className="pt-2 mt-1 border-t border-stone-100 space-y-2.5" data-testid={`tpl-english-${kind}`}>
              <div>
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500">{t.tplEnglish}</span>
                <span className="block text-xs text-stone-400">{t.tplEnglishHint}</span>
              </div>
              <label className="block">
                <span className={fieldLabel}>{t.tplHeadingEn}</span>
                <TemplateField value={tpl.headingEn ?? ''} onChange={(v) => patch(kind, { headingEn: v })} rows={1} singleLine {...fieldProps('headingEn')} />
              </label>
              <label className="block">
                <span className={fieldLabel}>{t.tplIntroEn}</span>
                <TemplateField value={tpl.introEn ?? ''} onChange={(v) => patch(kind, { introEn: v })} rows={kind === 'reminder' ? 14 : 6} {...fieldProps('introEn')} />
              </label>
              <label className="block">
                <span className={fieldLabel}>{t.tplOutroEn}</span>
                <TemplateField value={tpl.outroEn ?? ''} onChange={(v) => patch(kind, { outroEn: v })} rows={3} {...fieldProps('outroEn')} />
              </label>
            </div>
          )}
        </div>
        <p className="mt-3 text-[11px] text-stone-400">
          {t.tplPlaceholders}{' '}
          {/* Offered, not accepted: the aliases render but are not advertised,
              and a chip for each would double this list to no purpose. */}
          {offered.map((p) => (
            <button
              key={p} type="button"
              onMouseDown={(e) => e.preventDefault()} // keep the field's caret where it is
              onClick={() => insert(p)}
              title={`{{${p}}}`}
              className="inline-block mx-0.5 my-0.5 rounded bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-blue-700 hover:bg-blue-200"
            >{p}</button>
          ))}
        </p>
        {unknownUsed && <p className="mt-1.5 text-[11px] text-amber-600">{t.tplUnknown}</p>}
      </Card>
    );
  };

  return (
    <>
      {/* The on/off switch first, under Test-Modus; the three long editors and
          their one Save button follow. */}
      <Card>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-red-600" checked={data.reminder_enabled}
            onChange={(e) => void toggleReminder(e.target.checked)} />
          <span>
            <span className="block text-sm font-medium text-stone-700">{t.reminderEnabled}</span>
            <span className="block text-xs text-stone-400">{t.reminderEnabledHint}</span>
          </span>
        </label>
        {flagErr && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{flagErr}</p>}
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
      {editor('reminder', t.tplReminder, t.tplReminderHint)}
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
  // The 4.4.10 Rückmeldungen. Same tab, because they are the same promise from
  // the chair's side — a coach writing to her about a referee nobody observed —
  // and a separate list, because they are not notes ON an observation: these
  // games have no feedback at all, which is the point of the rule.
  const [srRows, setSrRows] = useState<RcGameNote[] | null>(null);
  const [err, setErr] = useState('');
  const [srErr, setSrErr] = useState('');

  useEffect(() => {
    listPresidentNotes().then(setRows).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // Its own error line: an empty SR list must not read as "the notes above
    // failed to load", and neither list should take the other down.
    loadRcGameNotes().then(setSrRows).catch((e) => setSrErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const fmtDate = (value: string) => {
    return dayLabel(value, { year: true }) || value;
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

      <div className="pt-2">
        <h3 className="text-sm font-semibold text-stone-800">{t.srNotes}</h3>
        <p className="text-xs text-stone-500 leading-snug mt-1">{t.srNotesHint}</p>
      </div>
      {srErr && <p className="text-sm text-red-600">{srErr}</p>}
      {!srRows && !srErr && <SkeletonRows />}
      {srRows?.length === 0 && <p className="text-sm text-stone-400 py-8 text-center">{t.srNotesEmpty}</p>}
      {srRows?.map((r) => (
        <div key={r.id} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-3 mb-3 border-b border-stone-100">
            {/* Who was observed, and in which slot — a 4.4.10 note is always
                about the OTHER whistle, so the roles are half the context. */}
            <span className="text-sm font-semibold text-stone-800">{r.coacheeName || '—'}</span>
            {r.coacheeRole && <span className="text-xs text-stone-400">{r.coacheeRole}</span>}
            {r.gameDate && <span className="text-xs text-stone-400">{fmtDate(r.gameDate)}</span>}
            {r.league && <span className="text-xs text-stone-400">{r.league}</span>}
            {r.teams && <span className="text-xs text-stone-500 truncate">{r.teams}</span>}
            <span className="ml-auto text-xs text-stone-500">{r.rcName}{r.rcRole ? ` (${r.rcRole})` : ''}</span>
          </div>
          {/* 7.3's report, arriving with the note instead of as a WhatsApp
              message somebody has to remember to send. It is the one thing on
              this card that asks her to go and do something. */}
          {r.rolesSwapped && (
            <p className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
              {t.srNotesSwapped}
            </p>
          )}
          <p data-log-redact className="text-sm text-stone-800 whitespace-pre-wrap">{r.note}</p>
        </div>
      ))}
    </div>
  );
}

// ── The forms database ────────────────────────────────────────────────
// One folder per referee, every season, every coach. Loaded the first time the
// tab is opened rather than with the console: it reads every filed feedback,
// and most sessions never come here.
// The desk layout of a filed form: date, role, game, coach, button.
// Every column fixed but the game's: each form is its own grid, so an `auto`
// button column would size per row and nudge the coach column out of line.
const FORMS_GRID = 'sm:grid-cols-[5.5rem_3rem_minmax(0,1fr)_8rem_5.5rem] sm:gap-x-4 sm:items-center';
// Field labels exist only on the phone; the desk has a header row instead.
const FORMS_LABEL = 'sm:hidden text-stone-500';

function FormsAdmin({ t, active }: { t: T; active: boolean }) {
  const [folders, setFolders] = useState<FormsFolder[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string>('');
  const [zipBusy, setZipBusy] = useState('');
  const [zipDone, setZipDone] = useState<{ key: string; n: number } | null>(null);
  const [zipErr, setZipErr] = useState('');
  const asked = useRef(false);

  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    loadFormsIndex()
      .then(setFolders)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [active]);

  // Accent-blind, like every other name lookup in the app: "Muller" finds Müller.
  const shown = useMemo(() => {
    if (!folders) return [];
    const needle = foldName(q);
    if (!needle) return folders;
    return folders.filter((f) => foldName(f.name).includes(needle) || (f.refereeId && f.refereeId.includes(needle)));
  }, [folders, q]);
  const total = useMemo(() => (folders ?? []).reduce((n, f) => n + f.forms.length, 0), [folders]);

  const zip = async (f: FormsFolder) => {
    setZipBusy(f.key); setZipErr(''); setZipDone(null);
    try {
      setZipDone({ key: f.key, n: await downloadRefereeForms(f.key) });
    } catch (e) {
      setZipErr(e instanceof Error ? e.message : String(e));
    } finally { setZipBusy(''); }
  };

  return (
    <Card testId="forms-body">
      <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.forms}</h2>
      <p className="text-xs text-stone-500 mb-3 leading-snug">{t.formsHint}</p>
      {err && <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
      {folders === null && !err && <SkeletonRows rows={4} />}
      {folders !== null && folders.length === 0 && <p className="text-sm text-stone-500">{t.formsEmpty}</p>}
      {folders !== null && folders.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
              <input
                data-testid="forms-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.formsSearch}
                className={cn(input, 'pl-8')}
              />
            </div>
            <span className="text-xs text-stone-500 tabular-nums">{t.formsPeople(folders.length)} · {t.formsCount(total)}</span>
          </div>
          {shown.length === 0 && <p className="text-sm text-stone-500">{t.formsNoMatch}</p>}
          <div className="divide-y divide-stone-100 border border-stone-200 rounded-xl overflow-hidden">
            {shown.map((f) => {
              const isOpen = open === f.key;
              return (
                <div key={f.key} data-testid="forms-folder">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? '' : f.key)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-stone-50 transition-colors"
                  >
                    <FolderOpen size={16} className={cn('shrink-0', isOpen ? 'text-red-600' : 'text-stone-400')} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold text-stone-900 truncate">{f.name || t.formsUnnamed}</span>
                      <span className="block text-xs text-stone-500 tabular-nums">
                        {t.formsCount(f.forms.length)}
                        {f.seasons.length > 0 && <> · {f.seasons.map(seasonLabel).join(', ')}</>}
                        {f.refereeId && <> · SV-Nr. {f.refereeId}</>}
                      </span>
                    </span>
                    {isOpen ? <ChevronUp size={16} className="text-stone-400 shrink-0" /> : <ChevronDown size={16} className="text-stone-400 shrink-0" />}
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 bg-stone-50/60" data-testid="forms-folder-open">
                      {/* One grid, two shapes. On a desk each form is a row and
                          the header names the columns; on a phone every field
                          gets a line of its own with its label beside it, and
                          the button closes the card — the row version crammed
                          the game into a two-word column and put the button
                          somewhere off to the right of it. */}
                      <div className={cn('hidden sm:grid text-xs text-stone-500 py-1.5', FORMS_GRID)}>
                        <span className="font-medium">{t.formsDate}</span>
                        <span className="font-medium">{t.formsRole}</span>
                        <span className="font-medium">{t.formsGame}</span>
                        <span className="font-medium">{t.formsRc}</span>
                        <span />
                      </div>
                      <div className="divide-y divide-stone-200/70">
                        {f.forms.map((e) => (
                          <div
                            key={e.id}
                            data-testid="forms-entry"
                            className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2.5 sm:py-2 text-xs items-baseline', FORMS_GRID)}
                          >
                            <span className={FORMS_LABEL}>{t.formsDate}</span>
                            <span className="whitespace-nowrap tabular-nums text-stone-800">{e.date ? dayLabel(e.date, { year: true }) : '–'}</span>
                            <span className={FORMS_LABEL}>{t.formsRole}</span>
                            <span className="whitespace-nowrap text-stone-800">{e.role}</span>
                            <span className={FORMS_LABEL}>{t.formsGame}</span>
                            <span className="text-stone-700 min-w-0">
                              {[e.league, e.matchNo ? `#${e.matchNo}` : ''].filter(Boolean).join(' · ') || '–'}
                              {(e.homeTeam || e.awayTeam) && (
                                <>
                                  <span className="hidden sm:inline"> · </span>
                                  <span className="block sm:inline">{`${e.homeTeam || '?'} – ${e.awayTeam || '?'}`}</span>
                                </>
                              )}
                            </span>
                            <span className={FORMS_LABEL}>{t.formsRc}</span>
                            <span className="text-stone-700 min-w-0 truncate">{e.rc || '–'}</span>
                            <span className="col-span-2 mt-1.5 sm:col-span-1 sm:mt-0 sm:text-right">
                              {e.file ? (
                                <a
                                  href={feedbackFileUrl(e.id)}
                                  target="_blank"
                                  rel="noopener"
                                  className={cn(btnGhost, 'w-full justify-center sm:w-auto')}
                                  data-testid="forms-open"
                                >
                                  <ExternalLink size={13} />{e.file === 'image' ? t.formsScan : t.formsOpen}
                                </a>
                              ) : (
                                <span className="text-stone-400">{t.formsNoFile}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => void zip(f)} disabled={zipBusy === f.key} className={btnPrimary} data-testid="forms-zip">
                          {zipBusy === f.key ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {zipBusy === f.key ? t.archiveBusy : t.formsFolderZip}
                        </button>
                        {zipDone?.key === f.key && <span className="text-xs text-green-700 font-medium">{t.formsFolderDone(zipDone.n)}</span>}
                        {zipErr && zipBusy === '' && <span className="text-xs text-red-700">{zipErr}</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

function ArchiveAdmin({ t, defaultSeason }: { t: T; defaultSeason: number }) {
  const [season, setSeason] = useState<number>(defaultSeason);
  const seasonTouched = useRef(false);
  useEffect(() => { if (!seasonTouched.current) setSeason(defaultSeason); }, [defaultSeason]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [err, setErr] = useState('');

  // Past seasons too: the two-year duty is about the ones already finished, so
  // offering only the current one would miss the point of the tab.
  const options = [...new Set([season, defaultSeason, defaultSeason - 1, defaultSeason - 2])].sort((a, b) => b - a);

  const run = async () => {
    setBusy(true); setErr(''); setDone(0);
    try {
      setDone(await downloadFeedbackArchive(season));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(/Keine Formulare/.test(msg) ? t.archiveEmpty : msg);
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.archive}</h2>
      <p className="text-xs text-stone-500 mb-3 leading-snug">{t.archiveHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={season}
          disabled={busy}
          onChange={(e) => { seasonTouched.current = true; setSeason(Number(e.target.value)); }}
          className="h-9 rounded-lg border border-stone-300 bg-white text-sm px-3"
        >
          {options.map((y) => <option key={y} value={y}>{seasonLabel(y)}</option>)}
        </select>
        <button onClick={() => void run()} disabled={busy} className={btnPrimary}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {busy ? t.archiveBusy : t.archiveDownload}
        </button>
        {done > 0 && <span className="text-xs text-green-700 font-medium">{t.archiveDone(done)}</span>}
      </div>
      {err && <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
    </Card>
  );
}

// One log line, shared by the live tail and the stored-history view — same
// shape, same colours, so switching between "what is happening" and "what
// happened on Tuesday" doesn't mean learning a second layout.
function LogRow({ e, expanded, onToggle, badge, actions }: {
  // This repo ships no @types/react, so `key` is not folded in for us — a
  // component used in a list has to accept it like any other prop.
  key?: string;
  e: LogEntry | StoredLogEntry;
  expanded: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="px-2.5 py-1.5 hover:bg-stone-50">
      {/* One line per entry on a desktop, two on a phone. Everything
          around the message is shrink-0, so on a narrow screen the
          message was the only thing left to squeeze: it ended up a
          column two characters wide, one letter per line. `w-full`
          drops it onto its own full-width line below the metadata
          instead, and `sm:w-auto sm:flex-1` puts the terminal-style
          single line back as soon as there is room for it. */}
      <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5 font-mono text-[11px] leading-relaxed cursor-pointer" onClick={onToggle}>
        <span className="text-stone-400 shrink-0 tabular-nums">{clockLabel(e.t, { seconds: true })}</span>
        <span className={cn('shrink-0 px-1.5 rounded border text-[10px] font-semibold uppercase', LEVEL_STYLE[e.lvl] || LEVEL_STYLE.info)}>{e.lvl}</span>
        <span className={cn('shrink-0 text-[10px] uppercase font-semibold', e.src === 'client' ? 'text-indigo-500' : 'text-stone-400')}>{e.src === 'client' ? 'app' : 'srv'}</span>
        <span className="shrink-0 text-stone-500 break-all">{e.evt}</span>
        {badge}
        <span className="order-last sm:order-none w-full sm:w-auto sm:flex-1 min-w-0 text-stone-800 break-words">{e.msg}</span>
        {personLabel(e.user) && <span className="ml-auto shrink-0 text-stone-400 truncate max-w-[45%]">{personLabel(e.user)}</span>}
      </div>
      {actions && <div className="flex flex-wrap gap-1.5 mt-1">{actions}</div>}
      {expanded && (
        <pre className="mt-1.5 p-2 rounded-lg bg-stone-900 text-stone-100 text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify({ ...e }, null, 2)}
        </pre>
      )}
    </div>
  );
}

// `/api/client-logs` takes no session — a beacon fires after logout — so the
// name in a batch is whatever the caller claimed, and the store marks one it
// cannot tie to a session as `unverified:<name>`. That belongs to the ingest,
// not to the person: reading it beside a name suggested the coach had an auth
// problem, when in truth the browser had simply shipped that batch without its
// cookie. The row shows the person; the raw value is still in the entry the
// row expands to, and still what a search for "unverified" matches.
function personLabel(user: string | undefined): string | undefined {
  return user?.replace(/^unverified:/, '') || undefined;
}

const logActionBtn = 'inline-flex items-center gap-1 h-7 px-2 rounded-md border border-stone-200 text-[11px] font-medium text-stone-600 hover:bg-stone-100 transition-colors';

// The Protokoll tab. Two views over the same store: the live ring (fast, and
// empty again after every redeploy) and the stored daily files (30 days, and
// the only place a report from yesterday can be answered).
// `mode` is owned by the console so the URL can carry it: /admin/logs/history
// is what makes "the error is under Verlauf" a linkable sentence.
function LogsAdmin({ t, lang, active, mode, onMode }: {
  t: T; lang: Lang; active: boolean; mode: 'live' | 'history'; onMode: (m: 'live' | 'history') => void;
}) {
  const setMode = onMode;
  return (
    <Card>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <h2 className="text-sm font-semibold text-stone-800 mr-auto">{t.logs}</h2>
        <div className="inline-flex rounded-lg border border-stone-200 overflow-hidden">
          {(['live', 'history'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn('h-9 px-3 text-xs font-medium transition-colors', mode === m ? 'bg-stone-800 text-white' : 'bg-white text-stone-600 hover:bg-stone-100')}
            >
              {m === 'live' ? t.logsTabLive : t.logsTabHistory}
            </button>
          ))}
        </div>
      </div>
      {mode === 'live' ? <LiveLogs t={t} active={active && mode === 'live'} /> : <LogHistory t={t} lang={lang} active={active && mode === 'history'} />}
    </Card>
  );
}

function LiveLogs({ t, active }: { t: T; active: boolean }) {
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

  const tail = useFreshest();
  const load = useCallback(async () => {
    const ticket = tail.take();
    try {
      const res = await getAdminLogs({ limit: 800, q, level, src, sid });
      // A poll started before the filter was typed answers after it, and the
      // unfiltered tail lands back on screen for three seconds.
      if (!tail.isCurrent(ticket)) return;
      setEntries(res.entries);
      setErr('');
    } catch (e) {
      if (!tail.isCurrent(ticket)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (tail.isCurrent(ticket)) setLoading(false);
    }
  }, [q, level, src, sid, tail]);

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
    <>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <p className="text-xs text-stone-500 mr-auto">{t.logsHint}</p>
        <button onClick={() => setLive((v) => !v)} className={cn('inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border transition-colors', live ? 'bg-green-50 border-green-200 text-green-700' : 'bg-stone-100 border-stone-200 text-stone-500')}>
          {live ? <Pause size={13} /> : <Play size={13} />}{t.logsLive}
        </button>
        <button onClick={copyAll} className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium border border-stone-200 text-stone-600 hover:bg-stone-100 transition-colors">
          <Copy size={13} />{copied ? t.logsCopied : t.logsCopy}
        </button>
      </div>

      <div className="flex flex-wrap gap-2 my-3">
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
              {(s.user || 'Anonym')} · {clockLabel(s.last, { seconds: true })} · {s.count}{s.errors ? ` ⚠${s.errors}` : ''}
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
            <LogRow key={e.seq} e={e} expanded={expanded === e.seq} onToggle={() => setExpanded(expanded === e.seq ? null : e.seq)} />
          ))}
        </div>
      )}
    </>
  );
}

// The stored side: the daily files, the triage that keeps them readable, and the
// same rules that decide which errors are worth an e-mail.
function LogHistory({ t, lang, active }: { t: T; lang: Lang; active: boolean }) {
  const [date, setDate] = useState('');
  const [dates, setDates] = useState<LogDay[]>([]);
  const [level, setLevel] = useState('warn');
  const [src, setSrc] = useState('');
  const [q, setQ] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [showSolved, setShowSolved] = useState(false);
  const [showMuted, setShowMuted] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof getErrorLogs>> | null>(null);
  const [rules, setRules] = useState<LogMuteRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const fresh = useFreshest();
  const load = useCallback(async () => {
    const ticket = fresh.take();
    try {
      const res = await getErrorLogs({ date, level, src, q, group: grouped, show_solved: showSolved, show_muted: showMuted, limit: grouped ? 2000 : 400 });
      if (!fresh.isCurrent(ticket)) return;
      setResult(res);
      setErr('');
    } catch (e) {
      if (!fresh.isCurrent(ticket)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (fresh.isCurrent(ticket)) setLoading(false);
    }
  }, [date, level, src, q, grouped, showSolved, showMuted, fresh]);

  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => {
    if (!active) return;
    getErrorLogDates().then((r) => setDates(r.dates)).catch(() => {});
    getLogMuteRules().then(setRules).catch(() => {});
  }, [active]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await load(); toast.success(t.logsSaved); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const annotate = (hashes: string[], status: 'open' | 'important' | 'solved') =>
    act(() => annotateLogEntries({ hashes, status, date: result?.date }));

  // Muting is by EVENT plus the first words of the message: the event alone is
  // usually too broad (every `req.out` is not the same problem), the whole
  // message too narrow (it carries ids and timings that differ every time).
  const mute = async (evt: string, msg?: string) => {
    const match = (msg || '').slice(0, 60).trim();
    if (!(await confirmDialog({ title: t.logsMuteTitle(msg ? `${evt}: ${match}` : evt), message: t.logsMuteBody, confirmLabel: t.logsMuteConfirm, tone: 'danger', lang }))) return;
    await act(async () => {
      await createLogMuteRule({ evt, match: match || undefined, note: `Admin ${dayLabel(new Date(), { year: true })}` });
      setRules(await getLogMuteRules());
    });
  };

  const groups = result?.groups || [];
  const entries = result?.entries || [];
  const hidden = result?.hidden;

  return (
    <>
      <p className="text-xs text-stone-500 mb-3">{t.logsHistoryHint}</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <select value={date} onChange={(e) => setDate(e.target.value)} className={cn(input, 'w-auto')}>
          <option value="">{t.logsDate}: {t.logsToday}</option>
          {dates.map((d) => <option key={d.date} value={d.date}>{d.date}</option>)}
        </select>
        <select value={level} onChange={(e) => setLevel(e.target.value)} className={cn(input, 'w-auto')}>
          <option value="error">error</option>
          <option value="warn">{t.logsErrorsOnly}</option>
          <option value="info">info+</option>
          <option value="debug">{t.logsAll}</option>
        </select>
        <select value={src} onChange={(e) => setSrc(e.target.value)} className={cn(input, 'w-auto')}>
          <option value="">{t.logsSource}: {t.logsAll}</option>
          <option value="server">{t.logsServer}</option>
          <option value="client">{t.logsClient}</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.logsSearch} className={cn(input, 'flex-1 min-w-[160px]')} />
        <div className="inline-flex rounded-lg border border-stone-200 overflow-hidden">
          {([true, false] as const).map((g) => (
            <button key={String(g)} onClick={() => setGrouped(g)} className={cn('h-9 px-3 text-xs font-medium transition-colors inline-flex items-center gap-1.5', grouped === g ? 'bg-stone-800 text-white' : 'bg-white text-stone-600 hover:bg-stone-100')}>
              {g ? <><Layers size={13} />{t.logsGrouped}</> : t.logsSingle}
            </button>
          ))}
        </div>
        <button onClick={() => void load()} disabled={busy} className="h-9 px-3 rounded-lg text-xs font-medium border border-stone-200 text-stone-600 hover:bg-stone-100 inline-flex items-center gap-1.5">
          <RotateCcw size={13} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-[11px] text-stone-500">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showSolved} onChange={(e) => setShowSolved(e.target.checked)} className="accent-red-600" />{t.logsShowSolved}
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showMuted} onChange={(e) => setShowMuted(e.target.checked)} className="accent-red-600" />{t.logsShowMuted}
        </label>
        <button onClick={() => setRulesOpen((v) => !v)} className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-800">
          <BellOff size={12} />{t.logsRules} ({rules.filter((r) => r.enabled).length})
        </button>
        {result && (
          <span className="ml-auto tabular-nums">
            {t.logsSummary(grouped ? groups.reduce((n, g) => n + g.count, 0) : entries.length, result.scanned)}
            {hidden && (hidden.solved || hidden.muted) ? ` · ${t.logsHiddenNote(hidden.solved, hidden.muted)}` : ''}
          </span>
        )}
      </div>

      {rulesOpen && (
        <div className="mb-3 rounded-xl border border-stone-200 divide-y divide-stone-100 bg-stone-50/60">
          {rules.length === 0 ? (
            <p className="text-xs text-stone-400 px-3 py-3">{t.logsRulesNone}</p>
          ) : rules.map((r) => (
            <div key={r.id} className="flex items-center gap-2 px-3 py-2 text-xs">
              <span className="font-mono text-stone-700 break-all">{r.evt || '*'}{r.match ? ` · "${r.match}"` : ''}</span>
              <span className="ml-auto shrink-0 text-stone-400">{r.note}</span>
              <button onClick={() => void act(async () => { await setLogMuteRuleEnabled(r.id, !r.enabled); setRules(await getLogMuteRules()); })} className={cn(logActionBtn, r.enabled ? 'text-green-700 border-green-200' : 'text-stone-400')}>
                {r.enabled ? t.logsRuleOn : t.logsRuleOff}
              </button>
              <button onClick={() => void act(async () => { await deleteLogMuteRule(r.id); setRules(await getLogMuteRules()); })} className={cn(logActionBtn, 'text-red-600 border-red-200')}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
      {loading ? <SkeletonRows rows={8} /> : (grouped ? groups.length === 0 : entries.length === 0) ? (
        <p className="text-sm text-stone-400 py-6 text-center">{t.logsEmpty}</p>
      ) : grouped ? (
        <div className="max-h-[62vh] overflow-y-auto rounded-xl border border-stone-200 divide-y divide-stone-100 bg-white">
          {groups.map((g) => (
            <div key={g.group} className="px-2.5 py-2 hover:bg-stone-50">
              <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5 font-mono text-[11px] leading-relaxed cursor-pointer" onClick={() => setExpanded(expanded === g.group ? null : g.group)}>
                <span className={cn('shrink-0 px-1.5 rounded border text-[10px] font-semibold tabular-nums', g.count > 1 ? 'bg-stone-800 text-white border-stone-800' : 'bg-stone-50 text-stone-500 border-stone-200')}>{t.logsOccurrences(g.count)}</span>
                <span className={cn('shrink-0 px-1.5 rounded border text-[10px] font-semibold uppercase', LEVEL_STYLE[g.lvl] || LEVEL_STYLE.info)}>{g.lvl}</span>
                <span className={cn('shrink-0 text-[10px] uppercase font-semibold', g.src === 'client' ? 'text-indigo-500' : 'text-stone-400')}>{g.src === 'client' ? 'app' : 'srv'}</span>
                <span className="shrink-0 text-stone-500 break-all">{g.evt}</span>
                {g.sample._muted && <span className="shrink-0 text-[10px] px-1.5 rounded border border-stone-200 text-stone-400">{t.logsMuted}</span>}
                <span className="order-last sm:order-none w-full sm:w-auto sm:flex-1 min-w-0 text-stone-800 break-words">{g.msg}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-stone-400">
                <span>{t.logsFirstLast(clockLabel(g.first, { seconds: true }), clockLabel(g.last, { seconds: true }))}</span>
                {g.users.length > 0 && <span className="truncate max-w-[50%]">{[...new Set(g.users.map((u) => personLabel(u) ?? u))].join(', ')}</span>}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <button disabled={busy} onClick={() => void annotate(g.hashes, 'solved')} className={logActionBtn}><CheckCheck size={12} />{t.logsSolveGroup}</button>
                <button disabled={busy} onClick={() => void annotate([g.sample.hash], 'important')} className={logActionBtn}><Star size={12} />{t.logsImportant}</button>
                <button disabled={busy} onClick={() => void mute(g.evt, g.msg)} className={logActionBtn}><BellOff size={12} />{t.logsMute}</button>
              </div>
              {expanded === g.group && (
                <pre className="mt-1.5 p-2 rounded-lg bg-stone-900 text-stone-100 text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(g.sample, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto rounded-xl border border-stone-200 divide-y divide-stone-100 bg-white">
          {entries.map((e) => (
            <LogRow
              key={e.hash}
              e={e}
              expanded={expanded === e.hash}
              onToggle={() => setExpanded(expanded === e.hash ? null : e.hash)}
              badge={(e._annotation || e._muted) && (
                <span className={cn('shrink-0 text-[10px] px-1.5 rounded border', e._annotation?.status === 'important' ? 'border-amber-200 text-amber-700 bg-amber-50' : 'border-stone-200 text-stone-400')}>
                  {e._muted ? t.logsMuted : t.logsAnnotated(e._annotation?.status || 'open')}
                </span>
              )}
              // Only the opened row carries buttons. With them on every line the
              // list stopped reading as a log — three buttons per entry is
              // fine for the dozen rows of the grouped view, not for 400.
              actions={expanded === e.hash && (
                <>
                  {e._annotation?.status === 'solved' ? (
                    <button disabled={busy} onClick={() => void annotate([e.hash], 'open')} className={logActionBtn}><RotateCcw size={12} />{t.logsReopen}</button>
                  ) : (
                    <button disabled={busy} onClick={() => void annotate([e.hash], 'solved')} className={logActionBtn}><Check size={12} />{t.logsSolve}</button>
                  )}
                  <button disabled={busy} onClick={() => void annotate([e.hash], 'important')} className={logActionBtn}><Star size={12} />{t.logsImportant}</button>
                  <button disabled={busy} onClick={() => void mute(e.evt, e.msg)} className={logActionBtn}><BellOff size={12} />{t.logsMute}</button>
                </>
              )}
            />
          ))}
        </div>
      )}
    </>
  );
}

// One entry in a name picker: the name that gets written onto the game, and the
// address the feedback would actually reach.
// `warn` is why picking this person will not produce a mail — everything the
// form can know before the send is attempted, said before the pick rather than
// as a 422 at the end of a filled-in feedback form.
type PickPerson = { id: string; name: string; email?: string; warn?: string; svNumber?: string };

/** A name field backed by the list of people the app knows. Typing filters it
 *  accent-blind ("Muller" finds "Müller") and every row carries the e-mail
 *  beside the name — aiming a test game at an inbox you can open is the whole
 *  reason to pick from a list instead of typing. Free text still goes through:
 *  a game may carry a referee who is nobody's coachee, and the old form could
 *  write one. */
function PersonPicker({ id, value, onChange, people, t }: {
  id: string;
  value: string;
  onChange: (name: string) => void;
  people: PickPerson[];
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // A click anywhere else closes the list. Without this it stays open on top of
  // the fields below and hides them — three fields tabbed through in a row left
  // three lists hanging over the form.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // No list means the fetch failed (or has not landed yet). The field then
  // behaves as the plain text box it used to be, rather than telling the admin
  // that every name they know is unknown.
  const hasList = people.length > 0;
  const terms = foldName(value).split(' ').filter(Boolean);
  const matches = people.filter((p) => {
    const hay = `${foldName(p.name)} ${foldName(p.email || '')}`;
    return terms.every((term) => hay.includes(term));
  });
  const shown = matches.slice(0, 50);
  const exact = people.find((p) => foldName(p.name) === foldName(value));

  // The address line, in both places it appears: under the field and on every
  // row. Grey only when this pick would actually reach somebody.
  const line = (p: PickPerson) => [p.email || t.noEmail, p.warn].filter(Boolean).join(' · ');
  const reaches = (p: PickPerson) => Boolean(p.email) && !p.warn;

  const pick = (p: PickPerson) => { onChange(p.name); setOpen(false); };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setHi(0); return; }
      setHi((i) => Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (e.key === 'Enter' && open && shown[hi]) { e.preventDefault(); pick(shown[hi]); }
  };

  return (
    <div ref={box} className="relative">
      <input
        id={id}
        className={input}
        value={value}
        placeholder={t.mgPickSearch}
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        // Tab moves focus without a click, so the pointerdown guard above never
        // fires; this is what closes the list behind a field being left.
        onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
        onKeyDown={onKey}
      />
      {open && hasList && (
        <div
          className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-lg"
          // Keeps the field focused while the list is being used — dragging its
          // scrollbar would otherwise blur the input and close what it scrolls.
          onPointerDown={(e) => e.preventDefault()}
        >
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-xs text-stone-400">{t.mgPickNone}</p>
          ) : shown.map((p, i) => (
            <button
              key={p.id}
              type="button"
              // Arrowing past the bottom of a long list has to bring the row
              // into view, or the highlight walks off screen and the list looks
              // stuck on its last visible name.
              ref={i === hi ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              // pointerdown, not click: the blur a click starts with would close
              // the list before the click itself ever lands on a row.
              onPointerDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setHi(i)}
              className={cn('w-full text-left px-3 py-1.5', i === hi && 'bg-stone-50')}
            >
              <span className="block text-sm text-stone-800 truncate">{p.name}</span>
              <span className={cn('block text-[11px] truncate', reaches(p) ? 'text-stone-400' : 'text-amber-600')}>
                {line(p)}
              </span>
            </button>
          ))}
          {matches.length > shown.length && (
            // Said out loud rather than silently truncated — a list that stops
            // at 50 without mentioning it reads as "that is all of them".
            <p className="px-3 py-1.5 text-[11px] text-stone-400">{t.mgPickMore(matches.length - shown.length)}</p>
          )}
        </div>
      )}
      {/* Under the field, the consequence of what stands in it: which address
          the feedback would reach, or that this name is nobody the app knows. */}
      {hasList && value.trim() !== '' && (
        <span className={cn('mt-0.5 block text-[11px] truncate', exact && reaches(exact) ? 'text-stone-400' : 'text-amber-600')}>
          {exact ? line(exact) : t.mgPickUnknown}
        </span>
      )}
    </div>
  );
}

/** The list the referee pickers offer: every referee in the register, with the
 *  coachees among them carrying the address the feedback would actually use.
 *
 *  Coachees are matched to the register by SV-Nr. where the import could link
 *  them, and by name where it could not — a coachee whose name answered to two
 *  referees is deliberately left unlinked, and a name is all that is left for
 *  those. Everyone else is offered too, marked: a referee who is no coachee can
 *  stand on a game, but the feedback submit refuses them, and that is worth
 *  saying before the form is filled in rather than after.
 *
 *  Coachee rows the register does not carry are appended rather than dropped —
 *  a register imported months ago is not a reason to make somebody unpickable. */
function refereeOptions(coachees: Coachee[], roster: RosterReferee[], notACoachee: string): PickPerson[] {
  const nameOf = (c: Coachee) => (c.full_name || `${c.first_name || ''} ${c.last_name || ''}`).trim();
  const best = new Map<string, Coachee>();
  for (const c of coachees) {
    const name = nameOf(c);
    if (!name) continue;
    const key = foldName(name);
    const prev = best.get(key);
    // The later season wins; at equal seasons the row that carries an address
    // does, because one without an address cannot receive the test mail at all.
    // This is the row the server's own lookup resolves a name to, so it is the
    // row whose address the picker must show.
    if (!prev
      || (c.season || 0) > (prev.season || 0)
      || ((c.season || 0) === (prev.season || 0) && !prev.email && !!c.email)) best.set(key, c);
  }

  // Two ways in, because the link is not always there: by number when the
  // import could set one, by either name order when it could not. The exports
  // disagree about which half of a name comes first — the same reason the
  // contact sync indexes both.
  const byNumber = new Map<string, Coachee>();
  const byName = new Map<string, Coachee>();
  const claimed = new Set<string>();
  for (const c of best.values()) {
    const id = c.referee_id;
    if (id) byNumber.set(String(id), c);
    const name = nameOf(c);
    byName.set(foldName(name), c);
    if (c.first_name && c.last_name) byName.set(foldName(`${c.last_name} ${c.first_name}`), c);
    else {
      const parts = foldName(name).split(' ');
      if (parts.length === 2) byName.set(`${parts[1]} ${parts[0]}`, c);
    }
  }

  const options: PickPerson[] = [];
  for (const r of roster) {
    const name = (r.name || '').trim();
    if (!name) continue;
    const parts = foldName(name).split(' ');
    const coachee = (r.id ? byNumber.get(r.id) : undefined)
      ?? byName.get(foldName(name))
      ?? (parts.length === 2 ? byName.get(`${parts[1]} ${parts[0]}`) : undefined);
    if (coachee) claimed.add(coachee.id);
    options.push({
      id: r.id ? `sv:${r.id}` : `vm:${foldName(name)}`,
      svNumber: r.id,
      name,
      // A coachee's address is the one the mail uses; the register's copy is
      // only what VolleyManager has on file for a referee nobody coaches.
      email: coachee ? coachee.email : r.email,
      warn: coachee ? undefined : notACoachee,
    });
  }
  for (const c of best.values()) {
    if (claimed.has(c.id)) continue;
    options.push({ id: c.id, svNumber: c.referee_id, name: nameOf(c), email: c.email });
  }
  return options.sort((a, b) => bySurname({ full_name: a.name }, { full_name: b.name }));
}

// Settings are fetched once by the console shell and handed down — this card
// never issues its own /api/settings request.
// Create (and delete) a one-off game. VolleyManager is the normal source; this
// covers fixtures it doesn't carry and throwaway games used to exercise the
// whole observation → PDF → e-mail flow against the real backend.
function ManualGameAdmin({ t, lang, active }: { t: T; lang: Lang; active: boolean }) {
  // The ZÜRICH day. An ISO slice is the UTC day, so between midnight and 02:00
  // the form pre-filled yesterday and the fixture was created a day early.
  const today = todayKey();
  // 20:00 is the ordinary evening kick-off; it is a field rather than a fixture
  // because a test of "the game is tomorrow" mail, or of a Saturday afternoon
  // fixture, needs its own time.
  const empty = { match_no: '', league: '', match_date: today, match_time: '20:00', location: '', home_team: '', away_team: '', first_referee: '', second_referee: '', assigned_rc: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; match_no?: string } | null>(null);
  const [err, setErr] = useState('');
  const [list, setList] = useState<ManualGame[]>([]);
  const [q, setQ] = useState('');
  const [refs, setRefs] = useState<PickPerson[]>([]);
  const [rcs, setRcs] = useState<PickPerson[]>([]);
  // Only when the referee list could not be reached — the pickers then hold the
  // coachees alone, which is a smaller list than the label promises.
  const [dirErr, setDirErr] = useState('');
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setName = (k: keyof typeof empty) => (v: string) => setF({ ...f, [k]: v });
  // The league is one string ("3L ♂"), because that is what a game carries and
  // what every reader of a league parses. The form splits it in two only to
  // offer the symbol as a choice rather than as something to be typed.
  const leagueGender = /[♂♀]/.exec(f.league)?.[0] ?? '';
  const leagueName = f.league.replace(/[♂♀]/g, '').replace(/\s+/g, ' ').trim();
  const setLeague = (name: string, gender: string) =>
    setF({ ...f, league: [name.trim(), gender].filter(Boolean).join(' ') });

  // The search reloads on every keystroke, so the answers can arrive out of
  // order; and until the first one lands there are no test games to report,
  // which is not the same as there being none.
  const games = useFreshest();
  const [listed, setListed] = useState(false);
  const reload = useCallback(async (search = '') => {
    const ticket = games.take();
    try {
      const rows = await listManualGames(search);
      if (!games.isCurrent(ticket)) return;
      setList(rows);
    } catch (e) {
      if (!games.isCurrent(ticket)) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (games.isCurrent(ticket)) setListed(true);
    }
  }, [games]);
  useEffect(() => { void reload(); }, [reload]);

  // Read once, and only once this tab is actually on screen: /api/coachees is
  // the console's most expensive read and the coachee tab already issues it on
  // mount. Neither list changes while the form is open, so a picker that
  // re-fetched per keystroke would only add latency. A list that fails to load
  // leaves the field a plain text box rather than blocking the form — typing
  // the name by hand is what this form did before.
  const [listsAsked, setListsAsked] = useState(false);
  useEffect(() => {
    if (!active || listsAsked) return;
    setListsAsked(true);
    void (async () => {
      const [cs, ps, roster] = await Promise.all([
        listCoachees().catch(() => [] as Coachee[]),
        listRefereeCoachPeople().catch(() => [] as RefereeCoachPerson[]),
        listReferees().catch((e: unknown) => ({ people: [], error: e instanceof Error ? e.message : String(e) }) as RefereeRoster),
      ]);
      setRefs(refereeOptions(cs, roster.people, t.mgPickNoCoachee));
      setRcs(ps.map((rc) => ({ id: rc.id, name: rc.fullName, email: rc.email })));
      setDirErr(roster.error || '');
    })();
  }, [active, listsAsked, t]);

  // Which SV-Nr. stands behind the name in a field, if the name came off the
  // register. Read back from the option list rather than tracked in state: the
  // field is still free text, and a name edited after being picked must not
  // keep the number of whoever was picked before it.
  const svNumberFor = (name: string) => refs.find((p) => foldName(p.name) === foldName(name))?.svNumber || '';

  const create = async () => {
    setBusy(true); setErr('');
    try {
      // Date and time go as they were typed, and the server reads them in the
      // region's clock — appending "20:00:00.000Z" here made every test game
      // start at 22:00 Swiss time in summer.
      const created = await createGame({
        ...f,
        match_time: f.match_time || '20:00',
        first_referee_id: svNumberFor(f.first_referee),
        second_referee_id: svNumberFor(f.second_referee),
      });
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
      {dirErr && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">{t.mgDirFail(dirErr)}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgDate}</span>
          <div className="flex gap-2">
            <input type="date" className={input} value={f.match_date} onChange={set('match_date')} />
            {/* Read as Swiss time, not as UTC — see the server. */}
            <input id="mg-time" type="time" className={cn(input, 'w-28 shrink-0')} value={f.match_time} onChange={set('match_time')} aria-label={t.mgTime} />
          </div></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgLeague}</span>
          <div className="flex gap-2">
            <input className={input} placeholder="3L" value={leagueName} onChange={(e) => setLeague(e.target.value, leagueGender)} />
            {/* VolleyManager writes the league with the gender on it ("3L ♂ A"),
                and everything that reads a league — the Niveau matrix, the
                filters, the mail — reads that symbol. A test game typed without
                one is a league nothing recognises. */}
            <select
              className={cn(input, 'w-16 shrink-0 cursor-pointer')}
              value={leagueGender}
              aria-label={t.mgGender}
              onChange={(e) => setLeague(leagueName, e.target.value)}
            >
              <option value="">–</option>
              <option value="♂">♂</option>
              <option value="♀">♀</option>
            </select>
          </div></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgMatchNo}</span>
          <input className={input} value={f.match_no} onChange={set('match_no')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgHome}</span>
          <input className={input} value={f.home_team} onChange={set('home_team')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgAway}</span>
          <input className={input} value={f.away_team} onChange={set('away_team')} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11px] font-semibold uppercase text-stone-500">{t.mgLocation}</span>
          <input className={input} value={f.location} onChange={set('location')} /></label>
        {/* The three name fields are pickers, not free text boxes: a feedback
            mail only has a recipient if the name matches a person the app
            knows, and the only way to see which address that is, is to have
            the list say so. */}
        <div className="flex flex-col gap-1"><label htmlFor="mg-ref1" className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRef1}</label>
          <PersonPicker id="mg-ref1" value={f.first_referee} onChange={setName('first_referee')} people={refs} t={t} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="mg-ref2" className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRef2}</label>
          <PersonPicker id="mg-ref2" value={f.second_referee} onChange={setName('second_referee')} people={refs} t={t} /></div>
        <div className="flex flex-col gap-1"><label htmlFor="mg-rc" className="text-[11px] font-semibold uppercase text-stone-500">{t.mgRc}</label>
          <PersonPicker id="mg-rc" value={f.assigned_rc} onChange={setName('assigned_rc')} people={rcs} t={t} /></div>
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
        {!listed ? (
          <SkeletonRows rows={2} />
        ) : list.length === 0 ? (
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
                    {g.match_date ? dayLabel(g.match_date, { year: true }) : ''}
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

/**
 * The SR-Börse poller, and the three numbers worth watching.
 *
 * `matchedGames` / `unmatchedOffers` answer the one question no amount of code
 * reading could: whether VolleyManager's `game.number` is formatted like our
 * `match_no`. `joinVia` says how the slot owner was identified — dominated by
 * `position+sv` is healthy, a rise in `unstaffed` or `unresolved` is not.
 *
 * The staleness test reads **lastSuccessAt**, never lastAttemptAt. A poller
 * failing every hour still stamps an attempt every hour, so a card built on that
 * stays green through exactly the outage it exists to report.
 */
function BoerseCard({ lang }: { lang: Lang }) {
  const [data, setData] = useState<BoerseSyncStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const de = lang === 'DE';

  const load = useCallback(() => {
    getBoerseStatus()
      .then((d) => setData(d && typeof d === 'object' && !Array.isArray(d) ? d : null))
      .catch(() => setData(null))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setRunning(true); setNote(''); setError('');
    try {
      const r = await runBoerseSync();
      if (!r) {
        setNote(de ? 'Läuft noch — die Uhr unten aktualisiert sich, sobald die Abfrage fertig ist.' : 'Still running — the clock below updates when the poll finishes.');
      } else if (r.skipped) {
        // The account was in somebody else's hands (the hourly poll, or the
        // games sync) — nothing was read, and nothing is wrong. The status
        // line below names who held it; this only says the tap did not run.
        setNote(de ? 'Nicht abgefragt — der VolleyManager-Zugang war gerade belegt.' : 'Not polled — the VolleyManager account was in use.');
      } else if (!r.ok) {
        setError(r.error || (de ? 'Abfrage fehlgeschlagen.' : 'Poll failed.'));
      } else {
        setNote(de
          ? `${r.offers ?? 0} Angebote (${r.open ?? 0} offen), ${r.matchedGames ?? 0} Spiele zugeordnet.`
          : `${r.offers ?? 0} offers (${r.open ?? 0} open), ${r.matchedGames ?? 0} games matched.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setRunning(false); load(); }
  };

  const st = data?.status ?? null;
  const lastGood = st?.lastSuccessAt ? new Date(st.lastSuccessAt) : null;
  // Hourly, so three missed runs is the point at which something is wrong.
  const stale = !lastGood || Number.isNaN(lastGood.getTime())
    || (Date.now() - lastGood.getTime()) / 3_600_000 > 3;
  const bad = loaded && data?.enabled !== false && (stale || (st ? !st.ok : false));
  const when = (iso?: string) => (iso ? dayTimeLabel(iso) || '–' : '–');

  return (
    <div className={cn('mb-4 rounded-lg border p-4', bad ? 'border-red-300 bg-red-50/50' : 'border-stone-200 bg-white')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-stone-800">
          {de ? 'SR-Börse' : 'SR-Börse'}
          {data?.enabled === false && (
            <span className="ml-2 rounded bg-stone-200 px-1.5 py-px text-[10px] font-bold uppercase text-stone-600">
              {de ? 'Aus' : 'Off'}
            </span>
          )}
        </h3>
        <button
          onClick={run}
          disabled={running}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-50"
        >
          {running ? (de ? 'Läuft… (~80 s)' : 'Running… (~80 s)') : (de ? 'Jetzt prüfen' : 'Check now')}
        </button>
      </div>

      {!loaded ? (
        <p className="mt-2 text-xs text-stone-400">{de ? 'Wird geladen…' : 'Loading…'}</p>
      ) : !st ? (
        <p className="mt-2 text-xs text-stone-500">{de ? 'Noch kein Lauf aufgezeichnet.' : 'No run recorded yet.'}</p>
      ) : (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-stone-400">{de ? 'Zuletzt erfolgreich' : 'Last success'}</dt>
            <dd className={cn('font-semibold', stale ? 'text-red-700' : 'text-stone-700')}>{when(st.lastSuccessAt)}</dd>
          </div>
          <div>
            <dt className="text-stone-400">{de ? 'Letzter Versuch' : 'Last attempt'}</dt>
            <dd className="text-stone-600">{when(st.lastAttemptAt)}</dd>
          </div>
          <div>
            <dt className="text-stone-400">{de ? 'Offene Angebote' : 'Open offers'}</dt>
            <dd className="font-semibold text-stone-700">{st.open ?? 0} <span className="font-normal text-stone-400">/ {data?.liveOffers ?? 0}</span></dd>
          </div>
          <div>
            <dt className="text-stone-400">{de ? 'Spiele zugeordnet' : 'Games matched'}</dt>
            <dd className="text-stone-700">{st.matchedGames ?? 0}</dd>
          </div>
          <div>
            {/* Expected to sit around 55: those are games with no coachee, which
                the nightly import never stores. A JUMP means the join broke. */}
            <dt className="text-stone-400">{de ? 'Ohne Spiel' : 'Unmatched'}</dt>
            <dd className="text-stone-700">{st.unmatchedOffers ?? 0}</dd>
          </div>
          <div>
            <dt className="text-stone-400">{de ? 'Crew korrigiert' : 'Crew corrected'}</dt>
            <dd className="text-stone-700">{st.refereesCorrected ?? 0}</dd>
          </div>
          {st.joinVia && (
            <div className="col-span-2 sm:col-span-3">
              <dt className="text-stone-400">{de ? 'Zuordnung' : 'Resolved by'}</dt>
              <dd className="font-mono text-[11px] text-stone-600">
                {Object.entries(st.joinVia).map(([k, v]) => `${k}: ${v}`).join('  ·  ')}
              </dd>
            </div>
          )}
        </dl>
      )}

      {st?.blocked && (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
          {de ? 'Zurückgehalten: ' : 'Held back: '}{st.blocked}
        </p>
      )}
      {st?.skipped && <p className="mt-2 text-[11px] text-stone-500">{de ? 'Übersprungen: ' : 'Skipped: '}{st.skipped}</p>}
      {st?.error && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-800">
          {st.error}{st.consecutiveFailures ? ` (${st.consecutiveFailures}×)` : ''}
        </p>
      )}
      {data?.accountHeldBy && (
        <p className="mt-2 text-[11px] text-stone-500">
          {de ? 'VM-Konto belegt von ' : 'VM account held by '}<span className="font-semibold">{data.accountHeldBy.label}</span>
        </p>
      )}
      {note && <p className="mt-2 text-xs text-green-700">{note}</p>}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

function GameImportCard({ lang }: { lang: Lang }) {
  const [sync, setSync] = useState<GamesSyncStatus | null>(null);
  // Whether the status has been ASKED for and answered — distinct from "there
  // is no status". Without it this card opened red on every console load,
  // saying "Status nicht abrufbar" for as long as the request took: an alarm
  // about the nightly import raised by nothing but a pending fetch.
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const de = lang === 'DE';

  const load = useCallback(() => {
    getGamesSyncStatus()
      // Anything that is not the object we expect (an array, a string) is no
      // status at all: reading .cron off it printed "schedule undefined".
      .then((s) => setSync(s && typeof s === 'object' && !Array.isArray(s) ? s : null))
      .catch(() => setSync(null))
      .finally(() => setLoaded(true));
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
  const bad = loaded && ((sync?.status ? !sync.status.ok : false) || stale);
  // Zürich, like every other clock in the app and like the alert mails.
  const when = (iso: string) => dayTimeLabel(iso) || '–';

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
          ) : loaded ? (
            <div>{de ? 'Status nicht abrufbar.' : 'Status unavailable.'}</div>
          ) : (
            <Skeleton className="h-3.5 w-64" />
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
/** One game behind a coach's counters, with everyone of theirs on it. The
 *  per-coachee summary hands a game over once per coachee, and the counters
 *  above count it once — so a game with two of the coach's coachees on the
 *  whistle is folded to one row naming both. */
type OverviewGame = {
  key: string; gameDate: string; league: string; matchNo?: string; teams: string;
  location?: string; mapsUrl?: string; result?: string; who: string[];
};

function foldOverviewGames(rows: rcCoachSummary[], pick: (r: rcCoachSummary) => rcCoachSummaryGame[]): OverviewGame[] {
  const byKey = new Map<string, OverviewGame>();
  for (const r of rows) {
    for (const g of pick(r)) {
      const key = g.gameId || `${g.gameDate}|${g.teams}`;
      const label = g.noCoachee ? '' : `${r.coacheeName}${g.refereeRole ? ` · ${g.refereeRole}` : ''}`;
      const seen = byKey.get(key);
      if (seen) {
        if (label && !seen.who.includes(label)) seen.who.push(label);
        continue;
      }
      byKey.set(key, {
        key, gameDate: g.gameDate, league: g.league, matchNo: g.matchNo, teams: g.teams,
        location: g.location, mapsUrl: g.mapsUrl, result: g.result, who: label ? [label] : [],
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.gameDate.localeCompare(b.gameDate));
}

/** What a coach's three numbers are made of, under their row. The chair read
 *  a "1" under Ausstehend and asked what it meant and where to find the game —
 *  the number was the whole answer the table had. This is the same detail the
 *  coach sees on their own Home, drawn the same way. */
function OverviewDetail({ t, lang, rcName, season }: { t: T; lang: Lang; rcName: string; season: number }) {
  const [rows, setRows] = useState<rcCoachSummary[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError('');
    loadrcCoachSummary(rcName, season)
      .then((r) => { if (!cancelled) setRows(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [rcName, season]);

  if (error) return <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>;
  if (!rows) return <div className="flex items-center gap-2 py-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /></div>;

  const outstanding = foldOverviewGames(rows, (r) => r.outstandingGames);
  const planned = foldOverviewGames(rows, (r) => r.plannedGames);
  // A filed feedback names no game id; the date and the teams are the game.
  const done = foldOverviewGames(rows, (r) => r.doneFeedbacks.map((fb) => ({
    gameId: '', gameDate: fb.gameDate, league: fb.league, teams: fb.teams,
    refereeName: r.coacheeName, refereeRole: fb.role, result: fb.result,
  })));

  const section = (title: string, hint: string, tone: RowTone, icon: React.ReactNode, games: OverviewGame[]) => (
    <div>
      <SectionHead tone={tone} icon={icon} title={title} count={games.length} />
      <p className="mt-1.5 text-xs text-stone-500">{hint}</p>
      {games.length === 0 ? (
        <p className="mt-1.5 text-xs text-stone-400">{t.ovEmpty}</p>
      ) : (
        <GameList className="mt-1">
          {games.map((g) => (
            <GameRow
              key={g.key}
              lang={lang}
              tone={tone}
              date={g.gameDate}
              league={g.league}
              matchNo={g.matchNo}
              teams={g.teams}
              location={g.location}
              mapsUrl={g.mapsUrl}
              chips={g.who.map((w) => <MetaChip key={w} tone="amber">{w}</MetaChip>)}
            />
          ))}
        </GameList>
      )}
    </div>
  );

  return (
    <div className="space-y-4 py-1">
      {section(t.ovOutstanding, t.ovOutstandingHint, 'amber', <AlertTriangle size={14} />, outstanding)}
      {section(t.ovPlanned, t.ovPlannedHint, 'sky', <CalendarDays size={14} />, planned)}
      {section(t.ovDone, t.ovDoneHint, 'emerald', <CheckCheck size={14} />, done)}
    </div>
  );
}

function OverviewAdmin({ t, lang, paidCap, season, settingsLoading, meetingDate }: { t: T; lang: Lang; paidCap: number; season: number; settingsLoading: boolean; meetingDate: string }) {
  const [rows, setRows] = useState<RcOverviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  // Fetched for the console's season, once the settings have said which one
  // — not for the calendar's guess in the meantime, which would put the
  // wrong season's counters on screen and then swap them. Asked without a
  // season at all, this table was the sum of every season ever synced: a
  // March fixture from the season before, counted as this season's
  // unfinished observation.
  useEffect(() => {
    if (settingsLoading) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    loadRcOverview(season)
      .then((r) => { if (!cancelled) setRows(Array.isArray(r) ? r : []); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [season, settingsLoading]);
  // Optimistic, with the server's answer written back over it — and rolled
  // back if the save fails, so a rejected mark never shows as recorded.
  const [paidBusy, setPaidBusy] = useState<string | null>(null);
  const [meetingBusy, setMeetingBusy] = useState<string | null>(null);
  const toggleMeeting = async (r: RcOverviewEntry) => {
    const on = !r.meetingAttended;
    setMeetingBusy(r.id);
    const previous = rows;
    setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, meetingAttended: on } : x)));
    try {
      await setRcMeeting(r.id, season, on);
      toast.success(on ? t.ovMeetingOk : t.ovMeetingOff, { lang });
    } catch (e) {
      setRows(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMeetingBusy(null);
    }
  };
  const [sheetBusy, setSheetBusy] = useState<string | null>(null);
  const downloadSheet = async (rcId: string | null) => {
    setSheetBusy(rcId ?? '*');
    try {
      if (rcId) await downloadRcExpenses(rcId, season); else await downloadAllRcExpenses(season);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSheetBusy(null);
    }
  };
  const togglePaid = async (r: RcOverviewEntry) => {
    const on = !r.paidAt;
    setPaidBusy(r.id);
    const previous = rows;
    setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, paidAt: on ? new Date().toISOString() : null } : x)));
    try {
      const saved = await setRcPaid(r.id, season, on);
      setRows((cur) => cur.map((x) => (x.id === r.id ? { ...x, paidAt: saved.paidAt, paidBy: saved.paidBy } : x)));
      toast.success(on ? t.ovPaidOk : t.ovUnpaidOk, { lang });
    } catch (e) {
      setRows(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaidBusy(null);
    }
  };

  // Infoschreiben 5.1: only what was filed in the tool gets reimbursed, so this
  // table is the claim. Semicolons and a BOM because the file is opened in a
  // German-locale Excel, where a comma-separated file lands in one column.
  const downloadCsv = () => {
    const head = [t.ovName, t.ovDone, t.ovPlanned, t.ovOutstanding, t.ovPaid, t.ovPaidCol];
    const cell = (v: string | number) => {
      const s = String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = [...rows]
      // The order the table on screen uses, so the export can be checked
      // against it line by line (it sorted by given name — Anna Zünd first).
      .sort((a, b) => bySurname({ full_name: a.fullName }, { full_name: b.fullName }))
      .map((r) => [r.fullName, r.done, r.planned, r.outstanding, Math.min(r.done, paidCap), r.paidAt ? dayLabel(r.paidAt, { year: true }) : ''].map(cell).join(';'));
    const csv = '\ufeff' + [head.map(cell).join(';'), ...body].join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    // Named by the season it settles, then the day it was drawn: the claim is
    // for one season, and a file named by date alone did not say which.
    a.download = `spesen-rc-${seasonLabel(season).replace('/', '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-stone-700">{t.overview}</h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void downloadSheet(null)} disabled={loading || rows.length === 0 || sheetBusy === '*'} title={t.ovSheetAllHint}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 transition-colors">
            {sheetBusy === '*' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {t.ovSheetAll}
          </button>
          <button onClick={downloadCsv} disabled={loading || rows.length === 0} title={t.ovCsvHint}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 transition-colors">
            <Download size={14} /> {t.ovCsv}
          </button>
        </div>
      </div>
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
              {/* Tighter on a phone: four uppercase headers at 11px with wide
                  tracking are what pushed this table past a 393px screen. */}
              <tr className="text-left text-[10px] sm:text-[11px] uppercase tracking-tight sm:tracking-wide text-stone-400 border-b border-stone-200">
                <th className="py-2 pr-1.5 sm:pr-3 font-semibold">{t.ovName}</th>
                <th className="py-2 pr-1.5 sm:pr-3 font-semibold text-right">{t.ovDone}</th>
                <th className="py-2 pr-1.5 sm:pr-3 font-semibold text-right">{t.ovPlanned}</th>
                <th className="py-2 pr-1.5 sm:pr-3 font-semibold text-right">{t.ovOutstanding}</th>
                <th className="py-2 font-semibold text-right" title={t.paidCapHint}>{t.ovPaid}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = openId === r.id;
                return (
                  <React.Fragment key={r.id}>
                    <tr className={cn('border-b border-stone-100 last:border-0 hover:bg-stone-50/70', open && 'bg-stone-50/70')}>
                      {/* The chevron lives IN the name cell, not in a column of
                          its own: on a phone the five columns fill the width
                          exactly, and a sixth pushed the table into a sideways
                          scroll with the chevron parked off-screen. */}
                      <td className="py-1 pr-2 sm:pr-3 font-medium text-stone-800 sm:whitespace-nowrap">
                        {/* A long name may wrap on a phone — the four numbers
                            beside it must stay on screen, which nowrap did not
                            allow once the chevron took its share of the line. */}
                        <button
                          type="button"
                          onClick={() => setOpenId(open ? null : r.id)}
                          aria-expanded={open}
                          title={open ? t.ovHide : t.ovShow}
                          className="inline-flex min-h-7 items-start gap-1 rounded-lg py-1 pl-0.5 pr-1.5 -ml-0.5 text-left hover:bg-stone-100"
                        >
                          {open ? <ChevronUp size={14} className="mt-[3px] text-stone-500 shrink-0" /> : <ChevronDown size={14} className="mt-[3px] text-stone-500 shrink-0" />}
                          <span>{r.fullName}</span>
                        </button>
                      </td>
                      <td className="py-2 pr-1.5 sm:pr-3 text-right text-green-700 font-semibold">{r.done}</td>
                      <td className="py-2 pr-1.5 sm:pr-3 text-right text-blue-700 font-semibold">{r.planned}</td>
                      {/* Outstanding is the number worth acting on, so it is the one that shouts. */}
                      <td className={cn('py-2 pr-1.5 sm:pr-3 text-right font-semibold', r.outstanding > 0 ? 'text-amber-700' : 'text-stone-400')} title={t.ovOutstandingHint}>{r.outstanding}</td>
                      {/* What the season actually pays. Equal to Erledigt until a
                          coach passes the ceiling, and then deliberately not. */}
                      <td className="py-2 text-right tabular-nums text-stone-600 whitespace-nowrap">
                        {Math.min(r.done, paidCap)}
                        {r.done > paidCap && <span className="text-stone-400"> / {r.done}</span>}
                        {/* The tick says the claim was settled; the action to
                            set it sits in the opened row, where there is room
                            to say when and by whom. */}
                        {r.paidAt && (
                          <Check
                            size={13}
                            aria-label={`${t.ovPaidOn} ${dayLabel(r.paidAt, { year: true })}`}
                            className="ml-1 inline-block align-[-2px] text-emerald-600"
                          />
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-stone-100 last:border-0">
                        <td colSpan={5} className="pb-3 pt-1 pl-1 pr-1 sm:pl-4">
                          {/* Outer w-0 + min-w-full: the panel fills the table
                              but never widens it — a cell's content counts toward
                              the column widths, and a chip line that does not
                              wrap was pushing the whole table past a phone's
                              edge. Inner: no wider than the screen (less the
                              page's, the card's and this cell's padding) and
                              pinned to its left edge, so when the table itself
                              is wider than the phone (it scrolls sideways
                              there) the panel is still read whole, not clipped
                              mid-word. */}
                          <div className="w-0 min-w-full">
                            <div className="sticky left-0" style={{ width: 'min(100%, calc(100vw - 4.75rem))' }}>
                              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                <span className={cn('inline-flex items-center gap-1', r.paidAt ? 'text-emerald-700' : 'text-stone-500')} title={t.ovPaidHint}>
                                  {r.paidAt ? <Check size={13} /> : <Coins size={13} />}
                                  {r.paidAt
                                    ? <>{t.ovPaidOn} {dayLabel(r.paidAt, { year: true })}{r.paidBy ? ` ${t.ovPaidBy} ${r.paidBy}` : ''}</>
                                    : `${t.ovPaid}: ${Math.min(r.done, paidCap)}`}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void togglePaid(r)}
                                  disabled={paidBusy === r.id}
                                  className={cn('h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-50',
                                    r.paidAt ? 'border-stone-200 text-stone-600 hover:bg-stone-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100')}
                                >
                                  {r.paidAt ? t.ovUnmarkPaid : t.ovMarkPaid}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void downloadSheet(r.id)}
                                  disabled={sheetBusy === r.id}
                                  title={t.ovSheetHint}
                                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
                                >
                                  {sheetBusy === r.id ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {t.ovSheet}
                                </button>
                                <label className="inline-flex items-center gap-1.5 text-xs text-stone-600" title={t.ovMeetingHint}>
                                  <input
                                    type="checkbox"
                                    checked={Boolean(r.meetingAttended)}
                                    disabled={meetingBusy === r.id}
                                    onChange={() => void toggleMeeting(r)}
                                    className="h-3.5 w-3.5 rounded border-stone-300 text-emerald-600 focus:ring-emerald-500/40"
                                  />
                                  {t.ovMeeting(meetingDate ? dayLabel(meetingDate, { year: true }) : '')}
                                </label>
                              </div>
                              <OverviewDetail t={t} lang={lang} rcName={r.fullName} season={season} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
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
function GamesAdmin({ t, lang, season, settingsLoading, active }: { t: T; lang: Lang; season: number; settingsLoading: boolean; active: boolean }) {
  const [games, setGames] = useState<EligibleGame[]>([]);
  const [people, setPeople] = useState<{ id: string; fullName: string }[]>([]);
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [q, setQ] = useState('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [showPast, setShowPast] = useState(false);
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

  // Read once, and only once this tab is actually on screen — the same deal
  // ManualGameAdmin makes, for the same reason: /api/coachees is the console's
  // most expensive read and the coachee tab already issues it on mount, so
  // asking again on every console open would double it for a tab nobody may
  // visit. NOT inside `reload` either: assigning an RC re-reads the games, and
  // the roster does not change while a coach is being picked. A list that fails
  // to load costs the amber marks and nothing else — the games still assign.
  const [coacheesAsked, setCoacheesAsked] = useState(false);
  useEffect(() => {
    if (!active || coacheesAsked) return;
    setCoacheesAsked(true);
    void listCoachees().then(setCoachees).catch(() => setCoachees([]));
  }, [active, coacheesAsked]);
  const byName = useMemo(() => coacheeIndex(coachees, season), [coachees, season]);
  const coacheeFor = (name?: string) => (name ? byName.get(foldName(name)) : undefined);

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

  // "We want this one observed." Optimistic and NOT followed by a reload: the
  // whole list is a sync away, and a star is the one edit whose result the
  // server cannot surprise us with — the button is dead for VM-flagged games,
  // which are the only ones whose effective state differs from what was asked.
  const toggleStar = async (game: EligibleGame) => {
    if (game.vmFlagged) return;
    const next = !game.starred;
    setError('');
    setGames((cur) => cur.map((x) => (x.id === game.id ? { ...x, starred: next } : x)));
    try { await setGameStarred(game.id, next); }
    catch (e) {
      setGames((cur) => cur.map((x) => (x.id === game.id ? { ...x, starred: !next } : x)));
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Folded on both sides, or a typed "Müller" would miss the folded haystack.
  const needle = foldName(q);
  const today = todayKey();
  const shown = games.filter((g) => {
    // The season on the tab, test games exempt — the same rule the coach app
    // applies to the same endpoint. Without it, last season's fixtures were
    // offered for assignment under this season's heading.
    if (!inSeasonOrManual(g, season)) return false;
    if (unassignedOnly && g.assignedRc) return false;
    // Handing out and flagging are about games still to come, so a played
    // game is off the list unless asked for — but a search looks through all
    // of them: a typed match number is a question about THAT game, wherever
    // it is. The Zürich day, so tonight's game stays listed until midnight.
    if (!showPast && !needle && dayKey(g.date) < today) return false;
    if (!needle) return true;
    // Accent-blind, like every other name match: "muller" finds "Müller".
    return [g.matchNo, g.league, g.location, g.homeTeam, g.awayTeam, g.firstReferee, g.secondReferee, g.assignedRc]
      .some((v) => foldName(v || '').includes(needle));
  // The endpoint serves newest-first, which read as "the season starts in
  // March": the first rows were the last games, and September was 300 rows
  // down and cut. Chronological — the next game is the first row.
  }).sort((a, b) => (instantOf(a.date) ?? 0) - (instantOf(b.date) ?? 0));

  // 637 rows of selects is a slow render, so the list is paged — but by a
  // button, not by the "narrow the search" the old 300-cut ended in: the rest
  // of the season is a click away, not a search away. Back to the first page
  // whenever the list is re-cut, or a narrowed search would keep the old depth.
  const PAGE = 200;
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [q, unassignedOnly, showPast, season]);

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
        <button onClick={() => setShowPast((v) => !v)} className={cn(btnGhost, showPast && 'text-red-600 border-red-200')}>
          {t.gamesPast}
        </button>
      </div>
      {/* The list is cut to a season, so the season is on the tab — and the
          list is not drawn until the settings have said which one, or it
          would flash the calendar's guess and re-cut itself a moment later. */}
      {!(loading || settingsLoading) && (
        <p className="mt-2 text-xs text-stone-400">{t.gamesCount(shown.length, seasonLabel(season))}</p>
      )}
      {loading || settingsLoading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /></div>
      ) : shown.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">{t.gamesNone}</p>
      ) : (
        <GameList className="mt-3 max-h-[70vh] overflow-y-auto">
          {shown.slice(0, limit).map((g) => (
            <GameRow
              key={g.id}
              lang={lang}
              tone={g.assignedRc ? 'emerald' : 'red'}
              date={g.date}
              league={g.league}
              home={g.homeTeam}
              away={g.awayTeam}
              location={g.location}
              status={g.assignedRc
                ? <span className="h-2.5 w-2.5 rounded-full bg-green-500" title={g.assignedRc} />
                : <span className="h-2.5 w-2.5 rounded-full bg-stone-300" title="No RC" />}
              chips={<>
                {g.matchNo && <MetaChip tone="ghost">#{g.matchNo}</MetaChip>}
                {g.isRcGame && (
                  <MetaChip
                    tone="sky"
                    title={lang === 'DE'
                      ? 'Ein Referee Coach pfeift hier neben einem Coachee.'
                      : 'A referee coach is whistling next to a coachee here.'}
                  >{lang === 'DE' ? 'RC-Spiel' : 'RC Game'}</MetaChip>
                )}
                {/* Both referees, and each saying whether this is somebody's
                    coachee and which group they are in. The row used to append
                    "· 1SR Name" to the address and stop there: the 2SR was
                    invisible, and the console — the screen an admin hands a game
                    out from — could not say which cohort the game was worth
                    handing out FOR. Which is the whole question the coach app's
                    own lists answer with the same amber chips. */}
                {([['1SR', g.firstReferee], ['2SR', g.secondReferee]] as const)
                  .filter(([, name]) => name)
                  .map(([slot, name]) => {
                    const c = coacheeFor(name);
                    const group = c ? groupLabel(c.groups, lang) : '';
                    return (
                      <MetaChip key={slot} wrap tone={c ? 'amber' : 'stone'}>
                        <span><span className="font-bold opacity-70">{slot}&nbsp;</span>{name}</span>
                        {c && <CoacheeChip />}
                        <GroupChip group={group} />
                      </MetaChip>
                    );
                  })}
              </>}
            >
              {/* Controls under the game rather than beside it: the RC picker is
                  a select, and a select squeezed into a row's right-hand gutter
                  is unusable at every width. The row itself opens nothing here,
                  so nothing interactive is nested inside anything clickable. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
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
                <button
                  // Flags coming from VolleyManager are read-only here — the
                  // marking lives in VM and comes back on the next sync.
                  disabled={g.vmFlagged}
                  onClick={() => void toggleStar(g)}
                  className={cn(
                    'h-9 px-3 text-sm font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 shrink-0',
                    g.starred ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-stone-300 bg-white text-stone-600',
                    g.vmFlagged ? 'cursor-default opacity-90' : cn('cursor-pointer', g.starred ? 'hover:bg-amber-100' : 'hover:bg-stone-50'),
                  )}
                  title={g.vmFlagged ? t.gamesFlagVmHint : t.gamesFlagHint}
                >
                  <Star size={14} className={cn(g.starred && 'fill-amber-500 text-amber-500')} />
                  {g.vmFlagged ? t.gamesFlaggedVm : g.starred ? t.gamesFlagged : t.gamesFlag}
                </button>
              </div>
            </GameRow>
          ))}
          {shown.length > limit && (
            // Said out loud rather than silently truncated: a list that stops
            // without mentioning it reads as "that is all of them".
            <div className="py-2">
              <button onClick={() => setLimit((n) => n + PAGE)} className={btnGhost}>{t.gamesMore(Math.min(PAGE, shown.length - limit))}</button>
            </div>
          )}
        </GameList>
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
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await getCredentials();
      // Defensive: every tab is mounted at once, so a malformed body here does
      // not just break this card — it throws during render and the console's
      // ErrorBoundary replaces the whole page, coachees and all.
      setSlots(Array.isArray(data?.slots) ? data.slots : []);
      if (Number.isFinite(data?.minLength)) setMinLength(data.minLength);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoaded(true); }
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
        {/* Three passwords open this app; an empty card while they load reads as
            "none configured", which is the one thing it must never say. */}
        {!loaded && <SkeletonRows rows={3} />}
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
                  : t.credChangedAt(dayLabel(slot.updatedAt ?? '', { year: true }), slot.updatedBy ?? '')}
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

// Standard-Pensum sits at the bottom of Referee Coaches: the list above shows
// each RC's own Pensum, whose placeholder is this number.
function DefaultGoalCard({ t, defaultGoal, onDefaultGoal, loading }: { t: T; defaultGoal: number; onDefaultGoal: (n: number) => Promise<void>; loading: boolean }) {
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
  return (
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
  );
}

// Under the Übersicht table whose Vergütet column it caps; the Pensum (what is
// owed) lives with the RCs — one is owed, the other is paid, and each sits
// where its number shows.
function PaidCapCard({ t, paidCap, onPaidCap, loading }: { t: T; paidCap: number; onPaidCap: (n: number) => Promise<void>; loading: boolean }) {
  const [cap, setCap] = useState<string>(String(paidCap));
  const capTouched = useRef(false);
  useEffect(() => { if (!capTouched.current) setCap(String(paidCap)); }, [paidCap]);
  const [capSaved, setCapSaved] = useState(false);
  const saveCap = async () => {
    const n = Math.round(Number(cap));
    if (!Number.isFinite(n) || n <= 0) { setCap(String(paidCap)); return; }
    await onPaidCap(n);
    setCapSaved(true); setTimeout(() => setCapSaved(false), 2500);
  };
  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.paidCap}</h2>
      <p className="text-xs text-stone-400 mb-3">{t.paidCapHint}</p>
      <div className="flex items-center gap-2">
        <input
          type="number" min={1} inputMode="numeric" disabled={loading}
          className="h-9 w-20 px-3 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500"
          value={cap}
          onChange={(e) => { capTouched.current = true; setCap(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void saveCap(); }}
        />
        <button onClick={() => void saveCap()} className={btnPrimary}><Check size={15} /> {t.save}</button>
        {capSaved && <span className="text-xs text-green-600 font-medium">{t.saved}</span>}
      </div>
    </Card>
  );
}

// Last card of Übersicht: the Spesenabrechnung is downloaded from the table
// above, and the RC-Sitzung checkbox in an opened row is labelled with the
// meeting date set here.
function ExpenseRatesCard({ t, expenseRates, onExpenseRates, loading }: { t: T; expenseRates: ExpenseRates; onExpenseRates: (r: ExpenseRates) => Promise<void>; loading: boolean }) {
  // The three expense figures, edited together and saved as one.
  const [rates, setRates] = useState({ visit: String(expenseRates.visit), meeting: String(expenseRates.meeting), meetingDate: expenseRates.meetingDate });
  const ratesTouched = useRef(false);
  useEffect(() => {
    if (!ratesTouched.current) setRates({ visit: String(expenseRates.visit), meeting: String(expenseRates.meeting), meetingDate: expenseRates.meetingDate });
  }, [expenseRates]);
  const [ratesSaved, setRatesSaved] = useState(false);
  const saveRates = async () => {
    const money = (v: string, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback; };
    await onExpenseRates({
      visit: money(rates.visit, expenseRates.visit),
      meeting: money(rates.meeting, expenseRates.meeting),
      meetingDate: /^\d{4}-\d{2}-\d{2}$/.test(rates.meetingDate) ? rates.meetingDate : '',
    });
    ratesTouched.current = false;
    setRatesSaved(true); setTimeout(() => setRatesSaved(false), 2500);
  };
  return (
    <Card>
      <h2 className="text-sm font-semibold text-stone-700 mb-1">{t.expenses}</h2>
      <p className="text-xs text-stone-400 mb-3">{t.expensesHint}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.expVisit}</span>
          <input type="number" min={0} step="0.05" inputMode="decimal" disabled={loading}
            className="h-9 w-24 px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500"
            value={rates.visit} onChange={(e) => { ratesTouched.current = true; setRates((r) => ({ ...r, visit: e.target.value })); }} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.expMeeting}</span>
          <input type="number" min={0} step="0.05" inputMode="decimal" disabled={loading}
            className="h-9 w-24 px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500"
            value={rates.meeting} onChange={(e) => { ratesTouched.current = true; setRates((r) => ({ ...r, meeting: e.target.value })); }} />
        </label>
        <label className="text-xs text-stone-500">
          <span className="block mb-0.5">{t.expMeetingDate}</span>
          <input type="date" disabled={loading}
            className="h-9 px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500"
            value={rates.meetingDate} onChange={(e) => { ratesTouched.current = true; setRates((r) => ({ ...r, meetingDate: e.target.value })); }} />
        </label>
        <button onClick={() => void saveRates()} className={btnPrimary}><Check size={15} /> {t.save}</button>
        {ratesSaved && <span className="text-xs text-green-600 font-medium">{t.saved}</span>}
      </div>
    </Card>
  );
}

// The group catalogue closes the Coachees tab: nothing but the GroupMultiSelect
// in the add form and the edit rows above reads it.
function GroupsCard({ t, lang, groups, onGroups, loading }: { t: T; lang: Lang; groups: string[]; onGroups: (g: string[]) => void; loading: boolean }) {
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
  return (
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
        {loading && groups.length === 0 && <SkeletonRows rows={3} />}
        {!loading && groups.length === 0 && <p className="py-4 text-center text-xs text-stone-400">—</p>}
      </div>
      {groupsError && <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-2">{groupsError}</p>}
    </Card>
  );
}

// The kill switch for every outgoing mail, so it heads the E-Mails tab; the
// reminder switch right below it says the test mode suppresses sending too.
// `onTestMode` is the console's own setter — the header badge reads the same
// state, so switch and badge can never disagree.
function TestModeCard({ t, testMode, onTestMode, loading }: { t: T; testMode: boolean; onTestMode: (v: boolean) => void; loading: boolean }) {
  const toggleTest = async () => { const next = !testMode; onTestMode(next); try { await putSettings({ test_mode: next }); } catch { onTestMode(!next); } };
  return (
    <Card>
      <div className="flex items-start gap-3">
        <FlaskConical size={18} className={testMode ? 'text-amber-600 mt-0.5' : 'text-stone-400 mt-0.5'} />
        <div className="flex-1"><h2 className="text-sm font-semibold text-stone-700">{t.testTitle}</h2><p className="text-xs text-stone-400">{t.testHint}</p></div>
        <button onClick={toggleTest} disabled={loading} role="switch" aria-checked={loading ? undefined : testMode} className={cn('relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors', testMode ? 'bg-amber-500' : 'bg-stone-300', loading && 'opacity-50')}><span className={`inline-block h-6 w-6 rounded-full bg-white shadow transform transition-transform mt-0.5 ${testMode ? 'translate-x-5' : 'translate-x-0.5'}`} /></button>
      </div>
      {/* Held until the setting has actually been read. `testMode` starts
          false, so this line used to announce "E-Mails werden versendet" on
          every console load — including the loads where the truth was the
          opposite. */}
      {loading
        ? <Skeleton className="mt-2 h-4 w-56" />
        : <p className={`mt-2 text-xs font-medium ${testMode ? 'text-amber-700' : 'text-green-600'}`}>{testMode ? t.testOn : t.testOff}</p>}
    </Card>
  );
}

// What is left of Einstellungen: the one setting no tab owns. Everything else
// that used to live here sits under the tab whose content it changes.
function SettingsAdmin({ t, defaultSeason, settingsLoading }: { t: T; defaultSeason: number; settingsLoading: boolean }) {
  const [season, setSeason] = useState<number>(defaultSeason);
  const seasonTouched = useRef(false);
  useEffect(() => { if (!seasonTouched.current) setSeason(defaultSeason); }, [defaultSeason]);
  const [saved, setSaved] = useState(false);
  const loading = settingsLoading;
  const save = async () => { await putSettings({ default_season: season }); setSaved(true); setTimeout(() => setSaved(false), 2500); };
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
    </>
  );
}
