import React, { useCallback, useState, useEffect, useRef, useMemo, useId } from 'react';
import { Maximize2, Download, FileJson, Video, Loader2, ArrowLeftRight, RotateCcw, ClipboardCheck, MessageSquare, Target, Info, Languages, LogOut, ShieldAlert, ChevronDown, ChevronLeft, ChevronRight, ArrowLeft, List, CalendarDays, CalendarPlus, Copy, SlidersHorizontal, Home, Navigation, Clock, MapPin, Users, Eye, Tag, Send, Upload, X, CloudOff, Star, Pencil, Lock, Mail } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { INITIAL_DATA, FeedbackFormData, AssessmentSection, Results, SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN, LEGEND, SR_ZIEL_OPTIONS, OBSERVATION_GOAL, goalForMandate, RcMandateMap, EligibleGame, RcOverviewEntry, rcCoachSummary, rcCoachSummaryGame } from './types';
import {
  CalendarGameStatus,
  Coachee,
  CoacheeGame,
  FeedbackRecord,
  hasPocketBaseConfig,
  listCoacheeFeedbacks,
  listCoacheeGames,
  listCoachees,
  loadCalendarGames,
  loadEligibleGames,
  sendGameReminder,
  getAdminAuthStatus,
  saveFeedbackToPocketBase,
  updateCoachee,
  listRefereeCoachPeople,
  assignRcToGame,
  RefereeCoachPerson,
  loadRcOverview,
  loadrcCoachSummary,
  getSettings,
  startSignature,
  getSignatureSession,
  submitSignatureSession,
  getPresidentNote,
  savePresidentNote,
  getIcalSubscription,
  settlePendingLogout,
  parkDrafts,
  listParkedDrafts,
  unparkDrafts,
  type IcalSubscription,
} from './lib/pocketbase';
import SignaturePad, { type SignaturePadHandle } from './components/SignaturePad';
import { enqueueFeedback, flushOutbox, outboxCounts, discardOutboxItem, retryOutboxItem, listOutbox, foreignOutboxSummary, type OutboxItem, type OutboxPayload, type SendResult } from './lib/offlineQueue';
import {
  draftKey, putDrafts, listDrafts, getGameDrafts, setDraftStatus, deleteDraft, pruneDrafts,
  draftStoreAvailable, requestPersistentStorage, encodeDraftFile, decodeDraftFile,
  draftFileName, resumeHint, setResumeHint, clearResumeHint,
  draftIsStale, draftAgeDays, claimDraft, releaseDraft, subscribeDraftClaims,
  DRAFT_SCHEMA, DRAFT_MAX_BYTES, type DraftRecord, type DraftFilePart, type DraftClaimNotice,
} from './lib/formDraft';
import { cn } from './lib/utils';
import { getStoredLang, setStoredLang } from './lib/prefs';
import { subscribeLive } from './lib/liveEvents';
import { domToRich, richToEditableHtml, richToPlain, richToDisplayHtml, sanitizeRich } from './lib/richText';
import { parseResult, formatResult, validateResult, findSetError, tallyFromSets, isSetComplete, isMatchDecided } from './lib/matchResult';
import { normalizeCoacheeGroup, groupLabel, splitCoacheeGroups, COACHEE_GROUP_OPTIONS } from './lib/coacheeGroup';
import { bySurname, surnameFirstLabel } from './lib/coacheeName';
import { keepGame, levelKey, levelDisplay, isTargetActive, resolveNiveauTable, type CoacheeTargetMap, type NiveauMatrix, type TargetRole } from './lib/niveauTargets';
import SvrzLogo from './SvrzLogo';
import LevelText from './components/LevelText';
import { Skeleton, SkeletonRows } from './components/Skeleton';
import AppSpinner from './components/AppSpinner';
import { useRcAuth } from './components/AuthGate';
import { isDemoMode, getSentMail, demoTips, type DemoEmail } from './lib/demo';
import { APP_VERSION, BUILD_INFO, VERSION_STAMP } from './lib/buildInfo';
import { confirmDialog, toast } from './components/ui';

// Niveau string for the feedback form / PDF: raw and truthful — "N3 - 2", "N4",
// "ITA" — never a fabricated or TBD value (the red TBD is a UI-only concept).
// Empty when unknown so a stored or manually entered value is preserved.
function metaNiveau(c?: { referee_level?: string; stage?: string } | null): string {
  if (!c) return '';
  const lvl = (c.referee_level || '').trim();
  if (!lvl) return '';
  const st = (c.stage || '').trim();
  return /^\d+$/.test(st) ? `${lvl} - ${st}` : lvl;
}

const RATINGS = ['A', 'B', 'C', 'D', 'E'];

// A/B are the two greens (exemplary → mostly exceeded), C is the neutral
// "fully achieved" standard, D/E warn and fail.
const RATING_COLORS: Record<string, string> = {
  'A': 'bg-green-400 text-white',
  'B': 'bg-green-700 text-white',
  'C': 'bg-blue-600 text-white',
  'D': 'bg-orange-500 text-white',
  'E': 'bg-red-600 text-white',
  'N/A': 'bg-stone-400 text-white',
};

// Picked option in the results row (match level, motivation, outlook, further
// visit) — the same blue as a "C", so the report reads as one scale.
const SELECTED_RESULT = 'bg-blue-600 text-white border-blue-600 font-bold';

const NA_ELIGIBLE_IDS = new Set(['1sr-lead-2', '2sr-lead-1']);

const UI_STRINGS = {
  DE: {
    title: "SR-Coaching Feedback",
    modeAdmin: "Admin",
    modeFeedback: "Feedback",
    languageToggleTitle: "Sprache wechseln",
    switchRole: "Wechseln zu",
    lists: "Listen",
    reset: "Zurücksetzen",
    pdf: "PDF / Drucken",
    json: "JSON Export",
    matchNo: "Spiel-Nr.",
    league: "Liga",
    date: "Datum",
    location: "Ort",
    teams: "Mannschaften",
    result: "Ergebnis",
    refLevel: "SR-Niveau",
    rc: "Referee Coach",
    group: "Gruppe",
    criteria: "Kriterien",
    matchLevel: "Spielniveau",
    motivation: "Motivation",
    rating: "Ausblick",
    secondVisit: "Weiterer Besuch",
    remarks: "Bemerkungen",
    refGoal: "SR-Ziel",
    easy: "Leicht",
    normal: "Normal",
    difficult: "Schwierig",
    select: "Wählen...",
    remarksPlaceholder: "Hier Feedback, Beobachtungen und Verbesserungsvorschläge eingeben...",
    highlights: "Highlights & Potenziale",
    improvements: "Bereiche / Potenzial zur Verbesserung",
    goalsNext: "Ziele für nächste Spiele",
    required: "Pflicht",
    goalPlaceholder: "Ziele werden basierend auf dem gewählten Niveau und den Bemerkungen festgelegt.",
    version: "Stand",
    versionDate: "12. März 2026",
    close: "Schliessen",
    copy: "Kopieren",
    copied: "In die Zwischenablage kopiert!",
    confirmReset: "Möchten Sie alle Daten löschen?",
    gamePool: "Spiele",
    coacheePool: "Coachees",
    loadCoachees: "Coachees laden",
    active: "Aktiv",
    inactive: "Inaktiv",
    noObservation: "Keine Beobachtung",
    plannedObservation: "Beobachtung geplant",
    uploadedObservation: "Beobachtung hochgeladen",
    furtherObservation: "Weitere Beobachtung nötig",
    openGames: "Spiele",
    openFeedback: "Feedbacks",
    coacheeGames: "Spiele für Coachee",
    calendar: "Kalender",
    feedbackHistory: "Feedback-Verlauf",
    noFeedbacks: "Keine Feedbacks gefunden.",
    noCoacheeGames: "Keine Spiele für diesen Coachee gefunden.",
    closeMenu: "Schliessen",
    noCoachees: "Keine Coachees gefunden.",
    loadGames: "Spiele laden",
    noGames: "Keine passenden Spiele gefunden.",
    selectedGame: "Ausgewähltes Spiel",
    downloadPdf: "PDF herunterladen",
    downloadEmptyForm: "Leeres Formular herunterladen",
    emptyFormChoose: "Formular wählen",
    emptyForm1SR: "1. SR",
    emptyForm2SR: "2. SR",
    emptyFormBoth: "Beide",
    saveBackend: "Bestätigen und senden",
    saveOk: "Feedback wurde gespeichert.",
    saveOkEmail: "Feedback gespeichert und E-Mail gesendet.",
    saveOkNoEmail: "Feedback gespeichert, aber E-Mail fehlgeschlagen:",
    feedbackLocked: "Feedback eingereicht",
    gameClosed: "Dieses Spiel wurde für diese Rolle bereits beobachtet",
    saveError: "Speichern fehlgeschlagen.",
    loading: "Lädt...",
    pbMissing: "VITE_POCKETBASE_URL fehlt. Bitte in .env setzen.",
    role1Short: "1SR",
    role2Short: "2SR",
    rolesLabel: "Rolle",
    rcShort: "RC",
    notes: "Notizen",
    notesPlaceholder: "Notizen zum Coachee...",
    saveNotes: "Notizen speichern",
    notesSaved: "Notizen gespeichert.",
    notesSaveError: "Notizen speichern fehlgeschlagen.",
    level: "Stufe",
    phone: "Telefon",
    emailLabel: "E-Mail",
    noNotes: "Keine Notizen vorhanden.",
    rcDone: "Erledigt",
    rcOutstanding: "Ausstehend",
    rcPlanned: "Geplant",
    rcNoData: "Keine RC-Daten gefunden.",
    rcBackToOverview: "Zurück zur Übersicht",
    rcDoneFeedbacks: "Erledigte Feedbacks",
    rcOutstandingGames: "Ausstehende Spiele",
    rcPlannedGames: "Geplante Spiele",
    rcNoFeedbacks: "Keine Feedbacks.",
    rcNoOutstanding: "Keine ausstehenden Spiele.",
    rcNoPlanned: "Keine geplanten Spiele.",
    manualUpload: "Manuelle Beobachtung hochladen",
    manualUploadTitle: "Manuelle Beobachtung",
    manualUploadFile: "Formular-Datei (PDF/Bild)",
    manualUploadSubmit: "Hochladen und senden",
    manualUploadSuccess: "Manuelle Beobachtung gespeichert und E-Mail gesendet.",
    manualUploadError: "Hochladen fehlgeschlagen.",
    manualUploadFileRequired: "Bitte Formular-Datei hochladen.",
    manualUploadFieldsMissing: "Bitte alle Pflichtfelder ausfüllen.",
    // Manual-upload form field labels (the dialog used to be hardcoded German).
    muRole: "Rolle", muMatchNo: "Spiel-Nr.", muLeague: "Liga", muDate: "Datum",
    muVenue: "Ort", muTeams: "Mannschaften",
    muResultSets: "Ergebnis (Sätze)", muResultPoints: "Ergebnis (Punkte)",
    muRefName: "SR-Name", muRefLevel: "SR-Niveau", muRc: "Referee Coach", muGroup: "Gruppe",
    muPlusMinus: "+/- Noten", muPlusMinusOn: "A+ bis E- verfügbar", muPlusMinusOff: "A bis E",
    muGameLevel: "Spielniveau", muEasy: "Leicht", muNormal: "Normal", muHard: "Schwierig",
    muMotivation: "Motivation", muOutlook: "Ausblick",
    muSecondVisit: "2. Besuch", muYes: "Ja", muNo: "Nein", muRefGoal: "SR-Ziel",
    muHighlights: "Positiv / Stärken", muImprovements: "Verbesserungspotenzial",
    muGoals: "Ziele / Nächste Schritte", muRemarks: "Bemerkungen",
    muChooseFile: "Datei wählen", muNoFile: "Keine Datei ausgewählt", muUploading: "Lädt…",
    // Entwürfe: eine angefangene Beobachtung, die auf diesem Gerät liegt.
    draftSaving: "Entwurf wird gespeichert…",
    draftSaved: "Entwurf gespeichert",
    draftSaveFailed: "Entwurf konnte nicht gespeichert werden — bitte als Datei sichern.",
    draftSaveAsFile: "Als Datei sichern",
    draftExport: "Entwurf sichern",
    draftImport: "Entwurf laden",
    draftExportOk: "Entwurf als Datei gesichert.",
    draftImportOk: "Entwurf geladen.",
    draftRestored: "Entwurf wiederhergestellt.",
    draftHeading: "Nicht abgeschlossene Beobachtung",
    draftHeadingPlural: "Nicht abgeschlossene Beobachtungen",
    draftUnsentHeading: "Nicht gesendete Beobachtung",
    draftUnsentHeadingPlural: "Nicht gesendete Beobachtungen",
    draftResume: "Weiterarbeiten",
    draftDiscard: "Verwerfen",
    draftDiscardTitle: "Entwurf verwerfen?",
    draftDiscardMsg: "Die gespeicherten Eingaben zu diesem Spiel werden gelöscht. Das lässt sich nicht rückgängig machen.",
    draftBadge: "Entwurf",
    draftUnsentBadge: "Nicht gesendet",
    draftQueued: "Wird gesendet — wartet in der Warteschlange.",
    draftFiled: "Bereits eingereicht.",
    draftRoleClosed: "Für diese Rolle wurde bereits ein Bericht eingereicht.",
    draftGameMissing: "Dieses Spiel steht gerade nicht in deiner Spielliste — der Entwurf bleibt gespeichert. Sobald die Liste wieder geladen ist, kannst du weiterarbeiten.",
    draftNoStore: "Dieses Gerät kann keine Entwürfe speichern (privater Modus?). Bitte den Entwurf als Datei sichern, bevor du die Seite schliesst.",
    draftImportBadFile: "Das ist keine SVRZ-Entwurfsdatei.",
    draftImportTooNew: "Diese Datei stammt aus einer neueren Version der App. Bitte die App aktualisieren (Seite neu laden).",
    draftImportBroken: "Die Datei ist beschädigt und konnte nicht gelesen werden.",
    draftImportTooBig: "Die Datei ist zu gross (max. 4 MB).",
    draftImportEmpty: "Dieser Entwurf enthält nichts, was geladen werden könnte.",
    draftImportReplaceTitle: "Vorhandenen Entwurf ersetzen?",
    draftScoreChanged: "Das Spiel trägt inzwischen ein anderes Resultat.",
    draftUseGameScore: "Resultat des Spiels übernehmen",
    draftOtherTab: "Diese Beobachtung ist in einem anderen Tab geöffnet. Beide Tabs speichern in denselben Entwurf — arbeite nur in einem weiter, sonst überschreibt der eine den anderen.",
    parkHint: "So geht die Beobachtung nicht verloren, wenn das Gerät kaputt geht oder verloren geht. Die Unterschriften werden mitgespeichert.",
    parkedAt: "Auf dem Server gesichert",
    sigShareLink: "Link senden",
    sigCopyLink: "Link kopieren",
    sigLinkCopied: "Link kopiert.",
    sigLinkHint: "Der Link öffnet sich auf dem Handy des Schiedsrichters. Dieses Fenster offen lassen, bis die Unterschrift da ist.",
    parkFailed: "Die Server-Sicherung hat nicht geklappt — der Entwurf ist auf diesem Gerät gespeichert.",
  },
  EN: {
    title: "Referee Coaching Feedback",
    modeAdmin: "Admin",
    modeFeedback: "Feedback",
    languageToggleTitle: "Switch language",
    switchRole: "Switch to",
    lists: "Lists",
    reset: "Reset",
    pdf: "PDF / Print",
    json: "JSON Export",
    matchNo: "Match No.",
    league: "League",
    date: "Date",
    location: "Location",
    teams: "Teams",
    result: "Result",
    refLevel: "Referee Level",
    rc: "Referee Coach",
    group: "Group",
    criteria: "Criteria",
    matchLevel: "Match Level",
    motivation: "Motivation",
    rating: "Outlook",
    secondVisit: "Further visit",
    remarks: "Remarks",
    refGoal: "Referee Goal",
    easy: "Easy",
    normal: "Normal",
    difficult: "Difficult",
    select: "Select...",
    remarksPlaceholder: "Enter feedback, observations and suggestions for improvement here...",
    highlights: "Highlights & potential",
    improvements: "Areas / potential for improvement",
    goalsNext: "Goals for next games",
    required: "required",
    goalPlaceholder: "Goals are set based on the selected level and remarks.",
    version: "Version",
    versionDate: "12 March 2026",
    close: "Close",
    copy: "Copy",
    copied: "Copied to clipboard!",
    confirmReset: "Do you want to clear all data?",
    gamePool: "Games",
    coacheePool: "Coachees",
    loadCoachees: "Load Coachees",
    active: "Active",
    inactive: "Inactive",
    noObservation: "No Observation",
    plannedObservation: "Observation Planned",
    uploadedObservation: "Observation Uploaded",
    furtherObservation: "Further Observation Needed",
    openGames: "Games",
    openFeedback: "Feedback",
    coacheeGames: "Coachee Games",
    calendar: "Calendar",
    feedbackHistory: "Feedback History",
    noFeedbacks: "No feedbacks found.",
    noCoacheeGames: "No games found for this coachee.",
    closeMenu: "Close",
    noCoachees: "No coachees found.",
    loadGames: "Load Games",
    noGames: "No matching games found.",
    selectedGame: "Selected Game",
    downloadPdf: "Download PDF",
    downloadEmptyForm: "Download empty form",
    emptyFormChoose: "Choose form",
    emptyForm1SR: "1st Ref",
    emptyForm2SR: "2nd Ref",
    emptyFormBoth: "Both",
    saveBackend: "Confirm and send",
    saveOk: "Feedback saved successfully.",
    saveOkEmail: "Feedback saved and email sent.",
    saveOkNoEmail: "Feedback saved, but email failed:",
    feedbackLocked: "Feedback submitted",
    gameClosed: "This game has already been observed for this role",
    saveError: "Saving failed.",
    loading: "Loading...",
    pbMissing: "VITE_POCKETBASE_URL is missing. Please set it in .env.",
    role1Short: "1SR",
    role2Short: "2SR",
    rolesLabel: "Role",
    rcShort: "RC",
    notes: "Notes",
    notesPlaceholder: "Notes about the coachee...",
    saveNotes: "Save Notes",
    notesSaved: "Notes saved.",
    notesSaveError: "Failed to save notes.",
    level: "Level",
    phone: "Phone",
    emailLabel: "Email",
    noNotes: "No notes yet.",
    rcDone: "Done",
    rcOutstanding: "Outstanding",
    rcPlanned: "Planned",
    rcNoData: "No RC data found.",
    rcBackToOverview: "Back to overview",
    rcDoneFeedbacks: "Done Feedbacks",
    rcOutstandingGames: "Outstanding Games",
    rcPlannedGames: "Planned Games",
    rcNoFeedbacks: "No feedbacks.",
    rcNoOutstanding: "No outstanding games.",
    rcNoPlanned: "No planned games.",
    manualUpload: "Upload manual observation",
    manualUploadTitle: "Manual Observation",
    manualUploadFile: "Form file (PDF/Image)",
    manualUploadSubmit: "Upload and send",
    manualUploadSuccess: "Manual observation saved and email sent.",
    manualUploadError: "Upload failed.",
    manualUploadFileRequired: "Please upload a form file.",
    manualUploadFieldsMissing: "Please fill in all required fields.",
    muRole: "Role", muMatchNo: "Match no.", muLeague: "League", muDate: "Date",
    muVenue: "Venue", muTeams: "Teams",
    muResultSets: "Result (sets)", muResultPoints: "Result (points)",
    muRefName: "Referee name", muRefLevel: "Referee level", muRc: "Referee coach", muGroup: "Group",
    muPlusMinus: "+/- grades", muPlusMinusOn: "A+ to E- available", muPlusMinusOff: "A to E",
    muGameLevel: "Match level", muEasy: "Easy", muNormal: "Normal", muHard: "Difficult",
    muMotivation: "Motivation", muOutlook: "Outlook",
    muSecondVisit: "2nd visit", muYes: "Yes", muNo: "No", muRefGoal: "Referee goal",
    muHighlights: "Strengths", muImprovements: "Room for improvement",
    muGoals: "Goals / next steps", muRemarks: "Remarks",
    muChooseFile: "Choose file", muNoFile: "No file selected", muUploading: "Uploading…",
    // Drafts: an observation started but not yet filed, held on this device.
    draftSaving: "Saving draft…",
    draftSaved: "Draft saved",
    draftSaveFailed: "Draft could not be saved — please save it as a file.",
    draftSaveAsFile: "Save as file",
    draftExport: "Save draft",
    draftImport: "Load draft",
    draftExportOk: "Draft saved as a file.",
    draftImportOk: "Draft loaded.",
    draftRestored: "Draft restored.",
    draftHeading: "Unfinished observation",
    draftHeadingPlural: "Unfinished observations",
    draftUnsentHeading: "Unsent observation",
    draftUnsentHeadingPlural: "Unsent observations",
    draftResume: "Resume",
    draftDiscard: "Discard",
    draftDiscardTitle: "Discard draft?",
    draftDiscardMsg: "The saved entries for this game will be deleted. This cannot be undone.",
    draftBadge: "Draft",
    draftUnsentBadge: "Not sent",
    draftQueued: "Being sent — waiting in the queue.",
    draftFiled: "Already submitted.",
    draftRoleClosed: "A report has already been filed for this role.",
    draftGameMissing: "This game is not in your games list right now — the draft is kept. You can resume once the list has loaded.",
    draftNoStore: "This device cannot store drafts (private mode?). Please save the draft as a file before you close the page.",
    draftImportBadFile: "That is not an SVRZ draft file.",
    draftImportTooNew: "This file was written by a newer version of the app. Please update the app (reload the page).",
    draftImportBroken: "The file is damaged and could not be read.",
    draftImportTooBig: "The file is too large (max 4 MB).",
    draftImportEmpty: "This draft contains nothing that could be loaded.",
    draftImportReplaceTitle: "Replace the existing draft?",
    draftScoreChanged: "The game now carries a different result.",
    draftUseGameScore: "Use the game's result",
    draftOtherTab: "This observation is open in another tab. Both tabs save into the same draft — carry on in one of them only, or one will overwrite the other.",
    parkHint: "So the observation survives a lost or broken device. The signatures are stored with it.",
    parkedAt: "Backed up on the server",
    sigShareLink: "Send link",
    sigCopyLink: "Copy link",
    sigLinkCopied: "Link copied.",
    sigLinkHint: "The link opens on the referee's phone. Keep this dialog open until the signature arrives.",
    parkFailed: "The server backup did not go through — the draft is saved on this device.",
  }
};

type FeedbackSubView = 'coachees' | 'coacheeGames' | 'calendar' | 'feedbackForm';

// ── URL routing ───────────────────────────────────────────────────────
// The hash mirrors what is on screen, so every tab is linkable, bookmarkable
// and reachable with the browser/Android Back button. `#/admin` and `#/sign/…`
// belong to other roots and are handled in main.tsx.
type AppRoute = {
  subView: FeedbackSubView;
  listTab: 'home' | 'coachees' | 'games';
  /** Whom the route is about, when it is about somebody. This is what makes a
   *  coachee's own list and a filed observation addressable: with the id in the
   *  URL the app can fetch what it needs instead of relying on a selection that
   *  only exists if you arrived from the screen before. */
  coacheeId: string | null;
  feedbackId: string | null;
};

const DEFAULT_ROUTE: AppRoute = { subView: 'coachees', listTab: 'home', coacheeId: null, feedbackId: null };

// Hashes owned by another root (main.tsx swaps the whole tree and reloads for
// these). The app must neither read nor rewrite them, or it would fight that
// router mid-navigation.
const isForeignHash = (hash: string) => /^#\/?(admin|sign|survey|guide)(\/|$)/i.test(hash);

function routeToHash(r: AppRoute): string {
  // A FILED observation has an address; one still being written does not — it
  // lives in a draft on this device and nobody else could open the link.
  if (r.subView === 'feedbackForm') {
    return r.coacheeId && r.feedbackId ? `#/feedbacks/${r.coacheeId}/${r.feedbackId}` : '#/form';
  }
  if (r.subView === 'coacheeGames') return r.coacheeId ? `#/games/${r.coacheeId}` : '#/coachees';
  if (r.subView === 'calendar') return '#/calendar';
  return `#/${r.listTab}`;
}

// `restorable` is false on a cold load: a view that only makes sense with a
// selection carried from the previous screen resolves to its parent list rather
// than to an empty shell. A route carrying an id is exempt — the id IS the
// selection, and openDeepLink fetches the rest.
function parseHash(hash: string, restorable: boolean): AppRoute {
  const path = hash.replace(/^#\/?/, '').replace(/\/+$/, '');
  const [head, ...rest] = path.split('/').map((part) => decodeURIComponent(part));
  switch (head) {
    case 'calendar': return { ...DEFAULT_ROUTE, subView: 'calendar' };
    case 'form': return restorable ? { ...DEFAULT_ROUTE, subView: 'feedbackForm' } : { ...DEFAULT_ROUTE, listTab: 'games' };
    // One noun per surface, narrowed by an id. `#/games` is every fixture;
    // `#/games/<coachee>` is that coachee's own list, which used to be
    // `#/coachee-games` and could only be reached by clicking your way to it.
    case 'games': return rest[0]
      ? { ...DEFAULT_ROUTE, subView: 'coacheeGames', coacheeId: rest[0] }
      : { ...DEFAULT_ROUTE, listTab: 'games' };
    // `#/feedbacks/<coachee>/<observation>` opens that observation. Without the
    // second id it opens the coachee's list of them, which is a modal over the
    // coachees tab and so is an entry point rather than a state we write back.
    case 'feedbacks': return rest[0]
      ? rest[1]
        ? { ...DEFAULT_ROUTE, subView: 'feedbackForm', coacheeId: rest[0], feedbackId: rest[1] }
        : { ...DEFAULT_ROUTE, listTab: 'coachees', coacheeId: rest[0] }
      : { ...DEFAULT_ROUTE, listTab: 'coachees' };
    // Written before the id was in the URL, and never emitted now. Kept so a
    // bookmark from then still lands on the coachee list instead of nowhere.
    case 'coachee-games': return restorable ? { ...DEFAULT_ROUTE, subView: 'coacheeGames' } : { ...DEFAULT_ROUTE, listTab: 'coachees' };
    case 'coachees': return { ...DEFAULT_ROUTE, listTab: 'coachees' };
    default: return DEFAULT_ROUTE;
  }
}

function getRefereeForRole(game: EligibleGame, role: FeedbackFormData['role']) {
  return role === '1. SR' ? game.firstReferee : game.secondReferee;
}

/** Function filter: both referees on the game are coachees — one trip, two
 *  observations, which is the game a coach wants to find first. */
const BOTH_SR = '1SR + 2SR';

function normName(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
}

/** Coachees are per-season rows. Everything the games list derives — is this
 *  referee a coachee, at what Niveau, in which group — has to read the row for
 *  the season on screen, or last season's people leak back onto this season's
 *  games wearing last season's badge. Rows with no season predate the field and
 *  are treated as season-agnostic. */
function isInSeason(coachee: Coachee, season: number): boolean {
  return typeof coachee.season !== 'number' || coachee.season === season;
}

function asInputDate(value: string): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  return value;
}

function formatDisplayDate(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  // dd.mm.yyyy is the Swiss convention, and it is what the filed PDF shows.
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${min}`;
}

function downloadIcal(game: EligibleGame) {
  const start = new Date(game.date);
  if (Number.isNaN(start.getTime())) return;
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // 2h match
  const fmt = (d: Date) =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const title = `${game.matchNo} ${game.homeTeam} vs ${game.awayTeam}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SVRZ RC//Referee Coaching//EN',
    'BEGIN:VEVENT',
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`,
    `LOCATION:${game.location || ''}`,
    `DESCRIPTION:${game.league}${game.firstReferee ? `\\n1SR: ${game.firstReferee}` : ''}${game.secondReferee ? `\\n2SR: ${game.secondReferee}` : ''}`,
    `UID:${game.id}@svrz-rc`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${game.matchNo || 'game'}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

function LeagueLabel({ text }: { text: string }) {
  const parts = text.split(/(♂|♀)/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part === '♂' || part === '♀' ? (
          <span key={i} className={cn("leading-none font-bold", part === '♂' ? 'text-red-500' : 'text-pink-500')}>{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** 1 → "1st", 2 → "2nd", 13 → "13th". German just counts: "2." */
function englishOrdinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** An observation an RC has already booked for a coachee: their next taken game. */
type PlannedObs = { game: EligibleGame; role: string; rc: string };

/** Referee name rendered with a clear coachee highlight (amber chip + badge).
 *  The Niveau and the group ride in the badge — the games list is where an RC
 *  decides whom to watch, and both answers ("which level is this one?", "are
 *  they up for promotion?") used to mean a trip to the Coachees tab and back.
 *  Wraps rather than overflowing: a group can be as long as "Beförderung?". */
function CoacheeName({ name, level, group }: { name: string; level?: string; group?: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-md bg-amber-100 border border-amber-300 px-1.5 py-0.5 font-bold text-amber-900">
      {name}
      <span className="rounded bg-amber-300/70 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-900">
        Coachee{level ? ` · ${level}` : ''}{group ? ` · ${group}` : ''}
      </span>
    </span>
  );
}

/** "Doppelturnhalle Feld 1, Gerlisbergstrasse 5, 8302 Kloter" → "Doppelturnhalle Feld 1, Kloter" */
function shortenLocation(loc: string): string {
  const parts = loc.split(',').map(p => p.trim());
  if (parts.length < 2) return loc;
  const hall = parts[0];
  const last = parts[parts.length - 1];
  // Strip leading ZIP (e.g. "8302 Kloter" → "Kloter")
  const city = last.replace(/^\d{4,5}\s+/, '');
  return `${hall}, ${city}`;
}

// — the current cuts are 5:43 and 6:38, and they were different before that — so
// a number here is a fact that goes quietly wrong the next time the pipeline
// runs, exactly like the tab name the narration used to quote. The player shows
// the length the moment the link opens.

function pdfFilename(formData: FeedbackFormData): string {
  const match = formData.meta.spielNr || 'feedback';
  const role = formData.role.replace('.', '').replace(/\s+/g, '');
  return `${match}-${role}.pdf`;
}

/**
 * Work worth keeping on disk. Deliberately NOT the old `formIsDirty` predicate,
 * which counted only signatures, ratings and results: a coach who had typed only
 * the score or only the Tips & Tricks box read as "clean", and both are real
 * work — the score is written onto the game when the report is filed, and the
 * tips are mailed to the referee.
 */
function draftHasWork(fd: FeedbackFormData, tips: string): boolean {
  return !!fd.signature || !!fd.rcSignature
    || fd.sections.some((s) => s.items.some((i) => !!i.rating))
    || Object.values(fd.results).some((v) => typeof v === 'string' && v.trim() !== '')
    || !!(fd.meta.ergebnis || '').trim()
    || !!tips.trim();
}

// Ratings leave the form keyed by criterion id, never by position, so a
// catalogue that gains, loses or reorders an item can never shift a stored
// draft's marks onto the wrong criterion.
function ratingsFromSections(sections: AssessmentSection[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of sections) for (const i of s.items) if (i.rating) out[i.id] = i.rating;
  return out;
}

// Every criterion id the current build knows, in either language. Handed to
// decodeDraftFile so an imported file written against a catalogue this build no
// longer recognises is rejected loudly instead of restored half-empty.
const KNOWN_RATING_IDS: string[] = [SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN]
  .flatMap((catalogue) => catalogue.flatMap((s) => s.items.map((i) => i.id)));

const signUrlFor = (slug: string) => `${window.location.origin}${window.location.pathname}#/sign/${slug}`;

// One editable surface, used both inline and in the full-screen editor.
//
// Uncontrolled on purpose: writing `value` back into the DOM on every keystroke
// puts the caret at position zero, which is the classic contenteditable bug. The
// DOM is authoritative while the field has focus, and the incoming value is only
// applied when it differs from what is already rendered.
function RichSurface({ value, onChange, placeholder, className, style, autoFocus, onFocus }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = richToEditableHtml(value);
    // Comparing against what we last emitted, not against innerHTML verbatim:
    // the browser normalises its own markup and would otherwise look changed
    // after every keystroke.
    if (domToRich(el) !== value) el.innerHTML = next;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      onFocus={onFocus}
      onInput={() => { const el = ref.current; if (el) onChange(domToRich(el)); }}
      onBlur={() => { const el = ref.current; if (el) onChange(domToRich(el)); }}
      // Paste as text, then let the toolbar add formatting: pasting from Word
      // otherwise drags in fonts, sizes and background colours that the subset
      // would drop anyway, mid-sentence and invisibly.
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }}
      className={cn('rich-surface outline-none whitespace-pre-wrap break-words', className)}
      style={style}
    />
  );
}

const RICH_COLOURS = ['#1c1917', '#b91c1c', '#b45309', '#15803d', '#1d4ed8', '#7e22ce'];

/** The formatting toolbar. execCommand is deprecated and still the only thing
 *  every browser implements for a contenteditable selection; the output is
 *  normalised by domToRich on the way out, so what it emits does not matter. */
function RichToolbar({ de, onCommand, onBullet, children }: {
  de: boolean;
  onCommand: (command: string, value?: string) => void;
  onBullet: () => void;
  children?: React.ReactNode;
}) {
  const btn = 'h-8 min-w-8 px-2 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-100 transition-colors';
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" title={de ? 'Fett' : 'Bold'} aria-label={de ? 'Fett' : 'Bold'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('bold')} className={cn(btn, 'font-bold')}>B</button>
      <button type="button" title={de ? 'Kursiv' : 'Italic'} aria-label={de ? 'Kursiv' : 'Italic'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('italic')} className={cn(btn, 'italic')}>I</button>
      <button type="button" title={de ? 'Unterstrichen' : 'Underline'} aria-label={de ? 'Unterstrichen' : 'Underline'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('underline')} className={cn(btn, 'underline')}>U</button>
      <button type="button" title={de ? 'Durchgestrichen' : 'Strikethrough'} aria-label={de ? 'Durchgestrichen' : 'Strikethrough'} onMouseDown={(e) => e.preventDefault()} onClick={() => onCommand('strikeThrough')} className={cn(btn, 'line-through')}>S</button>
      <span className="mx-0.5 h-5 w-px bg-stone-200" />
      {RICH_COLOURS.map((colour) => (
        <button
          key={colour}
          type="button"
          title={de ? 'Textfarbe' : 'Text colour'}
          aria-label={`${de ? 'Textfarbe' : 'Text colour'} ${colour}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommand('foreColor', colour)}
          className="h-6 w-6 rounded-full border border-stone-300 hover:scale-110 transition-transform"
          style={{ backgroundColor: colour }}
        />
      ))}
      <span className="mx-0.5 h-5 w-px bg-stone-200" />
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onBullet} className={btn}>• {de ? 'Aufzählung' : 'Bullet'}</button>
      {children}
    </div>
  );
}

// Long-form field: the inline box grows with its content, and the expand button
// opens a full-screen editor. On a phone the fixed 3-row box was unusable — the
// keyboard covers the page and the form scrolls away under you while typing.
// The value is the restricted HTML subset in src/lib/richText.ts — the same
// string the PDF lays out as runs and the e-mail renders.
function ExpandableTextarea({ value, onChange, label, placeholder, lang, minHeight, className }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  lang: 'DE' | 'EN';
  minHeight: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const de = lang === 'DE';
  // Plain-text bullets: renders correctly in the PDF and the e-mail as-is.
  const addBullet = () => {
    const plain = richToPlain(value);
    onChange(value ? `${value.replace(/\s+$/, '')}${plain ? '\n' : ''}• ` : '• ');
  };
  return (
    <>
      <div className="relative">
        <RichSurface
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className={cn('w-full text-xs leading-relaxed bg-white border border-stone-200 rounded p-2 pr-8', className)}
          style={{ minHeight }}
        />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="no-print absolute right-1 top-1 h-6 w-6 inline-flex items-center justify-center rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
          title={de ? 'Grösser bearbeiten' : 'Edit larger'}
          aria-label={de ? 'Grösser bearbeiten' : 'Edit larger'}
        >
          <Maximize2 size={12} />
        </button>
      </div>
      {open && (
        <div className="no-print fixed inset-0 z-50 bg-stone-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4">
          {/* A full-screen editor with no dialog role is a page a screen reader
              reads straight through, form behind and all. */}
          <div role="dialog" aria-modal="true" aria-label={label} className="bg-white w-full sm:max-w-2xl h-[92dvh] sm:h-auto sm:max-h-[85vh] rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-stone-200">
              <h3 className="text-sm font-semibold text-stone-800">{label}</h3>
              <button type="button" onClick={() => setOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label={de ? 'Schliessen' : 'Close'}>
                <X size={18} />
              </button>
            </div>
            <div className="flex items-center gap-2 px-4 py-2 border-b border-stone-100">
              <RichToolbar
                de={de}
                onCommand={(command, commandValue) => {
                  // styleWithCSS off: the browser emits <b>/<i>/<font color>
                  // rather than inline styles, which is closer to the stored
                  // subset — though domToRich normalises either way.
                  document.execCommand('styleWithCSS', false, 'false');
                  document.execCommand(command, false, commandValue);
                }}
                onBullet={addBullet}
              />
              <span className="ml-auto text-[11px] text-stone-400">{richToPlain(value).length}</span>
            </div>
            <RichSurface
              autoFocus
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              // min-height, because a div is not a textarea: flex-1 inside an
              // auto-height dialog collapses to nothing when it is empty, and
              // the writing area then sits behind the backdrop.
              className="flex-1 w-full overflow-auto px-4 py-3 text-sm leading-relaxed min-h-[45vh] sm:min-h-[280px]"
            />
            <div className="px-4 py-3 border-t border-stone-200 text-right">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-10 px-5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors"
              >
                {de ? 'Fertig' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// jsPDF, the embedded font subsets and the PDF layout only matter the moment a
// coach asks for a document, so they load on demand rather than at startup.
// Workbox precaches the chunk with everything else, so this still works offline.
const loadPdfBuilder = () => import('./lib/feedbackPdf');

/**
 * The match result the way the games list shows it: the set count, then the
 * individual set scores. One component so every list that carries a result
 * reads the same — the games list grew this look first, and copying it by hand
 * into each new list is how three of them end up subtly different.
 *
 * Renders nothing when there is no result yet, so callers can drop it into a
 * row unconditionally: most planned games have no score, and a row that
 * silently stays as it was is the point.
 */
function MatchResult({ result, className }: { result?: string; className?: string }) {
  const parsed = result ? parseResult(result) : null;
  if (!parsed || (parsed.home === '' && parsed.away === '')) return null;
  // Only completed sets: a half-entered "25:" is a score nobody can read.
  const sets = parsed.sets.filter(isSetComplete).map((s) => `${s.h}:${s.a}`);
  return (
    <span className={cn('inline-flex items-baseline gap-2 tabular-nums whitespace-nowrap', className)}>
      <span className="text-sm font-bold text-stone-600">{parsed.home}:{parsed.away}</span>
      {sets.length > 0 && <span className="text-[11px] text-stone-400">{sets.join(' | ')}</span>}
    </span>
  );
}

/**
 * The wait shown in place of a list that has not arrived — in one of two ways.
 *
 * The very first load of a session gets the branded spinner: nothing is on
 * screen yet, there is no layout to preserve, and it is the moment worth
 * making the app's own. Every load after that gets skeleton rows instead,
 * because by then the reader knows the shape of the page and wants to see it
 * coming back, not a logo where their list used to be.
 *
 * The spinner is padded to roughly the height the list occupies, so the page
 * does not jolt when the data lands.
 */
function ListLoading({
  label,
  first,
  rows = 6,
  pill = true,
  framed = false,
  className = 'py-20',
}: {
  label: string;
  /** True only while the app is still doing its one-time bootstrap. */
  first: boolean;
  rows?: number;
  pill?: boolean;
  /** Wrap the skeleton in the bordered box its list normally sits in. */
  framed?: boolean;
  className?: string;
}) {
  if (!first) {
    const skeleton = <SkeletonRows rows={rows} pill={pill} />;
    // Some of these stand in for a bordered table; the frame is part of the
    // shape being held open.
    return framed ? <div className="border border-stone-200 rounded">{skeleton}</div> : skeleton;
  }
  return (
    <div className={`flex justify-center ${className}`}>
      <AppSpinner size={132} label={label} />
    </div>
  );
}

function detectInitialLang(): FeedbackFormData['lang'] {
  // A choice made at the login screen outranks the browser's guess — that is
  // the point of putting the toggle there.
  const stored = getStoredLang();
  if (stored) return stored;
  if (typeof window === 'undefined' || !window.navigator?.language) {
    return INITIAL_DATA.lang;
  }
  return window.navigator.language.toLowerCase().startsWith('en') ? 'EN' : 'DE';
}

function localizeRuntimeError(message: string, lang: FeedbackFormData['lang']): string {
  const normalized = message.trim();
  const map: Record<string, { DE: string; EN: string }> = {
    Unauthorized: { DE: 'Nicht autorisiert.', EN: 'Unauthorized.' },
    'email and password are required.': { DE: 'E-Mail und Passwort sind erforderlich.', EN: 'Email and password are required.' },
    'Invalid credentials.': { DE: 'Ungültige Anmeldedaten.', EN: 'Invalid credentials.' },
    'gameId, role and formData are required.': { DE: 'gameId, Rolle und formData sind erforderlich.', EN: 'gameId, role and formData are required.' },
    'Set VM_USERNAME and VM_PASSWORD in environment variables.': {
      DE: 'VM_USERNAME und VM_PASSWORD müssen als Umgebungsvariablen gesetzt sein.',
      EN: 'Set VM_USERNAME and VM_PASSWORD in environment variables.',
    },
  };
  return map[normalized]?.[lang] || message;
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function DateRangeDropdown({ from, to, onChangeFrom, onChangeTo, lang }: {
  from: string;
  to: string;
  onChangeFrom: (v: string) => void;
  onChangeTo: (v: string) => void;
  lang: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasFilter = from || to;
  const today = toDateString(new Date());
  const yesterday = toDateString(new Date(Date.now() - 86400000));
  const tomorrow = toDateString(new Date(Date.now() + 86400000));
  const isDE = lang === 'DE';

  const setPreset = (f: string, t: string) => { onChangeFrom(f); onChangeTo(t); };

  let label: string;
  if (!hasFilter) {
    label = isDE ? 'Datum' : 'Date';
  } else if (from && to && from === to) {
    label = new Date(from + 'T00:00:00').toLocaleDateString(isDE ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit' });
  } else if (from && to) {
    const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(isDE ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit' });
    label = `${fmt(from)} – ${fmt(to)}`;
  } else if (from) {
    label = `${isDE ? 'ab' : 'from'} ${new Date(from + 'T00:00:00').toLocaleDateString(isDE ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit' })}`;
  } else {
    label = `${isDE ? 'bis' : 'to'} ${new Date(to + 'T00:00:00').toLocaleDateString(isDE ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit' })}`;
  }

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-medium text-stone-500 mb-0.5">
        {isDE ? 'Datum' : 'Date'}
      </label>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="h-9 w-full min-w-[120px] flex items-center justify-between gap-1 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400 text-left"
      >
        <span className="truncate text-stone-700">{label}</span>
        <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-64 bg-white border border-stone-300 rounded shadow-lg p-3">
          <div className="flex gap-1.5 mb-3">
            <button
              type="button"
              onClick={() => setPreset(yesterday, yesterday)}
              className={cn("flex-1 h-8 text-xs rounded border", from === yesterday && to === yesterday ? "bg-red-600 text-white border-red-600" : "border-stone-300 hover:bg-stone-50")}
            >
              {isDE ? 'Gestern' : 'Yesterday'}
            </button>
            <button
              type="button"
              onClick={() => setPreset(today, today)}
              className={cn("flex-1 h-8 text-xs rounded border", from === today && to === today ? "bg-red-600 text-white border-red-600" : "border-stone-300 hover:bg-stone-50")}
            >
              {isDE ? 'Heute' : 'Today'}
            </button>
            <button
              type="button"
              onClick={() => setPreset(tomorrow, tomorrow)}
              className={cn("flex-1 h-8 text-xs rounded border", from === tomorrow && to === tomorrow ? "bg-red-600 text-white border-red-600" : "border-stone-300 hover:bg-stone-50")}
            >
              {isDE ? 'Morgen' : 'Tomorrow'}
            </button>
            {hasFilter && (
              <button
                type="button"
                onClick={() => { onChangeFrom(''); onChangeTo(''); }}
                className="flex-1 h-8 text-xs rounded border border-stone-300 hover:bg-stone-50 text-stone-600"
              >
                {isDE ? 'Zurücksetzen' : 'Clear'}
              </button>
            )}
          </div>
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-stone-500 mb-0.5">{isDE ? 'Von' : 'From'}</label>
              <input
                type="date"
                value={from}
                onChange={(e) => onChangeFrom(e.target.value)}
                className="h-8 w-full px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              />
            </div>
            <div>
              <label className="block text-xs text-stone-500 mb-0.5">{isDE ? 'Bis' : 'To'}</label>
              <input
                type="date"
                value={to}
                onChange={(e) => onChangeTo(e.target.value)}
                className="h-8 w-full px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// A filter toggle. An active filter changes what the whole list shows, so it
// says so on the button and not only in the little switch inside it — the
// switch alone was a 20px colour cue on a bar of six identical white pills.
function FilterToggle({ on, onToggle, label, title, dotClass }: {
  on: boolean; onToggle: () => void; label: string; title?: string; dotClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={title}
      className={cn(
        'h-9 px-3 border rounded-md text-sm flex items-center gap-2 whitespace-nowrap transition-colors cursor-pointer select-none',
        on
          ? 'border-red-500 ring-1 ring-red-500/25 bg-red-50/60 text-red-700 font-medium'
          : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50',
      )}
    >
      <span className={cn('relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', on ? dotClass : 'bg-stone-300')}>
        <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5', on ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function MultiSelectDropdown({ options, selected, onChange, placeholder, lang, labelOf }: {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  lang: 'DE' | 'EN';
  /** How an option READS, where that differs from the value it filters on —
   *  a coachee is listed by surname but matched on the name the game carries. */
  labelOf?: (value: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="h-9 w-full flex items-center justify-between gap-1 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400 text-left"
      >
        <span className="truncate text-stone-700">
          {selected.length === 0
            ? placeholder
            : `${selected.length} ${lang === 'DE' ? 'ausgewählt' : 'selected'}`}
        </span>
        <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto bg-white border border-stone-300 rounded shadow-lg">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-sm text-stone-400 italic">{lang === 'DE' ? 'Keine Optionen' : 'No options'}</div>
          ) : options.map((opt) => (
            // A name is the whole point of the row, so it wraps rather than
            // truncating: "Dario Stefano Quattrini" cut to "Dario Stefano Qua…"
            // is indistinguishable from the next Dario. The box aligns to the
            // first line so a two-line name still reads as one option.
            <label
              key={opt}
              className="flex items-start gap-2 px-2 py-1.5 text-sm hover:bg-stone-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="h-3.5 w-3.5 mt-0.5 shrink-0 rounded border-stone-300 accent-red-600"
              />
              <span className="min-w-0 break-words">{labelOf ? labelOf(opt) : opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  // Deep link the app was opened with — read once, before the first paint, so
  // a shared/bookmarked tab renders directly instead of flashing Home first.
  const initialRoute = useRef(parseHash(window.location.hash, false)).current;
  const rcAuth = useRcAuth();
  // An admin-console session is nobody in particular: it carries no RC record,
  // so the Home tab has no dashboard to show it — only a "Willkommen." dead
  // end. Every route that would put such a session on Home puts it on the RC
  // list instead, which is the screen it came for.
  // A session with a console cookie and no RC name is not a coach, and this app
  // has nothing for it now that admin work lives entirely on the admin page.
  // Rather than inventing a landing screen, send it where it was going.
  const homelessAdmin = !rcAuth.rcName && rcAuth.isAdminSession;
  useEffect(() => {
    if (homelessAdmin) window.location.hash = '/admin';
  }, [homelessAdmin]);
  const landingTab = (tab: AppRoute['listTab']): AppRoute['listTab'] => tab;
  // Legacy in-app database panel: no control switches to it any more, so it
  // stays out of the URL scheme.
  const [feedbackSubView, setFeedbackSubView] = useState<FeedbackSubView>(initialRoute.subView);
  const [listTab, setListTab] = useState<'home' | 'coachees' | 'games'>(() => landingTab(initialRoute.listTab));
  // `doneList` powers the "already observed" list at the bottom of Home; each
  // entry keeps its coachee id so the row can open the filed feedback.
  type HomeDone = { gameDate: string; league: string; teams: string; role: string; submittedAt: string; result?: string; coacheeName: string; coacheeId: string };
  // The coach summary is per coachee, so a game with two coachees on the
  // whistle arrives twice. Home lists appointments — one row per game — and
  // carries the other referee(s) along for the subtitle. The per-coachee split
  // stays in the Coachees / RC detail views.
  /** `refs` is every coachee on the game with the slot they stand in. The merge
   *  below folds one row per referee into one row per GAME, and a bare name
   *  list could not say which of them was the 1. SR. */
  type HomeGame = rcCoachSummaryGame & { refs?: Array<{ name: string; role: string }> };
  const [homeData, setHomeData] = useState<{ done: number; planned: number; outstanding: number; nextGames: HomeGame[]; missingGames: HomeGame[]; doneList: HomeDone[] } | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [listPage, setListPage] = useState(0);
  const LIST_PAGE_SIZE = 50;
  // How many of a coachee's games the row itself lists before deferring to the
  // full per-coachee list. A referee can be down for twenty-five fixtures; the
  // row is a place to take the next one, not to read the whole season.
  const INLINE_GAME_LIMIT = 5;
  const [listSearch, setListSearch] = useState('');
  const [listFilterLevels, setListFilterLevels] = useState<string[]>([]);
  const [listFilterNeedsObs, setListFilterNeedsObs] = useState(true);
  const [listFilterShowInactive, setListFilterShowInactive] = useState(false);
  const [coacheeFiltersOpen, setCoacheeFiltersOpen] = useState(false);
  const [listSortBy, setListSortBy] = useState<'name' | 'level' | 'status'>('name');
  const [listSortAsc, setListSortAsc] = useState(true);

  // RC Overview state
  const [rcOverviewData, setRcOverviewData] = useState<RcOverviewEntry[]>([]);
  const [rcOverviewLoading, setRcOverviewLoading] = useState(false);
  const [rcDetailTab, setRcDetailTab] = useState<'planned' | 'outstanding' | 'done'>('planned');
  const [rcCoachSummaryData, setrcCoachSummaryData] = useState<rcCoachSummary[]>([]);
  const [rcCoachSummaryLoading, setrcCoachSummaryLoading] = useState(false);
  // Distinguishes a failed load from a genuinely empty season — the detail view
  // showed the same "keine RC-Daten" for both, with no way to retry.
  const [rcCoachSummaryFailed, setRcCoachSummaryFailed] = useState(false);
  // Which `${rcName}|${season}` the loaded summary belongs to — lets the Home
  // dashboard and the RC detail view share one fetch instead of racing two.
  const [rcSummaryKey, setRcSummaryKey] = useState<string | null>(null);
  const toggleListSort = (col: 'name' | 'level' | 'status') => {
    if (listSortBy === col) setListSortAsc((v) => !v);
    else { setListSortBy(col); setListSortAsc(true); }
    setListPage(0);
  };
  const [gameFilterCoachees, setGameFilterCoachees] = useState<string[]>([]);
  const [gameFilterLevels, setGameFilterLevels] = useState<string[]>([]);
  const [gameFilterLeagues, setGameFilterLeagues] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [gameFilterFunction, setGameFilterFunction] = useState<string[]>([]);
  const [gameFilterDateFrom, setGameFilterDateFrom] = useState('');
  const [gameFilterDateTo, setGameFilterDateTo] = useState('');
  // Season selector (Sep 1 -> Apr 30), persisted across reloads
  const curSeasonYear = new Date().getMonth() <= 7 ? new Date().getFullYear() - 1 : new Date().getFullYear();
  // Season pref (v3) stores {s: chosen season, d: the default it was chosen under}:
  // a new admin default (season rollover) snaps everyone forward exactly once,
  // while a deliberate past-season choice survives reloads until the next rollover.
  const [seasonStartYear, setSeasonStartYear] = useState<number>(() => {
    try {
      const v3 = JSON.parse(localStorage.getItem('svrz_season_v3') || 'null') as { s?: number } | null;
      if (v3 && Number.isFinite(v3.s)) return v3.s as number;
      const sv = localStorage.getItem('svrz_season_v2'); const n = sv ? parseInt(sv, 10) : NaN; if (Number.isFinite(n)) return n;
    } catch { /* ignore */ }
    return curSeasonYear;
  });
  const seasonFrom = `${seasonStartYear}-09-01`;
  const seasonTo = `${seasonStartYear + 1}-04-30`;
  /** Inside the season on screen — or a test game, which is exempt.
   *
   *  A season runs September to April, and a test game is usually made today,
   *  which in May–August belongs to no season at all. It then disappeared from
   *  every list while sitting in the console that had just created it. The row
   *  says "Testspiel", so showing one out of season misleads nobody. */
  const inSeasonOrManual = useCallback((g: { date?: string; isManual?: boolean }) => {
    if (g.isManual) return true;
    if (!g.date) return true;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) return true;
    return d >= new Date(seasonFrom) && d <= new Date(seasonTo + 'T23:59:59');
  }, [seasonFrom, seasonTo]);
  const [emailTestMode, setEmailTestMode] = useState(false);
  // Per-coachee level/role targets (drives "watch at their level" game filtering).
  const [coacheeTargets, setCoacheeTargets] = useState<CoacheeTargetMap>({});
  // The SR-Niveau table in force: the official one, with the admin's edits
  // (Admin → Niveau) laid over it.
  const [niveauTable, setNiveauTable] = useState<NiveauMatrix>(() => resolveNiveauTable(null));
  // Season observation goal: what a full mandate owes, halved for the RCs the
  // admin has marked as being on a half mandate.
  const [rcMandates, setRcMandates] = useState<RcMandateMap>({});
  const [defaultGoal, setDefaultGoal] = useState<number>(OBSERVATION_GOAL);
  // When true, ignore Niveau targets and show every game (escape hatch).
  const [showAllLevels, setShowAllLevels] = useState(false);
  // Read admin settings: email test-mode banner + default season + coachee targets.
  // A saved season pref older than the admin default is stale (new season started) — snap forward.
  // Part of the mount bootstrap below, not an effect of its own.
  // Resolves to the season everything else should be loaded for. The caller
  // needs that answer rather than the state setter's, because setState is not
  // visible until the next render and the bootstrap has to fire its
  // season-scoped requests now — see the mount effect.
  const loadSettings = async (): Promise<number> => {
    try {
      const s = await getSettings();
      setEmailTestMode(Boolean(s.test_mode));
      setCoacheeTargets(s.coachee_targets ?? {});
      setNiveauTable(resolveNiveauTable(s.niveau_table ?? null));
      setRcMandates(s.rc_mandates ?? {});
      if (s.default_goal) setDefaultGoal(s.default_goal);
      if (!s.default_season) return seasonStartYear;
      // The season is no longer pickable in the app — it is set once in the
      // admin console and everyone follows it. A stored preference used to win
      // here, which is how people ended up stranded in a finished 25/26.
      setSeasonStartYear(s.default_season);
      // Claim it in the same breath, so the season-change effect sees the value
      // as already loaded and stays quiet. The mount batch is about to fetch
      // this exact season; without the claim that effect fires on the state
      // change and fetches it a second time.
      loadedSeasonRef.current = s.default_season;
      try {
        localStorage.removeItem('svrz_season_v3');
        localStorage.removeItem('svrz_season_v2');
      } catch { /* storage unavailable */ }
      return s.default_season;
    } catch { /* keep the local season pref and defaults */ }
    return seasonStartYear;
  };
  const [gameViewMode, setGameViewMode] = useState<'list' | 'calendar'>('list');
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  // The coachee row whose games are unfolded underneath it.
  const [expandedCoacheeId, setExpandedCoacheeId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [gameFilterNeedsObs, setGameFilterNeedsObs] = useState(true);
  const [gameFilterShowInactive, setGameFilterShowInactive] = useState(false);
  const [gameFilterRd, setGameFilterRd] = useState(false);
  const [gameFilterRcGame, setGameFilterRcGame] = useState(false);
  const [gameFilterLd, setGameFilterLd] = useState(false);
  const [gameFilterRcAssigned, setGameFilterRcAssigned] = useState(false);
  // Show only games an admin flagged as "we'd like this one observed".
  const [gameFilterStarred, setGameFilterStarred] = useState(false);
  const [formData, setFormData] = useState<FeedbackFormData>(() => {
    const lang = detectInitialLang();
    return {
      ...INITIAL_DATA,
      lang,
      sections: lang === 'EN' ? SECTIONS_1SR_EN : SECTIONS_1SR_DE,
    };
  });
  const [dualFormData, setDualFormData] = useState<{
    '1. SR': { formData: FeedbackFormData; tipsAndTricks: string } | null;
    '2. SR': { formData: FeedbackFormData; tipsAndTricks: string } | null;
  }>({ '1. SR': null, '2. SR': null });
  // Which referee(s) of the selected game this observation covers — free choice, independent of who is a coachee
  const [observationTarget, setObservationTarget] = useState<'1SR' | '2SR' | 'both'>('1SR');
  // A score carried by the game is read-only, but correctable on request — it
  // may have been typed by the coach who filed the other referee.
  const [resultUnlocked, setResultUnlocked] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [eligibleGames, setEligibleGames] = useState<EligibleGame[]>([]);
  // Read by the live-event handler, which needs to know who held a game BEFORE
  // the pushed change without making its effect depend on the whole list — that
  // dependency would tear the stream down and rebuild it on every refresh.
  const eligibleGamesRef = useRef<EligibleGame[]>([]);
  useEffect(() => { eligibleGamesRef.current = eligibleGames; }, [eligibleGames]);
  // A pending RC assignment held back by the "already observed" notice.
  const [takeNotice, setTakeNotice] = useState<{ gameId: string; rcName: string; previousRc?: string; observed: Array<{ name: string; count: number }> } | null>(null);
  const [rcPeople, setRcPeople] = useState<RefereeCoachPerson[]>([]);
  const [calendarGames, setCalendarGames] = useState<CalendarGameStatus[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [selectedCoacheeName, setSelectedCoacheeName] = useState('');
  const [selectedCoacheeLevel, setSelectedCoacheeLevel] = useState('');
  const [selectedCoacheeId, setSelectedCoacheeId] = useState('');
  // The filed feedback record currently on screen, if any. Set when an already
  // submitted observation is reopened (or right after sending one). It is what
  // the private note to the RC president hangs off — the note belongs to a
  // feedback that exists, not to a form still being filled in — and, with the
  // coachee id beside it, what gives that observation its own URL.
  const [openFeedbackId, setOpenFeedbackId] = useState<string | null>(null);
  const [loadingGames, setLoadingGames] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [coacheeGames, setCoacheeGames] = useState<CoacheeGame[]>([]);
  const [loadingCoacheeGames, setLoadingCoacheeGames] = useState(false);
  const [loadingCoachees, setLoadingCoachees] = useState(false);
  // True until the one parallel first-run batch below settles. While it is up,
  // lists render skeletons instead of their "nothing found" empty states.
  const [booting, setBooting] = useState(true);
  // Whose details are open is not a second piece of state: it is whichever row
  // is expanded. Read out of `coachees` rather than stashed, so a saved note is
  // on screen the moment the list has it.
  const detailCoachee = useMemo(
    () => coachees.find((c) => c.id === expandedCoacheeId) ?? null,
    [coachees, expandedCoacheeId],
  );
  const [detailNotes, setDetailNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [feedbackPickerCoachee, setFeedbackPickerCoachee] = useState<Coachee | null>(null);
  const [coacheeFeedbacks, setCoacheeFeedbacks] = useState<FeedbackRecord[]>([]);
  const [loadingCoacheeFeedbacks, setLoadingCoacheeFeedbacks] = useState(false);
  const [showAllPastGames, setShowAllPastGames] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' && !navigator.onLine);
  const [outboxPending, setOutboxPending] = useState(0);
  // Queued by a DIFFERENT coach on this device — see foreignOutboxSummary.
  const [outboxForeign, setOutboxForeign] = useState<{ ownerId: string; count: number }[]>([]);
  const [outboxFailed, setOutboxFailed] = useState<OutboxItem[]>([]);
  const [flushing, setFlushing] = useState(false);
  // Unfinished observations held on this device, for THIS coach only.
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  // False where the device refuses to persist at all (private browsing, blocked
  // IndexedDB). Then the exported file is the only durable copy there is, and
  // the UI has to say so instead of quietly saving nothing.
  const [draftStoreOk, setDraftStoreOk] = useState(true);
  const [draftUnsaved, setDraftUnsaved] = useState(false);
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState(0);
  // The game's own score, when a resumed draft disagrees with it. Filing writes
  // the form's score onto the game, so a stale draft must not do that silently.
  const [draftScoreConflict, setDraftScoreConflict] = useState('');
  // Another tab of this browser is on the same observation. Advisory only — it
  // never blocks the form, because a lock that strands work is worse than the
  // overwrite it prevents.
  const [draftClaimedElsewhere, setDraftClaimedElsewhere] = useState(false);
  const [parkFailed, setParkFailed] = useState(false);
  const [parkedOk, setParkedOk] = useState(false);
  const [backendNotice, setBackendNotice] = useState('');
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  // Admin via the admin-console session or the in-app database login: keeps
  // the unrestricted RC picker and may open any RC's detail. Plain RC sessions
  // act only as themselves (the server enforces this too).
  const isPrivileged = rcAuth.isAdminSession || adminAuthenticated;
  // How many tabs the nav actually renders: Home drops out for a session with no
  // dashboard, Referee Coaches for one with no admin rights. An odd count leaves
  // the last tile alone on the second mobile row, so it takes the full width.
  // Three tabs in a two-column grid on a phone leaves the last one alone on its
  // row; it spans the width instead of sitting half-empty.
  const oddTabOut = 'max-sm:col-span-2';
  // Identity that owns any outbox item created now — a queued submission is only
  // ever sent back under this same identity, never a different coach's.
  const outboxOwnerId = rcAuth.rcId || (isPrivileged ? 'admin' : 'anon');
  const [showEmptyFormModal, setShowEmptyFormModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [icalInfo, setIcalInfo] = useState<IcalSubscription | null>(null);
  const [icalError, setIcalError] = useState('');
  const [icalCopied, setIcalCopied] = useState(false);
  // Fetched when the dialog opens rather than on load — nobody pays for a
  // feature they never open. Re-runs on a language switch because the event
  // texts inside the feed follow the language the link was taken in.
  useEffect(() => {
    if (!showCalendarModal) return;
    let cancelled = false;
    setIcalError('');
    getIcalSubscription(formData.lang)
      .then(info => { if (!cancelled) setIcalInfo(info); })
      .catch(err => { if (!cancelled) setIcalError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [showCalendarModal, formData.lang]);
  // Mints a new token and drops the old one. The confirm dialog is not
  // ceremony: the links already handed out are in other people's calendar apps,
  // and those simply stop updating with no error anyone will notice.
  const [icalRotating, setIcalRotating] = useState(false);
  const regenerateIcalUrl = async () => {
    const de = formData.lang === 'DE';
    const ok = await confirmDialog({
      title: de ? 'Neuen Link erzeugen?' : 'Generate a new link?',
      message: de
        ? 'Der bisherige Link hört auf zu funktionieren — Kalender, die ihn abonniert haben, aktualisieren sich nicht mehr und müssen neu abonniert werden.'
        : 'The current one stops working — calendars subscribed to it will no longer update and have to subscribe again.',
      confirmLabel: de ? 'Neu erzeugen' : 'Regenerate',
      cancelLabel: de ? 'Abbrechen' : 'Cancel',
      tone: 'danger',
      lang: formData.lang,
    });
    if (!ok) return;
    setIcalRotating(true);
    setIcalError('');
    try {
      setIcalInfo(await getIcalSubscription(formData.lang, true));
      toast.success(de ? 'Neuer Kalender-Link erzeugt.' : 'New calendar link generated.', { lang: formData.lang });
    } catch (err) {
      // The error stays inline under the field — toasting it too would say the
      // same thing twice.
      setIcalError(err instanceof Error ? err.message : String(err));
    } finally {
      setIcalRotating(false);
    }
  };
  const copyIcalUrl = async () => {
    if (!icalInfo) return;
    try {
      await navigator.clipboard.writeText(icalInfo.url);
      setIcalCopied(true);
      window.setTimeout(() => setIcalCopied(false), 2000);
    } catch {
      // Clipboard access denied (or no secure context). The URL sits in a
      // selectable field right there, so there is nothing to recover from.
    }
  };
  const [sigModalOpen, setSigModalOpen] = useState(false);
  const [sigSlug, setSigSlug] = useState('');
  const [sigError, setSigError] = useState('');
  // Which of the two signatures the open modal is collecting. The referee signs
  // to acknowledge the discussion, the coach for what the form says; both use
  // the same pad and the same QR hand-off to a phone.
  const [sigTarget, setSigTarget] = useState<'referee' | 'rc'>('referee');
  /** Bumped by updateSignature; see the comment there for why a token and not a
   *  direct call. Batched with the form update, so the effect that watches it
   *  runs on the commit that contains the signature. */
  const [sigFlushToken, setSigFlushToken] = useState(0);
  const sigPadRef = useRef<SignaturePadHandle>(null);
  const sigSignerName = (target: 'referee' | 'rc') =>
    target === 'rc' ? (formData.meta.rc || '') : formData.meta.srName;
  const updateSignature = (data: string, target: 'referee' | 'rc' = sigTarget) => {
    setFormData(prev => (target === 'rc' ? { ...prev, rcSignature: data } : { ...prev, signature: data }));
    // The coach signs the visit, not one of its forms. On a game where both
    // referees are coachees that is one person signing once, not the same
    // signature collected twice — so it reaches the other role's form too.
    if (target === 'rc') {
      setDualFormData(prev => ({
        '1. SR': prev['1. SR'] ? { ...prev['1. SR'], formData: { ...prev['1. SR'].formData, rcSignature: data } } : null,
        '2. SR': prev['2. SR'] ? { ...prev['2. SR'], formData: { ...prev['2. SR'].formData, rcSignature: data } } : null,
      }));
    }
    // A captured signature cannot be retyped — it must not sit in a debounce
    // window waiting for the next keystroke that may never come, and it is the
    // one thing a lost device makes genuinely unrecoverable.
    //
    // Bumped, not called: the flush refs are assigned during RENDER, so calling
    // them here would commit the form exactly as it was BEFORE the signature —
    // React does not apply a setState synchronously inside an event handler.
    // The effect below runs on the render that actually carries the ink.
    setSigFlushToken((n) => n + 1);
  };

  const canShareLink = typeof navigator !== 'undefined' && !!navigator.share;
  /**
   * Hand the signing link to the referee instead of holding a QR code up at
   * them — the faster route when both are packing up. It goes to the referee's
   * own phone, in the hall, while this dialog stays open waiting for it: the
   * session is only watched while the dialog is, so the signature still belongs
   * to the visit it was collected at.
   */
  const shareSignatureLink = async (slug: string) => {
    const url = signUrlFor(slug);
    const lang = formData.lang;
    try {
      if (navigator.share) { await navigator.share({ title: t.sigShareLink, url }); return; }
      await navigator.clipboard.writeText(url);
      toast.success(t.sigLinkCopied, { lang });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;   // the coach closed the sheet
      // Clipboard access can be refused outright (permissions, an insecure
      // context). The QR beside this button never needs either, so point at it
      // rather than leaving a dead end.
      toast.error(lang === 'DE'
        ? 'Link konnte nicht kopiert werden — bitte den QR-Code verwenden.'
        : 'Could not copy the link — please use the QR code.', { lang });
    }
  };

  const openSignatureModal = async (target: 'referee' | 'rc') => {
    setSigTarget(target);
    setSigModalOpen(true); setSigSlug(''); setSigError('');
    try {
      const who = target === 'rc'
        ? `${formData.lang === 'DE' ? 'Referee Coach' : 'Referee Coach'} ${sigSignerName('rc')}`.trim()
        : `${formData.role} ${formData.meta.srName}`.trim();
      const context = [formData.meta.mannschaften, formData.meta.liga, who].filter(Boolean).join(' · ');
      const started = await startSignature(context, sigSignerName(target));
      setSigSlug(started.slug);
    } catch { setSigError(formData.lang === 'DE' ? 'Konnte nicht gestartet werden.' : 'Could not start.'); }
  };
  const saveSignatureHere = async () => {
    if (!sigPadRef.current || sigPadRef.current.isEmpty()) return;
    const data = sigPadRef.current.toDataURL();
    updateSignature(data);
    if (sigSlug) { try { await submitSignatureSession(sigSlug, data, sigSignerName(sigTarget)); } catch { /* ignore */ } }
    setSigModalOpen(false);
  };
  useEffect(() => {
    if (!sigModalOpen || !sigSlug) return;
    const id = setInterval(async () => {
      try {
        const sess = await getSignatureSession(sigSlug);
        // The phone that scanned the QR is signing for whichever party the modal
        // was opened for, so the relayed image lands in that slot.
        if (sess.signed && sess.data) { updateSignature(sess.data, sigTarget); setSigModalOpen(false); }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(id);
  }, [sigModalOpen, sigSlug, sigTarget]);
  const [downloadingEmptyForm, setDownloadingEmptyForm] = useState(false);
  const [manualUploadCoachee, setManualUploadCoachee] = useState<Coachee | null>(null);
  const [manualUploadSubmitting, setManualUploadSubmitting] = useState(false);
  const [manualUploadNotice, setManualUploadNotice] = useState('');

  const t = UI_STRINGS[formData.lang] || UI_STRINGS.DE;
  const selectedGame = eligibleGames.find((game) => game.id === selectedGameId) ?? null;
  const gameHas2SR = !!(selectedGame?.secondReferee);
  const dualMode = gameHas2SR && observationTarget === 'both';

  const adjustSectionsFor2SR = (sections: typeof SECTIONS_1SR_DE, has2SR: boolean) =>
    sections.map(section => ({
      ...section,
      items: section.items.map(item => {
        if (!has2SR) {
          if (item.id === '1sr-prep-3') {
            return { ...item, label: item.label.includes('Schreiber')
              ? 'Absprache mit Schreiber (Aufgabenteilung)'
              : 'Briefing with scorer (division of tasks)' };
          }
          if (item.id === '1sr-tech-5') {
            return { ...item, label: item.label.includes('Schreiber')
              ? 'Zusammenarbeit mit Schreiber'
              : 'Cooperation with scorer' };
          }
        }
        return item;
      }),
    }));

  useEffect(() => {
    document.documentElement.lang = formData.lang === 'DE' ? 'de' : 'en';
    document.title = formData.lang === 'DE' ? 'SR-Coaching Plattform' : 'Referee Coaching Platform';
  }, [formData.lang]);

  // ── URL ↔ view sync ────────────────────────────────────────────────
  // State → URL. pushState (not location.hash) so this never fires the
  // hashchange listener in main.tsx, and each view becomes a Back step.
  const currentHash = routeToHash({
    subView: feedbackSubView,
    listTab,
    coacheeId: selectedCoacheeId || null,
    feedbackId: openFeedbackId,
  });
  const didSyncHashRef = useRef(false);
  useEffect(() => {
    if (isForeignHash(window.location.hash)) return; // main.tsx is switching roots
    if (window.location.hash !== currentHash) {
      // The very first sync only names the landing view — it must not become a
      // Back step of its own (Back from the landing tab should leave the app).
      if (didSyncHashRef.current) window.history.pushState(null, '', currentHash);
      else window.history.replaceState(null, '', currentHash);
    }
    didSyncHashRef.current = true;
  }, [currentHash]);

  // URL → state, for Back/Forward. Registered once; the handler only calls
  // setters, so it needs no fresh render values.
  useEffect(() => {
    const onPop = () => {
      if (isForeignHash(window.location.hash)) return;
      const r = parseHash(window.location.hash, true);
      // Back onto a different coachee's list or observation has to fetch it —
      // the state on screen belongs to whoever we are stepping away from.
      if (r.coacheeId) void openDeepLinkRef.current(r);
      setFeedbackSubView(r.subView);
      const tab = landingTab(r.listTab);
      // Rewriting the tab must REPLACE the entry, not push one: otherwise Back
      // onto #/home would bounce here and push #/rc straight back on, and Back
      // could never get past it.
      if (tab !== r.listTab) didSyncHashRef.current = false;
      setListTab(tab);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // A landing hash that names a coachee — `#/games/<id>`, `#/feedbacks/<id>/…`.
  // Nothing is on screen yet and the roster has not arrived, so the open waits
  // for it, once. If the bootstrap finishes with an empty roster the link is
  // answered anyway, with "not found", rather than waiting for a list that is
  // never coming.
  const deepLinkOpenedRef = useRef(false);
  useEffect(() => {
    if (deepLinkOpenedRef.current || !initialRoute.coacheeId) return;
    if (coachees.length === 0 && booting) return;
    deepLinkOpenedRef.current = true;
    void openDeepLink(initialRoute);
    // openDeepLink is rebuilt every render; the ref above is what guards it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachees, booting]);

  // First-run bootstrap. Every screen's data is requested in ONE parallel batch
  // on mount — not chained, and not deferred until its tab is opened — so no
  // page can be reached before its own request was even started. Runs once:
  // language is a pure client-side concern and must not refetch anything.
  useEffect(() => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      setBooting(false);
      return;
    }
    setBackendNotice('');
    // Everything that does not depend on the season starts at once. The two
    // that DO — overview and the Home dashboard — wait for settings to say
    // which season, and only for that: settings is one small request, so they
    // still overlap the rest.
    //
    // They used to launch immediately off the locally guessed season, and the
    // guess is usually wrong (the stored preference is deleted after the first
    // successful load, leaving a client-side calculation the admin default
    // routinely disagrees with). Both then ran a second time when the real
    // season arrived — two extra round trips per cold start, and a dashboard
    // that showed the wrong season's numbers until the rerun landed.
    const seasonReady = loadSettings();
    void Promise.allSettled([
      refreshGames(),
      refreshCoachees(),
      refreshCalendarGames(),
      refreshRcPeople(),
      refreshAdminAuthStatus(),
      seasonReady.then((season) => {
        // The Home dashboard and the RC Overview tab read the same overview
        // endpoint — fetch it once and share the promise.
        const overview = refreshRcOverview(season);
        return Promise.all([overview, loadHome(overview, season)]);
      }),
    ]).then(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedGame) {
      return;
    }
    // A reopened observation is a snapshot of what was filed. Refilling its meta
    // from today's game record would show a since-corrected score and a level
    // the coachee has since been promoted to — and "PDF herunterladen" would
    // then produce a document that disagrees with the one the coachee received.
    if (openFeedbackId) {
      return;
    }
    const srName = getRefereeForRole(selectedGame, formData.role);
    // Match the coachee against the referee currently being observed (handles first/last name order)
    const coacheeById = coachees.find((c) => c.id === selectedCoacheeId);
    // Fold accents, like normName does everywhere else. Without it VolleyManager's
    // "Kevin León Peña de los Santos" missed the imported "Kevin Leon Peña de los
    // Santos", so the games list badged him a coachee — that lookup DOES fold —
    // while this one found nobody and left Niveau and Gruppe empty on his form
    // and in the PDF the coachee receives.
    const normalizeName = (name: string) => normName(name).split(' ').sort().join(' ');
    const matchesNorm = (c: Coachee, norm: string) => {
      if (!norm) return false;
      if (normalizeName(c.full_name || '') === norm) return true;
      if (c.first_name && c.last_name && normalizeName(`${c.first_name} ${c.last_name}`) === norm) return true;
      return false;
    };
    const srNorm = normalizeName(srName || '');
    // Prefer this season's row: `find` over the raw list answers in load order,
    // which is last season's copy for anyone imported twice. Falling back to any
    // season beats refusing to prefill (the server re-resolves by game date).
    const coacheeByName = coachees.find((c) => isInSeason(c, seasonStartYear) && matchesNorm(c, srNorm))
      ?? coachees.find((c) => matchesNorm(c, srNorm));
    // Fall back to the navigated-from coachee only if they aren't the *other* referee of this game
    const otherRef = getRefereeForRole(selectedGame, formData.role === '1. SR' ? '2. SR' : '1. SR');
    const otherNorm = normalizeName(otherRef || '');
    const coachee = coacheeByName || (coacheeById && !matchesNorm(coacheeById, otherNorm) ? coacheeById : undefined);
    const has2SR = !!selectedGame.secondReferee;
    setFormData((prev) => ({
      ...prev,
      sections: adjustSectionsFor2SR(prev.sections, has2SR),
      meta: {
        ...prev.meta,
        spielNr: selectedGame.matchNo || prev.meta.spielNr,
        liga: (selectedGame.league || prev.meta.liga).replace('♂', 'M').replace('♀', 'D'),
        datum: formatDisplayDate(selectedGame.date) || prev.meta.datum,
        ort: shortenLocation(selectedGame.location) || prev.meta.ort,
        mannschaften: [selectedGame.homeTeam, selectedGame.awayTeam].filter(Boolean).join(' - '),
        // Once the coach has unlocked and corrected the score, the game's copy
        // must not win — a role toggle re-runs this refill, and letting
        // game_result overwrite here silently reverted their correction.
        ergebnis: resultUnlocked ? prev.meta.ergebnis : (selectedGame.game_result || prev.meta.ergebnis),
        srName: srName || prev.meta.srName,
        srNiveau: metaNiveau(coachee) || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee?.groups) || prev.meta.gruppe,
        rc: rcAuth.rcName || selectedGame.assignedRc || prev.meta.rc,
      },
    }));
  }, [selectedGameId, selectedGame?.assignedRc, formData.role, coachees, selectedCoacheeId, openFeedbackId]);

  const updateMeta = (key: keyof typeof formData.meta, value: string) => {
    setFormData(prev => ({
      ...prev,
      meta: { ...prev.meta, [key]: value }
    }));
    // The score belongs to the match, not to a referee. With two referees the
    // coach types it into whichever form happens to be open, so keep the
    // stashed one in step — otherwise switching back restores the stale score.
    if (key === 'ergebnis') mirrorErgebnisToStash(value);
  };

  const mirrorErgebnisToStash = (value: string) => {
    setDualFormData(prev => {
      const withErgebnis = (stored: typeof prev['1. SR']) => stored && ({
        ...stored,
        formData: { ...stored.formData, meta: { ...stored.formData.meta, ergebnis: value } },
      });
      return { '1. SR': withErgebnis(prev['1. SR']), '2. SR': withErgebnis(prev['2. SR']) };
    });
  };

  const updateRating = (sectionIdx: number, itemIdx: number, columnRating: string) => {
    setFormData(prev => {
      const newSections = [...prev.sections];
      const newItems = [...newSections[sectionIdx].items];
      const currentRating = newItems[itemIdx].rating;
      
      let nextRating = '';
      if (currentRating === columnRating) {
        nextRating = columnRating + '+';
      } else if (currentRating === columnRating + '+') {
        nextRating = columnRating + '-';
      } else if (currentRating === columnRating + '-') {
        nextRating = '';
      } else {
        nextRating = columnRating;
      }

      newItems[itemIdx] = { ...newItems[itemIdx], rating: nextRating };
      newSections[sectionIdx] = { ...newSections[sectionIdx], items: newItems };
      return { ...prev, sections: newSections };
    });
  };

  const updateResult = (key: keyof typeof formData.results, value: string) => {
    setFormData(prev => ({
      ...prev,
      results: { ...prev.results, [key]: prev.results[key] === value ? '' : value }
    }));
  };

  // Every load runs under a per-resource generation token. A response from a
  // superseded load (season switch, manual refresh, a second click) is dropped
  // instead of racing the newer one into state.
  const reqGen = useRef<Record<string, number>>({});
  const beginLoad = (key: string) => (reqGen.current[key] = (reqGen.current[key] ?? 0) + 1);
  const isCurrentLoad = (key: string, gen: number) => reqGen.current[key] === gen;
  // `${rcName}|${season}` whose summary fetch has already been started, so the
  // RC-detail effect never re-runs a request that is in flight or has failed.
  const rcSummaryAttemptRef = useRef<string | null>(null);

  // The connectivity listener is registered once and keeps the closures of that
  // first render forever. Reading the selection through a ref means a flush
  // triggered hours later still sees which game is actually open, instead of
  // the empty string it was at mount — which used to make the "nothing selected
  // yet" branch below fire and silently swap the half-filled form's game.
  const selectedGameIdRef = useRef(selectedGameId);
  selectedGameIdRef.current = selectedGameId;
  // Same reason: the flush itself (and the loadHome inside it) must be this
  // render's, not the mount render's, or a flush reloads the season that was
  // current when the tab opened.
  const flushOutboxNowRef = useRef<() => Promise<void>>(async () => {});
  const flushDraftNowRef = useRef<() => Promise<void>>(async () => {});
  /** The identity the work on screen belongs to. Without it the identity flip
   *  ALONE would re-run the autosave effect and re-stamp the outgoing coach's
   *  ratings and signatures under the incoming coach's key — a report filed as B
   *  over A's ink. (`switchRc()` does not reload the page; it does unmount App,
   *  which is why the park timer needs cancelling in the unmount cleanup.) */
  const draftOwnerRef = useRef('');
  /** Set synchronously while a game's drafts are being read, so the debounced
   *  autosave cannot write the blank form over the draft it is about to load. */
  const draftLoadingRef = useRef('');
  /** Read synchronously from sessionStorage so the games-list auto-select cannot
   *  claim the selection before a resume lands on top of it. */
  const autoResumeRef = useRef<string>(resumeHint());
  const didBootDraftsRef = useRef(false);
  const parkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const parkImmediatelyRef = useRef<() => void>(() => {});

  const refreshGames = async () => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    const gen = beginLoad('games');
    setLoadingGames(true);
    setBackendNotice('');
    try {
      const games = await loadEligibleGames();
      if (!isCurrentLoad('games', gen)) return;
      setEligibleGames(games);
      // A pending draft resume gets to choose the game; auto-selecting the first
      // one here would claim the selection before the restore lands on top.
      if (games.length > 0 && !selectedGameIdRef.current && !autoResumeRef.current) {
        setSelectedGameId(games[0].id);
      }
    } catch (error) {
      if (!isCurrentLoad('games', gen)) return;
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      if (isCurrentLoad('games', gen)) setLoadingGames(false);
    }
  };

  // Fills the "assign a coach" picker; a failure just leaves it empty.
  const refreshRcPeople = async () => {
    const gen = beginLoad('rcPeople');
    try {
      const people = await listRefereeCoachPeople();
      if (isCurrentLoad('rcPeople', gen)) setRcPeople(people);
    } catch { /* picker stays empty */ }
  };

  // Not a screen of its own any more — the admin console at #/admin has its own
  // login. What the app still needs from it is the one bit isPrivileged reads:
  // whether this browser carries an admin session.
  const refreshAdminAuthStatus = async () => {
    const gen = beginLoad('adminAuth');
    try {
      const status = await getAdminAuthStatus();
      if (!isCurrentLoad('adminAuth', gen)) return;
      setAdminAuthenticated(status.authenticated);
    } catch {
      if (!isCurrentLoad('adminAuth', gen)) return;
      setAdminAuthenticated(false);
    }
  };

  const refreshCoachees = async () => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    const gen = beginLoad('coachees');
    setLoadingCoachees(true);
    setBackendNotice('');
    try {
      const items = await listCoachees();
      if (!isCurrentLoad('coachees', gen)) return;
      setCoachees(items);
    } catch (error) {
      if (!isCurrentLoad('coachees', gen)) return;
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      if (isCurrentLoad('coachees', gen)) setLoadingCoachees(false);
    }
  };

  // Personal dashboard for the logged-in RC: counters from the overview row,
  // upcoming + missing games from their own coachee summary. Takes the overview
  // promise from the caller when one is already in flight, so the dashboard and
  // the RC Overview tab never issue the same request twice.
  // `seasonOverride` exists for the mount batch: it runs before the settings
  // answer has reached state, so the season it must load for is only available
  // as a value, not from `seasonStartYear`.
  const loadHome = async (overviewInFlight?: Promise<RcOverviewEntry[]>, seasonOverride?: number) => {
    const myName = rcAuth.rcName;
    if (!myName) { setHomeData(null); return; }
    const gen = beginLoad('home');
    const season = seasonOverride ?? seasonStartYear;
    // This request also covers the RC detail view for the logged-in coach —
    // claim it so the detail effect below doesn't fetch the same thing again.
    rcSummaryAttemptRef.current = `${myName}|${season}`;
    setHomeLoading(true);
    try {
      const norm = (s: string) => s.trim().toLowerCase();
      const [overview, summary] = await Promise.all([
        overviewInFlight ?? loadRcOverview(season),
        loadrcCoachSummary(myName, season),
      ]);
      if (!isCurrentLoad('home', gen)) return;
      const myRow = overview.find((r) => norm(r.fullName) === norm(myName));
      const byDate = (a: rcCoachSummaryGame, b: rcCoachSummaryGame) => a.gameDate.localeCompare(b.gameDate);
      // The summary is per coachee, so a game with two coachees on the whistle
      // arrives twice and Home listed the same appointment twice — while the
      // "planned" counter beside it, which the server counts per game, said one
      // less. Collapse to one row per game and name both referees on it.
      const perGame = (games: rcCoachSummaryGame[]): HomeGame[] => {
        const byId = new Map<string, HomeGame>();
        for (const g of games) {
          // Without an id there is nothing to merge on — keep the row as it is
          // rather than folding unrelated games together under an empty key.
          const key = g.gameId || `${g.gameDate}|${g.teams}|${g.refereeName}`;
          const seen = byId.get(key);
          if (!seen) {
            byId.set(key, { ...g, refs: g.refereeName ? [{ name: g.refereeName, role: g.refereeRole || '' }] : [] });
            continue;
          }
          if (g.refereeName && !(seen.refs ?? []).some((r) => r.name === g.refereeName)) {
            seen.refs = [...(seen.refs ?? []), { name: g.refereeName, role: g.refereeRole || '' }];
          }
          // "No coachee on this game" only holds if it holds for every entry.
          if (!g.noCoachee) seen.noCoachee = false;
          if (!seen.result && g.result) seen.result = g.result;
        }
        return [...byId.values()];
      };
      const nextGames = perGame(summary.flatMap((cs) => cs.plannedGames)).sort(byDate);
      const missingGames = perGame(summary.flatMap((cs) => cs.outstandingGames)).sort(byDate);
      const done = myRow?.done ?? summary.reduce((n, cs) => n + cs.doneFeedbacks.length, 0);
      // Observations already filed, newest first — shown at the bottom of Home.
      const doneList: HomeDone[] = summary
        .flatMap((cs) => cs.doneFeedbacks.map((fb) => ({
          gameDate: fb.gameDate, league: fb.league, teams: fb.teams,
          role: fb.role, submittedAt: fb.submittedAt, result: fb.result,
          coacheeName: cs.coacheeName, coacheeId: cs.coacheeId,
        })))
        .sort((a, b) => (b.submittedAt || b.gameDate).localeCompare(a.submittedAt || a.gameDate));
      setHomeData({
        done,
        planned: myRow?.planned ?? nextGames.length,
        outstanding: myRow?.outstanding ?? missingGames.length,
        nextGames,
        missingGames,
        doneList,
      });
      // Same payload the RC detail view needs — hand it over so opening that
      // tab is instant instead of triggering an identical fetch.
      setrcCoachSummaryData(summary);
      setRcSummaryKey(`${myName}|${season}`);
    } catch {
      if (isCurrentLoad('home', gen)) setHomeData(null);
      // The claim above covers the RC detail view too; holding it after a
      // failure would block that view from ever loading this session.
      if (rcSummaryAttemptRef.current === `${myName}|${season}`) rcSummaryAttemptRef.current = null;
    } finally {
      if (isCurrentLoad('home', gen)) setHomeLoading(false);
    }
  };

  const refreshRcOverview = async (seasonOverride?: number): Promise<RcOverviewEntry[]> => {
    const gen = beginLoad('rcOverview');
    setRcOverviewLoading(true);
    try {
      const data = await loadRcOverview(seasonOverride ?? seasonStartYear);
      if (isCurrentLoad('rcOverview', gen)) setRcOverviewData(data);
      return data;
    } catch {
      if (isCurrentLoad('rcOverview', gen)) setRcOverviewData([]);
      return [];
    } finally {
      if (isCurrentLoad('rcOverview', gen)) setRcOverviewLoading(false);
    }
  };

  // Open on the first section that actually has games.
  const pickRcDetailTab = (data: rcCoachSummary[]) => {
    const has = (pick: (cs: rcCoachSummary) => unknown[]) => data.some((cs) => pick(cs).length > 0);
    setRcDetailTab(has((cs) => cs.plannedGames) ? 'planned' : has((cs) => cs.outstandingGames) ? 'outstanding' : 'done');
  };

  const loadRcSummary = async (rcName: string) => {
    const gen = beginLoad('rcSummary');
    setrcCoachSummaryLoading(true);
    setRcCoachSummaryFailed(false);
    try {
      const data = await loadrcCoachSummary(rcName, seasonStartYear);
      if (!isCurrentLoad('rcSummary', gen)) return;
      setrcCoachSummaryData(data);
      setRcSummaryKey(`${rcName}|${seasonStartYear}`);
    } catch {
      if (!isCurrentLoad('rcSummary', gen)) return;
      setrcCoachSummaryData([]);
      setRcSummaryKey(null);
      setRcCoachSummaryFailed(true);
      // Release the claim, or one flaky fetch makes the RC detail say "no data"
      // for the rest of the session — a network blip presented as an empty
      // season, with no retry control anywhere on the screen.
      rcSummaryAttemptRef.current = null;
    } finally {
      if (isCurrentLoad('rcSummary', gen)) setrcCoachSummaryLoading(false);
    }
  };

  // Overview / summary / dashboard are season-scoped on the server, so a season
  // switch re-fetches exactly that slice — in parallel, and only on a real
  // change (the initial values come from the mount bootstrap). Declared before
  // the RC-detail effect below so loadHome can claim the summary fetch first.
  const loadedSeasonRef = useRef(seasonStartYear);
  useEffect(() => {
    if (loadedSeasonRef.current === seasonStartYear) return;
    loadedSeasonRef.current = seasonStartYear;
    const overview = refreshRcOverview();
    void loadHome(overview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonStartYear]);

  // Selecting an RC — by click, by deep link (#/rc/Name) or via Back — drives
  // the detail view. One place decides whether a fetch is needed, so no path
  // can double-load and none can leave the view without data.

  // Track connectivity; flush the outbox when we come back online.
  useEffect(() => {
    // A logout that never reached the server is retried the moment there is a
    // network, so the session really is revoked rather than merely hidden.
    const goOnline = () => { setIsOffline(false); void settlePendingLogout(); void flushOutboxNowRef.current(); };
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    void refreshOutboxCount();
    if (navigator.onLine) void flushOutboxNowRef.current();
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Taking a game (or giving one back) moves it in or out of a coach's planned
  // list, which Home reads from the server. Without this the dashboard kept the
  // figures it loaded with, and the game only showed up after a page reload.
  // Both the old and the new holder count, so handing a game back refreshes too.
  const refreshAfterAssignment = (...affected: Array<string | undefined>) => {
    const me = rcAuth.rcName ? normName(rcAuth.rcName) : '';
    if (me && affected.some((n) => n && normName(n) === me)) {
      // One overview request feeds both the counters and the dashboard.
      const overview = refreshRcOverview();
      void loadHome(overview);
    } else if (rcOverviewData.length > 0) {
      void refreshRcOverview();
    }
  };

  // Refetch the games in the background: no skeleton, no cleared notice, no
  // change to what is selected. Used by the freshness poll below and after a
  // rejected assignment, where the list on screen is provably behind.
  const gamesSyncInFlight = useRef(false);
  const syncGamesQuietly = async () => {
    if (gamesSyncInFlight.current || !hasPocketBaseConfig()) return;
    gamesSyncInFlight.current = true;
    try {
      setEligibleGames(await loadEligibleGames());
    } catch {
      // A failed background refresh is not news — the list simply stays as it is.
    } finally {
      gamesSyncInFlight.current = false;
    }
  };

  const applyRcAssignment = async (gameId: string, rcName: string, previousRc?: string) => {
    try {
      await assignRcToGame(gameId, rcName);
      setEligibleGames((prev) => prev.map((g) => g.id === gameId ? { ...g, assignedRc: rcName } : g));
      refreshAfterAssignment(previousRc, rcName);
    } catch (err) {
      // The server refuses to hand over a game somebody else holds (409). That
      // answer only ever reaches a screen that was already out of date, so the
      // row is corrected in the same breath as the message.
      setBackendNotice(localizeRuntimeError(err instanceof Error ? err.message : String(err), formData.lang));
      void syncGamesQuietly();
    }
  };

  // Coachees on this game who have already been observed this season. A second
  // look is a legitimate thing to plan, so this never blocks the assignment —
  // it just makes sure it is a decision and not something discovered afterwards.
  const observedCoacheesOnGame = (game: EligibleGame) => {
    const seen = new Set<string>();
    const out: Array<{ name: string; count: number; plannedBy?: string; plannedOn?: string }> = [];
    for (const r of [game.firstReferee, game.secondReferee]) {
      if (!r) continue;
      const c = coacheeByName.get(normName(r));
      if (!c) continue;
      const name = c.full_name || r;
      const key = normName(name);
      if (seen.has(key)) continue;
      const count = observationCount(c);
      // A booking on ANOTHER game counts as coverage too: two coaches taking
      // the same coachee in the same week is the duplicate nobody notices,
      // because neither observation has been filed yet.
      const booked = plannedObsByCoachee.get(key);
      const elsewhere = booked && booked.game.id !== game.id ? booked : undefined;
      if (count === 0 && !elsewhere) continue;
      seen.add(key);
      out.push({ name, count, plannedBy: elsewhere?.rc, plannedOn: elsewhere?.game.date });
    }
    return out;
  };

  const requestRcAssignment = (game: EligibleGame, rcName: string) => {
    // Clearing an assignment needs no warning — nobody is being observed twice.
    const observed = rcName ? observedCoacheesOnGame(game) : [];
    if (observed.length > 0) {
      setTakeNotice({ gameId: game.id, rcName, previousRc: game.assignedRc, observed });
      return;
    }
    void applyRcAssignment(game.id, rcName, game.assignedRc);
  };

  // Give a taken game back: clears the RC assignment, so the game (and its
  // coachees' other games) reappear in the open games list.
  // Reports whether it went through — the failure path is handled here (inline
  // notice + resync), so a caller that wants to confirm the hand-back cannot
  // tell from a rejection and needs this answer instead.
  const handleUnassignGame = async (gameId: string) => {
    const previousRc = eligibleGames.find((g) => g.id === gameId)?.assignedRc;
    try {
      await assignRcToGame(gameId, '');
      setEligibleGames((prev) => prev.map((g) => g.id === gameId ? { ...g, assignedRc: '' } : g));
      setrcCoachSummaryData((prev) => prev.map((cs) => ({
        ...cs,
        plannedGames: cs.plannedGames.filter((g) => g.gameId !== gameId),
        outstandingGames: cs.outstandingGames.filter((g) => g.gameId !== gameId),
      })));
      refreshAfterAssignment(previousRc);
      return true;
    } catch (err) {
      setBackendNotice(localizeRuntimeError(err instanceof Error ? err.message : String(err), formData.lang));
      void syncGamesQuietly();
      return false;
    }
  };

  // Whoever takes or gives back a game changes what everyone else may take. The
  // API pushes that out over /api/events, and this applies it the moment it
  // lands: an assignment is patched into the row by id — the payload says who
  // holds it now, so there is nothing to go and ask.
  const [liveConnected, setLiveConnected] = useState(false);
  useEffect(() => {
    if (!rcAuth.rcName) return;
    return subscribeLive((event) => {
      if (event.type === 'game.assignment') {
        setEligibleGames((prev) => prev.map((g) => (g.id === event.gameId ? { ...g, assignedRc: event.assignedRc } : g)));
        // Counters and "next appointments" are per coach, so they only move when
        // the game changed hands to or from this one.
        const mine = normName(event.assignedRc || '') === normName(rcAuth.rcName || '');
        const wasMine = eligibleGamesRef.current.some((g) => g.id === event.gameId && normName(g.assignedRc || '') === normName(rcAuth.rcName || ''));
        if (mine || wasMine) void loadHome();
      } else if (event.type === 'games.synced') {
        void syncGamesQuietly();
      } else if (event.type === 'settings.changed') {
        void loadSettings();
      }
    }, setLiveConnected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rcAuth.rcName]);

  // The poll stays, as the answer to a stream that quietly died — a hotel WiFi,
  // a proxy that eats text/event-stream, an iOS tab suspended in the background.
  // While the stream is live it drops to a slow heartbeat; when it is not, it is
  // the only thing keeping the list honest and goes back to 45 seconds.
  useEffect(() => {
    if (!rcAuth.rcName) return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (listTab === 'games') void syncGamesQuietly();
      else if (listTab === 'home') void loadHome();
    };
    // Coming back to the window is the moment worth reacting to; the interval is
    // the fallback for a screen nobody touches.
    let last = 0;
    const onWake = () => {
      const now = Date.now();
      if (now - last < 15_000) return;
      last = now;
      refresh();
    };
    const timer = window.setInterval(refresh, liveConnected ? 300_000 : 45_000);
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listTab, rcAuth.rcName, seasonStartYear, liveConnected]);

  // Handing a game back used to mean finding it in the games list and opening
  // its card. From Home it is one tap on the row that already shows it — the
  // same server call, with a confirmation because the game becomes free for
  // everyone the moment it goes through.
  // Shared by the Home row and the games list: both hand a game back, so both
  // ask the same question, in the same words, and both confirm it the same way.
  // The label lives in the MESSAGE, not the title — a full team-vs-team string
  // rendered as the title was four lines of bold on a phone, with the verb and
  // the question mark 55 characters apart.
  const giveBackGame = async (gameId: string, label: string, german: boolean, after?: () => Promise<void>) => {
    const ok = await confirmDialog({
      title: german ? 'Spiel abgeben?' : 'Give game back?',
      message: german
        ? `„${label}" ist danach wieder für alle Referee Coaches frei.`
        : `"${label}" becomes available to every referee coach again.`,
      confirmLabel: german ? 'Abgeben' : 'Give back',
      cancelLabel: german ? 'Abbrechen' : 'Cancel',
      tone: 'danger',
      lang: german ? 'DE' : 'EN',
    });
    if (!ok) return;
    const done = await handleUnassignGame(gameId);
    if (after) await after();
    // Only on the way through — a failure already put its own notice on screen.
    if (done) {
      toast.success(
        german ? `„${label}" abgegeben.` : `Gave back "${label}".`,
        { lang: german ? 'DE' : 'EN' },
      );
    }
  };

  const giveBackFromHome = (gameId: string, label: string, german: boolean) =>
    giveBackGame(gameId, label, german, loadHome);

  // "Send the reminder now" — a confirm first, because it puts a mail in
  // somebody's inbox and there is no unsending it.
  const remindFromHome = async (gameId: string, label: string, german: boolean) => {
    const ok = await confirmDialog({
      title: german ? 'Erinnerung jetzt senden?' : 'Send the reminder now?',
      message: german
        ? `Die SR von „${label}" erhalten die Erinnerungs-Mail sofort — sonst ginge sie automatisch am Vortag um 10:00 raus. Du bekommst sie in Kopie.`
        : `The referees of "${label}" get the reminder mail straight away — otherwise it would go out automatically at 10:00 the day before. You are copied in.`,
      confirmLabel: german ? 'Senden' : 'Send',
      lang: german ? 'DE' : 'EN',
    });
    if (!ok) return;
    try {
      const res = await sendGameReminder(gameId);
      if (res.suppressed) {
        toast.info(german
          ? 'Test-Modus ist aktiv — es wurde keine E-Mail versendet.'
          : 'Test mode is on — no e-mail was sent.', { lang: german ? 'DE' : 'EN' });
      } else {
        toast.success(german
          ? `Erinnerung an ${res.sent} Empfänger gesendet.`
          : `Reminder sent to ${res.sent} recipient(s).`, { lang: german ? 'DE' : 'EN' });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { lang: german ? 'DE' : 'EN' });
    }
  };

  const applyCoacheeToMeta = (coachee: Coachee) => {
    // A filed record is a document about ONE referee, already signed and sent.
    // Tapping another coachee while it is open used to rewrite the name, Niveau
    // and Gruppe on screen — and into "PDF herunterladen" — so the saved file
    // showed one person's name over another's ratings and signature. The
    // meta-fill effect already refuses to run while openFeedbackId is set; this
    // path skipped that guard, and nothing put the record's own values back.
    if (openFeedbackId) return;
    setFormData((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        srName: coachee.full_name || prev.meta.srName,
        srNiveau: metaNiveau(coachee) || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee.groups) || prev.meta.gruppe,
      },
    }));
  };

  const handleSelectGame = (game: EligibleGame | CoacheeGame, preferredRef?: string) => {
    // First statement, before any setter: the outgoing game's last keystrokes
    // are still only in the render being left behind.
    void flushDraftNowRef.current();
    parkImmediatelyRef.current();
    // The form binds to a game from the eligible list. A coachee's games list
    // also carries games where they are only a line judge — opening one gave a
    // form bound to nothing: the previous game's header still on screen and a
    // send button greyed out forever with no explanation.
    if (!eligibleGames.some((g) => g.id === game.id)) {
      setBackendNotice(formData.lang === 'DE'
        ? 'Für dieses Spiel ist keine SR-Beobachtung möglich — der Coachee ist dort nicht als 1./2. SR eingeteilt.'
        : 'No referee observation is possible for this game — the coachee is not assigned as 1st/2nd referee.');
      return;
    }
    const isNewGame = game.id !== selectedGameId;
    setSelectedGameId(game.id);
    setFeedbackLocked(false);
    // A game picked from the list is a form to fill, not a filed record — any
    // note editor belonging to a previously opened observation goes away.
    setOpenFeedbackId(null);
    setOpenFeedbackMine(false);
    setFeedbackSubView('feedbackForm');

    // Reset dual form storage; a different game must not inherit the previous
    // game's ratings, results, or tips.
    setDualFormData({ '1. SR': null, '2. SR': null });
    if (isNewGame) setResultUnlocked(false);
    if (isNewGame) setTipsAndTricks(demoTips());

    // Pre-select the observation target based on which referee(s) are coachees — freely changeable afterwards
    const g = game as EligibleGame;
    const r1 = g.firstReferee || '';
    const r2 = g.secondReferee || '';
    const r1IsC = coacheeNames.has(normName(r1));
    const r2IsC = !!(r2 && coacheeNames.has(normName(r2)));
    const has2 = !!r2;

    let target: '1SR' | '2SR' | 'both' = '1SR';
    let role: FeedbackFormData['role'] = '1. SR';
    if (has2 && r1IsC && r2IsC) {
      target = 'both';
    } else if (has2 && r2IsC && !r1IsC) {
      target = '2SR';
      role = '2. SR';
    }
    // Coming from the RC view we know whom the coach plans to observe — start there.
    if (preferredRef && has2 && normName(preferredRef) === normName(r2)) role = '2. SR';
    else if (preferredRef && normName(preferredRef) === normName(r1)) role = '1. SR';
    setObservationTarget(target);
    setFormData(prev => {
      if (!isNewGame && prev.role === role) return prev;
      const newSections = role === '1. SR'
        ? adjustSectionsFor2SR(prev.lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, has2)
        : (prev.lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
      if (!isNewGame) return { ...prev, role, sections: newSections };
      return {
        ...prev,
        role,
        sections: newSections,
        results: { ...INITIAL_DATA.results },
        // Signatures are an acknowledgment of THIS observation. Carried over,
        // the mandatory-signature gate is satisfied by the previous referee's
        // ink and their signature ends up on someone else's report.
        signature: '',
        rcSignature: undefined,
        // Every game-derived meta field is cleared too: the fill effect below
        // keeps `prev` whenever the new game leaves a field empty, so a game
        // with no published score used to inherit the previous game's.
        meta: {
          ...prev.meta,
          spielNr: '', liga: '', datum: '', ort: '', mannschaften: '',
          ergebnis: '', srName: '', srNiveau: '', gruppe: '',
        },
      };
    });

    draftOwnerRef.current = outboxOwnerId;
    // Claimed synchronously: the debounced autosave writes to the very key the
    // stored draft occupies, so the blank form must not be allowed to overwrite
    // the draft in the window before it loads.
    draftLoadingRef.current = game.id;
    void resumeDraftForGame(game.id);
  };

  const refreshCalendarGames = async () => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    setLoadingCalendar(true);
    setBackendNotice('');
    try {
      const games = await loadCalendarGames();
      setCalendarGames(games);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      setLoadingCalendar(false);
    }
  };

  // Everything a filed observation changes: the games list (the role closes),
  // the coachee statuses, the calendar dots, the RC overview counters and the
  // dashboard — one shared overview request feeds the last two. Every path that
  // files one goes through here: the form, the offline flush, and the upload of
  // a paper form. They each used to refresh a different subset, so which views
  // were stale depended on how the observation had been submitted.
  const refreshAfterFeedback = () => {
    const overview = refreshRcOverview();
    return Promise.allSettled([refreshGames(), refreshCoachees(), refreshCalendarGames(), overview, loadHome(overview)]);
  };

  const loadCoacheeGames = async (coachee: Coachee) => {
    // Under the same generation guard the other loaders use: the header name is
    // set synchronously on click, so a slow response for the coachee opened
    // first would otherwise land under the second one's name — and starting an
    // observation from that list would target the wrong person's game.
    const gen = beginLoad('coacheeGames');
    setLoadingCoacheeGames(true);
    setShowAllPastGames(false);
    setBackendNotice('');
    try {
      const [games, feedbacks] = await Promise.all([
        listCoacheeGames(coachee.id),
        listCoacheeFeedbacks(coachee.id),
      ]);
      if (!isCurrentLoad('coacheeGames', gen)) return;
      setCoacheeGames(games);
      setCoacheeFeedbacks(feedbacks);
      setFeedbackSubView('coacheeGames');
    } catch (error) {
      if (!isCurrentLoad('coacheeGames', gen)) return;
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      if (isCurrentLoad('coacheeGames', gen)) setLoadingCoacheeGames(false);
    }
  };

  const normalizeLoadedFeedback = (raw: FeedbackFormData): FeedbackFormData => {
    const role = raw.role === '2. SR' ? '2. SR' : '1. SR';
    const lang = raw.lang === 'EN' ? 'EN' : 'DE';
    const rawDefaultSections =
      role === '1. SR'
        ? (lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN)
        : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
    const defaultSections = role === '1. SR'
      ? adjustSectionsFor2SR(rawDefaultSections, gameHas2SR)
      : rawDefaultSections;
    const sections = Array.isArray(raw.sections) ? raw.sections : defaultSections;

    return {
      ...INITIAL_DATA,
      ...raw,
      role,
      lang,
      meta: { ...INITIAL_DATA.meta, ...(raw.meta ?? {}) },
      results: { ...INITIAL_DATA.results, ...(raw.results ?? {}) },
      sections: sections.map((section, sIdx) => ({
        ...defaultSections[sIdx],
        ...section,
        items: (section.items ?? defaultSections[sIdx]?.items ?? []).map((item, iIdx) => ({
          ...(defaultSections[sIdx]?.items?.[iIdx] ?? {}),
          ...item,
          rating: item.rating || '',
        })),
      })),
    };
  };

  const openFeedbackRecord = (record: FeedbackRecord) => {
    setOpenFeedbackId(record.id || null);
    // Id OR name, mirroring the server's rcRefMatches. Name alone was stricter
    // than the rule the server actually enforces: correct an RC's spelling in
    // the roster and their own filed observations stopped offering them the
    // president-note box, even though a write would still have been accepted.
    setOpenFeedbackMine(
      (!!record.rc_id && record.rc_id === rcAuth.rcId)
      || (!!rcAuth.rcName && normName(record.rc_name || '') === normName(rcAuth.rcName))
    );
    const payload = record.feedback_json;
    if (payload) {
      setFormData(normalizeLoadedFeedback(payload));
      setObservationTarget(payload.role === '2. SR' ? '2SR' : '1SR');
    }
    const expandedGame = record.expand?.game;
    // This record existing IS the proof that its role was filed, so the game it
    // reopens against carries that role as closed. The rebuilt game used to omit
    // it and so looked untouched — offering "confirm and send" for an
    // observation the server then (correctly) rejected as a duplicate. It also
    // corrects a games list that was loaded before the feedback was sent.
    const closedRole = record.role_assessed || payload?.role;
    const withRoleClosed = (roles?: string[]): string[] =>
      closedRole && !roles?.includes(closedRole) ? [...(roles ?? []), closedRole] : (roles ?? []);
    if (expandedGame?.id) {
      const mappedGame: EligibleGame = {
        id: expandedGame.id,
        matchNo: expandedGame.match_no || '',
        league: expandedGame.league || '',
        date: expandedGame.match_date || '',
        location: expandedGame.location || '',
        homeTeam: expandedGame.home_team || '',
        awayTeam: expandedGame.away_team || '',
        firstReferee: expandedGame.first_referee || '',
        secondReferee: expandedGame.second_referee || '',
        feedbackClosedRoles: withRoleClosed(),
      };
      setEligibleGames((prev) => (prev.some((item) => item.id === mappedGame.id)
        ? prev.map((item) => (item.id === mappedGame.id
          ? { ...item, feedbackClosedRoles: withRoleClosed(item.feedbackClosedRoles) }
          : item))
        : [mappedGame, ...prev]));
      setSelectedGameId(mappedGame.id);
      // Marking the role closed is what makes the form read-only; if the record
      // never said which role it assessed, fall back to locking it outright
      // rather than presenting a filed observation as sendable.
      setFeedbackLocked(!closedRole);
    } else {
      // No game came back with the record, so the previously selected game is
      // still the selected one. Lock the form rather than leave a filed
      // observation pointing send at whatever game happened to be open.
      setFeedbackLocked(true);
    }
    setFeedbackPickerCoachee(null);
    setFeedbackSubView('feedbackForm');
  };

  // Open an already-filed observation from a summary row. The summary carries no
  // feedback id, so we fetch that coachee's records and match on the game date
  // (plus role when the row names one) — then reuse the normal record viewer.
  const openDoneObservation = async (row: { coacheeId: string; gameDate: string; role?: string }) => {
    if (!row.coacheeId) return;
    setBackendNotice('');
    try {
      const records = await listCoacheeFeedbacks(row.coacheeId);
      const day = (s: string) => (s || '').slice(0, 10);
      const sameDay = records.filter((r) => day(r.expand?.game?.match_date || '') === day(row.gameDate));
      // Only ever a record from the day that was clicked. Falling back to
      // "whatever this coachee has" opened an unrelated observation and
      // presented it as the one on that row.
      const match = (row.role && sameDay.find((r) => r.role_assessed === row.role)) || sameDay[0];
      if (match) openFeedbackRecord(match);
      else setBackendNotice(formData.lang === 'DE' ? 'Beobachtung nicht gefunden.' : 'Observation not found.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    }
  };

  const openFeedbackPicker = async (coachee: Coachee) => {
    const gen = beginLoad('coacheeFeedbacks');
    setLoadingCoacheeFeedbacks(true);
    setBackendNotice('');
    try {
      const records = await listCoacheeFeedbacks(coachee.id);
      if (!isCurrentLoad('coacheeFeedbacks', gen)) return;
      if (records.length === 1) {
        openFeedbackRecord(records[0]);
        return;
      }
      setCoacheeFeedbacks(records);
      setFeedbackPickerCoachee(coachee);
    } catch (error) {
      if (!isCurrentLoad('coacheeFeedbacks', gen)) return;
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      if (isCurrentLoad('coacheeFeedbacks', gen)) setLoadingCoacheeFeedbacks(false);
    }
  };

  // Everything downstream of "this is the coachee we are looking at" — the
  // header of their games list, the name the form is filled with. Split out of
  // the row tap because the row's own buttons reach those views without ever
  // opening the sheet, and a games list under the previously selected name is
  // an observation started on the wrong person.
  /** Open a route that names a coachee — `#/games/<coachee>` and
   *  `#/feedbacks/<coachee>[/<observation>]`.
   *
   *  Everything these need is fetched here rather than assumed, which is the
   *  whole point of putting the id in the URL: the link works pasted into a
   *  fresh tab, sent to another coach, or opened from a mail, with nothing
   *  carried over from the screen you would otherwise have come from. */
  const openDeepLink = async (r: AppRoute) => {
    if (!r.coacheeId) return;
    const coachee = coachees.find((c) => c.id === r.coacheeId);
    if (!coachee) {
      // Deleted, or on a season this coach is not looking at. Say so; landing
      // silently on the coachee list looks like the link simply did nothing.
      setBackendNotice(formData.lang === 'DE'
        ? 'Coachee nicht gefunden — vielleicht eine andere Saison.'
        : 'Coachee not found — possibly a different season.');
      setFeedbackSubView('coachees');
      setListTab('coachees');
      return;
    }
    selectCoachee(coachee);
    if (r.subView === 'coacheeGames') {
      await loadCoacheeGames(coachee);
      return;
    }
    if (!r.feedbackId) {
      await openFeedbackPicker(coachee);
      return;
    }
    const gen = beginLoad('coacheeFeedbacks');
    setLoadingCoacheeFeedbacks(true);
    try {
      const records = await listCoacheeFeedbacks(coachee.id);
      if (!isCurrentLoad('coacheeFeedbacks', gen)) return;
      const record = records.find((x) => x.id === r.feedbackId);
      if (!record) {
        setBackendNotice(formData.lang === 'DE' ? 'Beobachtung nicht gefunden.' : 'Observation not found.');
        setCoacheeFeedbacks(records);
        setFeedbackPickerCoachee(coachee);
        return;
      }
      setCoacheeFeedbacks(records);
      openFeedbackRecord(record);
    } catch (error) {
      if (!isCurrentLoad('coacheeFeedbacks', gen)) return;
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      if (isCurrentLoad('coacheeFeedbacks', gen)) setLoadingCoacheeFeedbacks(false);
    }
  };

  // Back/Forward reaches openDeepLink through a ref: its listener is registered
  // once and must not close over a stale coachee list.
  const openDeepLinkRef = useRef(openDeepLink);
  openDeepLinkRef.current = openDeepLink;

  const selectCoachee = (coachee: Coachee) => {
    setSelectedCoacheeId(coachee.id);
    setSelectedCoacheeName(coachee.full_name || '');
    setSelectedCoacheeLevel(coachee.referee_level || '');
    applyCoacheeToMeta(coachee);
  };

  /** Open (or close) a coachee's row. Everything the detail sheet used to hold
   *  is in the panel underneath it now, so the row toggles rather than covering
   *  the list with a dialog you had to dismiss to compare two people. */
  const handleSelectCoachee = (coachee: Coachee) => {
    const opening = expandedCoacheeId !== coachee.id;
    setExpandedCoacheeId(opening ? coachee.id : null);
    if (!opening) return;
    // The draft starts from what is stored; an unsaved edit is dropped when the
    // row closes, which is what closing it means.
    setDetailNotes(coachee.notes || '');
    selectCoachee(coachee);
  };

  const openCoacheeGames = (coachee: Coachee) => {
    selectCoachee(coachee);
    void loadCoacheeGames(coachee);
  };

  const handleSaveNotes = async () => {
    if (!detailCoachee) return;
    setSavingNotes(true);
    try {
      await updateCoachee(detailCoachee.id, { notes: detailNotes });
      setCoachees((prev) =>
        prev.map((c) => (c.id === detailCoachee.id ? { ...c, notes: detailNotes } : c))
      );
      setBackendNotice(t.notesSaved);
    } catch {
      setBackendNotice(t.notesSaveError);
    } finally {
      setSavingNotes(false);
    }
  };

  // "Di 15.09." / "Tue 15/09" — the date shorthand the dashboard rows use.
  const shortDate = (d: string) => {
    const dt = new Date(d);
    return Number.isNaN(dt.getTime())
      ? d
      : dt.toLocaleDateString(formData.lang === 'DE' ? 'de-CH' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };

  // Observations are counted, not just flagged: a coachee can be watched more
  // than once a season, so the second one says so. First one stays unnumbered —
  // "1. Beobachtung geplant" would be noise on the common case.
  const obsLabel = (n: number, kind: 'planned' | 'uploaded') => {
    const base = kind === 'planned' ? t.plannedObservation : t.uploadedObservation;
    if (n <= 1) return base;
    return formData.lang === 'DE' ? `${n}. ${base}` : `${englishOrdinal(n)} ${base}`;
  };

  const observationCount = (coachee: Coachee) =>
    coachee.observation_status?.count ?? coachee.observations_count ?? 0;

  const coacheeBalls = (coachee: Coachee, plannedObs?: PlannedObs) => {
    const isActive = (coachee.stage || 'active') !== 'inactive';
    const status = coachee.observation_status;
    const balls: Array<{ color: string; title: string; key: string }> = [];
    const filed = observationCount(coachee);
    // Filed observations first, then the one still out on a taken game — read
    // together they are the season so far: "hochgeladen, 2. geplant".
    if (filed > 0 || status?.hasCompletedObservation) {
      balls.push({ key: 'done', color: 'bg-emerald-100 text-emerald-800', title: obsLabel(Math.max(filed, 1), 'uploaded') });
    }
    // An RC has taken one of their games, so the honest status is "booked" —
    // and it stays booked until the feedback is uploaded. "Keine Beobachtung"
    // on a coachee whose observation is already scheduled read as untouched and
    // sent coaches looking for a game to take.
    if (isActive && plannedObs) {
      balls.push({ key: 'planned', color: 'bg-sky-100 text-sky-800', title: obsLabel(filed + 1, 'planned') });
    } else if (isActive && filed === 0 && (status?.hasNoObservation ?? false)) {
      balls.push({ key: 'none', color: 'bg-amber-100 text-amber-800', title: t.noObservation });
    }
    if (isActive && (status?.hasFurtherObservationNeeded ?? false)) {
      balls.push({ key: 'further', color: 'bg-orange-100 text-orange-800', title: t.furtherObservation });
    }
    return balls;
  };

  const groupedCalendarGames = calendarGames.reduce<Record<string, CalendarGameStatus[]>>((acc, game) => {
    const key = asInputDate(game.date) || 'unknown';
    acc[key] = acc[key] ? [...acc[key], game] : [game];
    return acc;
  }, {});

  const sortedCalendarDays = Object.keys(groupedCalendarGames).sort();

  const statusDotClass = (status: CalendarGameStatus['status']) => {
    if (status === 'outstanding') {
      return 'bg-yellow-400';
    }
    if (status === 'completed') {
      return 'bg-emerald-500';
    }
    return 'bg-stone-300';
  };

  const handleDownloadPdf = async () => {
    // This button is the coach's rescue: it snapshots the form EXACTLY as it
    // stands, half-filled and unsigned included, with none of the send-time
    // validation. So it must never fail in silence — the whole call used to be
    // an unguarded `void`, and the two ways it throws are the two moments it is
    // most needed: the lazy chunk is gone after a deploy (the same failure
    // submitSingleFeedback already handles), or the share sheet rejects.
    const de = formData.lang === 'DE';
    try {
      const { buildFeedbackPdf } = await loadPdfBuilder();
      // The PDF is always German — it is the document the referee is sent and
      // files, and the coaching vocabulary it is written in is German whatever
      // language the coach set the app to. The emailed copy already did this; the
      // downloaded one carried the UI language, so the same observation existed
      // as two different documents.
      const pdfData = toGermanFormData(formData);
      const pdf = buildFeedbackPdf(pdfData);

      const file = new File([pdf.output('blob')], pdfFilename(pdfData), { type: 'application/pdf' });
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: t.title,
          files: [file],
        });
        return;
      }
      pdf.save(pdfFilename(formData));
    } catch (err) {
      // Dismissing the share sheet is a choice, not a failure — telling the
      // coach their download broke because they changed their mind is worse
      // than saying nothing.
      if ((err as Error)?.name === 'AbortError') return;
      toast.error(de
        ? 'PDF konnte nicht erstellt werden (App-Update nötig). Bitte die Seite neu laden — deine Eingaben bleiben erhalten.'
        : 'Could not build the PDF (app update needed). Please reload the page — your entries are kept.', { lang: formData.lang });
    }
  };

  const handleDownloadEmptyForm = async (choice: '1SR' | '2SR' | 'both') => {
    setDownloadingEmptyForm(true);
    setShowEmptyFormModal(false);
    try {
      const { buildEmptyFeedbackPdf } = await loadPdfBuilder();
      const roles: FeedbackFormData['role'][] = choice === '1SR' ? ['1. SR']
        : choice === '2SR' ? ['2. SR']
        : ['1. SR', '2. SR'];
      buildEmptyFeedbackPdf(roles).save(choice === 'both' ? 'feedback-empty.pdf' : `feedback-${choice}-empty.pdf`);
    } finally {
      setDownloadingEmptyForm(false);
    }
  };

  const handleManualUploadSubmit = async (form: HTMLFormElement) => {
    // Claimed before the first await. Encoding the file takes long enough on a
    // tablet that a second tap used to start a whole second submission, and the
    // button only disables on this flag.
    if (manualUploadSubmitting) return;
    setManualUploadSubmitting(true);
    try {
      await runManualUploadSubmit(form);
    } finally {
      setManualUploadSubmitting(false);
    }
  };

  const runManualUploadSubmit = async (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const role = fd.get('role') as FeedbackFormData['role'];
    const file = fd.get('formFile') as File;
    if (!file || file.size === 0) { setManualUploadNotice(t.manualUploadFileRequired); return; }

    // Build sections from form data
    const sectionsDef = role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE;
    const sections = sectionsDef.map(section => ({
      ...section,
      items: section.items.map(item => ({
        ...item,
        rating: (fd.get(`rating-${item.id}`) as string) || '',
      })),
    }));

    // Check all ratings filled
    const unrated = sections.flatMap(s => s.items).filter(it => !it.rating);
    if (unrated.length > 0) { setManualUploadNotice(t.manualUploadFieldsMissing); return; }

    const spielniveau = fd.get('spielniveau') as string;
    const motivation = fd.get('motivation') as string;
    const einstufung = fd.get('einstufung') as string;
    const secondBesuch = fd.get('secondBesuch') as string;
    const srZiel = fd.get('srZiel') as string;
    if (!spielniveau || !motivation || !einstufung || !secondBesuch || !srZiel) {
      setManualUploadNotice(t.manualUploadFieldsMissing); return;
    }

    const feedbackData: FeedbackFormData = {
      role,
      lang: 'DE',
      meta: {
        spielNr: (fd.get('spielNr') as string) || '',
        liga: (fd.get('liga') as string) || '',
        datum: (fd.get('datum') as string) || '',
        ort: (fd.get('ort') as string) || '',
        mannschaften: (fd.get('mannschaften') as string) || '',
        ergebnis: [fd.get('ergebnisSets') as string, fd.get('ergebnisPoints') as string].filter(Boolean).join(' | ') || (fd.get('ergebnis') as string) || '',
        srName: (fd.get('srName') as string) || '',
        srNiveau: (fd.get('srNiveau') as string) || '',
        rc: (fd.get('rc') as string) || '',
        gruppe: (fd.get('gruppe') as string) || '',
      },
      sections,
      results: {
        spielniveau: spielniveau as FeedbackFormData['results']['spielniveau'],
        motivation: motivation as FeedbackFormData['results']['motivation'],
        einstufung: einstufung as FeedbackFormData['results']['einstufung'],
        secondBesuch: secondBesuch as FeedbackFormData['results']['secondBesuch'],
        bemerkungen: (fd.get('bemerkungen') as string) || '',
        highlights: (fd.get('highlights') as string) || '',
        improvements: (fd.get('improvements') as string) || '',
        goals: (fd.get('goals') as string) || '',
        srZiel,
      },
    };

    // Convert file to base64
    const arrayBuf = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const fileBase64 = btoa(binary);

    // The server requires a real game; there is no "let the server sort it out"
    // path. Resolving here turns a mistyped or blank match number into a
    // sentence about the match number, instead of a raw 400 after ~20 ratings.
    const matchNo = (feedbackData.meta.spielNr || '').trim();
    const matchingGame = eligibleGames.find(g => (g.matchNo || '').trim() === matchNo);
    if (!matchNo || !matchingGame) {
      setManualUploadNotice(formData.lang === 'DE'
        ? `Spiel-Nr. ${matchNo ? `«${matchNo}» ` : ''}nicht gefunden — bitte die Nummer eines Spiels aus der Liste eintragen.`
        : `Match no. ${matchNo ? `"${matchNo}" ` : ''}not found — enter the number of a game from the list.`);
      return;
    }
    const gameId = matchingGame.id;

    setManualUploadNotice('');
    try {
      const result = await saveFeedbackToPocketBase({
        gameId,
        role,
        formData: feedbackData,
        pdfBase64: fileBase64,
        pdfFilename: file.name || 'manual-feedback.pdf',
        tipsAndTricks: '',
      });
      if (result.emailSent) {
        setManualUploadNotice(t.manualUploadSuccess);
      } else {
        setManualUploadNotice(result.emailWarning
          ? `${t.saveOkNoEmail} ${result.emailWarning}`
          : t.manualUploadSuccess);
      }
      // An uploaded paper form is a filed observation like any other: without
      // this the game stayed on the open list and the coachee kept reading
      // "no observation" until the next page load.
      void refreshAfterFeedback();
      setTimeout(() => setManualUploadCoachee(null), 2000);
    } catch (err: unknown) {
      setManualUploadNotice(`${t.manualUploadError} ${err instanceof Error ? err.message : ''}`);
    }
  };

  /**
   * The filed document and the e-mail are always German, whatever language the
   * coach worked in. The criteria wording therefore has to come from the German
   * catalogue rather than from `fd.sections`, which carries whichever language
   * was on screen; ratings travel with the item id.
   */
  const toGermanFormData = (fd: FeedbackFormData): FeedbackFormData => {
    const catalogue = adjustSectionsFor2SR(
      fd.role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE,
      gameHas2SR,
    );
    const ratings = new Map(fd.sections.flatMap(s => s.items.map(i => [i.id, i.rating] as const)));
    return {
      ...fd,
      lang: 'DE' as const,
      sections: catalogue.map(section => ({
        ...section,
        items: section.items.map(item => ({ ...item, rating: ratings.get(item.id) ?? '' })),
      })),
    };
  };

  const submitSingleFeedback = async (fd: FeedbackFormData, tips: string): Promise<string> => {
    if (!selectedGame) throw new Error(t.noGames);
    // Built straight from the data, so the on-screen form no longer has to be
    // switched to German and re-rendered before the attachment can be made.
    const deFormData = toGermanFormData(fd);
    // The PDF chunk is lazy-loaded, and after a deploy the old chunk hash is
    // gone — so the import can reject with the completed observation still only
    // in memory. Build the payload INSIDE the try, and treat an import/build
    // failure like any other pre-server failure: hold it in the outbox rather
    // than throwing it away.
    let payload: Awaited<ReturnType<typeof buildSubmitPayload>> | null = null;
    async function buildSubmitPayload() {
      const { feedbackPdfBase64 } = await loadPdfBuilder();
      return {
        gameId: selectedGame!.id,
        role: fd.role,
        formData: deFormData,
        pdfBase64: feedbackPdfBase64(deFormData),
        pdfFilename: pdfFilename(deFormData),
        tipsAndTricks: tips,
      };
    }
    try {
      payload = await buildSubmitPayload();
      const result = await saveFeedbackToPocketBase(payload);
      // Per role, the moment the server confirms it — never on the outer save
      // returning, because the dual-mode loop can file '1. SR' and then throw on
      // '2. SR'. The record is blanked to a tombstone: what survives is only the
      // memory that this game+role was sent, which feedbackLocked cannot provide
      // because it dies with the page.
      void setDraftStatus(outboxOwnerId, selectedGame.id, fd.role, 'filed').catch(() => {});
      // The local record is blanked to a tombstone, so the parked copy must not
      // outlive it — it is a full signed assessment with nothing left to guard.
      void unparkDrafts(selectedGame.id).catch(() => {});
      // The new record's id travels back so the sender can add a private note to
      // the RC president straight away, without reopening the game to find it.
      // Not in dual mode: two records are filed in one go and only one form is
      // on screen, so a note box there would attach to whichever finished last.
      if (!dualMode) { setOpenFeedbackId(result.id || null); setOpenFeedbackMine(true); }
      // The report is filed either way, so this is a warning beside the success,
      // not a failure. But the game still looks unobserved: someone can file and
      // mail a SECOND report for the same role, and a typed-in score was
      // dropped. The coach is the only one in a position to notice.
      const closureNote = result.closureFailed
        ? (fd.lang === 'DE'
          ? ' — Achtung: Die Rolle konnte im Spiel nicht als erledigt markiert werden, bitte im Admin prüfen.'
          : ' — note: the role could not be marked done on the game, please check in Admin.')
        : '';
      if (result.emailSent) {
        return result.emailWarning
          ? `${fd.role}: ${t.saveOkEmail} (${result.emailWarning})${closureNote}`
          : `${fd.role}: ${t.saveOkEmail}${closureNote}`;
      }
      return `${fd.role}: ${t.saveOkNoEmail} ${result.emailError || 'Unknown error'}${closureNote}`;
    } catch (err) {
      const e = err as Error & { status?: number; reachedServer?: boolean };
      const de = fd.lang === 'DE';
      const label = `${selectedGame.homeTeam} vs ${selectedGame.awayTeam} · ${fd.role}`;
      // The PDF chunk never loaded, so there is nothing to queue and retrying
      // this session would hit the same missing chunk. Ask for a reload, which
      // fetches the current build — the work is still on screen, unlost.
      if (!payload) {
        return `${fd.role}: ${de
          ? 'Konnte nicht senden (App-Update nötig). Bitte die Seite neu laden – deine Eingaben bleiben erhalten.'
          : 'Could not send (app update needed). Please reload the page – your entries are kept.'}`;
      }
      // An expired session is not a rejection of the work — the outbox replay
      // path already treats 401 as "retry after re-auth". Rethrowing it here
      // instead threw away a completed observation, because the only way back
      // to a login screen is a reload and nothing persists the form.
      if (e.status === 401) {
        await enqueueFeedback(payload, label, outboxOwnerId);
        void setDraftStatus(outboxOwnerId, selectedGame.id, fd.role, 'queued').catch(() => {});
        void refreshOutboxCount();
        return `${fd.role}: ${de
          ? 'Sitzung abgelaufen – Beobachtung zwischengespeichert. Bitte neu anmelden, sie wird dann automatisch gesendet.'
          : 'Session expired – observation stored locally. Log in again and it will send automatically.'}`;
      }
      // Reached the server but it rejected → a real error the coach must see.
      if (e.reachedServer) throw err;
      // Network failure / offline → hold it in the local outbox; it will be sent
      // (with real status) when connectivity returns. Never silently lost.
      await enqueueFeedback(payload, label, outboxOwnerId);
      // Marked, NOT deleted. discardFailedOutbox hard-deletes terminal items,
      // and terminal covers 400/403/422 — the FIXABLE errors. With the draft
      // gone, one tap on Discard would destroy the only copy of a finished
      // observation.
      void setDraftStatus(outboxOwnerId, selectedGame.id, fd.role, 'queued').catch(() => {});
      void refreshOutboxCount();
      return `${fd.role}: ${de ? 'Offline gespeichert – wird gesendet, sobald du online bist.' : 'Saved offline – will send when you are back online.'}`;
    }
  };

  const refreshOutboxCount = async () => {
    try {
      const { pending } = await outboxCounts(outboxOwnerId);
      setOutboxPending(pending);
      setOutboxFailed((await listOutbox(outboxOwnerId)).filter((i) => i.terminal));
      setOutboxForeign(await foreignOutboxSummary(outboxOwnerId));
    } catch { /* ignore */ }
  };

  // Classify a send attempt so the outbox knows to drop (sent/duplicate), retry
  // (transient — network, expired session, server 5xx), or mark terminal
  // (permanent — a validation/authorization error retrying won't fix).
  const sendOutbox = async (p: OutboxPayload): Promise<SendResult> => {
    try {
      await saveFeedbackToPocketBase(p as Parameters<typeof saveFeedbackToPocketBase>[0]);
      return { outcome: 'sent' };
    } catch (err) {
      const e = err as Error & { status?: number; reachedServer?: boolean };
      if (!e.reachedServer) return { outcome: 'retry', error: 'offline' };
      if (e.status === 409) return { outcome: 'duplicate' };          // already recorded
      if (e.status === 401 || (e.status ?? 500) >= 500) return { outcome: 'retry', error: e.message }; // re-auth / transient
      return { outcome: 'failed', error: e.message };                 // 400/403/422 — permanent
    }
  };

  const flushOutboxNow = async () => {
    if (!navigator.onLine) return;
    setFlushing(true);
    try {
      // The draft dies exactly when its outbox item does, and not a moment
      // earlier: only the per-item outcome says WHICH submission actually went.
      const { sent } = await flushOutbox(outboxOwnerId, sendOutbox, () => void refreshOutboxCount(),
        (item, outcome) => {
          if (outcome === 'sent' || outcome === 'duplicate') {
            void setDraftStatus(outboxOwnerId, item.payload.gameId, item.payload.role, 'filed').catch(() => {});
            void unparkDrafts(item.payload.gameId).catch(() => {});
          }
        });
      await refreshOutboxCount();
      if (sent > 0) {
        setBackendNotice(formData.lang === 'DE'
          ? `${sent} ausstehende Übermittlung${sent > 1 ? 'en' : ''} gesendet.`
          : `${sent} pending submission${sent > 1 ? 's' : ''} sent.`);
        // Regardless of the visible tab, so switching back to Home (or to the
        // coachee list) never shows the state from before the sync.
        void refreshAfterFeedback();
      }
    } finally {
      setFlushing(false);
    }
  };
  flushOutboxNowRef.current = flushOutboxNow;

  const discardFailedOutbox = async (id: string) => {
    const item = outboxFailed.find((i) => i.id === id);
    try {
      // Hand the work back BEFORE the queue entry goes. Terminal means 400/403/422
      // — a missing coachee e-mail, a wrong role/name pairing — all of which the
      // coach can fix and resend. Discarding the queue entry must return them to
      // an editable observation, not to nothing.
      if (item) await setDraftStatus(outboxOwnerId, item.payload.gameId, item.payload.role, 'editing').catch(() => {});
      await discardOutboxItem(id);
    } finally { void refreshOutboxCount(); void refreshDrafts(); }
  };

  const retryFailedOutbox = async (id: string) => {
    await retryOutboxItem(id);
    await refreshOutboxCount();
    void flushOutboxNow();
  };

  const handleSaveFeedback = async () => {
    if (!selectedGame) {
      setBackendNotice(t.noGames);
      return;
    }
    // Commit what is on screen before the send begins. If anything below throws
    // in a way that reloads the page, the observation is already on disk.
    await flushDraftNowRef.current();
    setSavingFeedback(true);
    setBackendNotice('');
    // submitSingleFeedback either sends (returns a notice), or on a NETWORK
    // failure stores the submission in the outbox and returns a "saved offline"
    // notice; only a real SERVER error throws. Locking the form after a
    // successful send/queue prevents accidental duplicate submissions.
    try {
      if (dualMode) {
        const notices: string[] = [];
        const roles = ['1. SR', '2. SR'] as const;
        for (const role of roles) {
          if (selectedGame.feedbackClosedRoles?.includes(role)) continue;
          const stored = role === formData.role
            ? { formData, tipsAndTricks }
            : dualFormData[role];
          if (!stored) continue;
          const fd = 'formData' in stored ? stored.formData : stored as FeedbackFormData;
          const tips = 'tipsAndTricks' in stored ? stored.tipsAndTricks : '';
          try {
            notices.push(await submitSingleFeedback(fd, tips));
          } catch (err) {
            // A role already recorded on the server (e.g. after a partial retry)
            // must not abort the other role — skip it and carry on.
            if ((err as { status?: number }).status === 409) continue;
            throw err;
          }
        }
        setFormData(formData);
        setBackendNotice(notices.join(' | '));
        setFeedbackLocked(true);
      } else {
        const notice = await submitSingleFeedback(formData, tipsAndTricks);
        setBackendNotice(notice.replace(`${formData.role}: `, ''));
        setFeedbackLocked(true);
      }
      // In the demo nothing is emailed — show the message(s) that would have gone out.
      if (isDemoMode()) {
        const mail = getSentMail();
        setDemoMail(mail);
        if (mail.length > 0) setDemoMailOpen(true);
      }
      // Refreshed in the background so every other tab is already up to date
      // when the coach navigates back to it.
      void refreshAfterFeedback();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(`${t.saveError} ${localizeRuntimeError(reason, formData.lang)}`);
    } finally {
      setSavingFeedback(false);
    }
  };

  // Pre-filled in the demo so the section — and the part of the feedback mail
  // that carries it — is visible without typing; empty in the real app.
  const [tipsAndTricks, setTipsAndTricks] = useState(demoTips);
  const [feedbackLocked, setFeedbackLocked] = useState(false);
  // Only the coach who filed an observation (or an admin) may write its note.
  // Anyone else opening the same record would get a box that 403s on save.
  const [openFeedbackMine, setOpenFeedbackMine] = useState(false);
  const [presidentNote, setPresidentNote] = useState('');
  const [presidentNoteLoaded, setPresidentNoteLoaded] = useState(false);
  const [presidentNoteSaving, setPresidentNoteSaving] = useState(false);
  const [presidentNoteSaved, setPresidentNoteSaved] = useState(false);
  const [presidentNoteError, setPresidentNoteError] = useState('');

  // Pull whatever note this observation already carries whenever one is opened,
  // so reopening a game shows what was written last time instead of a blank box.
  useEffect(() => {
    setPresidentNote(''); setPresidentNoteSaved(false); setPresidentNoteError(''); setPresidentNoteLoaded(false);
    if (!openFeedbackId) return;
    let cancelled = false;
    getPresidentNote(openFeedbackId)
      .then(({ note }) => { if (!cancelled) { setPresidentNote(note || ''); setPresidentNoteLoaded(true); } })
      .catch((error) => {
        // Leaving the box enabled and empty here would let a save overwrite a
        // note that exists and simply could not be read — so say so and keep
        // the box shut until a reload gets a real answer.
        if (cancelled) return;
        const reason = error instanceof Error ? error.message : String(error);
        setPresidentNoteError(localizeRuntimeError(reason, formData.lang));
      });
    return () => { cancelled = true; };
  }, [openFeedbackId]);

  const savePresidentNoteNow = async () => {
    if (!openFeedbackId) return;
    setPresidentNoteSaving(true); setPresidentNoteError(''); setPresidentNoteSaved(false);
    try {
      await savePresidentNote(openFeedbackId, presidentNote);
      setPresidentNoteSaved(true);
      setTimeout(() => setPresidentNoteSaved(false), 2500);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setPresidentNoteError(localizeRuntimeError(reason, formData.lang));
    } finally {
      setPresidentNoteSaving(false);
    }
  };
  // Demo mode: emails aren't sent, they're shown. This holds the captured
  // preview(s) and controls the preview modal (auto-opened after a demo submit).
  const [demoMail, setDemoMail] = useState<DemoEmail[]>([]);
  const [demoMailOpen, setDemoMailOpen] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState<'reset' | 'save' | null>(null);
  const [validationError, setValidationError] = useState('');

  const validateSingleForm = (fd: FeedbackFormData): string | null => {
    const unrated = fd.sections.flatMap(s => s.items).filter(it => !it.rating);
    if (unrated.length > 0) {
      return fd.lang === 'DE'
        ? `Bitte alle Bewertungen ausfüllen (${unrated.length} fehlend).`
        : `Please fill in all ratings (${unrated.length} missing).`;
    }
    const r = fd.results;
    if (!r.spielniveau || !r.motivation || !r.einstufung || !r.secondBesuch || !r.srZiel) {
      return fd.lang === 'DE'
        ? 'Bitte alle Felder im unteren Bereich ausfüllen (Spielniveau, Motivation, Ausblick, 2. Besuch, SR-Ziel).'
        : 'Please fill in all bottom fields (Match Level, Motivation, Outlook, 2nd Visit, Referee Goal).';
    }
    // The result is on the form and in the mail the coachee gets, so a missing
    // or impossible one (3:0 with a set the winner lost) has to stop the send.
    const resultError = validateResult(fd.meta.ergebnis, fd.lang);
    if (resultError) return resultError;
    // Both signatures: the referee confirming the feedback was discussed with
    // them, the coach standing behind what it says. Without either, the PDF is
    // an unacknowledged assessment.
    if (!fd.signature) {
      return fd.lang === 'DE'
        ? 'Bitte die Unterschrift des Schiedsrichters einholen.'
        : 'Please capture the referee’s signature.';
    }
    if (!fd.rcSignature) {
      return fd.lang === 'DE'
        ? 'Bitte die Unterschrift des Referee Coach einholen.'
        : 'Please capture the referee coach’s signature.';
    }
    return null;
  };

  const validateForm = (): boolean => {
    // Validate current form
    const currentError = validateSingleForm(formData);
    if (currentError) {
      setValidationError(currentError);
      return false;
    }

    // In dual mode, also validate the other role's form
    if (dualMode) {
      const otherRole = formData.role === '1. SR' ? '2. SR' : '1. SR';
      const otherClosed = selectedGame?.feedbackClosedRoles?.includes(otherRole);
      if (!otherClosed) {
        const otherData = dualFormData[otherRole];
        if (!otherData) {
          setValidationError(formData.lang === 'DE'
            ? `Bitte auch das Formular fuer ${otherRole} ausfuellen.`
            : `Please also fill in the form for ${otherRole}.`);
          return false;
        }
        const otherError = validateSingleForm(otherData.formData);
        if (otherError) {
          setValidationError(formData.lang === 'DE'
            ? `${otherRole}: ${otherError}`
            : `${otherRole}: ${otherError}`);
          return false;
        }
      }
    }

    setValidationError('');
    return true;
  };

  // Escape closes the topmost open overlay. None of the modals handled a key at
  // all, so a keyboard user who opened one had no way out but the mouse. Ordered
  // most-transient first so Escape peels one layer at a time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showConfirmModal !== null) { setShowConfirmModal(null); return; }
      if (sigModalOpen) { setSigModalOpen(false); return; }
      if (demoMailOpen) { setDemoMailOpen(false); return; }
      if (showInfoModal) { setShowInfoModal(false); return; }
      if (showCalendarModal) { setShowCalendarModal(false); return; }
      if (showEmptyFormModal) { setShowEmptyFormModal(false); return; }
      if (expandedCoacheeId !== null) { setExpandedCoacheeId(null); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showConfirmModal, sigModalOpen, demoMailOpen, showInfoModal, showCalendarModal, showEmptyFormModal, expandedCoacheeId]);

  const isGameRoleClosed = selectedGame?.feedbackClosedRoles?.includes(formData.role) ?? false;
  /**
   * This role's submission has already left the form: it is sitting in the
   * outbox ('queued') or the server has confirmed it ('filed').
   *
   * `feedbackLocked` cannot answer this — it lives in React state and dies with
   * the page — and neither can the server for a report it deliberately left the
   * role open for (a `closureFailed`, or one recommending a second visit). So
   * after an offline send and a reload, tapping that game in the LIST handed the
   * coach a blank, fully editable form for an observation already owed, and
   * filing it again would send the referee a second report and a second PDF.
   * The banner already refused to Resume such a role; this closes the other door.
   */
  const draftRoleSent: '' | 'queued' | 'filed' = (() => {
    const rec = drafts.find((d) => d.gameId === selectedGameId && d.role === formData.role);
    if (!rec) return '';
    return rec.status === 'queued' ? 'queued' : rec.status === 'filed' ? 'filed' : '';
  })();
  const formDisabled = feedbackLocked || isGameRoleClosed || !!draftRoleSent;

  // ── Drafts: the in-progress observation, held on this device ──────────
  //
  // A half-filled observation used to live only in React state, so a dead
  // battery, an accidental tab close or an evicted PWA destroyed it outright.
  // It is now committed to IndexedDB continuously, and the same work can be
  // exported to a file and re-imported — on another device if need be.

  const otherRole: FeedbackFormData['role'] = formData.role === '1. SR' ? '2. SR' : '1. SR';
  const otherStash = dualFormData[otherRole];

  // Every condition that makes writing a draft correct. `draftOwnerRef` is the
  // load-bearing one: it is the identity the work on SCREEN belongs to, which
  // is not the same thing as the identity currently signed in during the moment
  // after a coach hand-off.
  const draftContext = !!selectedGameId
    && !openFeedbackId                      // a filed record is not a draft
    && !formDisabled                        // locked or server-closed is not a draft
    && !isDemoMode()                        // the demo promises nothing is stored
    && draftStoreOk
    && outboxOwnerId !== 'anon'
    && draftOwnerRef.current === outboxOwnerId
    && draftLoadingRef.current === '';

  const draftWorth = draftHasWork(formData, tipsAndTricks)
    || !!(otherStash && draftHasWork(otherStash.formData, otherStash.tipsAndTricks));

  const buildDraftRecords = (owner: string): DraftRecord[] => {
    const out: DraftRecord[] = [];
    const push = (fd: FeedbackFormData, tips: string) => {
      if (!draftHasWork(fd, tips)) return;
      const prev = drafts.find((d) => d.gameId === selectedGameId && d.role === fd.role);
      out.push({
        id: draftKey(owner, selectedGameId, fd.role),
        schema: DRAFT_SCHEMA, ownerId: owner, gameId: selectedGameId, role: fd.role,
        updatedAt: Date.now(),
        status: 'editing', submissionKey: '',
        label: selectedGame ? `${selectedGame.homeTeam} vs ${selectedGame.awayTeam}` : '',
        matchNo: selectedGame?.matchNo || '',
        observationTarget, resultUnlocked,
        coacheeId: selectedCoacheeId, coacheeName: selectedCoacheeName, coacheeLevel: selectedCoacheeLevel,
        lang: fd.lang, meta: { ...fd.meta },
        ratings: ratingsFromSections(fd.sections),
        results: { ...fd.results } as Record<string, string>,
        signature: fd.signature || '', rcSignature: fd.rcSignature || '',
        tipsAndTricks: tips,
        // Carried, not dropped: a field a NEWER build wrote survives a round
        // trip through this one instead of being silently stripped.
        extra: prev?.extra,
      });
    };
    push(formData, tipsAndTricks);
    if (otherStash) push(otherStash.formData, otherStash.tipsAndTricks);
    return out;
  };

  const refreshDrafts = async () => {
    // A read failure is a missing banner, not an error worth a red line. A
    // WRITE failure is the one that matters, and it surfaces via draftSaveFailed.
    try { setDrafts(await listDrafts(outboxOwnerId)); } catch { /* leave the list as it is */ }
  };

  /**
   * The server backup, always on. Deliberately a second, much slower clock than
   * the local commit: the device copy is what protects the last keystroke, this
   * one only has to outlive the device itself. A park that fails while offline
   * says nothing — a backup that nags in a hall with no signal is noise, and the
   * next park catches up.
   *
   * It is unconditional rather than opt-in because the failure it guards against
   * — a phone lost, stolen, drowned or simply dead — gives no warning and leaves
   * the coach nothing to fall back on. The endpoint scopes every read to the
   * session's own RC, so a parked draft is only ever visible to its author.
   */
  const parkNow = async (records: DraftRecord[], gameId: string) => {
    if (records.length === 0 || !gameId) return;
    // A parked draft belongs to a PERSON, so the server refuses a bare console
    // session — correctly. Not attempting it there keeps that refusal from
    // showing an admin a backup-failed warning on every observation they file.
    if (outboxOwnerId === 'admin') return;
    try {
      await parkDrafts(gameId, records);
      setParkFailed(false); setParkedOk(true);
    } catch (err) {
      // Only a server that ANSWERED and refused is worth a word: a missing
      // collection, a rejected size, a rate limit. A failed fetch is just the
      // gym's wifi, and the next park catches up.
      if ((err as { reachedServer?: boolean })?.reachedServer) setParkFailed(true);
    }
  };
  const parkSoon = () => {
    const gameId = selectedGameId;
    const owner = draftOwnerRef.current;
    if (parkTimerRef.current) clearTimeout(parkTimerRef.current);
    parkTimerRef.current = setTimeout(() => {
      parkTimerRef.current = null;
      // The STORE at fire time, never the snapshot this timer was armed with.
      // Forty-five seconds is long enough for the work to LEAVE the form: a send
      // blanks the record to a tombstone and deletes the parked copy, Discard and
      // the reset dialog delete both. Re-uploading what the form happened to hold
      // back then would put exactly what those paths destroyed back on the
      // server, where the next device's boot merge would adopt it as live work.
      void (async () => {
        const live = await getGameDrafts(owner, gameId).catch(() => [] as DraftRecord[]);
        // Filtered here rather than relying on parkDrafts' own filter: a list of
        // pure tombstones would otherwise slip past parkNow's empty check and
        // report a backup that no longer exists.
        await parkNow(live.filter((d) => d.status === 'editing'), gameId);
      })();
    }, 45_000);
  };
  const parkImmediately = () => {
    if (!draftContext) return;
    if (parkTimerRef.current) { clearTimeout(parkTimerRef.current); parkTimerRef.current = null; }
    const gameId = selectedGameId;
    void (async () => {
      // Through the same guard the autosave uses, rather than straight from the
      // form: a role already filed or queued must not be re-parked out of the
      // copy still sitting in memory.
      const live = await putDrafts(buildDraftRecords(draftOwnerRef.current), true).catch(() => [] as DraftRecord[]);
      await parkNow(live, gameId);
    })();
  };
  parkImmediatelyRef.current = parkImmediately;

  const commitDraft = async (): Promise<void> => {
    if (!draftContext) { setDraftUnsaved(false); return; }
    const records = buildDraftRecords(draftOwnerRef.current);
    if (records.length === 0) { setDraftUnsaved(false); return; }
    try {
      // ONE transaction for both roles, so the fields the two forms mirror —
      // the coach's signature and the score — commit together or not at all.
      // The store refuses to demote a role that has already been sent, so park
      // what it ACCEPTED rather than what this render offered it.
      const written = await putDrafts(records, true);
      void requestPersistentStorage();
      // Nothing this form owns is still a draft — every record it offered had
      // already been sent. Saying "Entwurf gespeichert" there would be a claim
      // about a write that deliberately did not happen.
      if (written.length === 0) { setDraftUnsaved(false); void refreshDrafts(); return; }
      setResumeHint(selectedGameId);
      setDraftUnsaved(false); setDraftSaveFailed(false); setDraftSavedAt(Date.now());
      void refreshDrafts();
      // The server backup rides on a much coarser clock than the local commit:
      // IndexedDB is what protects the last keystroke, this only has to survive
      // the device itself. Gated on the owner MATCHING, because the coach
      // hand-off flushes this function under the outgoing identity while the
      // session cookie already names the incoming one — parking there would
      // file A's work under B's name on the server.
      if (written.length > 0 && draftOwnerRef.current === outboxOwnerId) parkSoon();
    } catch {
      // Best-effort by construction: a draft write must NEVER throw into the
      // submit path, or a full disk would stop a finished observation reaching
      // the outbox. But it is SURFACED rather than swallowed — silence is right
      // for a counter and wrong for "did my work save?".
      setDraftSaveFailed(true);
    }
  };
  flushDraftNowRef.current = commitDraft;

  useEffect(() => {
    // EVERY exit path clears the pending flag. A flag stuck true parks the
    // service-worker reload for the life of the page.
    if (!draftContext || !draftWorth) { setDraftUnsaved(false); return; }
    setDraftUnsaved(true);
    const timer = setTimeout(() => { void commitDraft(); }, 1200);
    return () => clearTimeout(timer);
  }, [formData, dualFormData, tipsAndTricks, observationTarget, resultUnlocked,
      selectedCoacheeId, selectedCoacheeName, selectedCoacheeLevel,
      selectedGameId, draftContext, draftWorth]);

  useEffect(() => {
    // `pagehide` and a hidden `visibilitychange` are what actually fire when
    // iOS Safari kills a tab or an installed PWA — `beforeunload` does not fire
    // there at all, which is exactly the case this whole feature exists for.
    const flush = () => { void flushDraftNowRef.current(); parkImmediatelyRef.current(); };
    const onHide = () => {
      flush();
      // Leaving, not merely backgrounding: a backgrounded tab still holds the
      // work it must keep warning other tabs about.
      releaseDraft();
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    window.__svrzFlushDraft = () => flushDraftNowRef.current();
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
      // The park is a 45 s promise this component cannot keep past its own life.
      // A coach hand-off UNMOUNTS App (AuthGate renders its children only while
      // authed) and re-cookies the session under the incoming coach seconds
      // later, so an armed timer would PUT the outgoing coach's ratings and both
      // signatures under the incoming coach's owner_id — precisely what the
      // owner check inside commitDraft exists to prevent. Cancelled rather than
      // flushed: the IndexedDB copy is untouched, so at most the last 45 s of
      // the SERVER backup is deferred to the next edit, and on logout the cookie
      // is being revoked anyway.
      if (parkTimerRef.current) { clearTimeout(parkTimerRef.current); parkTimerRef.current = null; }
      // A commit suspended on its IndexedDB round trip resumes AFTER this
      // cleanup and would arm a park the cleanup can no longer reach. Clearing
      // the owner is what that resume's guard reads, so the late park is dropped.
      draftOwnerRef.current = '';
      releaseDraft();
      delete window.__svrzFlushDraft;
    };
  }, []);

  // Advisory cross-tab claim. `claimDraft` is idempotent for an unchanged
  // triple and releases the previous observation itself, so this can run on
  // every relevant render without bookkeeping of its own.
  useEffect(() => {
    if (!draftContext) { releaseDraft(); return; }
    claimDraft(outboxOwnerId, selectedGameId, formData.role);
  }, [draftContext, outboxOwnerId, selectedGameId, formData.role]);

  useEffect(() => subscribeDraftClaims((n: DraftClaimNotice) => setDraftClaimedElsewhere(n.active)), []);

  // Commit and back up a captured signature at once, on the render that has it.
  // Fires for a cleared signature too — that also wants writing immediately.
  useEffect(() => {
    if (!sigFlushToken) return;
    void flushDraftNowRef.current();
    parkImmediatelyRef.current();
  }, [sigFlushToken]);

  // A resume that turns out to be impossible must hand the selection back to
  // the games list, which deferred its own auto-select while a resume was pending.
  const releaseAutoSelect = () => {
    autoResumeRef.current = '';
    clearResumeHint();
    if (!selectedGameIdRef.current && eligibleGames.length > 0) setSelectedGameId(eligibleGames[0].id);
  };

  const formDataFromDraft = (d: DraftRecord, has2SR: boolean): FeedbackFormData => {
    const role: FeedbackFormData['role'] = d.role === '2. SR' ? '2. SR' : '1. SR';
    const lang: FeedbackFormData['lang'] = d.lang === 'EN' ? 'EN' : 'DE';
    // Rebuilt from the catalogue in the DRAFT's own language and projected by
    // item id — the inverse of toGermanFormData, and unlike normalizeLoadedFeedback
    // it neither overlays by array index nor reads a previous game's 2-referee flag.
    const catalogue = role === '1. SR'
      ? adjustSectionsFor2SR(lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, has2SR)
      : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
    return {
      ...INITIAL_DATA, role, lang,
      meta: { ...INITIAL_DATA.meta, ...(d.meta || {}) },
      results: { ...INITIAL_DATA.results, ...(d.results || {}) } as Results,
      sections: catalogue.map((s) => ({
        ...s, items: s.items.map((i) => ({ ...i, rating: d.ratings?.[i.id] || '' })),
      })),
      signature: d.signature || '',
      // INITIAL_DATA leaves this undefined rather than '', and the difference is
      // load-bearing for the mandatory-signature gate.
      rcSignature: d.rcSignature || undefined,
    };
  };

  const resumeDraft = (records: DraftRecord[]) => {
    const editing = records.filter((d) => d.status === 'editing' && (d.schema ?? 1) <= DRAFT_SCHEMA);
    if (editing.length === 0) { releaseAutoSelect(); draftLoadingRef.current = ''; return; }
    const game = eligibleGames.find((g) => g.id === editing[0].gameId);
    if (!game) { setBackendNotice(t.draftGameMissing); releaseAutoSelect(); draftLoadingRef.current = ''; return; }
    const has2SR = !!game.secondReferee;   // THIS game, not a stale flag from the last one
    const live = editing.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const other = editing.find((d) => d.role !== live.role);

    const stash: typeof dualFormData = { '1. SR': null, '2. SR': null };
    if (other) stash[other.role] = { formData: formDataFromDraft(other, has2SR), tipsAndTricks: other.tipsAndTricks };

    // A sibling already queued or filed cannot be sent as a pair: validateForm
    // would demand a form for a role that is no longer editable, so collapse to
    // the single role that IS restorable. A sibling that was merely never
    // STARTED is a different thing — the visit is still the 'both' the coach
    // chose, and this record is the only thing left saying so. Collapsing there
    // silently filed one report on a two-referee visit.
    const blocked = !other && records.some((d) => d.role !== live.role && d.status !== 'editing');
    const target: '1SR' | '2SR' | 'both' =
      blocked ? (live.role === '2. SR' ? '2SR' : '1SR') : live.observationTarget;

    setSelectedGameId(game.id);
    setSelectedCoacheeId(live.coacheeId);
    setSelectedCoacheeName(live.coacheeName);
    setSelectedCoacheeLevel(live.coacheeLevel);
    setOpenFeedbackId(null); setOpenFeedbackMine(false); setFeedbackLocked(false);
    setResultUnlocked(live.resultUnlocked);
    setObservationTarget(target);
    setFormData(formDataFromDraft(live, has2SR));
    setTipsAndTricks(live.tipsAndTricks);
    setDualFormData(stash);
    setFeedbackSubView('feedbackForm');
    draftOwnerRef.current = outboxOwnerId;
    draftLoadingRef.current = '';
    autoResumeRef.current = '';

    // Filing writes the form's score onto the game, so a draft that disagrees
    // with a score published since would overwrite it without anyone noticing.
    // Put the disagreement in front of the coach instead.
    setDraftScoreConflict(
      live.resultUnlocked && game.game_result && game.game_result !== (live.meta.ergebnis || '')
        ? game.game_result : ''
    );
  };

  const resumeDraftForGame = async (gameId: string) => {
    try {
      const found = await getGameDrafts(outboxOwnerId, gameId);
      const editing = found.filter((d) => d.status === 'editing' && (d.schema ?? 1) <= DRAFT_SCHEMA);
      // No draft is the normal case: leave the fresh-game reset handleSelectGame
      // already performed exactly as it is.
      if (editing.length === 0) { draftLoadingRef.current = ''; return; }
      // The unfiltered list: resumeDraft filters internally, and it needs to see
      // a sibling that is queued or filed to tell that apart from one never started.
      resumeDraft(found);
      toast.success(t.draftRestored, { lang: formData.lang });
    } catch { draftLoadingRef.current = ''; }
  };

  const discardDraft = async (gameId: string) => {
    const ok = await confirmDialog({
      title: t.draftDiscardTitle,
      message: t.draftDiscardMsg,
      confirmLabel: t.draftDiscard,
      cancelLabel: formData.lang === 'DE' ? 'Abbrechen' : 'Cancel',
      tone: 'danger',
      lang: formData.lang,
    });
    if (!ok) return;
    try { await deleteDraft(outboxOwnerId, gameId); } catch { /* nothing to undo */ }
    // Discard means gone, including the server copy — leaving it parked would
    // resurrect the work on the next device the coach signs in on.
    void unparkDrafts(gameId).catch(() => {});
    if (gameId === selectedGameId) {
      // The form for THIS game is still in memory, and every flush path rebuilds
      // its record from that memory — handleSelectGame flushes before it does
      // anything else, so the next tap on the game wrote the discarded work
      // straight back and handed it over with a "restored" toast. Discard has to
      // take the copy on screen too, or "lässt sich nicht rückgängig machen" is
      // undone by one tap.
      doResetForm();
    }
    clearResumeHint();
    void refreshDrafts();
  };

  // Boot: is there a store at all, is there anything old to retire, and was the
  // coach on a form a moment ago?
  useEffect(() => {
    if (booting || didBootDraftsRef.current || outboxOwnerId === 'anon') return;
    didBootDraftsRef.current = true;
    void (async () => {
      const available = await draftStoreAvailable();
      setDraftStoreOk(available);
      if (!available) { releaseAutoSelect(); return; }
      try { await pruneDrafts(outboxOwnerId); } catch { /* a prune failure is not worth a word */ }
      let mine: DraftRecord[] = [];
      try { mine = await listDrafts(outboxOwnerId); } catch { /* ignore */ }
      // Whatever this coach parked on the server, merged in. On a brand-new or
      // wiped device this call is the ONLY thing that brings the work back.
      let parked: DraftRecord[] = [];
      try { parked = await listParkedDrafts(); } catch { /* offline, or nothing parked */ }
      const adopt = parked.filter((p) => {
        const local = mine.find((d) => d.id === p.id);
        // A local 'queued' or 'filed' record ALWAYS wins: the parked copy
        // predates the send, and restoring over it would re-arm a submission
        // that has already gone.
        if (!local) return true;
        return local.status === 'editing' && p.updatedAt > local.updatedAt;
      });
      if (adopt.length > 0) {
        try {
          await putDrafts(adopt);
          mine = await listDrafts(outboxOwnerId);
        } catch { /* keep the local list */ }
      }
      setDrafts(mine);
      const wanted = autoResumeRef.current;
      const forGame = wanted
        ? mine.filter((d) => d.gameId === wanted && d.status === 'editing' && (d.schema ?? 1) <= DRAFT_SCHEMA)
        : [];
      // Silent, no dialog: the tab is the same one the coach was typing in a
      // second ago. A COLD start deliberately gets the banner instead — on a
      // shared tablet, jumping into the previous session's screen would be wrong.
      if (forGame.length > 0 && eligibleGames.some((g) => g.id === wanted)) {
        draftOwnerRef.current = outboxOwnerId;
        resumeDraft(mine.filter((d) => d.gameId === wanted));
        toast.success(t.draftRestored, { lang: formData.lang });
      } else {
        releaseAutoSelect();
      }
    })();
  }, [booting, outboxOwnerId, eligibleGames.length]);

  // An owner flip that does NOT unmount — a privilege change, or a session that
  // gains an RC id in place. The outgoing coach's form can still be on screen,
  // so flush it under the OUTGOING id, then stop writing until the incoming
  // coach picks a game of their own. (A hand-off through switchRc unmounts App
  // instead; that path is covered by the lifecycle effect's cleanup.)
  const lastDraftOwnerRef = useRef(outboxOwnerId);
  useEffect(() => {
    if (lastDraftOwnerRef.current === outboxOwnerId) return;
    void commitDraft();
    // Same reasoning as the unmount cleanup, for an owner flip that does NOT
    // unmount (a privilege change turning 'anon'/'admin' into an RC id).
    if (parkTimerRef.current) { clearTimeout(parkTimerRef.current); parkTimerRef.current = null; }
    lastDraftOwnerRef.current = outboxOwnerId;
    draftOwnerRef.current = '';
    releaseDraft();
    setDrafts([]); setDraftScoreConflict(''); setDraftSaveFailed(false);
    setParkFailed(false); setParkedOk(false);
    clearResumeHint();
    void refreshDrafts();
  }, [outboxOwnerId]);

  const hasEditingDraft = (gameId: string) => drafts.some((d) => d.gameId === gameId && d.status === 'editing');
  const draftIsOverdue = (gameId: string) => draftGroups.some((g) => g.gameId === gameId && g.overdue);

  /**
   * One row per game, newest first. `filed` tombstones are deliberately left
   * out: they exist so a reload cannot re-arm a submission that already went,
   * which is bookkeeping the coach has no action to take on. What earns a row is
   * work that is unfinished ('editing') or still in flight ('queued').
   */
  const draftGroups = useMemo(() => {
    const byGame = new Map<string, DraftRecord[]>();
    for (const d of drafts) {
      if (d.status === 'filed') continue;
      const list = byGame.get(d.gameId) || [];
      list.push(d);
      byGame.set(d.gameId, list);
    }
    return Array.from(byGame.entries()).map(([gameId, list]) => {
      const game = eligibleGames.find((g) => g.id === gameId);
      const editing = list.filter((d) => d.status === 'editing');
      return {
        gameId,
        list,
        label: list[0].label || game?.matchNo || gameId,
        updatedAt: list.reduce((max, d) => Math.max(max, d.updatedAt || 0), 0),
        roles: list.map((d) => d.role).join(' · '),
        queued: list.some((d) => d.status === 'queued'),
        stale: editing.length > 0 && editing.every((d) => draftIsStale(d)),
        ageDays: editing.length > 0 ? Math.min(...editing.map((d) => draftAgeDays(d))) : 0,
        gameDate: game?.date || '',
        /**
         * The match is over and the report never went. An observation is written,
         * signed and sent at the hall, so a draft that outlives its own game by a
         * day is not a coach taking their time — it is a report the referee and
         * the association are still waiting for. A day of slack, so a late match
         * that runs past midnight is never accused of anything.
         */
        overdue: editing.length > 0 && !!game?.date
          && Number.isFinite(Date.parse(game.date))
          && Date.now() > Date.parse(game.date) + 24 * 60 * 60 * 1000,
        // A role the server has since closed cannot be resumed, but the draft is
        // never deleted for it — the coach discards it, or the age prune does.
        allClosed: editing.length > 0 && editing.every((d) => !!game?.feedbackClosedRoles?.includes(d.role)),
        resumable: editing.length > 0 && !!game,
        missing: !game,
        records: editing,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [drafts, eligibleGames]);

  const handleExportDraft = async () => {
    const lang = formData.lang;
    try {
      // Built from LIVE React state, not from the store, so the rescue button
      // still works while IndexedDB is refusing writes — which is precisely when
      // a coach is told to press it. It needs no lazy chunk either, so unlike
      // the PDF it cannot fail on the deploy the coach is trying to survive.
      const records = buildDraftRecords(outboxOwnerId);
      if (records.length === 0) { toast.error(t.draftImportEmpty, { lang }); return; }
      const text = encodeDraftFile(records, {
        game: selectedGame,
        author: { ownerId: outboxOwnerId, name: rcAuth.rcName || '' },
      });
      const name = draftFileName({
        id: selectedGame?.id || '', matchNo: selectedGame?.matchNo || '',
        date: selectedGame?.date || '', league: selectedGame?.league || '',
        location: selectedGame?.location || '',
        homeTeam: selectedGame?.homeTeam || '', awayTeam: selectedGame?.awayTeam || '',
        firstReferee: selectedGame?.firstReferee || '', secondReferee: selectedGame?.secondReferee || '',
      }, lang);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const file = new File([blob], name, { type: 'application/json' });
      // Share sheet first: on iOS and inside an installed PWA it is the only
      // route into Files, AirDrop or WhatsApp — the mirror of handleDownloadPdf.
      if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: t.draftExport, files: [file] });
        toast.success(t.draftExportOk, { lang });
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      URL.revokeObjectURL(url);
      toast.success(t.draftExportOk, { lang });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;   // the coach dismissed the share sheet
      toast.error(t.draftSaveFailed, { lang });
    }
  };

  const handleImportDraftFile = async (file: File) => {
    const lang = formData.lang;
    // Size checked BEFORE the read, so a huge file cannot stall a tablet first.
    if (file.size > DRAFT_MAX_BYTES) { toast.error(t.draftImportTooBig, { lang }); return; }
    let res;
    try { res = decodeDraftFile(await file.text(), file.size, KNOWN_RATING_IDS); }
    catch { toast.error(t.draftImportBroken, { lang }); return; }
    if (!res.ok || !res.file) {
      toast.error(res.reason === 'too-new' ? t.draftImportTooNew
        : res.reason === 'kind' ? t.draftImportBadFile
        : res.reason === 'empty' ? t.draftImportEmpty
        : res.reason === 'too-big' ? t.draftImportTooBig
        : t.draftImportBroken, { lang });
      return;
    }
    const f = res.file;
    // Bind to a game on THIS device. Without a bound game the form has no
    // 2-referee flag and no send target, and the coach gets a dead form with
    // no explanation.
    const game = eligibleGames.find((g) => g.id === f.game.id)
      ?? eligibleGames.find((g) => !!f.game.matchNo && g.matchNo === f.game.matchNo);
    if (!game) { toast.error(t.draftGameMissing, { lang }); return; }

    const foreign = !!f.author.ownerId && f.author.ownerId !== outboxOwnerId;
    if (foreign) {
      const ok = await confirmDialog({
        title: lang === 'DE' ? 'Fremden Entwurf laden?' : 'Load someone else’s draft?',
        message: lang === 'DE'
          ? `Dieser Entwurf wurde von ${f.author.name || 'einer anderen Person'} geschrieben. Die Unterschriften werden NICHT übernommen — du unterschreibst selbst, und der Bericht wird unter deinem Namen eingereicht.`
          : `This draft was written by ${f.author.name || 'another coach'}. The signatures are NOT carried over — you sign it yourself, and the report is filed under your name.`,
        confirmLabel: lang === 'DE' ? 'Laden' : 'Load',
        cancelLabel: lang === 'DE' ? 'Abbrechen' : 'Cancel',
        tone: 'danger', lang,
      });
      if (!ok) return;
    }
    let existing: DraftRecord[] = [];
    try { existing = await getGameDrafts(outboxOwnerId, game.id); } catch { /* treat as none */ }
    if (existing.some((d) => d.status === 'editing')) {
      const ok = await confirmDialog({
        title: t.draftImportReplaceTitle,
        message: `${f.game.homeTeam} vs ${f.game.awayTeam}. ` + (lang === 'DE'
          ? 'Die gespeicherten Eingaben zu diesem Spiel werden ersetzt.'
          : 'Your saved entries for this game will be replaced.'),
        confirmLabel: lang === 'DE' ? 'Ersetzen' : 'Replace',
        cancelLabel: lang === 'DE' ? 'Abbrechen' : 'Cancel',
        tone: 'danger', lang,
      });
      if (!ok) return;
    }
    const records = f.drafts.map((p) => draftRecordFromFilePart(p, game, foreign));
    try { await putDrafts(records); } catch { toast.error(t.draftSaveFailed, { lang }); return; }
    await refreshDrafts();
    draftOwnerRef.current = outboxOwnerId;
    resumeDraft(records);            // imported and autosaved drafts take ONE path into the form
    toast.success(t.draftImportOk, { lang });
  };

  const draftRecordFromFilePart = (p: DraftFilePart, game: EligibleGame, foreign: boolean): DraftRecord => {
    const role: DraftRecord['role'] = p.role === '2. SR' ? '2. SR' : '1. SR';
    // The rich-text fields reach innerHTML further down. That sink is already
    // safe, but a file picked off disk is input from outside the app and is
    // sanitised at the boundary, where the trust actually changes.
    const results: Record<string, string> = { ...(p.results || {}) };
    for (const key of ['bemerkungen', 'highlights', 'improvements', 'goals']) {
      if (typeof results[key] === 'string') results[key] = sanitizeRich(results[key]);
    }
    return {
      id: draftKey(outboxOwnerId, game.id, role),
      schema: DRAFT_SCHEMA, ownerId: outboxOwnerId, gameId: game.id, role,
      updatedAt: Date.now(), status: 'editing', submissionKey: '',
      label: `${game.homeTeam} vs ${game.awayTeam}`, matchNo: game.matchNo || '',
      observationTarget: p.observationTarget, resultUnlocked: !!p.resultUnlocked,
      coacheeId: '', coacheeName: p.coacheeName || '', coacheeLevel: p.coacheeLevel || '',
      lang: p.lang === 'EN' ? 'EN' : 'DE',
      // Carrying coach A's ink into a report filed under coach B's name forges a
      // document that the send-time validation would happily pass — it only ever
      // checks that a signature string is non-empty.
      meta: foreign ? { ...(p.meta || {}), rc: rcAuth.rcName || '' } : { ...(p.meta || {}) },
      ratings: { ...(p.ratings || {}) },
      results,
      signature: foreign ? '' : (p.signature || ''),
      rcSignature: foreign ? '' : (p.rcSignature || ''),
      tipsAndTricks: p.tipsAndTricks || '',
      extra: p.extra,
    };
  };

  const formIsDirty = !formDisabled && draftHasWork(formData, tipsAndTricks);
  /**
   * Work that exists NOWHERE ELSE. This used to stay true until the whole
   * observation was SENT, so a deploy could be postponed for the length of a
   * match; it now covers only the ~1.2 s between a keystroke and the commit —
   * or, when the device cannot store drafts at all (private mode, blocked
   * IndexedDB, demo) or the write is failing, for as long as that lasts, which
   * is exactly when postponing the reload is still the right answer.
   */
  const workUnsaved = formIsDirty && (!draftContext || draftUnsaved || draftSaveFailed);
  useEffect(() => {
    window.__svrzFormDirty = workUnsaved;
    if (!workUnsaved) window.dispatchEvent(new Event('svrz:form-clean'));
    // The effect had no cleanup, so unmounting while dirty left the flag up and
    // blocked every reload for the life of the page.
    return () => { window.__svrzFormDirty = false; };
  }, [workUnsaved]);

  useEffect(() => {
    // The durable draft IS the close guard; this is only the fallback, and it is
    // registered ONLY while the work really is unsaved — it does not fire on an
    // iOS tab kill, it costs bfcache while attached, and it must never nag about
    // work that is already on disk.
    if (!workUnsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [workUnsaved]);

  const selectedCoacheeInfo = useMemo(() => {
    const c = coachees.find(c => c.id === selectedCoacheeId);
    return {
      email: c?.email || '',
      fullName: c?.full_name || [c?.first_name, c?.last_name].filter(Boolean).join(' ') || '',
    };
  }, [coachees, selectedCoacheeId]);
  const selectedCoacheeEmail = selectedCoacheeInfo.email;

  const doResetForm = () => {
    setFormData((prev) => ({
      ...prev,
      sections: adjustSectionsFor2SR(
        prev.lang === 'DE'
          ? (prev.role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE)
          : (prev.role === '1. SR' ? SECTIONS_1SR_EN : SECTIONS_2SR_EN),
        gameHas2SR
      ),
      results: { ...INITIAL_DATA.results },
      // The confirm dialog promises everything is cleared, so the signatures go
      // too — they are the one field a stale value could smuggle past validation.
      signature: '',
      rcSignature: undefined,
    }));
    setFeedbackLocked(false);
    setOpenFeedbackId(null);
    setOpenFeedbackMine(false);
    setTipsAndTricks('');
    setDualFormData({ '1. SR': null, '2. SR': null });
    setShowConfirmModal(null);
    // The confirm dialog promises everything is cleared — including the copy on
    // disk, or "clear" would be a lie the next reload exposes.
    void deleteDraft(outboxOwnerId, selectedGameId).catch(() => {});
    void unparkDrafts(selectedGameId).catch(() => {});
    clearResumeHint();
    setDraftScoreConflict('');
    void refreshDrafts();
  };

  const resetForm = () => {
    setShowConfirmModal('reset');
  };

  const changeObservationTarget = (target: '1SR' | '2SR' | 'both') => {
    if (target === observationTarget) return;
    void flushDraftNowRef.current();
    setObservationTarget(target);
    if (target === 'both') {
      // Keep the current role's form on screen; the other role starts blank (or from its stash) when switched to
      return;
    }
    const newRole: FeedbackFormData['role'] = target === '1SR' ? '1. SR' : '2. SR';
    if (formData.role === newRole) return;
    // Stash the current role's work so nothing is lost if the user returns to "both"
    setDualFormData(prev => ({
      ...prev,
      [formData.role]: { formData: { ...formData }, tipsAndTricks },
    }));
    const saved = dualFormData[newRole];
    if (saved) {
      setFormData(saved.formData);
      setTipsAndTricks(saved.tipsAndTricks);
    } else {
      const lang = formData.lang;
      const newSections = newRole === '1. SR'
        ? adjustSectionsFor2SR(lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, gameHas2SR)
        : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
      setFormData(prev => ({
        ...INITIAL_DATA,
        lang,
        role: newRole,
        sections: newSections,
        // Same coach, same visit — they have already signed if they signed
        // the other role's form.
        rcSignature: prev.rcSignature,
        meta: {
          ...prev.meta,
          srName: selectedGame ? getRefereeForRole(selectedGame, newRole) || '' : '',
          srNiveau: '',
          gruppe: '',
        },
      }));
      setTipsAndTricks(demoTips());
    }
  };

  const toggleRole = () => {
    // Flushed before the swap, so a crash can never leave the stashed role a
    // role-switch of typing behind.
    void flushDraftNowRef.current();
    const currentRole = formData.role;
    const newRole = currentRole === '1. SR' ? '2. SR' : '1. SR';

    if (dualMode) {
      // Stash current role's form data
      setDualFormData(prev => ({
        ...prev,
        [currentRole]: { formData: { ...formData }, tipsAndTricks },
      }));

      // Restore other role's data if it exists
      const saved = dualFormData[newRole];
      if (saved) {
        setFormData(saved.formData);
        setTipsAndTricks(saved.tipsAndTricks);
      } else {
        // Initialize blank form for new role
        const lang = formData.lang;
        const newSections = newRole === '1. SR'
          ? adjustSectionsFor2SR(lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, gameHas2SR)
          : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
        setFormData(prev => ({
          ...INITIAL_DATA,
          lang,
          role: newRole,
          sections: newSections,
          // Same coach, same visit — they have already signed if they signed
          // the other role's form.
          rcSignature: prev.rcSignature,
          meta: {
            ...prev.meta,
            srName: selectedGame ? getRefereeForRole(selectedGame, newRole) || '' : '',
            srNiveau: '',
            gruppe: '',
          },
        }));
        setTipsAndTricks(demoTips());
      }
    } else {
      // Single-coachee mode: original behavior
      setFormData(prev => {
        let newSections;
        if (newRole === '1. SR') {
          newSections = adjustSectionsFor2SR(prev.lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, gameHas2SR);
        } else {
          newSections = prev.lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN;
        }
        return {
          ...prev,
          role: newRole,
          sections: newSections,
          meta: {
            ...prev.meta,
            srName: selectedGame ? getRefereeForRole(selectedGame, newRole) || prev.meta.srName : prev.meta.srName,
          },
        };
      });
    }
  };

  const toggleLang = () => {
    void flushDraftNowRef.current();
    setFormData(prev => {
      const newLang = prev.lang === 'DE' ? 'EN' : 'DE';
      // Remembered per device, so the gate and the app agree on the next visit.
      setStoredLang(newLang);
      let newSections;
      if (prev.role === '1. SR') {
        newSections = adjustSectionsFor2SR(newLang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, gameHas2SR);
      } else {
        newSections = newLang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN;
      }

      // Carry the ratings over BY ITEM ID, the way toGermanFormData already
      // does. The old version overlaid them by position, which only held while
      // the DE and EN catalogues stayed structurally identical — the day one of
      // them gained, lost or reordered a criterion, a language switch would have
      // shifted every mark below it onto the wrong criterion, silently.
      const ratings = new Map(prev.sections.flatMap((s) => s.items.map((i) => [i.id, i.rating] as const)));
      const mappedSections = newSections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({
          ...item,
          rating: ratings.get(item.id) ?? ''
        }))
      }));

      return {
        ...prev,
        lang: newLang,
        sections: mappedSections
      };
    });
  };

  // Memoize expensive list computations to avoid recomputing on every render
  const coacheeNames = useMemo(
    () => {
      const names = new Set<string>();
      for (const c of coachees) {
        if (!isInSeason(c, seasonStartYear)) continue;
        const fn = normName(c.full_name || '');
        if (fn) names.add(fn);
        // Also add reversed name order (server stores both variants)
        const first = (c.first_name || '').trim();
        const last = (c.last_name || '').trim();
        if (first && last) {
          names.add(normName(`${first} ${last}`));
          names.add(normName(`${last} ${first}`));
        }
      }
      return names;
    },
    [coachees, seasonStartYear],
  );
  const coacheeLevels = useMemo(
    () => [...new Set(coachees.filter((c) => isInSeason(c, seasonStartYear))
      .map((c) => levelDisplay(c.referee_level, c.stage).text))].sort(),
    [coachees, seasonStartYear],
  );
  const gameLeagues = useMemo(
    () => Array.from(new Set<string>(eligibleGames.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort(),
    [eligibleGames],
  );
  // The games behind the "1SR: n · 2SR: n" line on a coachee row, kept as the
  // games themselves rather than a tally so the row can also LIST them once its
  // chevron is open. Keyed by the referee's normalized name — the key every
  // other coachee lookup uses, so a name written with accents on the game and
  // without them on the coachee row still counts once. Season-scoped like the
  // games tab: a fixture outside the season on screen belongs to neither.
  const upcomingGamesByReferee = useMemo(() => {
    const now = new Date();
    const map = new Map<string, Array<{ game: EligibleGame; role: '1. SR' | '2. SR' }>>();
    const add = (name: string, game: EligibleGame, role: '1. SR' | '2. SR') => {
      const key = normName(name || '');
      if (!key) return;
      const list = map.get(key);
      if (list) list.push({ game, role });
      else map.set(key, [{ game, role }]);
    };
    const upcoming = eligibleGames
      .filter((g) => inSeasonOrManual(g) && new Date(g.date) >= now)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    for (const g of upcoming) {
      add(g.firstReferee || '', g, '1. SR');
      add(g.secondReferee || '', g, '2. SR');
    }
    return map;
  }, [eligibleGames, inSeasonOrManual]);

  /** Is this game inside the coachee's focus (the Niveau they are watched at)?
   *  Shared by the per-coachee games list and the row's inline list, so the same
   *  game cannot be worth watching on one and hidden on the other. A game with
   *  no referee role on it (a line judge) has nothing to compare and stays. */
  const inCoacheeFocus = useCallback((coachee: Coachee | undefined, league: string, roles: TargetRole[]) => {
    if (showAllLevels) return true;
    if (!coachee || roles.length === 0) return true;
    const key = levelKey(coachee.referee_level, coachee.stage);
    const target = coacheeTargets[coachee.id];
    if (!isTargetActive(target, key, niveauTable)) return true;
    return roles.some((role) => keepGame({ league, role, target, levelKey: key, table: niveauTable }));
  }, [showAllLevels, coacheeTargets, niveauTable]);
  const filteredCoachees = useMemo(() => {
    const q = listSearch.toLowerCase();
    const filtered = coachees.filter((c) => {
      if (!isInSeason(c, seasonStartYear)) return false;
      // Groups are matched in both languages: the badge in the games list may
      // read "Promotion?" while the record still says "Beförderung?".
      if (q && !(c.full_name || '').toLowerCase().includes(q) && !surnameFirstLabel(c).toLowerCase().includes(q) && !levelDisplay(c.referee_level, c.stage).text.toLowerCase().includes(q) && !(c.referee_level || '').toLowerCase().includes(q) && !(normalizeCoacheeGroup(c.groups) || '').toLowerCase().includes(q) && !groupLabel(c.groups, 'EN').toLowerCase().includes(q)) return false;
      if (listFilterLevels.length > 0) {
        const coacheeLevel = levelDisplay(c.referee_level, c.stage).text;
        if (!listFilterLevels.includes(coacheeLevel)) return false;
      }
      const isActive = (c.stage || 'active') !== 'inactive';
      if (!listFilterShowInactive && !isActive) return false;
      if (listFilterNeedsObs && !c.observation_status?.needsObservation) return false;
      return true;
    });
    const statusPriority = (c: Coachee) => {
      const s = c.observation_status;
      const active = (c.stage || 'active') !== 'inactive';
      if (active && (s?.hasNoObservation ?? false)) return 0;
      if (active && (s?.hasFurtherObservationNeeded ?? false)) return 1;
      if (s?.hasCompletedObservation) return 2;
      return 3;
    };
    const dir = listSortAsc ? 1 : -1;
    filtered.sort((a, b) => {
      // Shown as "Vorname Nachname", ordered by surname — see bySurname.
      if (listSortBy === 'name') return dir * bySurname(a, b);
      if (listSortBy === 'level') return dir * levelDisplay(a.referee_level, a.stage).text.localeCompare(levelDisplay(b.referee_level, b.stage).text);
      return dir * (statusPriority(a) - statusPriority(b));
    });
    return filtered;
  }, [coachees, listSearch, listFilterLevels, listFilterShowInactive, listFilterNeedsObs, listSortBy, listSortAsc, seasonStartYear]);
  // Lookup coachee by normalized name for game filtering
  const coacheeByName = useMemo(() => {
    const map = new Map<string, Coachee>();
    // Coachees are per-season records; the same person can have one per season.
    // Rows from OTHER seasons are not in this map at all — they are not coachees
    // now, and a name that only resolves through them must not badge a game.
    // Among what is left (this season's rows plus seasonless ones), the selected
    // season's record is inserted last so it wins the name key.
    const ordered = coachees.filter((c) => isInSeason(c, seasonStartYear)).sort((a, b) =>
      Number(a.season === seasonStartYear) - Number(b.season === seasonStartYear));
    for (const c of ordered) {
      const fn = normName(c.full_name || '');
      if (fn) map.set(fn, c);
      const first = (c.first_name || '').trim();
      const last = (c.last_name || '').trim();
      if (first && last) {
        map.set(normName(`${first} ${last}`), c);
        map.set(normName(`${last} ${first}`), c);
      }
    }
    return map;
  }, [coachees, seasonStartYear]);

  // The coachee filter on the games tab. Its VALUES stay the raw name the game
  // carries — that is what the filter matches on — while its order and its
  // labels follow the coachee lists: surname first. Sorted on the string alone
  // it filed everyone under their first name, the one thing the lists had
  // already been fixed not to do. Resolved through coacheeByName so a compound
  // surname comes from the record's own column rather than from guessing at
  // the last word: "Matthias von Ah" is von Ah, not Ah.
  const gameCoacheeOptions = useMemo(() => {
    const resolve = (name: string) => coacheeByName.get(normName(name)) ?? { full_name: name };
    return Array.from(new Set<string>(
      eligibleGames.flatMap((g) => [g.firstReferee, g.secondReferee].filter(Boolean) as string[])
        .filter((name) => coacheeNames.has(normName(name)))
    )).sort((a, b) => bySurname(resolve(a), resolve(b)));
  }, [eligibleGames, coacheeNames, coacheeByName]);
  const coacheeOptionLabel = useCallback(
    (name: string) => surnameFirstLabel(coacheeByName.get(normName(name)) ?? { full_name: name }),
    [coacheeByName],
  );

  // Which of the filter toggles have anything to act on. Computed over every
  // loaded game rather than the filtered list: deriving it from what is on
  // screen would make one active filter erase its neighbours' controls.
  const filterAvailability = useMemo(() => {
    const found = { rd: false, ld: false, rcGame: false, assigned: false, inactive: false };
    for (const g of eligibleGames) {
      if (g.isRdGame) found.rd = true;
      if (g.isLdGame) found.ld = true;
      if (g.isRcGame) found.rcGame = true;
      if (g.assignedRc) found.assigned = true;
      if (!found.inactive) {
        for (const name of [g.firstReferee, g.secondReferee]) {
          const c = name ? coacheeByName.get(normName(name)) : undefined;
          if (c && (c.stage || 'active') === 'inactive') { found.inactive = true; break; }
        }
      }
    }
    return found;
  }, [eligibleGames, coacheeByName]);

  // Niveau and group for the amber Coachee badge in the games list.
  const coacheeLevelOf = (name: string) => {
    const c = coacheeByName.get(normName(name || ''));
    return c ? levelDisplay(c.referee_level, c.stage).text : undefined;
  };
  const coacheeGroupOf = (name: string) => {
    const c = coacheeByName.get(normName(name || ''));
    return c ? groupLabel(c.groups, formData.lang) || undefined : undefined;
  };

  // Observations already booked: an RC took one of the coachee's games and the
  // feedback for that role is still open. Keyed by the coachee's canonical full
  // name, and it keeps the game itself so the Coachees tab can say which one,
  // when and by whom instead of labelling the referee "no observation".
  const plannedObsByCoachee = useMemo(() => {
    const map = new Map<string, PlannedObs>();
    const today = new Date().toISOString().slice(0, 10);
    // Upcoming beats past; among upcoming the soonest wins, among past the most
    // recent — so the row always names the game a coach would ask about.
    const beatsPlanned = (a: string, b: string) => {
      const [au, bu] = [a >= today, b >= today];
      if (au !== bu) return au;
      return au ? a < b : a > b;
    };
    for (const g of eligibleGames) {
      if (!g.assignedRc) continue;
      if (!inSeasonOrManual(g)) continue;
      const closed = g.feedbackClosedRoles || [];
      for (const [r, role] of [[g.firstReferee, '1. SR'], [g.secondReferee, '2. SR']] as Array<[string | undefined, string]>) {
        if (!r || closed.includes(role)) continue;
        // Resolve through the name map (handles "First Last" vs "Last First")
        // so coverage is keyed by the coachee's canonical full name.
        const cc = coacheeByName.get(normName(r));
        const key = normName(cc?.full_name || r);
        const prev = map.get(key);
        // With several taken games, name the next one to come. A taken game
        // that is already past is still worth showing (its feedback is open),
        // but only when nothing upcoming can take its place.
        if (!prev || beatsPlanned(g.date, prev.game.date)) map.set(key, { game: g, role, rc: g.assignedRc });
      }
    }
    return map;
  }, [eligibleGames, coacheeByName, inSeasonOrManual]);

  const filteredGames = useMemo(() => {
    const gameTime = (d: string) => {
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const q = listSearch.toLowerCase();
    // Referees already covered this season: an RC took one of their games and the
    // observation is still pending (role not yet in feedbackClosedRoles), so none
    // of their games need to stay on the open list. Once the feedback is filed,
    // coverage lifts and needsObservation (latest "further visit" answer) governs.
    const coveredRefs = plannedObsByCoachee;
    return eligibleGames.filter((g) => {
      if (q && !(
        (g.matchNo || '').toLowerCase().includes(q) ||
        (g.homeTeam || '').toLowerCase().includes(q) ||
        (g.awayTeam || '').toLowerCase().includes(q) ||
        (g.league || '').toLowerCase().includes(q) ||
        (g.firstReferee || '').toLowerCase().includes(q) ||
        (g.secondReferee || '').toLowerCase().includes(q)
      )) return false;
      if (gameFilterCoachees.length > 0) {
        const refs = [normName(g.firstReferee || ''), normName(g.secondReferee || '')];
        if (!gameFilterCoachees.some((c) => refs.includes(normName(c)))) return false;
      }
      if (gameFilterLevels.length > 0) {
        const refs = [g.firstReferee, g.secondReferee].filter(Boolean).map((r) => normName(r!));
        const refCoachees = refs.map((r) => coacheeByName.get(r)).filter(Boolean) as Coachee[];
        const hasMatchingLevel = refCoachees.some((c) => gameFilterLevels.includes(levelDisplay(c.referee_level, c.stage).text));
        if (!hasMatchingLevel) return false;
      }
      if (gameFilterFunction.length > 0) {
        const r1IsCoachee = coacheeNames.has(normName(g.firstReferee || ''));
        const r2IsCoachee = coacheeNames.has(normName(g.secondReferee || ''));
        // Still a union across what is ticked, so "1SR" + "1SR + 2SR" reads as
        // "a 1SR coachee, or both" rather than cancelling out. BOTH_SR needs a
        // second referee by construction, so single-referee games drop out.
        const match = gameFilterFunction.some((fn) =>
          fn === '1SR' ? r1IsCoachee
            : fn === '2SR' ? r2IsCoachee
              : fn === BOTH_SR ? (r1IsCoachee && r2IsCoachee)
                : false,
        );
        if (!match) return false;
      }
      if (gameFilterLeagues.length > 0 && !gameFilterLeagues.includes(g.league || '')) return false;
      if (gameFilterRd && !g.isRdGame) return false;
      if (gameFilterLd && !g.isLdGame) return false;
      if (gameFilterRcGame && !g.isRcGame) return false;
      if (gameFilterStarred && !g.starred) return false;
      // Games a coach has taken are hidden by default (they live under the RC in
      // the Referee Coaches tab); the toggle flips to showing only taken games.
      // The currently expanded game stays visible so assigning an RC doesn't rip
      // the panel (and its "start observation" button) out from under the user.
      if (gameFilterRcAssigned && !g.assignedRc) return false;
      if (!gameFilterRcAssigned && g.assignedRc && g.id !== expandedGameId) return false;
      // A referee coach is already on the whistle next to the coachee here, so
      // there is nothing for a second coach to take. Out of the list unless the
      // RC-Spiel filter asks for them — and never yanked out from under an open
      // row, same as a game somebody else just took.
      if (!gameFilterRcGame && g.isRcGame && g.id !== expandedGameId) return false;
      if (gameFilterDateFrom) {
        const from = new Date(gameFilterDateFrom);
        if (new Date(g.date) < from) return false;
      }
      if (gameFilterDateTo) {
        const to = new Date(gameFilterDateTo + 'T23:59:59');
        if (new Date(g.date) > to) return false;
      }
      // Season bound (whole-app season scope)
      if (!inSeasonOrManual(g)) return false;
      // Coachee-aware filters: check if at least one referee passes
      if (gameFilterNeedsObs || !gameFilterShowInactive) {
        const refs = [g.firstReferee, g.secondReferee].filter(Boolean).map((r) => normName(r!));
        const refCoachees = refs.map((r) => coacheeByName.get(r)).filter(Boolean) as Coachee[];
        // If no referees are coachees at all, keep the game visible
        if (refCoachees.length > 0) {
          const hasEligibleRef = refCoachees.some((c) => {
            const isActive = (c.stage || 'active') !== 'inactive';
            if (!gameFilterShowInactive && !isActive) return false;
            // The "taken games" view is an assignment audit — don't thin it out
            // with the needs-observation state.
            if (gameFilterNeedsObs && !gameFilterRcAssigned && !c.observation_status?.needsObservation) return false;
            // Covered by a planned observation → all their games leave the open list.
            // Skipped when viewing taken games, and when the user explicitly picked
            // coachees in the filter (explicit intent beats the coverage default).
            if (gameFilterNeedsObs && !gameFilterRcAssigned && gameFilterCoachees.length === 0 && coveredRefs.has(normName(c.full_name || ''))) return false;
            return true;
          });
          if (!hasEligibleRef) return false;
        }
      }
      // Niveau-target pruning: keep the game only if it matches the target of at least
      // one of its coachee referees (at their level + role). Coachees with no active
      // target never prune. The "show all levels" toggle bypasses this entirely.
      if (!showAllLevels) {
        const refRoles: Array<{ name: string; role: TargetRole }> = [];
        if (g.firstReferee) refRoles.push({ name: g.firstReferee, role: '1SR' });
        if (g.secondReferee) refRoles.push({ name: g.secondReferee, role: '2SR' });
        const coacheeRefs = refRoles
          .map((r) => ({ ...r, c: coacheeByName.get(normName(r.name)) }))
          .filter((r): r is { name: string; role: TargetRole; c: Coachee } => Boolean(r.c));
        const anyTargeted = coacheeRefs.some((r) => isTargetActive(coacheeTargets[r.c.id], levelKey(r.c.referee_level, r.c.stage), niveauTable));
        if (coacheeRefs.length > 0 && anyTargeted) {
          const keep = coacheeRefs.some((r) =>
            keepGame({ league: g.league || '', role: r.role, target: coacheeTargets[r.c.id], levelKey: levelKey(r.c.referee_level, r.c.stage), table: niveauTable }));
          if (!keep) return false;
        }
      }
      return true;
    })
      // The API hands games back newest-first (`sort: '-match_date'`), which put
      // the LAST game of the season at the top of the list — the one date nobody
      // is looking for. A fixture list reads chronologically. Compared as
      // timestamps rather than strings so a stray offset cannot reorder a day,
      // and anything undated sinks to the bottom instead of leading.
      .sort((a, b) => gameTime(a.date) - gameTime(b.date));
  }, [eligibleGames, plannedObsByCoachee, listSearch, gameFilterCoachees, gameFilterLevels, gameFilterFunction, gameFilterLeagues, gameFilterDateFrom, gameFilterDateTo, gameFilterNeedsObs, gameFilterShowInactive, gameFilterRd, gameFilterLd, gameFilterRcGame, gameFilterRcAssigned, gameFilterStarred, expandedGameId, coacheeByName, coacheeNames, inSeasonOrManual, showAllLevels, coacheeTargets, niveauTable]);

  // Any filter can shrink a list below the page currently shown, and the pager
  // itself disappears under one page of rows — leaving a blank list with no
  // control to get back from it. Clamping here covers every filter control at
  // once, including the ones that forget to reset the page.
  const clampPage = (total: number) => Math.min(listPage, Math.max(0, Math.ceil(total / LIST_PAGE_SIZE) - 1));
  const coacheesPage = clampPage(filteredCoachees.length);
  const gamesPage = clampPage(filteredGames.length);

  /** One game, drawn the same way wherever a game is listed.
   *
   *  The Games tab grew this row — day and time, league and match number, the
   *  two teams on their own lines with the set points beside them, the hall as
   *  a map link, the crew — while the coachee's own list still showed a single
   *  truncated "12345 - A vs B" line with no address and no time of day. Same
   *  game, same reader, two answers. It is one row now; a list adds only what
   *  is particular to it, through `status` (whatever closes the first line) and
   *  `roles` (the slot this coachee stands in, which the game itself cannot say).
   */
  const gameCard = (game: EligibleGame, opts?: { status?: React.ReactNode; roles?: string[] }) => {
    const d = new Date(game.date);
    const dateValid = !isNaN(d.getTime());
    const dayOfWeek = dateValid ? d.toLocaleDateString(formData.lang === 'DE' ? 'de-CH' : 'en-GB', { weekday: 'short' }) : '';
    const yearStr = window.innerWidth < 640 ? String(d.getFullYear()).slice(-2) : String(d.getFullYear());
    const datePart = dateValid ? `${dayOfWeek} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${yearStr}` : (game.date || '-');
    const timePart = dateValid ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
    const r1 = game.firstReferee || '';
    const r2 = game.secondReferee || '';
    const r1IsCoachee = coacheeNames.has(normName(r1));
    const r2IsCoachee = r2 ? coacheeNames.has(normName(r2)) : false;
    return (
      <>
      {/* Row 1: date/time + status indicators */}
      <div className="flex items-center gap-1.5 text-sm text-stone-400">
        <CalendarDays size={14} className="w-3.5 text-stone-400 shrink-0" />
        <span className="font-medium text-stone-700">{datePart}</span>
        {timePart && <><Clock size={14} className="w-3.5 text-stone-400 shrink-0 ml-1" /><span className="font-medium text-stone-700">{timePart}</span></>}
        <div className="flex-1" />
        {game.assignedRc ? (
          <span className="w-2.5 h-2.5 rounded-full bg-green-500" title={game.assignedRc} />
        ) : (
          <span className="w-2.5 h-2.5 rounded-full bg-stone-300" title="No RC" />
        )}
        {opts?.status}
      </div>
      {/* Row 2: league, match#, chips */}
      <div className="flex items-center gap-1.5 text-sm text-stone-400 mt-0.5">
        <Tag size={14} className="w-3.5 text-stone-400 shrink-0" />
        <span><LeagueLabel text={game.league} /></span>
        {game.matchNo && <span>#{game.matchNo}</span>}
        {game.isRdGame && <span className="px-2 py-1 rounded text-xs font-bold leading-none bg-stone-900 text-white">{formData.lang === 'DE' ? 'RD Spiel' : 'RD Game'}</span>}
        {game.isLdGame && <span className="px-2 py-1 rounded text-xs font-bold leading-none bg-stone-900 text-white">{formData.lang === 'DE' ? 'LD Spiel' : 'LD Game'}</span>}
        {game.isRcGame && (
          <span
            className="px-2 py-1 rounded text-xs font-bold leading-none bg-sky-100 text-sky-800 border border-sky-300"
            title={formData.lang === 'DE'
              ? 'Ein Referee Coach pfeift hier neben einem Coachee.'
              : 'A referee coach is whistling next to a coachee here.'}
          >{formData.lang === 'DE' ? 'RC-Spiel' : 'RC Game'}</span>
        )}
        {game.isManual && (
          <span
            className="px-2 py-1 rounded text-xs font-bold leading-none bg-violet-100 text-violet-800 border border-violet-300"
            title={formData.lang === 'DE'
              ? 'Von Hand angelegt — kein Spiel aus VolleyManager.'
              : 'Created by hand — not a VolleyManager fixture.'}
          >{formData.lang === 'DE' ? 'Testspiel' : 'Test game'}</span>
        )}
        {game.starred && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-bold leading-none bg-amber-100 text-amber-700 border border-amber-300"
            title={game.vmFlagged
              ? (formData.lang === 'DE'
                ? 'In VolleyManager für eine Beobachtung markiert (RD/RSV)'
                : 'Marked for observation in VolleyManager (RD/RSV)')
              : (formData.lang === 'DE' ? 'Für eine Beobachtung vorgemerkt' : 'Flagged for observation')}
          >
            <Star size={11} className="fill-amber-500 text-amber-500" />
            {formData.lang === 'DE' ? 'Gewünscht' : 'Priority'}
          </span>
        )}
        {hasEditingDraft(game.id) && (
          <span
            className={cn('px-2 py-1 rounded text-xs font-bold leading-none border',
              draftIsOverdue(game.id)
                ? 'bg-red-100 text-red-800 border-red-300'
                : 'bg-stone-200 text-stone-700 border-stone-300')}
            title={draftIsOverdue(game.id) ? t.draftUnsentHeading : t.draftHeading}
          >{draftIsOverdue(game.id) ? t.draftUnsentBadge : t.draftBadge}</span>
        )}
      </div>
      {/* Teams + result */}
      {(() => {
        // Two formats reach this list — "3:1 | 25:20, ..." from the
        // form and "3:1 (25:20 / ...)" from the VolleyManager sync.
        // Splitting on '|' by hand rendered every synced game's away
        // score as "1 (25"; parseResult reads both.
        const parsed = game.game_result ? parseResult(game.game_result) : null;
        const hasResult = !!parsed && (parsed.home !== '' || parsed.away !== '');
        const sets = (parsed?.sets ?? []).filter(isSetComplete);
        // Each team's own points, on that team's own row — so
        // reading across a row gives you their whole match, the
        // way the set count already did. As one "25:15 | 25:21"
        // line under both teams, the sets sat away from the
        // score they belong to and had to be decoded before
        // they said anything about either side.
        // tabular-nums keeps the two rows' digits in step, and
        // the count's fixed width keeps the counts aligned even
        // when one row's points are a digit shorter (a 25:9 set).
        const setPoints = (side: 'h' | 'a') => (
          sets.length > 0 && (
            <span className="text-[11px] text-stone-400 tabular-nums whitespace-nowrap shrink-0">
              {sets.map((s) => s[side]).join(' | ')}
            </span>
          )
        );
        return (
          <>
            <div className="mt-1 flex items-center gap-2">
              <Home size={14} className="w-3.5 text-stone-400 shrink-0" />
              <span className="text-base text-stone-800 truncate flex-1">{game.homeTeam}</span>
              {setPoints('h')}
              {hasResult && <span className="w-4 text-right text-sm font-bold text-stone-600 tabular-nums shrink-0">{parsed.home}</span>}
            </div>
            <div className="flex items-center gap-2">
              <Navigation size={14} className="w-3.5 text-stone-400 shrink-0" />
              <span className="text-base text-stone-800 truncate flex-1">{game.awayTeam}</span>
              {setPoints('a')}
              {hasResult && <span className="w-4 text-right text-sm font-bold text-stone-600 tabular-nums shrink-0">{parsed.away}</span>}
            </div>
          </>
        );
      })()}
      {/* Location */}
      {game.location && (
        <div className="mt-0.5 flex items-center gap-1.5">
          <MapPin size={14} className="w-3.5 text-red-400 shrink-0" />
          <a
            href={game.maps_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(game.location)}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm text-red-500 hover:text-red-700 underline decoration-red-300 hover:decoration-red-500 transition-colors"
          >
            {game.location.split(',')[0].trim()}
          </a>
        </div>
      )}
      {/* Referees */}
      <div className="mt-1.5 text-sm">
        <div className="flex items-center gap-1.5">
          <Users size={14} className="w-3.5 text-stone-400 shrink-0" />
          <span className="font-medium text-stone-400">1SR</span>
          {r1 ? (
            r1IsCoachee ? <CoacheeName name={r1} level={coacheeLevelOf(r1)} group={coacheeGroupOf(r1)} /> : <span className="font-semibold text-stone-700">{r1}</span>
          ) : (
            <span className="text-stone-300">–</span>
          )}
        </div>
        {r2 && (
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 shrink-0" />
            <span className="font-medium text-stone-400">2SR</span>
            {r2IsCoachee ? <CoacheeName name={r2} level={coacheeLevelOf(r2)} group={coacheeGroupOf(r2)} /> : <span className="font-semibold text-stone-700">{r2}</span>}
          </div>
        )}
      </div>
      {/* Which slot the coachee stands in, for a list that is about them
          rather than about the game. Line-judge duty shows here and nowhere
          else: the two referee lines above cannot name it. */}
      {opts?.roles && (
        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-stone-500">
          <ClipboardCheck size={14} className="w-3.5 text-stone-400 shrink-0" />
          <span className="font-medium text-stone-400">{t.rolesLabel}</span>
          <span className="font-semibold text-stone-700">{opts.roles.join(', ') || '–'}</span>
        </div>
      )}
      {/* RC */}
      {game.assignedRc && (
        <div className="mt-0.5 flex items-center gap-1.5 text-sm text-stone-500">
          <Eye size={14} className="w-3.5 text-stone-400 shrink-0" />
          <span className="font-medium text-stone-400">RC</span>
          <span className="font-bold text-stone-700">{game.assignedRc}</span>
        </div>
      )}
      </>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 py-6 sm:py-8 px-4 print:bg-white print:p-0">
      {isDemoMode() && (
        <div className="max-w-5xl mx-auto mb-3 no-print">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-red-600 text-white text-xs font-semibold px-3 py-2 shadow-sm">
            <span className="flex items-center gap-2">
              <Info size={14} />
              {formData.lang === 'DE'
                ? 'DEMO — Testdaten. Nichts wird gespeichert oder versendet.'
                : 'DEMO — sample data. Nothing is saved or emailed.'}
            </span>
            <span className="shrink-0 flex items-center gap-1.5">
              <button
                onClick={() => { setDemoMail(getSentMail()); setDemoMailOpen(true); }}
                className="inline-flex items-center gap-1 rounded-lg bg-white/15 hover:bg-white/25 px-2.5 py-1 transition-colors"
                title={formData.lang === 'DE' ? 'E-Mails, die gesendet würden' : 'Emails that would be sent'}
              >
                <Send size={12} />
                {formData.lang === 'DE' ? 'Demo-Mails' : 'Demo mail'}
                {demoMail.length > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-white text-red-600 text-[10px] font-bold leading-none">{demoMail.length}</span>
                )}
              </button>
              <button
                onClick={rcAuth.logout}
                className="inline-flex items-center gap-1 rounded-lg bg-white/15 hover:bg-white/25 px-2.5 py-1 transition-colors"
              >
                <LogOut size={12} />
                {formData.lang === 'DE' ? 'Demo verlassen' : 'Exit demo'}
              </button>
            </span>
          </div>
        </div>
      )}
      {demoMailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 no-print" onClick={() => setDemoMailOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-stone-200">
              <div className="flex items-center gap-2">
                <Send size={16} className="text-red-600" />
                <h2 className="text-sm font-bold text-stone-800">{formData.lang === 'DE' ? 'E-Mail-Vorschau (Demo)' : 'Email preview (demo)'}</h2>
              </div>
              <button onClick={() => setDemoMailOpen(false)} className="text-stone-400 hover:text-stone-600" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-800 font-medium flex items-center gap-2">
              <Info size={14} className="shrink-0" />
              {formData.lang === 'DE'
                ? 'Diese E-Mail(s) wurden NICHT gesendet — nur zur Ansicht.'
                : 'These emails were NOT sent — preview only.'}
            </div>
            <div className="overflow-y-auto px-5 py-4 space-y-4">
              {demoMail.length === 0 ? (
                <p className="text-sm text-stone-400 text-center py-8">
                  {formData.lang === 'DE'
                    ? 'Noch keine E-Mails. Reiche ein Feedback ein, um zu sehen, was gesendet würde.'
                    : 'No emails yet. Submit a feedback to see what would be sent.'}
                </p>
              ) : demoMail.map((m, i) => (
                <div key={i} className="rounded-xl border border-stone-200 overflow-hidden">
                  {m.label && (
                    <div className="px-3 py-1.5 bg-red-50 border-b border-red-100 text-[11px] font-semibold text-red-700">{m.label}</div>
                  )}
                  <div className="bg-stone-50 px-3 py-2 text-[12px] text-stone-600 space-y-0.5 border-b border-stone-200">
                    <div><span className="font-semibold text-stone-500">{formData.lang === 'DE' ? 'Von' : 'From'}:</span> {m.from}</div>
                    <div><span className="font-semibold text-stone-500">{formData.lang === 'DE' ? 'An' : 'To'}:</span> {m.to}</div>
                    {m.cc.length > 0 && <div><span className="font-semibold text-stone-500">Cc:</span> {m.cc.join(', ')}</div>}
                    {m.bcc.length > 0 && <div><span className="font-semibold text-stone-500">Bcc:</span> {m.bcc.join(', ')}</div>}
                    <div><span className="font-semibold text-stone-500">{formData.lang === 'DE' ? 'Betreff' : 'Subject'}:</span> {m.subject}</div>
                  </div>
                  <pre className="px-3 py-2.5 text-[12px] text-stone-700 whitespace-pre-wrap break-words font-sans leading-relaxed">{m.body}</pre>
                  {/* The real mail carries this as a button in its HTML part, so the
                      preview shows a button too — a raw token URL is unreadable and
                      overflows the box. Inert on purpose: nothing here was sent. */}
                  {m.surveyUrl && (
                    <div className="px-3 pb-3 -mt-1">
                      <span className="inline-block px-5 py-2 rounded-lg bg-red-600 text-white text-[12px] font-semibold">Feedback geben</span>
                    </div>
                  )}
                  {m.attachment && (
                    <div className="px-3 py-2 border-t border-stone-200 flex items-center gap-2 text-[12px] text-stone-500">
                      <Download size={13} className="shrink-0" /> {m.attachment}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-stone-200 text-right">
              <button onClick={() => setDemoMailOpen(false)} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800">
                {formData.lang === 'DE' ? 'Schliessen' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
      {emailTestMode && (
        <div className="max-w-5xl mx-auto mb-3 no-print">
          <div className="flex items-center gap-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-2">
            <Info size={14} /> {formData.lang === 'DE' ? 'Testmodus aktiv — es werden keine E-Mails versendet.' : 'Test mode on — no emails are sent.'}
          </div>
        </div>
      )}
      {/* UI Controls */}
      <div className="max-w-4xl mx-auto mb-6 flex flex-wrap gap-3 no-print">
        {feedbackSubView !== 'coachees' && (
          <>
        <button
          onClick={() => setFeedbackSubView('coachees')}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <ArrowLeft size={18} />
          <span>{formData.lang === 'DE' ? 'Zurück' : 'Back'}</span>
        </button>
        {feedbackSubView === 'feedbackForm' && (
          <>
        <button
          onClick={() => void handleDownloadPdf()}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <Download size={18} />
          <span className="hidden sm:inline">{t.downloadPdf}</span>
        </button>
        {/* The PDF is the document; this is the work. A PDF can be read but not
            loaded back, so a coach who wants to carry an unfinished observation
            to another device needs a file the app can re-open. */}
        <button
          onClick={() => void handleExportDraft()}
          disabled={!draftWorth}
          title={t.draftExport}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors disabled:opacity-50"
        >
          <FileJson size={18} />
          <span className="hidden sm:inline">{t.draftExport}</span>
        </button>
        {gameHas2SR && (
          <>
            <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex shrink-0 rounded-lg border border-stone-300 bg-white shadow-sm overflow-hidden"
              role="group"
              aria-label={formData.lang === 'DE' ? 'Beobachtung f\u00FCr' : 'Observation for'}
            >
              {(['1SR', '2SR', 'both'] as const).map((tg) => {
                const refName = tg === 'both' || !selectedGame ? '' : getRefereeForRole(selectedGame, tg === '1SR' ? '1. SR' : '2. SR');
                const isCoachee = !!refName && coacheeNames.has(normName(refName));
                const active = observationTarget === tg;
                return (
                  <button
                    key={tg}
                    onClick={() => changeObservationTarget(tg)}
                    title={tg === 'both'
                      ? (formData.lang === 'DE'
                        ? 'Beide Schiedsrichter in einem Besuch — je ein Formular, ein Senden für beide, und keines geht raus, bevor beide vollständig sind.'
                        : 'Both referees on one visit — one form each, one send for both, and neither goes out until both are complete.')
                      : `${refName}${isCoachee ? ' (Coachee)' : ''}`}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                      active ? "bg-slate-900 text-white" : "text-stone-600 hover:bg-stone-50"
                    )}
                  >
                    {tg === 'both' ? (formData.lang === 'DE' ? 'Beide' : 'Both') : tg}
                    {isCoachee && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title="Coachee" />}
                  </button>
                );
              })}
            </div>
            {dualMode && (
              <>
                <button
                  onClick={toggleRole}
                  aria-label={`${t.switchRole} ${formData.role === '1. SR' ? '2. SR' : '1. SR'}`}
                  title={`${t.switchRole} ${formData.role === '1. SR' ? '2. SR' : '1. SR'}`}
                  className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-2 rounded-lg shadow-sm hover:bg-red-700 transition-colors"
                >
                  {/* Two arrows over one another: this swaps between the two
                      referees' forms. It used to be a circular refresh, which
                      on a form full of unsaved work reads as "reload". The
                      label stays on the phone too — the full sentence never
                      fitted there, so the button was a bare icon. */}
                  <ArrowLeftRight size={18} />
                  <span className="text-sm font-medium">SR</span>
                </button>
                <div className="flex gap-1.5 text-xs font-medium">
                  <span className={dualFormData['1. SR'] || formData.role === '1. SR' ? 'text-green-600' : 'text-stone-400'}>
                    1SR {dualFormData['1. SR'] ? '\u2713' : '\u25CB'}
                  </span>
                  <span className={dualFormData['2. SR'] || formData.role === '2. SR' ? 'text-green-600' : 'text-stone-400'}>
                    2SR {dualFormData['2. SR'] ? '\u2713' : '\u25CB'}
                  </span>
                </div>
              </>
            )}
            </div>
            {/* "Both" is one word for a mode that changes what the send button
                does. The title said so on hover, which a phone does not have,
                so it said so to nobody who needed it. Full width and OUTSIDE
                the row above: as a flex item beside the toggle it took width
                the group could not spare, and the group — which clips — lost
                "2SR" and "Both" off its right edge. */}
            {dualMode && (
              <p className="w-full text-xs text-stone-500">
                {formData.lang === 'DE'
                  ? 'Beide Schiedsrichter in einem Besuch — je ein Formular, Wechsel mit dem roten Knopf.'
                  : 'Both referees on one visit — one form each, switch with the red button.'}
                {' '}
                {/* Why this is not just 1SR and 2SR done one after the other:
                    it files them together, and it refuses to file either half.
                    Nobody could tell that from the word "Beide". */}
                <span className="text-stone-400">
                  {formData.lang === 'DE'
                    ? 'Ein Senden für beide — und es geht keines raus, bevor beide vollständig sind.'
                    : 'One send files both — and neither goes out until both are complete.'}
                </span>
              </p>
            )}
          </>
        )}
        <button
          onClick={toggleLang}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors ml-auto"
          title={t.languageToggleTitle}
        >
          <Languages size={18} />
          <span className="hidden sm:inline">{formData.lang}</span>
        </button>
        <button
          onClick={resetForm}
          aria-label={t.reset}
          title={t.reset}
          className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-lg shadow-sm border border-red-100 hover:bg-red-100 transition-colors"
        >
          <RotateCcw size={18} />
          <span className="hidden sm:inline">{t.reset}</span>
        </button>
        {selectedGame && (
          <div className="w-full flex flex-wrap items-center gap-2">
            {(['1. SR', '2. SR'] as const).map((role) => {
              const name = getRefereeForRole(selectedGame, role);
              if (!name) return null;
              const isCoachee = coacheeNames.has(normName(name));
              const isObserved = dualMode || formData.role === role;
              return (
                <div
                  key={role}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm",
                    isObserved ? "border-slate-400 bg-white shadow-sm" : "border-stone-200 bg-stone-50 opacity-60"
                  )}
                >
                  {isObserved && <Eye size={14} className="text-slate-700 shrink-0" />}
                  <span className="font-medium text-stone-400">{role === '1. SR' ? '1SR' : '2SR'}</span>
                  <span className={cn("font-semibold", isCoachee ? "text-amber-900" : "text-stone-800")}>{name}</span>
                  {isCoachee && (
                    <span className="inline-flex items-center rounded bg-amber-100 border border-amber-300 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800">
                      Coachee
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
          </>
        )}
          </>
        )}
      </div>

      {feedbackSubView === 'coachees' && (
        <div className="max-w-5xl mx-auto no-print">
          <div className="bg-white p-4 sm:p-5 rounded-2xl shadow-card border border-stone-200/70 mb-4 flex items-center sm:items-start gap-4">
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-stone-900">{t.title}</h1>
              <p className="hidden sm:block text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400 mt-0.5">Swiss Volley Region Zürich</p>
            </div>
            <div className="flex flex-col items-center justify-center gap-2 self-center sm:self-start">
              <SvrzLogo className="h-10 w-auto" />
            </div>
          </div>

          <div className="bg-white p-3 sm:p-6 rounded-2xl shadow-card border border-stone-200/70">
            {/* Unfinished work first: it is the only thing on this screen that
                exists nowhere but this device, and the coach is the only one who
                can decide what happens to it. */}
            {draftGroups.length > 0 && (() => {
              // A draft whose match is over is a different thing from one the
              // coach is in the middle of, and it must not be able to hide among
              // them: the whole banner changes colour and name so an unsent
              // report is the loudest thing on the screen.
              const overdueCount = draftGroups.filter((g) => g.overdue).length;
              return (
              <div className={cn('mb-3 rounded-lg border px-3 py-2 text-xs',
                overdueCount > 0 ? 'border-red-300 bg-red-50' : 'border-stone-300 bg-stone-50')}>
                <p className={cn('font-semibold mb-1 flex items-center gap-1.5',
                  overdueCount > 0 ? 'text-red-800' : 'text-stone-700')}>
                  {overdueCount > 0 ? <ShieldAlert size={13} /> : <RotateCcw size={13} />}
                  {overdueCount > 0
                    ? (overdueCount > 1 ? t.draftUnsentHeadingPlural : t.draftUnsentHeading)
                    : (draftGroups.length > 1 ? t.draftHeadingPlural : t.draftHeading)}
                </p>
                <div className="space-y-1.5">
                  {draftGroups.map((g) => (
                    <div key={g.gameId} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-stone-800">{g.label}</p>
                        <p className="truncate text-stone-500">
                          {g.queued ? t.draftQueued
                            : g.missing ? t.draftGameMissing
                            : g.allClosed ? t.draftRoleClosed
                            : `${g.roles} · ${new Date(g.updatedAt).toLocaleDateString(formData.lang === 'DE' ? 'de-CH' : 'en-GB')}`}
                        </p>
                        {/* The report the referee is still waiting for. */}
                        {g.overdue && !g.queued && (
                          <p className="truncate font-semibold text-red-700">
                            {formData.lang === 'DE'
                              ? `Nicht gesendet — Spiel vom ${new Date(g.gameDate).toLocaleDateString('de-CH')}.`
                              : `Not sent — match of ${new Date(g.gameDate).toLocaleDateString('en-GB')}.`}
                          </p>
                        )}
                        {/* An old draft is warned about, never deleted: a coach
                            who parked an observation over a holiday must not come
                            back to nothing. */}
                        {g.stale && !g.overdue && (
                          <p className="truncate text-amber-700">
                            {formData.lang === 'DE'
                              ? `Seit ${g.ageDays} Tagen nicht mehr bearbeitet — der Entwurf bleibt gespeichert.`
                              : `Not touched for ${g.ageDays} days — the draft is kept.`}
                          </p>
                        )}
                      </div>
                      {g.resumable && !g.queued && !g.allClosed && (
                        <button
                          onClick={() => { draftOwnerRef.current = outboxOwnerId; resumeDraft(g.list); }}
                          className="shrink-0 rounded border border-stone-300 bg-white px-2 py-0.5 font-semibold text-stone-700 hover:bg-stone-100"
                        >
                          {t.draftResume}
                        </button>
                      )}
                      <button
                        onClick={() => void discardDraft(g.gameId)}
                        className="shrink-0 rounded border border-stone-300 bg-white px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100"
                      >
                        {t.draftDiscard}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              );
            })()}
            {/* Top row: language toggle + empty form download */}
            {isOffline && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                <CloudOff size={14} className="shrink-0" />
                {formData.lang === 'DE'
                  ? 'Offline – du siehst die zuletzt geladenen Daten. Neue Feedbacks werden lokal gespeichert und gesendet, sobald du wieder online bist.'
                  : 'Offline – showing last-loaded data. New feedback is saved locally and sent once you are back online.'}
              </div>
            )}
            {/* Somebody else's unsent observation is sitting on this device. It
                can only be sent as its own author, so the one useful thing this
                screen can do is say whose it is — otherwise the work is simply
                invisible until someone notices the game never got filed. */}
            {outboxForeign.length > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
                <CloudOff size={14} className="shrink-0 mt-0.5" />
                <span className="flex-1">
                  {outboxForeign.map(({ ownerId, count }) => {
                    const owner = rcPeople.find((p) => p.id === ownerId)?.fullName;
                    return formData.lang === 'DE'
                      ? `${count} nicht gesendete${count > 1 ? '' : 's'} Feedback${count > 1 ? 's' : ''} von ${owner || 'einer anderen Person'} — bitte als ${owner || 'diese Person'} anmelden, um es zu senden.`
                      : `${count} unsent feedback${count > 1 ? 's' : ''} from ${owner || 'another coach'} — sign in as ${owner || 'that coach'} to send ${count > 1 ? 'them' : 'it'}.`;
                  }).join(' ')}
                </span>
              </div>
            )}
            {outboxPending > 0 && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
                <Send size={14} className="shrink-0" />
                <span className="flex-1">
                  {formData.lang === 'DE'
                    ? `${outboxPending} Feedback${outboxPending > 1 ? 's' : ''} wartet auf Übermittlung.`
                    : `${outboxPending} feedback submission${outboxPending > 1 ? 's' : ''} waiting to send.`}
                </span>
                {!isOffline && (
                  <button
                    onClick={() => void flushOutboxNow()}
                    disabled={flushing}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-300 bg-white px-2 py-1 font-semibold text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                  >
                    {flushing ? <Loader2 size={12} className="animate-spin" /> : null}
                    {formData.lang === 'DE' ? 'Jetzt senden' : 'Send now'}
                  </button>
                )}
              </div>
            )}
            {outboxFailed.length > 0 && (
              <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs">
                <p className="font-semibold text-red-800 mb-1">
                  {formData.lang === 'DE'
                    ? `${outboxFailed.length} Übermittlung${outboxFailed.length > 1 ? 'en' : ''} fehlgeschlagen`
                    : `${outboxFailed.length} submission${outboxFailed.length > 1 ? 's' : ''} failed`}
                </p>
                <div className="space-y-1.5">
                  {outboxFailed.map((item) => (
                    <div key={item.id} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-red-800">{item.label}</p>
                        <p className="truncate text-red-600">{item.lastError}</p>
                      </div>
                      <button onClick={() => void retryFailedOutbox(item.id)} disabled={isOffline || flushing} className="rounded border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">
                        {formData.lang === 'DE' ? 'Erneut' : 'Retry'}
                      </button>
                      <button onClick={() => void discardFailedOutbox(item.id)} className="rounded border border-stone-300 bg-white px-2 py-0.5 font-medium text-stone-600 hover:bg-stone-100">
                        {formData.lang === 'DE' ? 'Verwerfen' : 'Discard'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-3 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-2">
              {/* Wraps rather than overflows: with Admin, season, calendar and
                  the logout name all present, this row runs out of phone. */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={toggleLang}
                  className="h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                  title={t.languageToggleTitle}
                >
                  <Languages size={14} />
                  <span>{formData.lang}</span>
                </button>
                {/* Shown to the people who actually use the console, not to
                    all fourteen coaches. It briefly appeared for everyone —
                    admin rights used to come from an RC's own login, so when
                    that login went the door vanished and #/admin had to be
                    typed by hand; putting it back for everybody fixed that and
                    left most of the team a locked door they can't open.

                    `adminShortcut` is COSMETIC and has to stay that way. It is
                    true for a console session, or when the name picked on this
                    device is on a list an admin keeps. That name was chosen off
                    a picker, never proven, so anyone with the team password can
                    make it true by picking differently — which costs them a
                    button and nothing else, because the page behind it asks for
                    the admin password regardless. Do not read it as a
                    permission; the last flag here that looked like one was
                    honoured as one. */}
                {(isPrivileged || rcAuth.adminShortcut) && (
                <button
                  onClick={() => { window.location.hash = '/admin'; }}
                  className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                  // The label is hidden below sm, which left an icon with no
                  // accessible name on every phone — the same trap the console's
                  // tab bar already names itself out of. `title` is not a
                  // substitute: it is a sentence, and it changes with language.
                  aria-label="Admin"
                  title={isPrivileged
                    ? 'Admin'
                    : (formData.lang === 'DE' ? 'Admin-Bereich — Anmeldung erforderlich' : 'Admin area — sign-in required')}
                >
                  {isPrivileged ? <ShieldAlert size={14} /> : <Lock size={14} />}
                  <span className="hidden sm:inline">Admin</span>
                </button>
                )}
                <button
                  onClick={() => setShowInfoModal(true)}
                  className="sm:hidden h-9 inline-flex items-center justify-center px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                  title={formData.lang === 'DE' ? 'Infos & Dokumente' : 'Info & documents'}
                  aria-label="Info"
                >
                  <Info size={14} />
                </button>
                {/* Display only — the season is set once in the admin console
                    (Einstellungen → Standard-Saison) and everyone follows it. */}
                <span
                  // No ml-auto: it pushed the season and everything after it to
                  // the right edge, so the row that wrapped underneath sat in a
                  // different place from the one above it.
                  className="h-9 inline-flex items-center rounded-lg border border-stone-200 bg-stone-50 text-stone-600 text-xs font-medium px-2.5"
                  title={formData.lang === 'DE' ? 'Saison' : 'Season'}
                >
                  {`${seasonStartYear}/${String((seasonStartYear + 1) % 100).padStart(2, '0')}`}
                </span>
                {/* The feed is per RC and served by the API, so it needs a real
                    session — the demo has neither. */}
                {rcAuth.rcName && !isDemoMode() && (
                  <button
                    onClick={() => setShowCalendarModal(true)}
                    className="h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                    title={formData.lang === 'DE' ? 'Kalender-Abo' : 'Calendar subscription'}
                  >
                    <CalendarPlus size={14} />
                    <span className="hidden sm:inline">{formData.lang === 'DE' ? 'Kalender' : 'Calendar'}</span>
                  </button>
                )}
                {/* On the team login the name is a claim, so it has to stay
                    changeable in the app: whoever picked wrong — or is handing
                    the tablet to the next coach — must not need the password
                    again. The name doubles as that button; a personal session
                    can't switch, so there it just labels the logout. */}
                {rcAuth.rcName && rcAuth.sharedSession && (
                  <button
                    onClick={() => { void (async () => {
                      // Ask BEFORE the hand-off, not after: an item queued under
                      // the outgoing coach can only ever be sent as that coach,
                      // so switching now is what strands it.
                      if (outboxPending > 0) {
                        const de = formData.lang === 'DE';
                        const ok = await confirmDialog({
                          title: de ? 'Trotzdem wechseln?' : 'Switch anyway?',
                          // An unfinished draft is NOT a reason to block a
                          // hand-off — nothing is stranded, it simply waits for
                          // its author. Saying so stops the queued-item warning
                          // from reading as "you are about to lose everything".
                          message: (de
                            ? `${outboxPending} Feedback wartet noch auf Übermittlung und kann nur von ${rcAuth.rcName} gesendet werden.`
                            : `${outboxPending} feedback submission is still waiting to send and can only be sent by ${rcAuth.rcName}.`)
                            + (drafts.some((d) => d.status === 'editing')
                              ? (de
                                ? ` Deine unfertige Beobachtung bleibt gespeichert und ist wieder da, wenn du dich als ${rcAuth.rcName} anmeldest.`
                                : ` Your unfinished observation stays saved and comes back when you sign in as ${rcAuth.rcName}.`)
                              : ''),
                          confirmLabel: de ? 'Wechseln' : 'Switch',
                          cancelLabel: de ? 'Abbrechen' : 'Cancel',
                          tone: 'danger',
                          lang: formData.lang,
                        });
                        if (!ok) return;
                      }
                      rcAuth.switchRc();
                    })(); }}
                    className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                    title={formData.lang === 'DE' ? `Angemeldet als ${rcAuth.rcName} — wechseln` : `Signed in as ${rcAuth.rcName} — switch`}
                  >
                    <Users size={14} />
                    <span className="hidden sm:inline max-w-[9rem] truncate">{rcAuth.rcName}</span>
                  </button>
                )}
                {/* Also for a session with no RC name — the admin console
                    login is one. Gating this on the name left that session with
                    no way out of the app at all: the only exit was typing
                    #/admin and signing out from the console instead. */}
                {(rcAuth.rcName || isPrivileged) && (
                  <button
                    onClick={rcAuth.logout}
                    className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                    title={rcAuth.rcName
                      ? (formData.lang === 'DE' ? `Abmelden (${rcAuth.rcName})` : `Log out (${rcAuth.rcName})`)
                      : (formData.lang === 'DE' ? 'Abmelden' : 'Log out')}
                  >
                    <LogOut size={14} />
                    {!rcAuth.sharedSession && (
                      <span className="hidden sm:inline max-w-[9rem] truncate">
                        {rcAuth.rcName ?? (formData.lang === 'DE' ? 'Abmelden' : 'Log out')}
                      </span>
                    )}
                  </button>
                )}
              </div>
              {/* The wide slot goes to the thing a coach reaches for mid-season.
                  The empty form is a once-a-year download and now sits with the
                  other documents; loading a draft is how an observation started
                  on a dead phone gets finished, so it is the one that earns the
                  room. Rendered whether or not this device holds a draft —
                  loading a file onto a FRESH device is the entire point.
                  The input hides behind the label because the native control
                  renders in the BROWSER's language, not the app's. */}
              <label className="w-full sm:w-auto sm:ml-auto h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors cursor-pointer">
                <Upload size={14} />
                <span>{t.draftImport}</span>
                <input
                  type="file"
                  accept=".json,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Cleared before the read, so picking the SAME file twice
                    // still fires change — otherwise a failed import cannot be
                    // retried without choosing something else first.
                    e.target.value = '';
                    if (f) void handleImportDraftFile(f);
                  }}
                />
              </label>
            </div>
            {/* Toggle tabs */}
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {/* Hidden rather than left to bounce off the redirect: a tab that
                  answers a click by highlighting a different one is worse than
                  no tab. See homelessAdmin. */}
              {!homelessAdmin && (
                <button
                  onClick={() => setListTab('home')}
                  className={cn(
                    "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center gap-1.5",
                    listTab === 'home'
                      ? "bg-slate-900 text-white"
                      : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                  )}
                >
                  <Home size={16} />
                  {formData.lang === 'DE' ? 'Start' : 'Home'}
                </button>
              )}
              <button
                onClick={() => { setListTab('coachees'); setListSearch(''); setListPage(0); }}
                className={cn(
                  "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center gap-1.5",
                  listTab === 'coachees'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                <Users size={16} />
                {t.coacheePool}
              </button>
              <button
                onClick={() => { setListTab('games'); setListSearch(''); setListPage(0); }}
                className={cn(
                  "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center gap-1.5",
                  oddTabOut,
                  listTab === 'games'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                <CalendarDays size={16} />
                {t.gamePool}
              </button>
            </div>

            {/* Home dashboard */}
            {listTab === 'home' && (() => {
              const de = formData.lang === 'DE';
              const firstName = (rcAuth.rcName || '').split(' ')[0];
              const fmtDate = (d: string) => {
                const dt = new Date(d);
                return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString(de ? 'de-CH' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });
              };
              /** The throw-in time, under the date. A row that says only "Tue
               *  15/09" still leaves you looking the game up somewhere else
               *  before you can plan the evening around it. */
              const fmtTime = (d: string) => {
                const dt = new Date(d);
                return Number.isNaN(dt.getTime()) ? '' : `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
              };
              const startFromSummary = (g: rcCoachSummaryGame) => {
                const eg = eligibleGames.find((e) => e.id === g.gameId);
                if (eg) handleSelectGame(eg, g.refereeName);
                else { setListTab('games'); setListSearch(g.teams); }
              };
              // `canRemind` only for games still to come: reminding somebody
              // about a match they have already refereed is noise.
              /** Home and away on their own lines. "VBC Rämi D1 vs VBC
               *  Einsiedeln D2" is wider than a phone, and one truncated line
               *  hid whichever team came second on every row of the list. Split
               *  on the separator the API builds the string with; a string that
               *  does not split cleanly stays one line rather than being
               *  guessed at. */
              const teamLines = (teams: string) => {
                const parts = teams.split(' vs ');
                if (parts.length !== 2) {
                  return <p className="text-sm font-medium text-stone-800 break-words">{teams}</p>;
                }
                // No "vs": the two names sit one above the other and the order
                // says which is home. The word only cost a line's worth of width
                // on the phone the list is read on.
                // A hairline instead of the old "vs". Either team can wrap onto
                // two lines — "KSC Wiedikon DU23-1" does on a phone — and with
                // nothing between them the four lines read as one block of text
                // with no way to see where home ends and away begins.
                // w-fit, so the rule is drawn to the longer of the two names
                // and not across the whole column: full width it read as a
                // divider between rows of the list rather than between the two
                // halves of one game.
                return (
                  <div className="w-fit max-w-full">
                    <p className="text-sm font-medium text-stone-800 break-words"><span className="font-semibold text-stone-400">H:</span> {parts[0]}</p>
                    <div className="my-1 border-t border-stone-200" />
                    <p className="text-sm font-medium text-stone-800 break-words"><span className="font-semibold text-stone-400">A:</span> {parts[1]}</p>
                  </div>
                );
              };
              const gameRow = (g: HomeGame, key: string, canRemind = false) => (
                <div
                  key={key}
                  className="flex items-stretch rounded-lg border border-stone-200 bg-white overflow-hidden focus-within:border-red-300 hover:border-red-300 transition-colors"
                >
                  {/* A div, not a button: the hall below is a link, and an
                      anchor inside a button is invalid markup — the same reason
                      the "take game" strip is a sibling of its row elsewhere.
                      role/tabIndex/Enter keep it reachable from the keyboard,
                      and a key pressed ON THE LINK is left to the link. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => startFromSummary(g)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startFromSummary(g); }
                    }}
                    className="min-w-0 flex-1 cursor-pointer text-left px-3 py-2.5 hover:bg-red-50/40 transition-colors flex items-center gap-3"
                  >
                    <div className="flex flex-col items-center justify-center w-12 shrink-0 text-center">
                      <span className="text-[11px] font-semibold text-red-600 leading-tight">{fmtDate(g.gameDate)}</span>
                      {fmtTime(g.gameDate) && <span className="mt-0.5 text-[11px] leading-tight text-stone-400 tabular-nums">{fmtTime(g.gameDate)}</span>}
                    </div>
                    <div className="min-w-0 flex-1">
                      {teamLines(g.teams)}
                      <p className="text-xs text-stone-500 break-words">
                        {g.league}{g.matchNo ? ` · #${g.matchNo}` : ''}
                      </p>
                      {/* Where to drive, as the address it is, linked to the
                          map the sync stored — or to a search for it when
                          VolleyManager carried no link. */}
                      {g.location && (
                        <p className="mt-0.5 flex items-start gap-1.5 text-xs">
                          <MapPin size={12} className="mt-0.5 shrink-0 text-red-400" />
                          <a
                            href={g.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.location)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="break-words text-red-500 underline decoration-red-300 transition-colors hover:text-red-700 hover:decoration-red-500"
                          >
                            {g.location}
                          </a>
                        </p>
                      )}
                      {/* Both referees, one line each, with the slot they stand
                          in — and the coachee marked when the pair is mixed. A
                          row that listed only coachees could not say whether the
                          other slot was empty or held by somebody this coach
                          does not follow, and those are different situations at
                          the hall. When BOTH are coachees nothing is marked:
                          highlighting everything highlights nothing.
                          Wraps rather than truncates: the name is the reason the
                          row is worth reading, and they run long — "Kevin León
                          Peña de los Santos" is wider than a phone by itself. */}
                      {(() => {
                        const crew = g.crew?.length
                          ? g.crew
                          : (g.refs?.length ? g.refs : [{ name: g.refereeName, role: g.refereeRole || '' }])
                              .filter((r) => r.name)
                              .map((r) => ({ ...r, coachee: !g.noCoachee }));
                        const mixed = crew.some((r) => r.coachee) && crew.some((r) => !r.coachee);
                        return crew.filter((r) => r.name).map((r) => (
                          <p
                            key={`${r.name}-${r.role}`}
                            className={cn('text-xs break-words', mixed && r.coachee ? 'text-stone-700 font-medium' : 'text-stone-500')}
                          >
                            {r.role && <span className={cn('font-semibold', mixed && r.coachee ? 'text-stone-800' : 'text-stone-600')}>{r.role === '2. SR' ? t.role2Short : t.role1Short} </span>}
                            {r.name}
                            {mixed && r.coachee && (
                              <span className="ml-1.5 align-middle rounded bg-amber-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-800 border border-amber-200">
                                {formData.lang === 'DE' ? 'Coachee' : 'Coachee'}
                              </span>
                            )}
                          </p>
                        ));
                      })()}
                      <MatchResult result={g.result} className="mt-0.5" />
                    </div>
                    <Eye size={15} className="text-stone-400 shrink-0" />
                  </div>
                  {canRemind && (
                    <button
                      onClick={() => void remindFromHome(g.gameId, `${g.teams} (${fmtDate(g.gameDate)})`, de)}
                      aria-label={de ? 'Erinnerung senden' : 'Send reminder'}
                      title={de
                        ? 'Erinnerungs-Mail jetzt senden — sonst automatisch am Vortag um 10:00'
                        : 'Send the reminder mail now — otherwise automatically at 10:00 the day before'}
                      className="shrink-0 px-3 border-l border-stone-200 text-stone-400 hover:bg-stone-50 hover:text-red-600 transition-colors"
                    >
                      <Mail size={15} />
                    </button>
                  )}
                  <button
                    onClick={() => void giveBackFromHome(g.gameId, `${g.teams} (${fmtDate(g.gameDate)})`, de)}
                    aria-label={de ? 'Spiel abgeben' : 'Give game back'}
                    title={de ? 'Spiel abgeben — es wird wieder für alle frei' : 'Give the game back — it becomes free for everyone'}
                    className="shrink-0 px-3 border-l border-stone-200 text-stone-400 hover:bg-stone-50 hover:text-red-600 transition-colors"
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              );
              if (!rcAuth.rcName) {
                return <p className="text-sm text-stone-500 py-6 text-center">{de ? 'Willkommen.' : 'Welcome.'}</p>;
              }
              const myMandate = rcAuth.rcId ? rcMandates[rcAuth.rcId] : undefined;
              const myGoal = goalForMandate(defaultGoal, myMandate);
              const toGoal = homeData ? Math.max(0, myGoal - homeData.done) : 0;
              return (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-xl font-bold text-stone-900">{de ? `Hallo ${firstName} 👋` : `Hello ${firstName} 👋`}</h2>
                    {/* The half mandate is named here rather than squeezed into
                        the goal tile, where "(5 ½)" would read as five and a half. */}
                    <p className="text-sm text-stone-500">
                      {de ? 'Deine Coaching-Übersicht' : 'Your coaching overview'}
                      {/* Only worth saying when it differs from the default —
                          and 'half mandate' no longer exists as a category. */}
                      {myMandate !== undefined && myGoal !== defaultGoal
                        && (de ? ` · Pensum ${myGoal}` : ` · target ${myGoal}`)}
                    </p>
                  </div>

                  {(homeLoading || booting) && !homeData ? (
                    booting ? (
                      <div className="flex justify-center py-24">
                        <AppSpinner size={132} label={t.loading} />
                      </div>
                    ) : (
                      // Same shape as the loaded dashboard — counters, then a list.
                      <div className="space-y-4" role="status" aria-busy="true">
                        <div className="grid grid-cols-3 gap-2">
                          <Skeleton className="h-[76px] rounded-xl" />
                          <Skeleton className="h-[76px] rounded-xl" />
                          <Skeleton className="h-[76px] rounded-xl" />
                        </div>
                        <Skeleton className="h-4 w-40" />
                        <div className="space-y-1.5">
                          <Skeleton className="h-[58px] rounded-lg" />
                          <Skeleton className="h-[58px] rounded-lg" />
                          <Skeleton className="h-[58px] rounded-lg" />
                          <Skeleton className="h-[58px] rounded-lg" />
                        </div>
                      </div>
                    )
                  ) : homeData ? (
                    <>
                      {/* Counters */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-3 text-center">
                          <div className="text-2xl font-bold text-green-700">{homeData.done}</div>
                          <div className="text-[11px] font-medium text-green-700/80 uppercase tracking-wide">{de ? 'Erledigt' : 'Done'}</div>
                        </div>
                        <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-center">
                          <div className="text-2xl font-bold text-sky-700">{homeData.planned}</div>
                          <div className="text-[11px] font-medium text-sky-700/80 uppercase tracking-wide">{de ? 'Geplant' : 'Planned'}</div>
                        </div>
                        <div
                          className={cn("rounded-xl border px-3 py-3 text-center", toGoal === 0 ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50")}
                          // The Pensum is a plain number now, so there is no
                          // "half mandate" to name — and 0 is a real answer,
                          // which does not stop anyone taking games.
                          title={myGoal === 0
                            ? (de ? 'Kein festes Pensum — du kannst trotzdem Spiele übernehmen.' : 'No fixed target — you can still take on games.')
                            : (de ? `${myGoal} Beobachtungen pro Saison.` : `${myGoal} observations per season.`)}
                        >
                          <div className={cn("text-2xl font-bold", toGoal === 0 ? "text-green-700" : "text-amber-700")}>{toGoal === 0 ? '✓' : toGoal}</div>
                          <div className={cn("text-[11px] font-medium uppercase tracking-wide", toGoal === 0 ? "text-green-700/80" : "text-amber-700/80")}>{de ? `bis Ziel (${myGoal})` : `to goal (${myGoal})`}</div>
                        </div>
                      </div>

                      {/* Missing observations warning */}
                      {homeData.missingGames.length > 0 && (
                        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                          <p className="text-sm font-semibold text-amber-800 flex items-center gap-1.5">
                            <Clock size={15} />
                            {de
                              ? `${homeData.missingGames.length} Beobachtung${homeData.missingGames.length > 1 ? 'en' : ''} ausstehend`
                              : `${homeData.missingGames.length} observation${homeData.missingGames.length > 1 ? 's' : ''} outstanding`}
                          </p>
                          <p className="text-xs text-amber-700 mt-0.5 mb-2">{de ? 'Vergangene Spiele ohne Feedback:' : 'Past games without feedback:'}</p>
                          <div className="space-y-1.5">
                            {homeData.missingGames.map((g, i) => gameRow(g, `miss-${g.gameId}-${i}`))}
                          </div>
                        </div>
                      )}

                      {/* Next appointments */}
                      <div>
                        <h3 className="text-sm font-semibold text-stone-700 mb-2 flex items-center gap-1.5">
                          <CalendarDays size={15} className="text-stone-400" />
                          {de ? 'Nächste Termine' : 'Next appointments'}
                        </h3>
                        {/* Every one of them: this list is the answer to the
                            counter beside it, and a cut-off row is a game the
                            coach has no other way to reach from here. */}
                        {homeData.nextGames.length === 0 ? (
                          <p className="text-sm text-stone-400 py-3">{de ? 'Keine geplanten Spiele.' : 'No planned games.'}</p>
                        ) : (
                          <div className="space-y-1.5">
                            {homeData.nextGames.map((g, i) => gameRow(g, `next-${g.gameId}-${i}`, true))}
                          </div>
                        )}
                      </div>

                      {/* Observations already filed — tap one to reopen its feedback. */}
                      <div>
                        <h3 className="text-sm font-semibold text-stone-700 mb-2 flex items-center gap-1.5">
                          <ClipboardCheck size={15} className="text-stone-400" />
                          {de ? 'Erledigte Beobachtungen' : 'Completed observations'}
                          {homeData.doneList.length > 0 && (
                            <span className="text-xs font-normal text-stone-400">({homeData.doneList.length})</span>
                          )}
                        </h3>
                        {homeData.doneList.length === 0 ? (
                          <p className="text-sm text-stone-400 py-3">{de ? 'Noch keine Beobachtung erfasst.' : 'No observations filed yet.'}</p>
                        ) : (
                          <div className="space-y-1.5">
                            {homeData.doneList.map((f, i) => (
                              <button
                                key={`done-${f.coacheeId}-${f.gameDate}-${i}`}
                                onClick={() => void openDoneObservation(f)}
                                className="w-full text-left px-3 py-2.5 rounded-lg border border-stone-200 bg-white hover:border-emerald-300 hover:bg-emerald-50/40 transition-colors flex items-center gap-3"
                                title={de ? 'Feedback öffnen' : 'Open feedback'}
                              >
                                <div className="flex flex-col items-center justify-center w-12 shrink-0">
                                  <span className="text-[11px] font-semibold text-emerald-600 leading-tight">{fmtDate(f.gameDate)}</span>
                                </div>
                                <div className="min-w-0 flex-1">
                                  {teamLines(f.teams)}
                                  <p className="text-xs text-stone-500 break-words">{f.league}</p>
                                  <p className="text-xs text-stone-500 break-words">
                                    {f.role && <span className="font-semibold text-stone-600">{f.role === '2. SR' ? t.role2Short : t.role1Short} </span>}
                                    {f.coacheeName}
                                  </p>
                                  <MatchResult result={f.result} className="mt-0.5" />
                                </div>
                                <Eye size={15} className="text-stone-400 shrink-0" />
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-stone-500 py-6 text-center">{de ? 'Übersicht konnte nicht geladen werden.' : 'Could not load overview.'}</p>
                  )}
                </div>
              );
            })()}

            {/* Coachees: Search & filters */}
            {listTab === 'coachees' && (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={listSearch}
                    onChange={(e) => { setListSearch(e.target.value); setListPage(0); }}
                    placeholder={formData.lang === 'DE' ? 'Suche...' : 'Search...'}
                    className="h-9 flex-1 min-w-0 px-3 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  />
                  {(() => {
                    const activeFilterCount = [
                      listFilterLevels.length > 0,
                      !listFilterNeedsObs,
                      listFilterShowInactive,
                    ].filter(Boolean).length;
                    return (
                      <button
                        onClick={() => setCoacheeFiltersOpen(!coacheeFiltersOpen)}
                        className={cn(
                          "h-9 flex items-center gap-1.5 px-2.5 text-sm border rounded-md transition-colors cursor-pointer",
                          coacheeFiltersOpen ? "bg-red-50 border-red-300 text-red-700" : "border-stone-300 text-stone-600 hover:bg-stone-50"
                        )}
                      >
                        <SlidersHorizontal size={14} />
                        <span className="hidden sm:inline">{formData.lang === 'DE' ? 'Filter' : 'Filters'}</span>
                        {activeFilterCount > 0 && (
                          <span className="ml-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold">{activeFilterCount}</span>
                        )}
                      </button>
                    );
                  })()}
                </div>
                {coacheeFiltersOpen && (
                  <div className="flex flex-wrap items-end gap-2 mb-3 p-3 bg-stone-50 border border-stone-200 rounded-md">
                    <div className="flex-1 min-w-[130px] max-w-[220px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Level' : 'Level'}
                      </label>
                      <MultiSelectDropdown
                        lang={formData.lang}
                        options={coacheeLevels}
                        selected={listFilterLevels}
                        onChange={(values) => { setListFilterLevels(values); setListPage(0); }}
                        placeholder={formData.lang === 'DE' ? 'Alle Level' : 'All levels'}
                      />
                    </div>
                    <button
                      onClick={() => setListFilterNeedsObs(!listFilterNeedsObs)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", listFilterNeedsObs ? "bg-red-600" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", listFilterNeedsObs ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>{formData.lang === 'DE' ? 'Beobachtung nötig' : 'Needs observation'}</span>
                    </button>
                    <button
                      onClick={() => setListFilterShowInactive(!listFilterShowInactive)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", listFilterShowInactive ? "bg-red-600" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", listFilterShowInactive ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>{formData.lang === 'DE' ? 'Inaktive zeigen' : 'Show inactive'}</span>
                    </button>
                    {(listFilterLevels.length > 0 || !listFilterNeedsObs || listFilterShowInactive) && (
                      <button
                        onClick={() => {
                          setListFilterLevels([]);
                          setListFilterNeedsObs(true);
                          setListFilterShowInactive(false);
                          setListPage(0);
                        }}
                        className="h-9 px-3 text-sm border border-stone-300 rounded hover:bg-stone-50 text-stone-600"
                      >
                        {formData.lang === 'DE' ? 'Zurücksetzen' : 'Clear'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Games: Search & filters */}
            {listTab === 'games' && (
              <>
                {/* Row 1: search + toggles + filter button */}
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={listSearch}
                    onChange={(e) => { setListSearch(e.target.value); setListPage(0); }}
                    placeholder={formData.lang === 'DE' ? 'Suche...' : 'Search...'}
                    className="h-9 flex-1 min-w-0 px-3 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  />
                  {(() => {
                    const activeFilterCount = [gameFilterCoachees.length > 0, gameFilterLevels.length > 0, gameFilterFunction.length > 0, gameFilterLeagues.length > 0, !!gameFilterDateFrom || !!gameFilterDateTo, gameFilterRd, gameFilterLd, gameFilterRcGame, gameFilterRcAssigned].filter(Boolean).length;
                    return (
                      <button
                        onClick={() => setFiltersOpen(!filtersOpen)}
                        // The label is hidden on a phone, so name the button for
                        // anyone (or anything) that cannot see the icon.
                        aria-label={formData.lang === 'DE' ? 'Filter' : 'Filters'}
                        aria-expanded={filtersOpen}
                        className={cn(
                          "h-9 flex items-center gap-1.5 px-2.5 text-sm border rounded-md transition-colors cursor-pointer",
                          filtersOpen ? "bg-red-50 border-red-300 text-red-700" : "border-stone-300 text-stone-600 hover:bg-stone-50"
                        )}
                      >
                        <SlidersHorizontal size={14} />
                        <span className="hidden sm:inline">{formData.lang === 'DE' ? 'Filter' : 'Filters'}</span>
                        {activeFilterCount > 0 && (
                          <span className="ml-0.5 w-5 h-5 flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold">{activeFilterCount}</span>
                        )}
                      </button>
                    );
                  })()}
                </div>
                {/* Quick date navigation */}
                {(() => {
                  const todayStr = toDateString(new Date());
                  const yesterdayStr = toDateString(new Date(Date.now() - 86400000));
                  const tomorrowStr = toDateString(new Date(Date.now() + 86400000));
                  const isDE = formData.lang === 'DE';
                  const shiftDay = (delta: number) => {
                    const base = gameFilterDateFrom || todayStr;
                    const d = new Date(base + 'T00:00:00');
                    d.setDate(d.getDate() + delta);
                    const ds = toDateString(d);
                    setGameFilterDateFrom(ds);
                    setGameFilterDateTo(ds);
                    setListPage(0);
                  };
                  const isActive = (ds: string) => gameFilterDateFrom === ds && gameFilterDateTo === ds;
                  const toggleDay = (ds: string) => { if (isActive(ds)) { setGameFilterDateFrom(''); setGameFilterDateTo(''); } else { setGameFilterDateFrom(ds); setGameFilterDateTo(ds); } setListPage(0); };
                  const presets = [yesterdayStr, todayStr, tomorrowStr];
                  const selectedSingle = gameFilterDateFrom && gameFilterDateFrom === gameFilterDateTo ? gameFilterDateFrom : '';
                  const customSelected = Boolean(selectedSingle) && !presets.includes(selectedSingle);
                  const fmtSel = (ds: string) => new Date(ds + 'T00:00:00').toLocaleDateString(isDE ? 'de-CH' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
                  const chipCls = (active: boolean) => cn(
                    "h-8 flex-1 sm:flex-none sm:px-3 px-1 text-xs rounded border transition-colors whitespace-nowrap",
                    active ? "bg-red-600 text-white border-red-600" : "border-stone-300 text-stone-600 hover:bg-stone-50"
                  );
                  return (
                    <div className="mb-2 flex flex-col items-stretch gap-1.5">
                      <div className="flex items-center justify-center gap-1.5">
                        <button onClick={() => shiftDay(-1)} className="h-8 w-8 shrink-0 flex items-center justify-center border border-stone-300 rounded hover:bg-stone-50 text-stone-500" title={isDE ? 'Vorheriger Tag' : 'Previous day'}>
                          <ChevronLeft size={16} />
                        </button>
                        <button onClick={() => toggleDay(yesterdayStr)} className={chipCls(isActive(yesterdayStr))}>{isDE ? 'Gestern' : 'Yesterday'}</button>
                        <button onClick={() => toggleDay(todayStr)} className={chipCls(isActive(todayStr))}>{isDE ? 'Heute' : 'Today'}</button>
                        <button onClick={() => toggleDay(tomorrowStr)} className={chipCls(isActive(tomorrowStr))}>{isDE ? 'Morgen' : 'Tomorrow'}</button>
                        <button onClick={() => shiftDay(1)} className="h-8 w-8 shrink-0 flex items-center justify-center border border-stone-300 rounded hover:bg-stone-50 text-stone-500" title={isDE ? 'Nächster Tag' : 'Next day'}>
                          <ChevronRight size={16} />
                        </button>
                      </div>
                      {customSelected && (
                        <div className="flex items-center justify-center">
                          <button
                            onClick={() => { setGameFilterDateFrom(''); setGameFilterDateTo(''); setListPage(0); }}
                            className="h-7 inline-flex items-center gap-1.5 pl-3 pr-2.5 text-xs font-semibold rounded-full bg-red-600 text-white shadow-sm hover:bg-red-700 transition-colors"
                            title={isDE ? 'Auswahl zurücksetzen' : 'Clear selection'}
                          >
                            <CalendarDays size={13} />
                            <span>{fmtSel(selectedSingle)}</span>
                            <span className="text-white/70">✕</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* Collapsible filter panel */}
                {filtersOpen && (
                  <div className="flex flex-wrap items-end gap-2 mb-3 p-3 bg-stone-50 border border-stone-200 rounded-md">
                    {/* A toggle for a marking no game in the list carries is a
                        control that can only ever empty the list, so it is not
                        offered — unless it is the one currently switched on,
                        which must stay reachable to be switched off again. */}
                    <FilterToggle
                      on={gameFilterNeedsObs}
                      onToggle={() => setGameFilterNeedsObs(!gameFilterNeedsObs)}
                      dotClass="bg-red-600"
                      label={formData.lang === 'DE' ? 'Beobachtung nötig' : 'Needs observation'}
                    />
                    {(filterAvailability.inactive || gameFilterShowInactive) && (
                      <FilterToggle
                        on={gameFilterShowInactive}
                        onToggle={() => setGameFilterShowInactive(!gameFilterShowInactive)}
                        dotClass="bg-red-600"
                        label={formData.lang === 'DE' ? 'Inaktive zeigen' : 'Show inactive'}
                      />
                    )}
                    {(filterAvailability.rd || gameFilterRd) && (
                      <FilterToggle
                        on={gameFilterRd}
                        onToggle={() => setGameFilterRd(!gameFilterRd)}
                        dotClass="bg-amber-500"
                        title={formData.lang === 'DE'
                          ? 'Im VolleyManager für eine SR-Beobachtung markiert.'
                          : 'Marked in VolleyManager for referee supervision.'}
                        label={formData.lang === 'DE' ? 'RD Spiel' : 'RD Game'}
                      />
                    )}
                    {(filterAvailability.rcGame || gameFilterRcGame) && (
                      <FilterToggle
                        on={gameFilterRcGame}
                        onToggle={() => setGameFilterRcGame(!gameFilterRcGame)}
                        dotClass="bg-sky-500"
                        title={formData.lang === 'DE'
                          ? 'Ein Referee Coach pfeift hier neben einem Coachee. Sonst ausgeblendet — solche Spiele sind nicht zu übernehmen.'
                          : 'A referee coach whistles next to a coachee here. Hidden otherwise — these are not games to take.'}
                        label={formData.lang === 'DE' ? 'RC-Spiel' : 'RC Game'}
                      />
                    )}
                    {(filterAvailability.ld || gameFilterLd) && (
                      <FilterToggle
                        on={gameFilterLd}
                        onToggle={() => setGameFilterLd(!gameFilterLd)}
                        dotClass="bg-violet-500"
                        title={formData.lang === 'DE'
                          ? 'Im VolleyManager ist eine Linienrichter-Beobachtung markiert.'
                          : 'VolleyManager has a line-judge supervision marked on this game.'}
                        label={formData.lang === 'DE' ? 'LD Spiel' : 'LD Game'}
                      />
                    )}
                    {(filterAvailability.assigned || gameFilterRcAssigned) && (
                      <FilterToggle
                        on={gameFilterRcAssigned}
                        onToggle={() => setGameFilterRcAssigned(!gameFilterRcAssigned)}
                        dotClass="bg-green-500"
                        label={formData.lang === 'DE' ? 'RC zugewiesen' : 'RC assigned'}
                      />
                    )}
                    {/* Twice the growth of its neighbours: these options are
                        full names, while Level, Funktion and Liga hold codes a
                        few characters long. */}
                    <div className="flex-[2] min-w-[200px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Coachee' : 'Coachee'}
                      </label>
                      <MultiSelectDropdown
                        lang={formData.lang}
                        options={gameCoacheeOptions}
                        labelOf={coacheeOptionLabel}
                        selected={gameFilterCoachees}
                        onChange={setGameFilterCoachees}
                        placeholder={formData.lang === 'DE' ? 'Alle Coachees' : 'All coachees'}
                      />
                    </div>
                    <div className="flex-1 min-w-[130px] max-w-[220px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Level' : 'Level'}
                      </label>
                      <MultiSelectDropdown
                        lang={formData.lang}
                        options={coacheeLevels}
                        selected={gameFilterLevels}
                        onChange={setGameFilterLevels}
                        placeholder={formData.lang === 'DE' ? 'Alle Level' : 'All levels'}
                      />
                    </div>
                    <div className="flex-1 min-w-[100px] max-w-[160px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Funktion' : 'Function'}
                      </label>
                      <MultiSelectDropdown
                        lang={formData.lang}
                        options={['1SR', '2SR', BOTH_SR]}
                        selected={gameFilterFunction}
                        onChange={setGameFilterFunction}
                        placeholder={formData.lang === 'DE' ? 'Alle' : 'All'}
                      />
                    </div>
                    {/* Capped: "1L ♀ C" needs nothing like the width it was
                        taking from the Coachee box beside it. */}
                    <div className="flex-1 min-w-[120px] max-w-[170px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Liga' : 'League'}
                      </label>
                      <MultiSelectDropdown
                        lang={formData.lang}
                        options={gameLeagues}
                        selected={gameFilterLeagues}
                        onChange={setGameFilterLeagues}
                        placeholder={formData.lang === 'DE' ? 'Alle Ligen' : 'All leagues'}
                      />
                    </div>
                    <DateRangeDropdown
                      from={gameFilterDateFrom}
                      to={gameFilterDateTo}
                      onChangeFrom={setGameFilterDateFrom}
                      onChangeTo={setGameFilterDateTo}
                      lang={formData.lang}
                    />
                    {(gameFilterCoachees.length > 0 || gameFilterLevels.length > 0 || gameFilterFunction.length > 0 || gameFilterLeagues.length > 0 || gameFilterDateFrom || gameFilterDateTo || gameFilterRcAssigned) && (
                      <button
                        onClick={() => { setGameFilterCoachees([]); setGameFilterLevels([]); setGameFilterFunction([]); setGameFilterLeagues([]); setGameFilterDateFrom(''); setGameFilterDateTo(''); setGameFilterRcAssigned(false); }}
                        className="h-9 px-3 text-sm border border-stone-300 rounded hover:bg-stone-50 text-stone-600"
                      >
                        {formData.lang === 'DE' ? 'Zurücksetzen' : 'Clear'}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Coachees table */}
            {listTab === 'coachees' && (
              <div className="border border-stone-200 rounded">
                {coachees.length === 0 && (booting || loadingCoachees) ? (
                  // Still loading — a skeleton, never the "nothing found" state.
                  <ListLoading label={t.loading} first={booting} rows={8} />
                ) : filteredCoachees.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-14 px-4 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400"><Users size={26} strokeWidth={1.75} /></div><p className="text-sm font-medium text-stone-500">{t.noCoachees}</p></div>
                ) : (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-4 bg-stone-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200">
                      <span className="flex-1 cursor-pointer select-none" onClick={() => toggleListSort('name')}>{formData.lang === 'DE' ? 'Name' : 'Name'}{listSortBy === 'name' ? (listSortAsc ? ' ▲' : ' ▼') : ''}</span>
                      <span className="cursor-pointer select-none" onClick={() => toggleListSort('status')}>Status{listSortBy === 'status' ? (listSortAsc ? ' ▲' : ' ▼') : ''}</span>
                    </div>
                    <div className="divide-y divide-stone-200">
                      {filteredCoachees.slice(coacheesPage * LIST_PAGE_SIZE, (coacheesPage + 1) * LIST_PAGE_SIZE).map((coachee) => {
                        const plannedObs = plannedObsByCoachee.get(normName(coachee.full_name || ''));
                        const balls = coacheeBalls(coachee, plannedObs);
                        const groupStr = groupLabel(coachee.groups, formData.lang);
                        const ownGames = upcomingGamesByReferee.get(normName(coachee.full_name || '')) ?? [];
                        const sr1 = ownGames.filter((e) => e.role === '1. SR').length;
                        const sr2 = ownGames.filter((e) => e.role === '2. SR').length;
                        // The row offers the games worth watching, by the same
                        // focus rule the per-coachee list uses; the rest are
                        // counted into the "+ n more" that opens that list.
                        const focusGames = ownGames.filter(({ game, role }) =>
                          inCoacheeFocus(coachee, game.league || '', [role === '1. SR' ? '1SR' : '2SR']));
                        const inlineGames = focusGames.slice(0, INLINE_GAME_LIMIT);
                        const moreGames = ownGames.length - inlineGames.length;
                        const isExpanded = expandedCoacheeId === coachee.id;
                        return (
                          <div
                            key={coachee.id}
                            onClick={() => handleSelectCoachee(coachee)}
                            className={cn(
                              "px-3 py-2.5 cursor-pointer transition-colors",
                              selectedCoacheeId === coachee.id ? "bg-red-50" : "hover:bg-stone-50"
                            )}
                          >
                            {/* Two long status pills used to squeeze the name column
                                to nothing and overlap it. Stack them under the name
                                on phones; cap their width beside it on desktop. */}
                            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-sm text-stone-900">{surnameFirstLabel(coachee)}</div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-stone-500">
                                  <span><LevelText level={coachee.referee_level} stage={coachee.stage} /></span>
                                  {groupStr && <span>{groupStr}</span>}
                                  {(sr1 > 0 || sr2 > 0) && (
                                    <span className="text-stone-400">
                                      {sr1 > 0 && <span>1SR: {sr1}</span>}
                                      {sr1 > 0 && sr2 > 0 && <span className="mx-1">·</span>}
                                      {sr2 > 0 && <span>2SR: {sr2}</span>}
                                    </span>
                                  )}
                                </div>
                                {/* The booked observation, spelled out: which
                                    game, when, in which role, and whose it is —
                                    otherwise the pill above raises the question
                                    it doesn't answer. */}
                                {plannedObs && (
                                  <div className="mt-1 flex items-start gap-1.5 text-xs text-sky-700">
                                    <CalendarDays size={13} className="mt-px shrink-0 text-sky-500" />
                                    <span className="min-w-0">
                                      {shortDate(plannedObs.game.date)} · {plannedObs.game.homeTeam} vs {plannedObs.game.awayTeam}
                                      {plannedObs.game.league ? ` · ${plannedObs.game.league}` : ''} · {plannedObs.role}
                                      {plannedObs.rc ? ` · RC ${plannedObs.rc}` : ''}
                                    </span>
                                  </div>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-1 sm:pt-0.5 sm:shrink-0 sm:justify-end sm:max-w-[45%]">
                                {balls.length > 0 ? balls.map((ball) => (
                                  <span
                                    key={ball.key}
                                    className={cn('inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full', ball.color)}
                                  >
                                    {ball.title}
                                  </span>
                                )) : (
                                  <span className="text-xs text-stone-300">–</span>
                                )}
                                {/* Unfolds this coachee's games under the row.
                                    ml-auto pins it to the right edge on phones,
                                    where the pills sit under the name; beside
                                    them the row is content-wide and it does
                                    nothing. Tapping it must not also open the
                                    sheet the rest of the row opens. */}
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleSelectCoachee(coachee); }}
                                  aria-expanded={isExpanded}
                                  aria-label={formData.lang === 'DE' ? 'Details anzeigen' : 'Show details'}
                                  title={formData.lang === 'DE' ? 'Details anzeigen' : 'Show details'}
                                  className="ml-auto sm:ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-stone-200 hover:text-stone-600 transition-colors"
                                >
                                  <ChevronDown size={16} className={cn('transition-transform', isExpanded && 'rotate-180')} />
                                </button>
                              </div>
                            </div>
                            {/* The chevron's panel. It sits inside the row, so
                                the negative margins undo the row's padding and
                                every click in here is stopped from reaching the
                                row underneath — opening a game must not also
                                open the detail sheet. */}
                            {isExpanded && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="-mx-3 -mb-2.5 mt-2.5 cursor-default border-t border-stone-200 bg-stone-50 px-3 py-2.5"
                              >
                                {/* What the row above does not already say. Name,
                                    level and group are on it an inch higher; the
                                    sheet repeated them because it covered them. */}
                                {(coachee.stage === 'inactive' || coachee.phone || coachee.email) && (
                                  <dl className="mb-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                                    {coachee.stage === 'inactive' && (
                                      <>
                                        <dt className="text-stone-500">Status</dt>
                                        <dd className="m-0 text-right font-medium text-red-600">{t.inactive}</dd>
                                      </>
                                    )}
                                    {coachee.phone && (
                                      <>
                                        <dt className="text-stone-500">{t.phone}</dt>
                                        <dd className="m-0 text-right">
                                          <a href={`tel:${coachee.phone}`} className="font-medium text-red-600 hover:underline">{coachee.phone}</a>
                                        </dd>
                                      </>
                                    )}
                                    {coachee.email && (
                                      <>
                                        <dt className="text-stone-500">{t.emailLabel}</dt>
                                        <dd className="m-0 break-words text-right">
                                          <a href={`mailto:${coachee.email}`} className="font-medium text-red-600 hover:underline">{coachee.email}</a>
                                        </dd>
                                      </>
                                    )}
                                  </dl>
                                )}
                                {inlineGames.length === 0 ? (
                                  <p className="text-xs text-stone-500">
                                    {ownGames.length === 0
                                      ? (formData.lang === 'DE' ? 'Keine bevorstehenden Spiele.' : 'No upcoming games.')
                                      : (formData.lang === 'DE'
                                        ? `Keines der ${ownGames.length} bevorstehenden Spiele liegt im Fokus.`
                                        : `None of the ${ownGames.length} upcoming games is in focus.`)}
                                  </p>
                                ) : (
                                  <div className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
                                    {inlineGames.map(({ game, role }) => {
                                      const de = formData.lang === 'DE';
                                      const holder = game.assignedRc || '';
                                      const mine = !!holder && normName(holder) === normName(rcAuth.rcName || '');
                                      return (
                                        <div key={game.id} className="flex items-start justify-between gap-2 px-2.5 py-2">
                                          <div className="min-w-0">
                                            <div className="text-xs text-stone-500">
                                              {shortDate(game.date)} · <LeagueLabel text={game.league} /> · {role}
                                            </div>
                                            <div className="truncate text-xs font-medium text-stone-800">{game.homeTeam} vs {game.awayTeam}</div>
                                          </div>
                                          <div className="flex shrink-0 items-center gap-1">
                                            {!holder ? (
                                              <button
                                                onClick={() => { if (rcAuth.rcName) requestRcAssignment(game, rcAuth.rcName); }}
                                                className="h-7 rounded-md bg-slate-900 px-2 text-[11px] font-medium text-white hover:bg-slate-800 transition-colors"
                                              >
                                                {de ? 'Spiel übernehmen' : 'Take game'}
                                              </button>
                                            ) : mine ? (
                                              <>
                                                <button
                                                  onClick={() => handleSelectGame(game, coachee.full_name)}
                                                  className="inline-flex h-7 items-center gap-1 rounded-md bg-slate-900 px-2 text-[11px] font-medium text-white hover:bg-slate-800 transition-colors"
                                                >
                                                  <Eye size={12} />{de ? 'Beobachten' : 'Observe'}
                                                </button>
                                                <button
                                                  onClick={() => void giveBackGame(game.id, `${game.homeTeam} vs ${game.awayTeam}`, de)}
                                                  title={de ? 'Abgeben' : 'Give back'}
                                                  aria-label={de ? 'Abgeben' : 'Give back'}
                                                  className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-300 bg-white text-stone-500 hover:bg-stone-50 transition-colors"
                                                >
                                                  <X size={12} />
                                                </button>
                                              </>
                                            ) : (
                                              <span
                                                className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] text-green-700"
                                                title={de ? 'Bereits von einem RC übernommen' : 'Already taken by an RC'}
                                              >
                                                RC: {holder}
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {/* Both lists the detail sheet leads to, one tap
                                    from the row that raised the question. */}
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <button
                                    onClick={() => openCoacheeGames(coachee)}
                                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 text-[11px] font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                                  >
                                    <CalendarDays size={13} className="text-stone-400" />{t.openGames}
                                  </button>
                                  <button
                                    onClick={() => { selectCoachee(coachee); void openFeedbackPicker(coachee); }}
                                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 text-[11px] font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                                  >
                                    <ClipboardCheck size={13} className="text-stone-400" />{t.openFeedback}
                                  </button>
                                  <button
                                    onClick={() => setManualUploadCoachee(coachee)}
                                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 text-[11px] font-medium text-stone-700 hover:bg-stone-100 transition-colors"
                                  >
                                    <Upload size={13} className="text-stone-400" />{t.manualUpload}
                                  </button>
                                  {moreGames > 0 && (
                                    <button
                                      onClick={() => openCoacheeGames(coachee)}
                                      className="text-[11px] text-stone-500 underline decoration-stone-300 hover:text-stone-700"
                                    >
                                      {formData.lang === 'DE' ? `+ ${moreGames} weitere Spiele` : `+ ${moreGames} more games`}
                                    </button>
                                  )}
                                </div>
                                {/* Last, because it is the one thing here you
                                    write rather than read. The draft belongs to
                                    the open row and goes when it closes. */}
                                <div className="mt-2.5 border-t border-stone-200 pt-2.5">
                                  <label htmlFor={`notes-${coachee.id}`} className="mb-1 block text-[11px] font-semibold text-stone-600">{t.notes}</label>
                                  <textarea
                                    id={`notes-${coachee.id}`}
                                    value={detailNotes}
                                    onChange={(e) => setDetailNotes(e.target.value)}
                                    placeholder={t.notesPlaceholder}
                                    rows={3}
                                    className="w-full resize-y rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-red-500"
                                  />
                                  <button
                                    onClick={() => void handleSaveNotes()}
                                    disabled={savingNotes || detailNotes === (coachee.notes || '')}
                                    className="mt-1.5 h-7 rounded-md bg-red-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
                                  >
                                    {savingNotes ? t.loading : t.saveNotes}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                {filteredCoachees.length > LIST_PAGE_SIZE && (
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-stone-500 border-t border-stone-200">
                    <span>{filteredCoachees.length} {formData.lang === 'DE' ? 'Einträge' : 'entries'}</span>
                    <div className="flex items-center gap-2">
                      <button disabled={coacheesPage === 0} onClick={() => setListPage(coacheesPage - 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&laquo;</button>
                      <span>{coacheesPage + 1} / {Math.ceil(filteredCoachees.length / LIST_PAGE_SIZE)}</span>
                      <button disabled={(coacheesPage + 1) * LIST_PAGE_SIZE >= filteredCoachees.length} onClick={() => setListPage(coacheesPage + 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&raquo;</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Games: view toggle */}
            {listTab === 'games' && (
              <>
                <div className="flex items-center gap-1 mb-3">
                  <button
                    onClick={() => setGameViewMode('list')}
                    className={cn(
                      "p-1.5 rounded transition-colors",
                      gameViewMode === 'list' ? "bg-slate-900 text-white" : "text-stone-400 hover:text-stone-600"
                    )}
                    title={formData.lang === 'DE' ? 'Liste' : 'List'}
                  >
                    <List size={18} />
                  </button>
                  <button
                    onClick={() => setGameViewMode('calendar')}
                    className={cn(
                      "p-1.5 rounded transition-colors",
                      gameViewMode === 'calendar' ? "bg-slate-900 text-white" : "text-stone-400 hover:text-stone-600"
                    )}
                    title={formData.lang === 'DE' ? 'Kalender' : 'Calendar'}
                  >
                    <CalendarDays size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setGameFilterStarred((v) => !v)}
                    className={cn(
                      "ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors",
                      gameFilterStarred
                        ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
                        : "border-stone-200 text-stone-500 hover:bg-stone-100",
                    )}
                    title={formData.lang === 'DE'
                      ? 'Nur Spiele zeigen, die für eine Beobachtung vorgemerkt sind.'
                      : 'Show only games flagged for observation.'}
                  >
                    <Star size={14} className={cn(gameFilterStarred && 'fill-amber-500 text-amber-500')} />
                    {formData.lang === 'DE' ? 'Vorgemerkt' : 'Flagged'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowAllLevels((v) => !v)}
                    className={cn(
                      "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors",
                      showAllLevels
                        ? "border-stone-200 text-stone-500 hover:bg-stone-100"
                        : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    )}
                    title={formData.lang === 'DE'
                      ? 'Nur Spiele im Fokus der Coachees, aus ihrem Niveau (Standard). Antippen, um alle Spiele zu zeigen.'
                      : "Only games in the coachees' focus, from their level (default). Tap to show all games."}
                  >
                    <Target size={14} />
                    {showAllLevels
                      ? (formData.lang === 'DE' ? 'Alle Spiele' : 'All games')
                      : (formData.lang === 'DE' ? 'Nur im Fokus' : 'In focus only')}
                  </button>
                </div>

                {/* Games list view */}
                {gameViewMode === 'list' && (<>
                  {!gameFilterRcAssigned && (() => {
                    const takenCount = eligibleGames.filter((g) => {
                      if (!g.assignedRc) return false;
                      return inSeasonOrManual(g);
                    }).length;
                    return takenCount > 0 ? (
                      <p className="mb-2 text-[11px] text-stone-400">
                        {formData.lang === 'DE'
                          ? `${takenCount} übernommene Spiele ausgeblendet — Filter «RC zugewiesen» zeigt sie.`
                          : `${takenCount} taken game(s) hidden — the "RC assigned" filter shows them.`}
                      </p>
                    ) : null;
                  })()}
                  <div className="border border-stone-200 rounded">
                    {eligibleGames.length === 0 && (booting || loadingGames) ? (
                      <ListLoading label={t.loading} first={booting} rows={8} />
                    ) : filteredGames.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 py-14 px-4 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400"><CalendarDays size={26} strokeWidth={1.75} /></div><p className="text-sm font-medium text-stone-500">{t.noGames}</p></div>
                    ) : (
                      <>
                        <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto] items-center gap-2 bg-stone-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200">
                          <span>{formData.lang === 'DE' ? 'Spiel' : 'Game'}</span>
                          <span>{formData.lang === 'DE' ? 'Status' : 'Status'}</span>
                        </div>
                        <div className="divide-y-4 divide-stone-200">
                        {filteredGames.slice(gamesPage * LIST_PAGE_SIZE, (gamesPage + 1) * LIST_PAGE_SIZE).map((game) => {
                          const isExpanded = expandedGameId === game.id;
                          return (
                            <div key={game.id}>
                              <div
                                onClick={() => setExpandedGameId(isExpanded ? null : game.id)}
                                className={cn(
                                  "px-3 py-3.5 cursor-pointer transition-colors",
                                  isExpanded ? "bg-red-50" : "hover:bg-stone-50"
                                )}
                              >
                                {gameCard(game, {
                                  status: <ChevronDown size={14} className={cn("text-stone-400 transition-transform", isExpanded && "rotate-180")} />,
                                })}
                              </div>
                              {/* Expanded row */}
                              {isExpanded && (
                                <div className="px-3 pb-3 pt-1 bg-red-50 border-t border-red-100 space-y-2">
                                  {/* RC selector + actions */}
                                  <div className="flex flex-wrap items-center gap-3">
                                    <label className="text-xs font-medium text-stone-500">RC:</label>
                                    {/* Assigning a game to someone else is an admin act and lives in
                                        the admin console now. Here a coach takes or releases their own
                                        game and nothing else — which is all the server ever allowed
                                        without an admin session anyway. */}
                                    {game.assignedRc && game.assignedRc === rcAuth.rcName ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); void giveBackGame(game.id, `${game.homeTeam} vs ${game.awayTeam}`, formData.lang === 'DE'); }}
                                        className="h-9 px-3 text-sm font-medium rounded-md border border-stone-300 bg-white text-stone-600 hover:bg-stone-50 transition-colors"
                                      >
                                        <X size={14} className="inline mr-1 -mt-0.5" />
                                        {formData.lang === 'DE' ? 'Abgeben' : 'Give back'}
                                      </button>
                                    ) : game.assignedRc ? (
                                      <span className="text-sm font-medium text-stone-700">{game.assignedRc}</span>
                                    ) : (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!rcAuth.rcName) return;
                                          requestRcAssignment(game, rcAuth.rcName);
                                        }}
                                        className="h-9 px-3 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 transition-colors"
                                      >
                                        {formData.lang === 'DE' ? 'Spiel übernehmen' : 'Take game'}
                                      </button>
                                    )}
                                    {/* Flagging a game "we want this observed" is an admin act;
                                        it moved to the console's Games tab. The endpoint behind it
                                        was always /api/admin/games/:id/star. */}
                                    {(() => {
                                      // You observe the games you hold. There used to be an admin
                                      // exception here; admin work moved to the console, and this app
                                      // is now the same app whoever is looking at it.
                                      const canObserve = !!game.assignedRc && game.assignedRc === rcAuth.rcName;
                                      return (
                                    <button
                                      onClick={() => handleSelectGame(game)}
                                      disabled={!canObserve}
                                      className={cn("h-9 px-3 text-sm font-medium rounded-md transition-colors", canObserve ? "bg-slate-900 text-white hover:bg-slate-800 cursor-pointer" : "bg-stone-200 text-stone-400 cursor-not-allowed")}
                                    >
                                      <Eye size={14} className="inline mr-1.5 -mt-0.5" />
                                      {formData.lang === 'DE' ? 'Beobachtung starten' : 'Start observation'}
                                    </button>
                                      );
                                    })()}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); downloadIcal(game); }}
                                      className="h-9 w-9 flex items-center justify-center border border-stone-300 rounded-md bg-white shadow-sm hover:border-stone-400 hover:bg-stone-50 transition-colors cursor-pointer"
                                      title={formData.lang === 'DE' ? 'Kalender-Export' : 'Export to calendar'}
                                    >
                                      <CalendarDays size={16} className="text-stone-500" />
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        </div>
                      </>
                    )}
                    {filteredGames.length > LIST_PAGE_SIZE && (
                      <div className="flex items-center justify-between px-3 py-2 text-xs text-stone-500 border-t border-stone-200">
                        <span>{filteredGames.length} {formData.lang === 'DE' ? 'Spiele' : 'games'}</span>
                        <div className="flex items-center gap-2">
                          <button disabled={gamesPage === 0} onClick={() => setListPage(gamesPage - 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&laquo;</button>
                          <span>{gamesPage + 1} / {Math.ceil(filteredGames.length / LIST_PAGE_SIZE)}</span>
                          <button disabled={(gamesPage + 1) * LIST_PAGE_SIZE >= filteredGames.length} onClick={() => setListPage(gamesPage + 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&raquo;</button>
                        </div>
                      </div>
                    )}
                  </div>
                </>)}

                {/* Games calendar view */}
                {gameViewMode === 'calendar' && (() => {
                  const year = calendarMonth.getFullYear();
                  const month = calendarMonth.getMonth();
                  const firstDay = new Date(year, month, 1);
                  const startWeekday = (firstDay.getDay() + 6) % 7; // Monday = 0
                  const daysInMonth = new Date(year, month + 1, 0).getDate();
                  const today = new Date();
                  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

                  // Build map of date string -> games
                  const gamesByDate = new Map<string, EligibleGame[]>();
                  for (const game of filteredGames) {
                    const gd = new Date(game.date);
                    if (isNaN(gd.getTime())) continue;
                    if (gd.getFullYear() !== year || gd.getMonth() !== month) continue;
                    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(gd.getDate()).padStart(2, '0')}`;
                    const arr = gamesByDate.get(key) || [];
                    arr.push(game);
                    gamesByDate.set(key, arr);
                  }

                  const weekdays = formData.lang === 'DE'
                    ? ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
                    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                  const monthNames = formData.lang === 'DE'
                    ? ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
                    : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

                  const cells: React.ReactNode[] = [];
                  // Empty cells before first day
                  for (let i = 0; i < startWeekday; i++) {
                    cells.push(<div key={`empty-${i}`} className="min-h-[3.5rem] sm:h-20" />);
                  }
                  for (let day = 1; day <= daysInMonth; day++) {
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const dayGames = gamesByDate.get(dateStr) || [];
                    const isToday = dateStr === todayStr;
                    const hasGames = dayGames.length > 0;


                    cells.push(
                      <div
                        key={day}
                        onClick={() => {
                          if (hasGames) {
                            const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                            setGameFilterDateFrom(ds);
                            setGameFilterDateTo(ds);
                            setGameViewMode('list');
                            setListPage(0);
                          }
                        }}
                        className={cn(
                          "min-h-[3.5rem] sm:h-20 p-0.5 sm:p-1 border border-stone-100 rounded text-xs transition-colors overflow-hidden",
                          hasGames ? "cursor-pointer hover:bg-red-50" : "",
                          isToday && "ring-2 ring-red-400"
                        )}
                      >
                        <div className={cn("font-medium text-[11px] sm:text-xs", isToday ? "text-red-600" : "text-stone-700")}>{day}</div>
                        {hasGames && (
                          <div className="mt-0.5 sm:mt-1 flex flex-wrap gap-0.5">
                            {dayGames.slice(0, 3).map((g, i) => (
                              <span
                                key={i}
                                className={cn(
                                  "w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full",
                                  g.assignedRc ? "bg-green-500" : "bg-stone-300"
                                )}
                                title={`${g.homeTeam} vs ${g.awayTeam}${g.assignedRc ? ` (RC: ${g.assignedRc})` : ''}`}
                              />
                            ))}
                            {dayGames.length > 3 && (
                              <span className="text-[9px] sm:text-[10px] text-stone-400 leading-none">+{dayGames.length - 3}</span>
                            )}
                          </div>
                        )}
                        {hasGames && (
                          <div className="mt-0.5 text-[9px] sm:text-[10px] text-stone-400 leading-tight truncate">{dayGames.length} {dayGames.length === 1 ? (formData.lang === 'DE' ? 'Spiel' : 'game') : (formData.lang === 'DE' ? 'Spiele' : 'games')}</div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div className="border border-stone-200 rounded">
                      {/* Month navigation */}
                      <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200 bg-stone-50">
                        <button
                          onClick={() => setCalendarMonth(new Date(year, month - 1, 1))}
                          className="p-1 rounded hover:bg-stone-200 transition-colors"
                        >
                          <ChevronLeft size={18} className="text-stone-600" />
                        </button>
                        <span className="text-sm font-semibold text-stone-800">
                          {monthNames[month]} {year}
                        </span>
                        <button
                          onClick={() => setCalendarMonth(new Date(year, month + 1, 1))}
                          className="p-1 rounded hover:bg-stone-200 transition-colors"
                        >
                          <ChevronRight size={18} className="text-stone-600" />
                        </button>
                      </div>
                      {/* Weekday headers */}
                      <div className="grid grid-cols-7 text-center text-xs font-medium text-stone-500 border-b border-stone-100 py-1.5">
                        {weekdays.map((wd) => <div key={wd}>{wd}</div>)}
                      </div>
                      {/* Day grid */}
                      <div className="grid grid-cols-7 gap-0 p-1">
                        {cells}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {backendNotice && (
              <p className="text-sm mt-3 text-red-700">{backendNotice}</p>
            )}
          </div>

          <div className="bg-white p-4 rounded-2xl shadow-card border border-stone-200/70 mt-4 no-print">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400 mb-2">{formData.lang === 'DE' ? 'Nützliche Infos & Dokumente' : 'Useful info & documents'}</h3>
            <div className="flex flex-col gap-1.5">
              <a href="https://www.svrz.ch/_Resources/Persistent/8/6/d/d/86dd9a07156e7501b5e74ec3e0eeeab30975bcbd/Uebersicht%20SR-Niveau%20und%20Stufe.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Download size={14} /> {formData.lang === 'DE' ? 'SR-Niveau und Stufe (PDF)' : 'SR levels & stages (PDF)'}</a>
              <a href={`${import.meta.env.BASE_URL}#/guide/${formData.lang === 'DE' ? 'de' : 'en'}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Video size={14} /> {formData.lang === 'DE' ? 'Video-Anleitung' : 'Video guide'}</a>
              <button type="button" onClick={() => setShowEmptyFormModal(true)} disabled={downloadingEmptyForm} className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit disabled:opacity-50"><Download size={14} /> {downloadingEmptyForm ? t.loading : t.downloadEmptyForm}</button>
              <a href={`${import.meta.env.BASE_URL}docs/Leitfaden-SR-Technik.pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Download size={14} /> {formData.lang === 'DE' ? 'Leitfaden SR-Technik (PDF)' : 'Refereeing technique guide (PDF)'}</a>
              <a href="https://www.svrz.ch/ausbildung/schiedsrichter-in/informationen" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Info size={14} /> {formData.lang === 'DE' ? 'SR-Informationen (svrz.ch)' : 'Referee info (svrz.ch)'}</a>
            </div>
          </div>
        </div>
      )}

      {feedbackSubView === 'coacheeGames' && (
        <div className="max-w-4xl mx-auto bg-white p-3 sm:p-6 shadow-xl border border-stone-200 no-print">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-stone-800">
              {selectedCoacheeName || '-'}
              {(() => {
                const vc = coachees.find((c) => c.id === selectedCoacheeId);
                if (!vc && !selectedCoacheeLevel) return null;
                return <span className="ml-2 text-xs font-normal text-stone-500">(Level: {vc ? <LevelText level={vc.referee_level} stage={vc.stage} /> : selectedCoacheeLevel})</span>;
              })()}
            </h2>
            <button
              onClick={() => setFeedbackSubView('coachees')}
              className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
            >
              {t.lists}
            </button>
          </div>
          <div className="border border-stone-200 rounded">
            {loadingCoacheeGames ? (
              <ListLoading label={t.loading} first={booting} rows={5} />
            ) : coacheeGames.length === 0 ? (
              <p className="text-sm text-stone-500 p-4">{t.noCoacheeGames}</p>
            ) : (() => {
              const now = new Date();
              const viewCoachee = coachees.find((c) => c.id === selectedCoacheeId);
              const lvlKey = levelKey(viewCoachee?.referee_level, viewCoachee?.stage);
              const target = viewCoachee ? coacheeTargets[viewCoachee.id] : undefined;
              // The endpoint answers with every game this person was ever put
              // on. Unscoped, last season's fixtures came back as "past games"
              // and — being outside the focus — were counted into "n games
              // outside the focus hidden", which read 14 for a referee with 12
              // games this season.
              const seasonGames = coacheeGames.filter((g) => inSeasonOrManual(g));
              const srRoles = (g: CoacheeGame): TargetRole[] => {
                const roles: TargetRole[] = [];
                if (g.assignedRoles.includes('1. SR')) roles.push('1SR');
                if (g.assignedRoles.includes('2. SR')) roles.push('2SR');
                return roles;
              };
              const visibleGames = seasonGames.filter((g) => inCoacheeFocus(viewCoachee, g.league || '', srRoles(g)));
              const hiddenByTarget = seasonGames.length - visibleGames.length;
              // The endpoint sorts newest-first, which is what the past list
              // wants and the exact opposite of what this one does: it put the
              // game furthest away at the top and the next one to referee at
              // the bottom. Soonest first here, most recent first below.
              const upcomingGames = visibleGames
                .filter((game) => new Date(game.date) >= now)
                .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
              const allPastGames = visibleGames.filter((game) => new Date(game.date) < now);
              const feedbackByGameId = new Set(coacheeFeedbacks.map((f) => f.game).filter(Boolean));
              const pastGames = showAllPastGames ? allPastGames : allPastGames.filter((game) => feedbackByGameId.has(game.id));
              return (
                <div>
                  {(hiddenByTarget > 0 || (showAllLevels && isTargetActive(target, lvlKey, niveauTable))) && (
                    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800">
                      <span>
                        {showAllLevels
                          ? (formData.lang === 'DE' ? 'Alle Spiele werden angezeigt (Fokus-Filter aus).' : 'Showing all games (focus filter off).')
                          : (formData.lang === 'DE'
                            ? `${hiddenByTarget} Spiel(e) ausserhalb des Fokus ausgeblendet.`
                            : `${hiddenByTarget} game(s) outside the focus hidden.`)}
                      </span>
                      <button
                        onClick={() => setShowAllLevels((v) => !v)}
                        className="shrink-0 normal-case font-medium px-2 py-0.5 border rounded border-emerald-300 hover:bg-emerald-100"
                      >
                        {showAllLevels
                          ? (formData.lang === 'DE' ? 'Nur im Fokus' : 'In focus only')
                          : (formData.lang === 'DE' ? 'Alle anzeigen' : 'Show all')}
                      </button>
                    </div>
                  )}
                  {/* Upcoming games */}
                  <div className="px-4 py-2 bg-stone-100 text-xs font-bold uppercase text-stone-500 border-b border-stone-200">
                    {formData.lang === 'DE' ? 'Bevorstehende Spiele' : 'Upcoming Games'} ({upcomingGames.length})
                  </div>
                  {upcomingGames.length === 0 ? (
                    <p className="text-sm text-stone-500 p-4">{formData.lang === 'DE' ? 'Keine bevorstehenden Spiele.' : 'No upcoming games.'}</p>
                  ) : (
                    <div className="divide-y divide-stone-100">
                      {upcomingGames.map((game) => {
                        // Taking a game acts on the open list's copy of it: this
                        // list also carries games where the coachee is only a
                        // line judge, and those can never be observed. Reading
                        // the holder from there too keeps the buttons right the
                        // moment the game changes hands, without a reload.
                        const eg = eligibleGames.find((e) => e.id === game.id);
                        const holder = eg ? eg.assignedRc || '' : game.assignedRc || '';
                        const mine = !!holder && normName(holder) === normName(rcAuth.rcName || '');
                        const de = formData.lang === 'DE';
                        return (
                          <div key={game.id}>
                            {/* role=button rather than a button: the row now
                                carries the hall as a link, and an anchor inside
                                a button is invalid markup. */}
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={() => handleSelectGame(game)}
                              onKeyDown={(e) => {
                                if (e.target !== e.currentTarget) return;
                                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectGame(game); }
                              }}
                              className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                            >
                              {/* The holder is read off the open games list, not
                                  off this row's own copy, so the dot turns green
                                  the moment the game changes hands. */}
                              {gameCard({ ...game, assignedRc: holder }, { roles: game.assignedRoles })}
                            </div>
                          {/* A sibling of the row, not a child: a button inside
                              a button is invalid, and this list was read-only
                              until now — the game had to be found again in the
                              open games list before it could be taken. */}
                          {eg && (
                            <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
                              {!holder ? (
                                <button
                                  onClick={() => { if (rcAuth.rcName) requestRcAssignment(eg, rcAuth.rcName); }}
                                  className="h-8 px-3 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 transition-colors"
                                >
                                  {de ? 'Spiel übernehmen' : 'Take game'}
                                </button>
                              ) : mine ? (
                                <>
                                  <button
                                    onClick={() => handleSelectGame(eg, selectedCoacheeName)}
                                    className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium rounded-md bg-slate-900 text-white hover:bg-slate-800 transition-colors"
                                  >
                                    <Eye size={13} />
                                    {de ? 'Beobachtung starten' : 'Start observation'}
                                  </button>
                                  <button
                                    onClick={() => void giveBackGame(eg.id, `${game.homeTeam} vs ${game.awayTeam}`, de)}
                                    className="inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium rounded-md border border-stone-300 bg-white text-stone-600 hover:bg-stone-50 transition-colors"
                                  >
                                    <X size={13} />
                                    {de ? 'Abgeben' : 'Give back'}
                                  </button>
                                </>
                              ) : null}
                            </div>
                          )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Past games — always available (behind a toggle), regardless of feedback */}
                  {allPastGames.length > 0 && (
                    <>
                      <div className="px-4 py-2 bg-stone-100 text-xs font-bold uppercase text-stone-500 border-b border-t border-stone-200 flex items-center justify-between">
                        <span>{formData.lang === 'DE' ? 'Vergangene Spiele' : 'Past Games'} ({allPastGames.length})</span>
                        <button
                          onClick={() => setShowAllPastGames((v) => !v)}
                          className="text-[10px] normal-case font-normal px-2 py-0.5 border rounded border-stone-300 hover:bg-stone-200"
                        >
                          {coacheeFeedbacks.length > 0
                            ? (showAllPastGames ? (formData.lang === 'DE' ? 'Nur beobachtete' : 'Observed only') : (formData.lang === 'DE' ? 'Alle Spiele' : 'Show all games'))
                            : (showAllPastGames ? (formData.lang === 'DE' ? 'Ausblenden' : 'Hide') : (formData.lang === 'DE' ? 'Anzeigen' : 'Show'))}
                        </button>
                      </div>
                      {pastGames.length === 0 ? (
                        <p className="text-sm text-stone-500 p-4">
                          {formData.lang === 'DE'
                            ? `${allPastGames.length} vergangene Spiele — «${coacheeFeedbacks.length > 0 ? 'Alle Spiele' : 'Anzeigen'}» antippen, um sie zu sehen.`
                            : `${allPastGames.length} past game(s) — tap "${coacheeFeedbacks.length > 0 ? 'Show all games' : 'Show'}" to view them.`}
                        </p>
                      ) : (
                        <div className="divide-y divide-stone-100">
                          {pastGames.map((game) => {
                            const hasFeedback = feedbackByGameId.has(game.id);
                            return (
                              <div
                                key={game.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => handleSelectGame(game)}
                                onKeyDown={(e) => {
                                  if (e.target !== e.currentTarget) return;
                                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectGame(game); }
                                }}
                                className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                              >
                                {gameCard(game, {
                                  roles: game.assignedRoles,
                                  status: (
                                    <span className={cn("ml-1 text-xs px-2 py-0.5 rounded-full", hasFeedback ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-500")}>
                                      {hasFeedback ? (formData.lang === 'DE' ? 'Feedback' : 'Feedback') : (formData.lang === 'DE' ? 'Kein Feedback' : 'No feedback')}
                                    </span>
                                  ),
                                })}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
          {backendNotice && (
            <p className="text-sm mt-3 text-red-700">{backendNotice}</p>
          )}
        </div>
      )}

      {feedbackSubView === 'calendar' && (
        <div className="max-w-5xl mx-auto bg-white p-3 sm:p-6 shadow-xl border border-stone-200 no-print">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-stone-800">{t.calendar}</h2>
            <div className="flex gap-2">
              <button
                onClick={() => setFeedbackSubView('coachees')}
                className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
              >
                {t.lists}
              </button>
              <button
                onClick={() => void refreshCalendarGames()}
                className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
              >
                {loadingCalendar ? t.loading : t.loadGames}
              </button>
            </div>
          </div>
          <div className="space-y-4 max-h-[70vh] overflow-auto">
            {sortedCalendarDays.length === 0 && (booting || loadingCalendar) ? (
              <ListLoading label={t.loading} first={booting} rows={5} framed />
            ) : sortedCalendarDays.length === 0 ? (
              <p className="text-sm text-stone-500">{t.noGames}</p>
            ) : (
              sortedCalendarDays.map((day) => (
                <div key={day} className="border border-stone-200 rounded">
                  <div className="px-3 py-2 border-b bg-stone-50 text-sm font-semibold text-stone-700">{day}</div>
                  <div className="divide-y divide-stone-100">
                    {groupedCalendarGames[day].map((game) => (
                      <div key={game.id} className="px-3 py-2 flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-stone-900">
                            {game.matchNo} - {game.homeTeam} vs {game.awayTeam}
                          </div>
                          <div className="text-xs text-stone-500 mt-1">
                            {game.league} | {game.location}
                          </div>
                        </div>
                        <span className={cn('w-3 h-3 rounded-full mt-1', statusDotClass(game.status))} />
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          {backendNotice && (
            <p className="text-sm mt-3 text-red-700">{backendNotice}</p>
          )}
        </div>
      )}

      {feedbackSubView === 'feedbackForm' && (
      <>
      {/* Where the coach finds out whether their work is safe. Silence here is
          the one thing this feature cannot afford: the whole point is that
          nobody has to wonder. */}
      {!formDisabled && (
        <div className="max-w-4xl mx-auto mb-3 no-print space-y-2">
          {!draftStoreOk && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
              <CloudOff size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1">{t.draftNoStore}</span>
              <button onClick={() => void handleExportDraft()} className="shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-700 hover:bg-red-100">
                {t.draftSaveAsFile}
              </button>
            </div>
          )}
          {draftSaveFailed && draftStoreOk && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-800">
              <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1">{t.draftSaveFailed}</span>
              <button onClick={() => void handleExportDraft()} className="shrink-0 rounded border border-red-300 bg-white px-2 py-0.5 font-semibold text-red-700 hover:bg-red-100">
                {t.draftSaveAsFile}
              </button>
            </div>
          )}
          {draftClaimedElsewhere && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
              <Copy size={14} className="shrink-0 mt-0.5" />
              <span className="flex-1">{t.draftOtherTab}</span>
            </div>
          )}
          {parkFailed && (
            <p className="text-xs text-amber-700 flex items-start gap-1.5">
              <CloudOff size={12} className="shrink-0 mt-0.5" />{t.parkFailed}
            </p>
          )}
          {draftContext && draftWorth && !draftSaveFailed && (
            <p className="text-xs text-stone-500 flex items-center gap-1.5">
              {draftUnsaved
                ? <><Loader2 size={12} className="animate-spin" />{t.draftSaving}</>
                : <><ClipboardCheck size={12} className="text-green-600" />{t.draftSaved}{draftSavedAt ? ` · ${new Date(draftSavedAt).toLocaleTimeString(formData.lang === 'DE' ? 'de-CH' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}` : ''}</>}
              {/* Said plainly rather than buried: the observation, signatures
                  included, is on the server as well as this device. */}
              {parkedOk && !parkFailed && (
                <span className="text-stone-400" title={t.parkHint}>· {t.parkedAt}</span>
              )}
            </p>
          )}
          {draftScoreConflict && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
              <span className="flex-1">
                {t.draftScoreChanged} {formData.lang === 'DE' ? 'Entwurf' : 'Draft'}: <b>{formData.meta.ergebnis || '—'}</b> · {formData.lang === 'DE' ? 'Spiel' : 'Game'}: <b>{draftScoreConflict}</b>
              </span>
              <button
                onClick={() => { updateMeta('ergebnis', draftScoreConflict); setDraftScoreConflict(''); }}
                className="rounded border border-amber-400 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100"
              >
                {t.draftUseGameScore}
              </button>
            </div>
          )}
        </div>
      )}
      {/* Main Form Container */}
      <div className="max-w-4xl mx-auto bg-white p-4 md:p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0 print:max-w-none print:mx-0">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-6 print:flex-row">
          <div className="flex flex-col sm:flex-row print:flex-row gap-2 sm:gap-4 items-start">
            <SvrzLogo className="h-12 sm:h-16 shrink-0" />
            <div className="min-w-0">
              <p className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold break-words">SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch</p>
              <h1 className="text-xl sm:text-2xl font-bold mt-1 text-stone-900 flex items-center gap-3">
                {t.title} 
                <span className="bg-stone-900 text-white px-3 py-0.5 rounded text-lg whitespace-nowrap shrink-0">{formData.role}</span>
              </h1>
            </div>
          </div>
        </div>

        {/* Meta Data Grid — inside the disabled wrapper's reach: a filed or
            already-closed observation must not accept edits to its header
            either, or the screen shows numbers the filed PDF never had. */}
        <div className={cn(
          // Four even-ish columns rather than 1/1/1/2: the referee row carries
          // four fields now, and the result underneath gets the whole width it
          // needs for a set-by-set score.
          "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1.6fr] print:grid-cols-[1.4fr_1fr_1fr_1.6fr] border-t border-l border-stone-900 mb-4",
          formDisabled && 'pointer-events-none opacity-60',
        )}>
          <MetaField label={t.matchNo} value={formData.meta.spielNr} onChange={v => updateMeta('spielNr', v)} />
          <MetaField label={t.league} value={formData.meta.liga} onChange={v => updateMeta('liga', v)} />
          <MetaField label={t.date} value={formData.meta.datum} onChange={v => updateMeta('datum', v)} />
          <MetaField label={t.location} value={formData.meta.ort} onChange={v => updateMeta('ort', v)} />
          
          <MetaField label={t.teams} value={formData.meta.mannschaften} onChange={v => updateMeta('mannschaften', v)} className="col-span-2 md:col-span-4 print:col-span-4" />

          {/* Who was observed, at what level, in which group, by whom — one
              line, because they are read together. */}
          <MetaField label={formData.role} value={formData.meta.srName} onChange={v => updateMeta('srName', v)} className="col-span-2 md:col-span-1 print:col-span-1" />
          <MetaField label={t.refLevel} value={formData.meta.srNiveau} onChange={v => updateMeta('srNiveau', v)} />
          <MetaField label={t.group} value={formData.meta.gruppe} onChange={v => updateMeta('gruppe', v)} />
          <MetaField label={t.rc} value={formData.meta.rc} onChange={v => updateMeta('rc', v)} className="col-span-2 md:col-span-1 print:col-span-1" readOnly />

          <ResultField label={t.result} value={formData.meta.ergebnis} onChange={v => updateMeta('ergebnis', v)} teams={formData.meta.mannschaften} className="col-span-2 md:col-span-4 print:col-span-4" readOnly={!!selectedGame?.game_result && !resultUnlocked} onUnlock={() => setResultUnlocked(true)} lang={formData.lang} />
        </div>

        {/* Legend */}
        <div className="mb-6 p-2 bg-stone-50 border border-stone-200 rounded flex items-start gap-2 text-[10px] text-stone-600 italic">
          <Info size={14} className="text-red-500 shrink-0 mt-px" />
          <div className="min-w-0">
            <div>{LEGEND[formData.lang]}</div>
            {/* Clicking a cell again has always cycled A → A+ → A- → empty, but
                nothing said so and coaches never found it. Deliberately NOT
                folded into LEGEND: feedbackPdf draws that same string and its
                legend line already runs close to the page width. Hidden in
                print so the paper sheet keeps the plain A–E scale. */}
            <div className="mt-1 not-italic text-stone-500 print:hidden">
              {formData.lang === 'DE'
                ? 'Feiner abstufen: dieselbe Zelle nochmals anklicken — A → A+ → A- → leer.'
                : 'Finer grading: click the same cell again — A → A+ → A- → empty.'}
            </div>
          </div>
        </div>

        <div className={cn(formDisabled && 'pointer-events-none opacity-60')}>

        {/* Assessment Sections */}
        <div className="space-y-6">
          {formData.sections.map((section, sIdx) => (
            <div key={section.title} className="overflow-hidden">
              <div className="bg-stone-100 border-x border-t border-stone-900 px-3 py-1.5 font-bold text-xs uppercase tracking-wider text-stone-700 flex items-center gap-2">
                <ClipboardCheck size={14} />
                {section.title}
              </div>
              {(() => {
                const sectionHasNA = section.items.some(it => NA_ELIGIBLE_IDS.has(it.id));
                return (
              <>
              <table className="w-full border-collapse border border-stone-900 hidden sm:table">
                <thead>
                  <tr className="bg-stone-50 text-[10px] uppercase font-bold text-stone-500">
                    <th className="p-2 text-left border-b border-stone-900">{t.criteria}</th>
                    {sectionHasNA && <th className="w-10 border-b border-stone-900 print:hidden" />}
                    {RATINGS.map(r => (
                      <th key={r} className={cn("w-10 border-l border-b border-stone-900 text-center", r === 'C' && "bg-stone-200")}>{r}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, iIdx) => {
                    const hasNA = NA_ELIGIBLE_IDS.has(item.id);
                    const isNA = item.rating === 'N/A';
                    return (
                    <tr key={item.id} className="group hover:bg-stone-50 transition-colors">
                      <td className="p-2 text-xs border-b border-stone-900 leading-tight">{item.label}</td>
                      {sectionHasNA && (
                        hasNA ? (
                          <td
                            onClick={() => {
                              setFormData(prev => {
                                const newSections = [...prev.sections];
                                const newItems = [...newSections[sIdx].items];
                                newItems[iIdx] = { ...newItems[iIdx], rating: isNA ? '' : 'N/A' };
                                newSections[sIdx] = { ...newSections[sIdx], items: newItems };
                                return { ...prev, sections: newSections };
                              });
                            }}
                            className={cn(
                              "w-10 border-l border-r border-b border-stone-900 text-center cursor-pointer transition-all text-[10px] font-bold print:hidden",
                              isNA
                                ? "bg-stone-500 text-white"
                                : "text-stone-400 hover:bg-stone-100"
                            )}
                          >
                            N/A
                          </td>
                        ) : (
                          <td className="w-10 border-b border-stone-900 print:hidden" />
                        )
                      )}
                      {isNA ? (
                        <td colSpan={5} className="border-l border-b border-stone-900 relative">
                          <div className="absolute inset-0 flex items-center px-2">
                            <div className="w-full border-t-2 border-stone-900" />
                          </div>
                        </td>
                      ) : (
                        RATINGS.map(r => {
                          const isSelected = item.rating.startsWith(r);
                          return (
                            <td
                              key={r}
                              onClick={() => updateRating(sIdx, iIdx, r)}
                              className={cn(
                                "rating-cell w-10 border-l border-b border-stone-900 text-center cursor-pointer transition-all text-sm font-bold",
                                r === 'C' && !item.rating && "bg-stone-200/50",
                                isSelected && RATING_COLORS[r]
                              )}
                            >
                              {isSelected ? item.rating : ''}
                            </td>
                          );
                        })
                      )}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="sm:hidden border-x border-b border-stone-900 divide-y divide-stone-200">
                {section.items.map((item, iIdx) => {
                  const hasNA = NA_ELIGIBLE_IDS.has(item.id);
                  const isNA = item.rating === 'N/A';
                  return (
                    <div key={item.id} className="p-2.5">
                      <div className="text-xs text-stone-700 mb-2 leading-snug">{item.label}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {RATINGS.map(r => {
                          const isSelected = item.rating.startsWith(r);
                          return (
                            <button key={r} type="button" onClick={() => updateRating(sIdx, iIdx, r)}
                              className={cn("w-9 h-9 rounded border text-sm font-bold transition-all", isSelected ? cn(RATING_COLORS[r], "border-transparent") : "bg-white border-stone-300 text-stone-600 hover:bg-stone-100")}>
                              {isSelected ? item.rating : r}
                            </button>
                          );
                        })}
                        {hasNA && (
                          <button type="button" onClick={() => setFormData(prev => { const ns = [...prev.sections]; const ni = [...ns[sIdx].items]; ni[iIdx] = { ...ni[iIdx], rating: isNA ? '' : 'N/A' }; ns[sIdx] = { ...ns[sIdx], items: ni }; return { ...prev, sections: ns }; })}
                            className={cn("h-9 px-3 rounded border text-xs font-bold transition-all", isNA ? "bg-stone-500 text-white border-stone-500" : "bg-white border-stone-300 text-stone-400 hover:bg-stone-100")}>
                            N/A
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
                );
              })()}
            </div>
          ))}
        </div>

        {/* Results Header Row */}
        <div className="mt-8 border border-stone-900 bg-stone-50 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 print:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-stone-900">
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.matchLevel}</h4>
            <div className="flex flex-wrap gap-1">
              {([['leicht', t.easy], ['normal', t.normal], ['schwierig', t.difficult]] as [string, string][]).map(([v, lbl]) => (
                <button key={v} type="button" onClick={() => updateResult('spielniveau', v)}
                  className={cn("h-8 px-2.5 border rounded text-xs font-bold transition-all", formData.results.spielniveau === v ? SELECTED_RESULT : "bg-white border-stone-300 hover:bg-stone-100")}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.motivation}</h4>
            <div className="flex gap-1">
              {['up', 'check', 'down'].map(v => (
                <button 
                  key={v}
                  onClick={() => updateResult('motivation', v)}
                  className={cn(
                    "w-8 h-8 border border-stone-300 rounded flex items-center justify-center text-lg font-bold transition-all",
                    formData.results.motivation === v ? SELECTED_RESULT : "bg-white hover:bg-stone-100"
                  )}
                >
                  {v === 'up' ? '↑' : v === 'check' ? '✓' : '↓'}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.rating}</h4>
            <div className="flex gap-1">
              {['up', 'check', 'down'].map(v => (
                <button 
                  key={v}
                  onClick={() => updateResult('einstufung', v)}
                  className={cn(
                    "w-8 h-8 border border-stone-300 rounded flex items-center justify-center text-lg font-bold transition-all",
                    formData.results.einstufung === v ? SELECTED_RESULT : "bg-white hover:bg-stone-100"
                  )}
                >
                  {v === 'up' ? '↑' : v === 'check' ? '✓' : '↓'}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.secondVisit}</h4>
            <div className="flex gap-1">
              {['Y', 'N'].map(v => (
                <button 
                  key={v}
                  onClick={() => updateResult('secondBesuch', v)}
                  className={cn(
                    "w-8 h-8 border border-stone-300 rounded flex items-center justify-center text-xs font-bold transition-all",
                    formData.results.secondBesuch === v ? SELECTED_RESULT : "bg-white hover:bg-stone-100"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.refGoal}</h4>
            <input
              type="text"
              className="w-full bg-white border border-stone-200 rounded text-xs p-1.5 outline-none focus:ring-2 focus:ring-red-500"
              value={formData.results.srZiel}
              onChange={e => setFormData(prev => ({ ...prev, results: { ...prev.results, srZiel: e.target.value } }))}
            />
          </div>
        </div>

        {/* Full-width Remarks */}
        <div className="border-x border-b border-stone-900 p-4 flex flex-col gap-3">
          <h3 className="font-bold border-b border-stone-900 pb-1 flex items-center gap-2 text-stone-800">
            <MessageSquare size={16} />
            {t.remarks}
          </h3>
          <ExpandableTextarea
            label={t.remarks}
            lang={formData.lang}
            minHeight="3.5rem"
            placeholder={t.remarksPlaceholder}
            value={formData.results.bemerkungen}
            onChange={(v) => setFormData(prev => ({ ...prev, results: { ...prev.results, bemerkungen: v } }))}
          />
          {(([['highlights', t.highlights], ['improvements', t.improvements], ['goals', t.goalsNext]]) as ['highlights' | 'improvements' | 'goals', string][]).map(([key, label]) => (
            <div key={key}>
              <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{label}</h4>
              <ExpandableTextarea
                label={label}
                lang={formData.lang}
                minHeight="2.75rem"
                value={formData.results[key] || ''}
                onChange={(v) => setFormData(prev => ({ ...prev, results: { ...prev.results, [key]: v } }))}
              />
            </div>
          ))}
        </div>

        {/* Signatures — referee and coach, side by side as they print. */}
        <div className="border-x border-b border-stone-900 grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-stone-300">
          {([
            { target: 'referee' as const, image: formData.signature || '', label: formData.lang === 'DE' ? 'Unterschrift Schiedsrichter' : 'Referee signature' },
            { target: 'rc' as const, image: formData.rcSignature || '', label: formData.lang === 'DE' ? 'Unterschrift Referee Coach' : 'Referee Coach signature' },
          ]).map((sig) => (
            <div key={sig.target} className="p-4 flex items-end gap-3 min-w-0">
              <div className="flex-1 min-w-0">
                <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-2">{sig.label}</h4>
                {sig.image ? (
                  <img src={sig.image} alt={sig.label} className="h-20 max-w-full object-contain" />
                ) : (
                  <div className="h-14 border-b border-stone-400" />
                )}
              </div>
              <div className="no-print flex flex-col gap-1.5 shrink-0">
                <button type="button" onClick={() => void openSignatureModal(sig.target)} className="h-9 px-3 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700">{formData.lang === 'DE' ? 'Unterschreiben' : 'Sign'}</button>
                {sig.image && <button type="button" onClick={() => updateSignature('', sig.target)} className="h-8 px-3 rounded-lg border border-stone-200 text-xs text-stone-500 hover:bg-stone-100">{formData.lang === 'DE' ? 'Entfernen' : 'Remove'}</button>}
              </div>
            </div>
          ))}
        </div>

        {/* Left on a phone, right where there is room for it. Each segment
            breaks as a unit, so a narrow screen splits the line at a separator
            instead of stranding the last word of the tool's name alone against
            the right edge. */}
        <div className="mt-6 pt-4 border-t border-stone-100 text-[9px] text-left sm:text-right print:text-right text-stone-400 italic">
          <span className="whitespace-nowrap">{t.version}: {t.versionDate}</span>
          {' | '}
          <span className="whitespace-nowrap">{VERSION_STAMP}</span>
          {' | '}
          <span className="whitespace-nowrap">SVRZ Referee Coaching Tool</span>
        </div>
      </div>

      {/* Tips & Tricks (not saved to feedback, included in email only) */}
      <div className="max-w-4xl mx-auto mt-6 bg-white p-6 shadow-xl border border-stone-200 no-print">
        <h3 className="font-bold text-stone-800 mb-3 flex items-center gap-2">
          <Info size={16} />
          {formData.lang === 'DE' ? 'Tipps & Tricks' : 'Tips & Tricks'}
        </h3>
        <p className="text-xs text-stone-500 mb-3">
          {formData.lang === 'DE'
            ? 'Diese Tipps werden nicht im offiziellen Feedback gespeichert, sondern nur per E-Mail an den Schiedsrichter gesendet.'
            : 'These tips will not be saved in the official feedback, but will be sent to the referee via email only.'}
        </p>
        <textarea
          className="w-full min-h-[8rem] text-sm leading-relaxed resize-none outline-none bg-stone-50 border border-stone-200 rounded p-3 placeholder:text-stone-300"
          placeholder={formData.lang === 'DE' ? 'Tipps und Tricks für den Schiedsrichter eingeben...' : 'Enter tips and tricks for the referee...'}
          value={tipsAndTricks}
          onChange={e => setTipsAndTricks(e.target.value)}
        />
      </div>
      </div>{/* end formDisabled wrapper */}

      {/* Private note to the RC president. Deliberately outside the disabled
          wrapper: the feedback it belongs to is already filed and read-only,
          and this note is the one thing still writable on that screen. */}
      {openFeedbackId && openFeedbackMine && (
        <div className="max-w-4xl mx-auto mt-6 bg-white p-6 shadow-xl border border-amber-200 no-print">
          <h3 className="font-bold text-stone-800 mb-3 flex items-center gap-2">
            <Lock size={16} className="text-amber-600" />
            {formData.lang === 'DE' ? 'Vertrauliche Notiz an die RC-Vorsitzende' : 'Private note to the RC president'}
          </h3>
          <p className="text-xs text-stone-500 mb-3">
            {formData.lang === 'DE'
              ? 'Nur die RC-Vorsitzende sieht diese Notiz. Sie wird weder im Feedback gespeichert noch dem Schiedsrichter gesendet.'
              : 'Only the RC president sees this note. It is not part of the feedback and is never sent to the referee.'}
          </p>
          <textarea
            className="w-full min-h-[7rem] text-sm leading-relaxed resize-none outline-none bg-amber-50/40 border border-amber-200 rounded p-3 placeholder:text-stone-300"
            placeholder={formData.lang === 'DE' ? 'Was die RC-Vorsitzende wissen sollte…' : 'What the RC president should know…'}
            value={presidentNote}
            disabled={!presidentNoteLoaded}
            onChange={(e) => setPresidentNote(e.target.value)}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void savePresidentNoteNow()}
              disabled={presidentNoteSaving || !presidentNoteLoaded}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {presidentNoteSaving && <Loader2 size={14} className="animate-spin" />}
              {formData.lang === 'DE' ? 'Notiz speichern' : 'Save note'}
            </button>
            {presidentNoteSaved && <span className="text-xs font-medium text-green-600">{formData.lang === 'DE' ? 'Gespeichert ✓' : 'Saved ✓'}</span>}
            {presidentNoteError && <span className="text-xs font-medium text-red-600">{presidentNoteError}</span>}
          </div>
        </div>
      )}

      {formDisabled && (
        <div className="max-w-4xl mx-auto mt-4 no-print">
          <div className="bg-stone-100 border border-stone-300 rounded-lg px-4 py-3 text-sm text-stone-600 font-medium">
            {isGameRoleClosed ? t.gameClosed
              : draftRoleSent === 'queued' ? t.draftQueued
              : draftRoleSent === 'filed' ? t.draftFiled
              : t.feedbackLocked}
          </div>
        </div>
      )}

      {/* Save to database */}
      {/* Gated on the same three things as formDisabled. The greyed-out wrapper
          below does not contain this button, so omitting draftRoleSent left the
          Senden button live on a role whose report has already gone — with only
          the blank form's own validation between it and a second submission. */}
      {!formDisabled && (
        <div className="max-w-4xl mx-auto mt-4 flex justify-end no-print">
          <div className="flex flex-col items-end gap-2">
            {validationError && (
              <p className="text-sm text-red-600 font-medium">{validationError}</p>
            )}
            <button
              onClick={() => { if (validateForm()) setShowConfirmModal('save'); }}
              disabled={savingFeedback || !selectedGame}
              className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 font-medium"
            >
              <Send size={18} />
              <span>{savingFeedback ? t.loading : t.saveBackend}</span>
            </button>
          </div>
        </div>
      )}
      {backendNotice && (
        <p className="max-w-4xl mx-auto mt-2 text-sm text-red-700 no-print">{backendNotice}</p>
      )}
      </>
      )}

      {/* Confirm Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
            <h3 className="text-lg font-bold text-stone-900 mb-3">
              {showConfirmModal === 'save'
                ? (formData.lang === 'DE' ? 'Feedback speichern?' : 'Save feedback?')
                : (formData.lang === 'DE' ? 'Eingaben zurücksetzen?' : 'Reset inputs?')}
            </h3>
            {showConfirmModal === 'save' ? (
              <div className="text-sm text-stone-600 mb-6 space-y-2">
                <p>{formData.lang === 'DE'
                  ? 'Das Feedback wird gespeichert und eine E-Mail mit dem PDF wird gesendet:'
                  : 'The feedback will be saved and an email with the PDF will be sent:'}</p>
                {dualMode ? (
                  <div className="bg-stone-50 rounded-lg p-3 text-xs space-y-2">
                    {(['1. SR', '2. SR'] as const).map(role => {
                      const refName = selectedGame ? getRefereeForRole(selectedGame, role) : '';
                      const coachee = refName ? coacheeByName.get(normName(refName)) : undefined;
                      const email = coachee?.email || '';
                      const alreadyClosed = selectedGame?.feedbackClosedRoles?.includes(role);
                      return (
                        <p key={role} className={alreadyClosed ? 'line-through opacity-50' : ''}>
                          <span className="font-semibold text-stone-700">{role}:</span>{' '}
                          {coachee?.full_name || refName}{' '}
                          <span className="text-stone-500">{email ? `<${email}>` : (formData.lang === 'DE' ? '(keine E-Mail)' : '(no email)')}</span>
                          {alreadyClosed && <span className="ml-1 text-stone-400">{formData.lang === 'DE' ? '(bereits gesendet)' : '(already sent)'}</span>}
                        </p>
                      );
                    })}
                    {formData.meta.rc && (
                      <p><span className="font-semibold text-stone-700">CC:</span> {formData.meta.rc}</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-stone-50 rounded-lg p-3 text-xs space-y-1">
                    <p><span className="font-semibold text-stone-700">{formData.lang === 'DE' ? 'An' : 'To'}:</span>{' '}
                      {selectedCoacheeInfo.fullName || formData.meta.srName}{' '}
                      <span className="text-stone-500">{selectedCoacheeEmail ? `<${selectedCoacheeEmail}>` : (formData.lang === 'DE' ? '(keine E-Mail)' : '(no email)')}</span>
                    </p>
                    {formData.meta.rc && (
                      <p><span className="font-semibold text-stone-700">CC:</span> {formData.meta.rc}</p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-stone-600 mb-6">
                {formData.lang === 'DE'
                  ? (gameHas2SR
                    ? 'Bewertungen, Bemerkungen, beide Unterschriften und das Formular für die andere Rolle werden gelöscht. Spieldaten (Spiel-Nr., Teams, Datum) bleiben erhalten.'
                    : 'Bewertungen, Bemerkungen und die Unterschriften werden gelöscht. Spieldaten (Spiel-Nr., Teams, Datum) bleiben erhalten.')
                  : (gameHas2SR
                    ? 'Ratings, remarks, both signatures and the other referee’s form will be cleared. Game data (match no., teams, date) is kept.'
                    : 'Ratings, remarks and the signatures will be cleared. Game data (match no., teams, date) is kept.')}
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowConfirmModal(null)}
                className="px-4 py-2 text-sm rounded-lg border border-stone-300 hover:bg-stone-50 transition-colors"
              >
                {formData.lang === 'DE' ? 'Abbrechen' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  if (showConfirmModal === 'save') {
                    setShowConfirmModal(null);
                    void handleSaveFeedback();
                  } else {
                    doResetForm();
                  }
                }}
                className={cn(
                  "px-4 py-2 text-sm rounded-lg font-medium transition-colors",
                  showConfirmModal === 'save'
                    ? "bg-emerald-600 text-white hover:bg-emerald-700"
                    : "bg-red-600 text-white hover:bg-red-700"
                )}
              >
                {showConfirmModal === 'save'
                  ? (formData.lang === 'DE' ? 'Speichern' : 'Save')
                  : (formData.lang === 'DE' ? 'Zurücksetzen' : 'Reset')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Empty Form Modal */}
      {sigModalOpen && (
        <div onClick={() => setSigModalOpen(false)} className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-bold text-stone-900">
                {sigTarget === 'rc'
                  ? (formData.lang === 'DE' ? 'Unterschrift Referee Coach' : 'Referee Coach signature')
                  : (formData.lang === 'DE' ? 'Unterschrift Schiedsrichter' : 'Referee signature')}
              </h3>
              <button onClick={() => setSigModalOpen(false)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>
            {/* The pad appears once startSignature has SETTLED — on success
                (sigSlug) or on failure (sigError, e.g. offline). Gating it on the
                slug alone left an offline coach without a pad, unable to satisfy
                the mandatory-signature check; showing it on the error too fixes
                that. It never mounts before the call resolves, so no stroke can
                land before the canvas is sized. */}
            {!sigSlug && !sigError ? (
              <div className="py-6 flex justify-center"><AppSpinner size={104} /></div>
            ) : (
              <>
                <p className="text-[11px] text-stone-400 mb-1.5">{formData.lang === 'DE' ? 'Hier unterschreiben:' : 'Sign here:'}</p>
                <div className="rounded-lg border-2 border-dashed border-stone-300 bg-stone-50/50 h-36 overflow-hidden"><SignaturePad ref={sigPadRef} /></div>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => sigPadRef.current?.clear()} className="h-9 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100">{formData.lang === 'DE' ? 'Löschen' : 'Clear'}</button>
                  <button onClick={saveSignatureHere} className="flex-1 h-9 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700">{formData.lang === 'DE' ? 'Unterschrift speichern' : 'Save signature'}</button>
                </div>
                {/* Signing on a second device needs the server to relay the
                    signature back, so the QR can't work in the demo — scanning
                    it lands on a device with no demo session and no session
                    record, i.e. "link invalid or expired". Offer only what works. */}
                {isDemoMode() ? (
                  <p className="mt-3 pt-3 border-t border-stone-200 text-[11px] text-stone-500 text-center">
                    {formData.lang === 'DE'
                      ? 'Im Demo-Modus kannst du nur hier unterschreiben. Der QR-Code zum Unterschreiben auf dem Handy braucht den Server.'
                      : 'In the demo you can only sign here. The QR code for signing on a phone needs the server.'}
                  </p>
                ) : sigError ? (
                  <p className="mt-3 pt-3 border-t border-stone-200 text-[11px] text-stone-500 text-center">
                    {formData.lang === 'DE'
                      ? 'Unterschreiben auf dem Handy ist gerade nicht möglich (offline). Hier unterschreiben funktioniert.'
                      : 'Signing on a phone isn’t available right now (offline). Signing here works.'}
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 my-3"><div className="flex-1 h-px bg-stone-200" /><span className="text-[10px] uppercase text-stone-400 font-semibold">{formData.lang === 'DE' ? 'oder' : 'or'}</span><div className="flex-1 h-px bg-stone-200" /></div>
                    <div className="flex flex-col items-center gap-2">
                      <div className="p-2 bg-white border border-stone-200 rounded-lg"><QRCodeSVG value={`${window.location.origin}${window.location.pathname}#/sign/${sigSlug}`} size={116} level="M" /></div>
                      <p className="text-[11px] text-stone-500 text-center">{formData.lang === 'DE' ? 'Mit dem Handy scannen und dort unterschreiben.' : 'Scan with a phone and sign there.'}</p>
                      {/* Faster than holding a QR up at someone who is already
                          packing their bag: the link lands in the referee's own
                          phone. Still the same visit — this dialog is what
                          watches the session, so it stays open until the ink
                          arrives. */}
                      <button
                        onClick={() => void shareSignatureLink(sigSlug)}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100"
                      >
                        {canShareLink ? <Send size={13} /> : <Copy size={13} />}
                        {canShareLink ? t.sigShareLink : t.sigCopyLink}
                      </button>
                      <p className="text-[11px] text-stone-400 text-center">{t.sigLinkHint}</p>
                      <p className="text-[11px] text-amber-600 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {formData.lang === 'DE' ? 'Warte auf Unterschrift…' : 'Waiting for signature…'}</p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {showInfoModal && (
        <div onClick={() => setShowInfoModal(false)} className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-bold text-stone-900">{formData.lang === 'DE' ? 'Infos & Dokumente' : 'Info & documents'}</h3>
              <button onClick={() => setShowInfoModal(false)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>
            <div className="flex flex-col gap-2.5">
              <a href="https://www.svrz.ch/_Resources/Persistent/8/6/d/d/86dd9a07156e7501b5e74ec3e0eeeab30975bcbd/Uebersicht%20SR-Niveau%20und%20Stufe.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Download size={15} /> {formData.lang === 'DE' ? 'SR-Niveau und Stufe (PDF)' : 'SR levels & stages (PDF)'}</a>
              <a href={`${import.meta.env.BASE_URL}#/guide/${formData.lang === 'DE' ? 'de' : 'en'}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Video size={15} /> {formData.lang === 'DE' ? 'Video-Anleitung' : 'Video guide'}</a>
              <button type="button" onClick={() => { setShowInfoModal(false); setShowEmptyFormModal(true); }} disabled={downloadingEmptyForm} className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline text-left disabled:opacity-50"><Download size={15} /> {downloadingEmptyForm ? t.loading : t.downloadEmptyForm}</button>
              <a href={`${import.meta.env.BASE_URL}docs/Leitfaden-SR-Technik.pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Download size={15} /> {formData.lang === 'DE' ? 'Leitfaden SR-Technik (PDF)' : 'Refereeing technique guide (PDF)'}</a>
              <a href="https://www.svrz.ch/ausbildung/schiedsrichter-in/informationen" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Info size={15} /> {formData.lang === 'DE' ? 'SR-Informationen (svrz.ch)' : 'Referee info (svrz.ch)'}</a>
            </div>
          </div>
        </div>
      )}

      {showCalendarModal && (
        <div onClick={() => setShowCalendarModal(false)} className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 max-h-[85vh] overflow-auto">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-bold text-stone-900 flex items-center gap-2">
                <CalendarDays size={17} className="text-red-600" />
                {formData.lang === 'DE' ? 'Kalender-Abo' : 'Calendar subscription'}
              </h3>
              <button onClick={() => setShowCalendarModal(false)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>

            <p className="text-sm text-stone-600 mb-4">
              {formData.lang === 'DE'
                ? 'Deine übernommenen Spiele – vergangene und künftige – in deinem eigenen Kalender. Der Link bleibt gültig; neu übernommene Spiele erscheinen von selbst.'
                : 'The games you have taken — past and future — in the calendar you already use. The link stays valid; games you take later show up on their own.'}
            </p>

            {icalError && (
              <p className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{icalError}</p>
            )}

            {!icalInfo && !icalError && (
              <div className="flex items-center gap-2 text-sm text-stone-500"><Loader2 size={15} className="animate-spin" /> {t.loading}</div>
            )}

            {icalInfo && (
              <div className="flex flex-col gap-3">
                <a
                  href={icalInfo.webcalUrl}
                  className="h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition-colors"
                >
                  <CalendarPlus size={16} />
                  {formData.lang === 'DE' ? 'Zum Kalender hinzufügen' : 'Add to calendar'}
                </a>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-stone-500 mb-1">
                    {formData.lang === 'DE' ? 'Oder Link kopieren' : 'Or copy the link'}
                  </label>
                  <div className="flex gap-2">
                    <input
                      readOnly
                      value={icalInfo.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="min-w-0 flex-1 h-9 rounded-lg border border-stone-200 bg-stone-50 px-2.5 font-mono text-[11px] text-stone-600"
                    />
                    <button
                      onClick={() => void copyIcalUrl()}
                      className="h-9 shrink-0 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 bg-stone-50 text-xs font-medium text-stone-600 hover:bg-stone-100 transition-colors"
                    >
                      {icalCopied ? <ClipboardCheck size={14} className="text-green-600" /> : <Copy size={14} />}
                      {/* Not t.copied — that one is a full sentence, and this
                          is a button that has to stay next to the field. */}
                      {icalCopied ? (formData.lang === 'DE' ? 'Kopiert' : 'Copied') : t.copy}
                    </button>
                  </div>
                </div>

                {/* New tab, not this one: the response is a download that the
                    browser hands off without navigating, but if the feed ever
                    answers with an error instead, a half-filled feedback form
                    must not be the thing that gets unloaded. A cross-origin
                    `download` attribute is ignored, so the attachment header on
                    the response is what actually makes this a file. */}
                <a
                  href={icalInfo.downloadUrl}
                  target="_blank"
                  rel="noopener"
                  className="h-10 inline-flex items-center justify-center gap-2 rounded-xl border border-stone-300 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
                >
                  <Download size={15} />
                  {formData.lang === 'DE'
                    ? `Alle ${icalInfo.count} Spiele als .ics herunterladen`
                    : `Download all ${icalInfo.count} games as .ics`}
                </a>

                {/* The link is the whole credential — anyone holding it reads
                    this calendar, with no login. This is how you take it back
                    if it ends up somewhere it should not be. */}
                <button
                  onClick={() => void regenerateIcalUrl()}
                  disabled={icalRotating}
                  className="h-9 inline-flex items-center justify-center gap-1.5 text-xs font-medium text-stone-500 hover:text-stone-700 disabled:text-stone-300 transition-colors"
                >
                  {icalRotating ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  {formData.lang === 'DE' ? 'Neuen Link erzeugen' : 'Generate a new link'}
                </button>

                <div className="rounded-lg bg-stone-50 border border-stone-200 px-3 py-2.5 text-[11px] leading-relaxed text-stone-500 space-y-1.5">
                  <p>
                    {formData.lang === 'DE'
                      ? 'Wie oft dein Kalender nachschaut, bestimmt dein Kalender-Programm selbst – meist zwischen ein paar Stunden und einmal täglich. Der Link liefert immer den aktuellen Stand.'
                      : 'How often your calendar checks back is your calendar app’s decision — usually somewhere between a few hours and once a day. The link always serves the current state.'}
                  </p>
                  <p>
                    {formData.lang === 'DE'
                      ? 'Die heruntergeladene .ics-Datei ist eine Momentaufnahme und aktualisiert sich nicht mehr.'
                      : 'The downloaded .ics file is a snapshot and never updates itself.'}
                  </p>
                  <p>
                    {formData.lang === 'DE'
                      ? 'Behalte den Link für dich – wer ihn hat, sieht deine Spiele.'
                      : 'Keep the link to yourself — anyone who has it can see your games.'}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showEmptyFormModal && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-6">
            <h3 className="text-lg font-bold text-stone-900 mb-4">{t.emptyFormChoose}</h3>
            <div className="flex flex-col gap-2">
              {(['1SR', '2SR', 'both'] as const).map(choice => (
                <button
                  key={choice}
                  onClick={() => void handleDownloadEmptyForm(choice)}
                  className="h-10 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-800 transition-colors"
                >
                  {choice === '1SR' ? t.emptyForm1SR : choice === '2SR' ? t.emptyForm2SR : t.emptyFormBoth}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowEmptyFormModal(false)}
              className="mt-3 w-full h-9 rounded-lg border border-stone-300 text-sm hover:bg-stone-50 transition-colors"
            >
              {formData.lang === 'DE' ? 'Abbrechen' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* "Already observed" notice — shown before an assignment goes through,
          never after; the RC decides whether a second look is what they want. */}
      {takeNotice && (() => {
        const de = formData.lang === 'DE';
        const self = !!rcAuth.rcName && normName(takeNotice.rcName) === normName(rcAuth.rcName);
        // Written as whole sentences per case: a coachee can be here for a
        // filed observation, for one somebody else has booked, or for both.
        const sentence = (o: { count: number; plannedBy?: string; plannedOn?: string }) => {
          const filed = o.count > 0
            ? (de
              ? `wurde diese Saison bereits ${o.count > 1 ? `${o.count}× ` : ''}beobachtet.`
              : `has already been observed ${o.count > 1 ? `${o.count}× ` : ''}this season.`)
            : '';
          if (!o.plannedBy) return filed;
          const when = shortDate(o.plannedOn || '');
          const booked = o.count > 0
            ? (de
              ? ` Zudem ist am ${when} eine Beobachtung durch ${o.plannedBy} geplant.`
              : ` Another observation is booked for ${when} by ${o.plannedBy}.`)
            : (de
              ? `hat bereits eine geplante Beobachtung am ${when} durch ${o.plannedBy}.`
              : `already has an observation booked for ${when} by ${o.plannedBy}.`);
          return `${filed}${booked}`;
        };
        return (
          <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
            <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
              <h3 className="text-lg font-bold text-stone-900 flex items-center gap-2">
                <Info size={18} className="text-amber-500" />
                {de ? 'Hinweis' : 'Notice'}
              </h3>
              <ul className="mt-3 space-y-1.5 text-sm text-stone-700">
                {takeNotice.observed.map((o) => (
                  <li key={o.name}>
                    <span className="font-semibold">{o.name}</span> {sentence(o)}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-stone-500">
                {de
                  ? `Spiel trotzdem ${self ? 'übernehmen' : 'zuweisen'}?`
                  : `${self ? 'Take' : 'Assign'} the game anyway?`}
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  onClick={() => setTakeNotice(null)}
                  className="flex-1 h-10 rounded-lg border border-stone-300 text-sm hover:bg-stone-50 transition-colors"
                >
                  {de ? 'Abbrechen' : 'Cancel'}
                </button>
                <button
                  onClick={() => {
                    void applyRcAssignment(takeNotice.gameId, takeNotice.rcName, takeNotice.previousRc);
                    setTakeNotice(null);
                  }}
                  className="flex-1 h-10 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors"
                >
                  {de ? (self ? 'Trotzdem übernehmen' : 'Trotzdem zuweisen') : (self ? 'Take anyway' : 'Assign anyway')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* JSON Modal */}
      {showJson && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div role="dialog" aria-modal="true" className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
            <div className="p-6 border-b border-stone-100 flex justify-between items-center">
              <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2">
                <FileJson className="text-red-600" />
                {t.json}
              </h2>
              <button 
                onClick={() => setShowJson(false)}
                className="text-stone-400 hover:text-stone-600 transition-colors"
              >
                {t.close}
              </button>
            </div>
            <div className="p-6 overflow-auto bg-stone-50 font-mono text-xs">
              <pre className="whitespace-pre-wrap">{JSON.stringify(formData, null, 2)}</pre>
            </div>
            <div className="p-6 border-t border-stone-100 flex justify-end gap-3">
              <button 
                onClick={() => { void (async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(formData, null, 2));
                    toast.success(t.copied, { lang: formData.lang });
                  } catch {
                    // Clipboard access denied (or no secure context) — say so
                    // instead of letting the rejected promise vanish.
                    toast.error(formData.lang === 'DE' ? 'Kopieren fehlgeschlagen.' : 'Copying failed.', { lang: formData.lang });
                  }
                })(); }}
                className="bg-red-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-200"
              >
                {t.copy}
              </button>
            </div>
          </div>
        </div>
      )}

      {feedbackPickerCoachee && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-4 max-h-[80vh] flex flex-col">
            <h3 className="text-sm font-semibold text-stone-900 mb-3">
              {t.feedbackHistory}: {feedbackPickerCoachee.full_name}
            </h3>
            <div className="overflow-auto border border-stone-200 rounded">
              {coacheeFeedbacks.length === 0 ? (
                <p className="text-sm text-stone-500 p-4">{t.noFeedbacks}</p>
              ) : (
                <div className="divide-y divide-stone-100">
                  {coacheeFeedbacks.map((record) => (
                    <button
                      key={record.id}
                      onClick={() => openFeedbackRecord(record)}
                      className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors"
                    >
                      <div className="text-sm font-semibold text-stone-900">
                        {record.expand?.game?.match_no || '-'} | {record.expand?.game?.home_team || '-'} vs {record.expand?.game?.away_team || '-'}
                      </div>
                      <div className="text-xs text-stone-500 mt-1">
                        {record.submitted_at || '-'} | {t.rcShort}: {record.rc_name || '-'} | {record.role_assessed || '-'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setFeedbackPickerCoachee(null)}
              className="mt-3 h-9 rounded border border-stone-300 hover:bg-stone-50 text-xs"
            >
              {t.closeMenu}
            </button>
          </div>
        </div>
      )}

      {/* Manual observation upload modal */}
      {manualUploadCoachee && (
        <ManualUploadModal
          coachee={manualUploadCoachee}
          coachees={coachees}
          rcPeople={rcPeople}
          fixedRcName={rcAuth.rcName}
          lang={formData.lang}
          notice={manualUploadNotice}
          noticeIsError={Boolean(manualUploadNotice) && manualUploadNotice !== t.manualUploadSuccess && !manualUploadNotice.startsWith(t.saveOkNoEmail)}
          submitting={manualUploadSubmitting}
          onSubmit={handleManualUploadSubmit}
          onClose={() => { setManualUploadCoachee(null); setManualUploadNotice(''); }}
        />
      )}
      <p className="mx-auto max-w-5xl mt-6 pb-2 text-center text-[10px] text-stone-400 no-print">
        v{APP_VERSION} · Build {BUILD_INFO}
        {/* The loading spinner's ball and whistle are Game Icons artwork, which
            is CC BY 3.0 — the licence requires the credit to be visible, so it
            rides with the build stamp rather than hiding behind a menu. It goes
            when those icons go, and not before. See components/AppSpinner.tsx. */}
        <span className="mx-1.5">·</span>
        {formData.lang === 'DE' ? 'Symbole' : 'Icons'}{' '}
        <a
          href="https://game-icons.net/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-stone-300 hover:text-stone-600"
        >Game Icons</a>{' '}
        <a
          href="https://creativecommons.org/licenses/by/3.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-stone-300 hover:text-stone-600"
        >CC BY 3.0</a>
      </p>
    </div>
  );
}

/* ── Manual Upload Modal ── */
// Grade picker for the manual-upload form. Buttons instead of a <select>, so a
// grade is one tap instead of a 16-entry list covering the screen; the value
// still reaches the form via a hidden input, so FormData is unchanged.
function RatingPicker({ name, options, allowNA }: { name: string; options: readonly string[]; allowNA: boolean }) {
  const [value, setValue] = useState('');
  const pick = (v: string) => setValue((cur) => (cur === v ? '' : v)); // tap again to clear
  // Turning the +/- toggle off drops A+/A-/… from `options`, but the hidden
  // input kept the old grade — the form then submitted a rating the UI showed
  // as unselected. Clear anything no longer offered (N/A stays valid when
  // allowed even though it is not in `options`).
  useEffect(() => {
    if (value && value !== 'N/A' && !options.includes(value)) setValue('');
    if (value === 'N/A' && !allowNA) setValue('');
  }, [options, allowNA, value]);
  const btn = (v: string, selectedClass: string) => (
    <button
      key={v}
      type="button"
      onClick={() => pick(v)}
      aria-pressed={value === v}
      className={cn(
        'h-8 min-w-[2.1rem] px-1.5 rounded border text-xs font-bold transition-colors',
        value === v ? cn(selectedClass, 'border-transparent') : 'bg-white border-stone-300 text-stone-600 hover:bg-stone-100',
      )}
    >
      {v}
    </button>
  );
  return (
    <>
      <input type="hidden" name={name} value={value} />
      <div className="flex flex-wrap gap-1">
        {options.map((r) => btn(r, RATING_COLORS[r[0]] ?? 'bg-stone-800 text-white'))}
        {allowNA && btn('N/A', RATING_COLORS['N/A'])}
      </div>
    </>
  );
}

function ManualUploadModal({ coachee, coachees, rcPeople, fixedRcName, lang, notice, noticeIsError, submitting, onSubmit, onClose }: {
  coachee: Coachee;
  coachees: Coachee[];
  rcPeople: RefereeCoachPerson[];
  fixedRcName: string | null;
  lang: 'DE' | 'EN';
  notice: string;
  noticeIsError: boolean;
  submitting: boolean;
  onSubmit: (form: HTMLFormElement) => void;
  onClose: () => void;
}) {
  const t = UI_STRINGS[lang] || UI_STRINGS.DE;
  const [role, setRole] = useState<'1. SR' | '2. SR'>('1. SR');
  // Coachee groups are stored joined with "/" ("Befördert/2. SR"), so splitting
  // on "," left whole combinations in the picker — you got one button per
  // observed COMBINATION instead of one per group. Split on "/" instead, but
  // keep season suffixes ("Neu-SR 2025/26") intact.
  // The same split as the chips below, or nothing is preselected and the raw
  // combined token is what gets filed.
  const [selectedGroups, setSelectedGroups] = useState<string[]>(
    () => splitCoacheeGroups(coachee.groups)
  );
  const [usePlusMinus, setUsePlusMinus] = useState(false);

  // Always offer the canonical list too, so a group is pickable even if nobody
  // has it yet.
  const allGroups = useMemo(() => {
    const set = new Set<string>(COACHEE_GROUP_OPTIONS);
    coachees.forEach(c => splitCoacheeGroups(c.groups).forEach(g => set.add(g)));
    return Array.from(set).sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachees]);

  // Derive unique levels from all coachees (level - stage format, raw values)
  const allLevels = useMemo(() => {
    const set = new Set<string>();
    coachees.forEach(c => { const v = metaNiveau(c); if (v) set.add(v); });
    return Array.from(set).sort();
  }, [coachees]);

  const defaultLevel = metaNiveau(coachee);

  const sections = role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE;

  const ratingOptions = usePlusMinus
    ? ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','E+','E','E-']
    : RATINGS;

  const toggleGroup = (g: string) => {
    setSelectedGroups(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
  };
  // Shown next to our own "Datei wählen" button (the native control is hidden).
  const [fileName, setFileName] = useState('');

  return (
    <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
      <div role="dialog" aria-modal="true" className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-stone-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-900">
            {t.manualUploadTitle}: {coachee.full_name}
          </h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-lg leading-none">&times;</button>
        </div>
        <form
          className="overflow-auto p-4 space-y-4 text-sm"
          onSubmit={(e) => { e.preventDefault(); void onSubmit(e.currentTarget); }}
        >
          {/* Hidden field for gruppe (populated from checkboxes) */}
          {/* "/" is the storage convention everywhere else; ", " here produced a
              third spelling of the same combination in the filed record. */}
          <input type="hidden" name="gruppe" value={selectedGroups.join('/')} />

          {/* Rolle + Spiel-Nr. */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRole}</span>
              <select name="role" value={role} onChange={e => setRole(e.target.value as '1. SR' | '2. SR')} className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="1. SR">1. SR</option>
                <option value="2. SR">2. SR</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muMatchNo}</span>
              <input name="spielNr" type="number" className="h-9 rounded border border-stone-300 px-2 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
            </label>
          </div>

          {/* Liga + Datum */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muLeague}</span>
              <input name="liga" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muDate}</span>
              <input name="datum" type="date" defaultValue={new Date().toISOString().split('T')[0]} className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* Ort + Mannschaften */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muVenue}</span>
              <input name="ort" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muTeams}</span>
              <input name="mannschaften" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* Ergebnis: Sätze + Punkte */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muResultSets}</span>
              <input name="ergebnisSets" type="text" placeholder="3:1" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muResultPoints}</span>
              <input name="ergebnisPoints" type="text" placeholder="25:20, 22:25, 25:18, 25:23" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* SR-Name + SR-Niveau */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRefName}</span>
              <select name="srName" defaultValue={coachee.full_name} className="h-9 rounded border border-stone-300 px-2 text-sm">
                {coachees.map(c => <option key={c.id} value={c.full_name}>{c.full_name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRefLevel}</span>
              <select name="srNiveau" defaultValue={defaultLevel} className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="">—</option>
                {allLevels.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>

          {/* Referee Coach + Gruppe */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRc}</span>
              {fixedRcName ? (
                <>
                  <input type="hidden" name="rc" value={fixedRcName} />
                  <span className="h-9 flex items-center rounded border border-stone-200 bg-stone-50 px-2 text-sm text-stone-700">{fixedRcName}</span>
                </>
              ) : (
                <select name="rc" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                  <option value="">—</option>
                  {[...rcPeople]
                    .sort((a, b) => bySurname({ full_name: a.fullName }, { full_name: b.fullName }))
                    .map(p => (
                      <option key={p.id} value={p.fullName}>{surnameFirstLabel({ full_name: p.fullName })}</option>
                    ))}
                </select>
              )}
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muGroup}</span>
              <div className="flex flex-wrap gap-1.5 min-h-[36px] p-1.5 rounded border border-stone-300">
                {allGroups.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => toggleGroup(g)}
                    className={cn(
                      "px-2 py-0.5 rounded text-xs border transition-colors",
                      selectedGroups.includes(g)
                        ? "bg-red-600 text-white border-red-600"
                        : "bg-white text-stone-600 border-stone-300 hover:border-stone-400"
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* +/- toggle for grades */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setUsePlusMinus(!usePlusMinus)}
              className={cn(
                "px-3 py-1 rounded text-xs border transition-colors",
                usePlusMinus
                  ? "bg-red-600 text-white border-red-600"
                  : "bg-white text-stone-600 border-stone-300"
              )}
            >
              {t.muPlusMinus}
            </button>
            <span className="text-xs text-stone-400">{usePlusMinus ? t.muPlusMinusOn : t.muPlusMinusOff}</span>
          </div>

          {/* Assessment sections */}
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-bold text-stone-700 mb-1">{section.title}</p>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <div key={item.id} className="py-1.5 border-b border-stone-100 last:border-b-0">
                    {/* Criterion first, grades as tap targets underneath: the old
                        14px select opened a 16-entry list over the whole screen. */}
                    <p className="text-xs text-stone-700 leading-snug mb-1.5">{item.label}</p>
                    <RatingPicker
                      name={`rating-${item.id}`}
                      options={ratingOptions}
                      allowNA={NA_ELIGIBLE_IDS.has(item.id)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Bottom fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muGameLevel}</span>
              <select name="spielniveau" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="leicht">{t.muEasy}</option>
                <option value="normal">{t.muNormal}</option>
                <option value="schwierig">{t.muHard}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muMotivation}</span>
              <select name="motivation" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="up">↑</option>
                <option value="check">✓</option>
                <option value="down">↓</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muOutlook}</span>
              <select name="einstufung" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="up">↑</option>
                <option value="check">✓</option>
                <option value="down">↓</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muSecondVisit}</span>
              <select name="secondBesuch" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="Y">{t.muYes}</option>
                <option value="N">{t.muNo}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRefGoal}</span>
              <select name="srZiel" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                {SR_ZIEL_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
          </div>

          {/* Same divisions as the main feedback form — the manual form only had
              a single "Bemerkungen" box, so those sections were lost on upload. */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">{t.muHighlights}</span>
            <textarea name="highlights" rows={2} className="rounded border border-stone-300 px-2 py-1 text-sm resize-y" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">{t.muImprovements}</span>
            <textarea name="improvements" rows={2} className="rounded border border-stone-300 px-2 py-1 text-sm resize-y" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">{t.muGoals}</span>
            <textarea name="goals" rows={2} className="rounded border border-stone-300 px-2 py-1 text-sm resize-y" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">{t.muRemarks}</span>
            <textarea name="bemerkungen" rows={3} className="rounded border border-stone-300 px-2 py-1 text-sm resize-y" />
          </label>

          {/* The native file input renders "Choose file / No file chosen" in the
              BROWSER's language — that's the English sitting in this German
              form. Hide it and drive it from our own labelled button instead. */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">{t.manualUploadFile}</span>
            <label className="flex items-center gap-3 cursor-pointer">
              <span className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded border border-stone-300 bg-white text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors">
                <Upload size={14} /> {t.muChooseFile}
              </span>
              <span className={cn('text-sm truncate', fileName ? 'text-stone-700' : 'text-stone-400')}>
                {fileName || t.muNoFile}
              </span>
              <input
                name="formFile"
                type="file"
                accept=".pdf,image/*"
                className="sr-only"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
              />
            </label>
          </div>

          {/* Notice */}
          {notice && (
            <p className={cn("text-sm font-medium", noticeIsError ? "text-red-600" : "text-green-600")}>
              {notice}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
          >
            {submitting ? t.muUploading : <><Send size={14} /> {t.manualUploadSubmit}</>}
          </button>
        </form>
      </div>
    </div>
  );
}

function MetaField({ label, value, onChange, type = "text", className = "", readOnly = false }: { label: string, value: string, onChange: (v: string) => void, type?: string, className?: string, readOnly?: boolean }) {
  // Associate the label with the input so a screen reader announces the field's
  // name; without htmlFor/id it read the box as an unlabelled edit field.
  const id = useId();
  return (
    <div className={cn("border-r border-b border-stone-900 p-1.5 flex flex-col min-h-[48px]", className)}>
      <label htmlFor={id} className="block text-[8px] uppercase font-black text-stone-400 leading-none mb-1">{label}</label>
      <input
        id={id}
        type={type}
        className={cn("outline-none text-xs font-medium bg-transparent w-full", readOnly && "text-stone-500")}
        value={value}
        onChange={e => onChange(e.target.value)}
        readOnly={readOnly}
      />
    </div>
  );
}

/** "VBC Züri Unterland - Volley Näfels II" as its two halves, or nothing.
 *
 *  Only an unambiguous split counts: a dash with spaces around it is how both
 *  the form and the sync write the pairing, while a team called "Bern-Muri"
 *  must not become two teams. */
function splitTeams(teams: string): [string, string] | null {
  const parts = String(teams ?? '').split(/\s+[-–—]\s+/);
  if (parts.length !== 2) return null;
  const [home, away] = parts.map((p) => p.trim());
  return home && away ? [home, away] : null;
}

function ResultField({ label, value, onChange, teams = '', readOnly = false, onUnlock, lang, className = "" }: { label: string; value: string; onChange: (v: string) => void; teams?: string; readOnly?: boolean; onUnlock?: () => void; lang: 'DE' | 'EN'; className?: string }) {
  // parseResult reads both the "3:1 | 25:20, …" this field writes and the
  // "3:1 (25:20 / …)" the VolleyManager sync writes — every synced game uses
  // the latter, whose set scores the old split-on-"|" parser dropped silently.
  const parsed = parseResult(value);
  // The set scores are the input; the match score is derived from them, so the
  // two can no longer contradict each other (a 3:0 with a set the winner lost
  // used to be typeable). A stored score with no set scores behind it — an old
  // record — still shows what it says rather than a computed 0:0.
  const tally = tallyFromSets(parsed.sets);
  const counted = tally.home + tally.away > 0;
  const home = counted ? String(tally.home) : parsed.home;
  const away = counted ? String(tally.away) : parsed.away;
  const decided = isMatchDecided(tally, parsed.sets);
  const completed = parsed.sets.filter(isSetComplete).length;
  // One set to start; finishing a set opens the next, up to the fifth, and the
  // match being won closes the rest. 2:2 opens the decider, 3:1 does not.
  const rows = readOnly || decided
    ? Math.max(parsed.sets.length, completed)
    : Math.min(5, Math.max(completed + 1, parsed.sets.length));
  const sets = Array.from({ length: rows }, (_, i) => ({
    h: (parsed.sets[i]?.h ?? '').slice(0, 2),
    a: (parsed.sets[i]?.a ?? '').slice(0, 2),
  }));
  // Only complain once something is actually filled in, and never about the
  // sets still to come — that is the normal state halfway through entry.
  const pending = /^(Bitte alle|Please enter all|Bitte das Ergebnis|Please enter the result)/;
  // A set is checked the moment both its numbers are there: 12:23 is not a set
  // anybody played, and saying so while it is being typed is the whole point.
  // The MATCH score is derived from the sets, so before the third set is won it
  // reads "1:1 is not possible" — true, and useless, and it was the only thing
  // this field said for the entire time a score was being entered. It is asked
  // for once the match is actually decided.
  const setIssue = findSetError(sets, lang);
  const error = setIssue?.message ?? (completed > 0 && decided ? validateResult(value, lang) : null);
  const bad = !!error && !pending.test(error);
  const c2 = (v: string) => v.replace(/\D/g, '').slice(0, 2);
  const setPoint = (i: number, side: 'h' | 'a', v: string) => {
    const next = sets.map((s, idx) => idx === i ? { ...s, [side]: c2(v) } : s);
    // Trailing blanks are just the rows on offer, not sets that were played.
    while (next.length > 0 && !next[next.length - 1].h && !next[next.length - 1].a) next.pop();
    const t = tallyFromSets(next);
    onChange(next.length === 0 ? '' : formatResult(String(t.home), String(t.away), next));
  };
  // Red on the derived match score only when the match score is what is wrong.
  // A bad set marks the set; making both shout leaves the reader hunting.
  const sbox = cn('w-7 h-7 flex items-center justify-center text-sm font-bold rounded border', bad && !setIssue ? 'border-red-500 bg-red-50 text-red-700' : 'border-stone-400 bg-white text-stone-800');
  const pbox = (i: number) => cn(
    'w-7 h-6 text-center text-[11px] font-medium rounded border outline-none focus:ring-2 focus:ring-red-500',
    // Marked on the set that is wrong, not on the row as a whole: with five of
    // them the message alone leaves the reader counting boxes.
    setIssue?.index === i ? 'border-red-500 bg-red-50 text-red-700' : 'border-stone-300',
  );
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  const pair = splitTeams(teams);
  return (
    <div className={cn("border-r border-b border-stone-900 p-1.5 flex flex-col min-h-[48px]", className)}>
      <label className="block text-[8px] uppercase font-black text-stone-400 leading-none mb-1">{label}</label>
      <div className="flex flex-col gap-1.5">
        {/* Centred: the cell is four columns wide and the score is the one
            thing in it, so it sits in the middle of that space rather than
            hugging the left edge with three quarters of the row empty. */}
        <div className="flex items-center justify-center gap-1">
          {/* The row is a quarter full and the boxes say nothing about which
              side is which, so the teams stand where their numbers do: home to
              the left of the colon, away to the right — for the sets below as
              much as for the count above them. */}
          {pair && <span className="text-[10px] font-semibold text-stone-500 truncate max-w-[10rem] text-right print:max-w-none">{pair[0]}</span>}
          {/* Computed from the sets below, never typed. */}
          <output className={sbox} aria-label={lang === 'DE' ? 'Sätze Heim' : 'Home sets'}>{home || '–'}</output>
          <span className="text-stone-400 font-bold">:</span>
          <output className={sbox} aria-label={lang === 'DE' ? 'Sätze Gast' : 'Away sets'}>{away || '–'}</output>
          {pair && <span className="text-[10px] font-semibold text-stone-500 truncate max-w-[10rem] print:max-w-none">{pair[1]}</span>}
          {/* A score already on the game may have come from the coach who filed
              the other referee — so it can be wrong, and locking it would leave
              nobody able to fix it. */}
          {readOnly && onUnlock && (
            <button
              type="button"
              onClick={onUnlock}
              title={lang === 'DE' ? 'Ergebnis korrigieren' : 'Correct the result'}
              aria-label={lang === 'DE' ? 'Ergebnis korrigieren' : 'Correct the result'}
              className="no-print ml-1 p-1 rounded text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
        {/* On its own line, so a long message cannot shove the score off centre. */}
        {bad && <p className="text-[9px] text-red-600 leading-tight text-center no-print">{error}</p>}
        {rows > 0 && (
          // Each set gets its own boxed cell with the number on top. Laid out
          // inline the digits ran together once they wrapped ("IV 22:25 V 12:15"),
          // so it was hard to see which score belonged to which set.
          <div className="rounded-md border border-stone-200 bg-stone-50/70 px-1.5 py-1">
            <span className="block text-[8px] uppercase font-semibold text-stone-400 leading-none mb-1 text-center">
              {lang === 'DE' ? 'Sätze' : 'sets'}
            </span>
            <div className="flex flex-wrap justify-center gap-1">
              {sets.map((s, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5 rounded border border-stone-200 bg-white px-1 py-0.5">
                  <span className="text-[9px] font-bold text-stone-400 leading-none">{ROMAN[i] ?? i + 1}</span>
                  <div className="flex items-center gap-0.5">
                    <input inputMode="numeric" maxLength={2} value={s.h} readOnly={readOnly} onChange={e => setPoint(i, 'h', e.target.value)} className={pbox(i)} aria-label={`${lang === 'DE' ? 'Satz' : 'Set'} ${i + 1} ${lang === 'DE' ? 'Heim' : 'home'}`} />
                    <span className="text-stone-300 text-[10px]">:</span>
                    <input inputMode="numeric" maxLength={2} value={s.a} readOnly={readOnly} onChange={e => setPoint(i, 'a', e.target.value)} className={pbox(i)} aria-label={`${lang === 'DE' ? 'Satz' : 'Set'} ${i + 1} ${lang === 'DE' ? 'Gast' : 'away'}`} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
