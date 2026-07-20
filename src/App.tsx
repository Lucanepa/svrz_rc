import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Download, FileJson, Loader2, RefreshCw, ClipboardCheck, MessageSquare, Target, Info, Languages, LogIn, LogOut, ShieldAlert, ChevronDown, ChevronLeft, ChevronRight, ArrowLeft, List, CalendarDays, SlidersHorizontal, Home, Navigation, Clock, MapPin, Users, Eye, Tag, Send, Upload } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { QRCodeSVG } from 'qrcode.react';
import { INITIAL_DATA, FeedbackFormData, SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN, LEGEND, SR_ZIEL_OPTIONS, EligibleGame, RcOverviewEntry, rcCoachSummary } from './types';
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
  getAdminAuthStatus,
  loginAdmin,
  logoutAdmin,
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
} from './lib/pocketbase';
import SignaturePad, { type SignaturePadHandle } from './components/SignaturePad';
import { cn } from './lib/utils';
import { normalizeCoacheeGroup } from './lib/coacheeGroup';
import { keepGame, levelKey, levelDisplay, isTargetActive, type CoacheeTargetMap, type TargetRole } from './lib/niveauTargets';
import SvrzLogo from './SvrzLogo';
import AdminPanel from './components/AdminPanel';
import LevelText from './components/LevelText';
import { BUILD_INFO } from './lib/buildInfo';

const RATINGS = ['A', 'B', 'C', 'D', 'E'];

const RATING_COLORS: Record<string, string> = {
  'A': 'bg-green-400 text-white',
  'B': 'bg-green-700 text-white',
  'C': 'bg-red-600 text-white',
  'D': 'bg-yellow-400 text-stone-900',
  'E': 'bg-orange-500 text-white',
  'N/A': 'bg-stone-400 text-white',
};

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
    gamePool: "Coachee-Spiele",
    coacheePool: "Coachees",
    loadCoachees: "Coachees laden",
    active: "Aktiv",
    inactive: "Inaktiv",
    noObservation: "Keine Beobachtung",
    furtherObservation: "Weitere Beobachtung nötig",
    completedObservation: "Beobachtung abgeschlossen",
    chooseAction: "Aktion wählen",
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
    adminLogout: "Admin abmelden",
    adminLoginRequiredTitle: "Admin-Anmeldung erforderlich",
    adminLoginRequiredDesc: "Melde dich mit deinem PocketBase-Admin-Benutzer an, um auf das Admin-Panel zuzugreifen.",
    email: "E-Mail",
    password: "Passwort",
    login: "Anmelden",
    currentSession: "Aktuelle Sitzung",
    authLoginSuccess: "Admin-Anmeldung erfolgreich.",
    authLoginFailed: "Anmeldung fehlgeschlagen.",
    authLoggedOut: "Abgemeldet.",
    authLogoutFailed: "Abmeldung fehlgeschlagen.",
    role1Short: "1SR",
    role2Short: "2SR",
    rolesLabel: "Rollen",
    rcShort: "RC",
    coacheeDetails: "Coachee Details",
    notes: "Notizen",
    notesPlaceholder: "Notizen zum Coachee...",
    saveNotes: "Notizen speichern",
    notesSaved: "Notizen gespeichert.",
    notesSaveError: "Notizen speichern fehlgeschlagen.",
    level: "Stufe",
    phone: "Telefon",
    emailLabel: "E-Mail",
    noNotes: "Keine Notizen vorhanden.",
    rcOverview: "Referee Coaches",
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
    gamePool: "Coachee Games",
    coacheePool: "Coachees",
    loadCoachees: "Load Coachees",
    active: "Active",
    inactive: "Inactive",
    noObservation: "No Observation",
    furtherObservation: "Further Observation Needed",
    completedObservation: "Observation Completed",
    chooseAction: "Choose Action",
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
    adminLogout: "Logout Admin",
    adminLoginRequiredTitle: "Admin Login Required",
    adminLoginRequiredDesc: "Sign in with your PocketBase admin user to access the admin panel.",
    email: "Email",
    password: "Password",
    login: "Login",
    currentSession: "Current session",
    authLoginSuccess: "Admin login successful.",
    authLoginFailed: "Login failed.",
    authLoggedOut: "Logged out.",
    authLogoutFailed: "Logout failed.",
    role1Short: "1SR",
    role2Short: "2SR",
    rolesLabel: "Roles",
    rcShort: "RC",
    coacheeDetails: "Coachee Details",
    notes: "Notes",
    notesPlaceholder: "Notes about the coachee...",
    saveNotes: "Save Notes",
    notesSaved: "Notes saved.",
    notesSaveError: "Failed to save notes.",
    level: "Level",
    phone: "Phone",
    emailLabel: "Email",
    noNotes: "No notes yet.",
    rcOverview: "Referee Coaches",
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
  }
};

type FeedbackSubView = 'coachees' | 'coacheeGames' | 'calendar' | 'feedbackForm';

function getRefereeForRole(game: EligibleGame, role: FeedbackFormData['role']) {
  return role === '1. SR' ? game.firstReferee : game.secondReferee;
}

function normName(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ');
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
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${min}`;
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

/** Referee name rendered with a clear coachee highlight (amber chip + badge). */
function CoacheeName({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 border border-amber-300 px-1.5 py-0.5 font-bold text-amber-900">
      {name}
      <span className="rounded bg-amber-300/70 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-900">Coachee</span>
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

function pdfFilename(formData: FeedbackFormData): string {
  const match = formData.meta.spielNr || 'feedback';
  const role = formData.role.replace('.', '').replace(/\s+/g, '');
  return `${match}-${role}.pdf`;
}

async function generatePdfBase64(element: HTMLElement, pixelRatio: number): Promise<string> {
  const imageData = await toPng(element, {
    pixelRatio,
    backgroundColor: '#ffffff',
  });

  const img = new Image();
  await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imageData; });
  const pdfWidth = img.width * 0.75;
  const pdfHeight = img.height * 0.75;
  const pdf = new jsPDF({
    orientation: pdfWidth > pdfHeight ? 'l' : 'p',
    unit: 'pt',
    format: [pdfWidth, pdfHeight],
  });
  pdf.addImage(imageData, 'PNG', 0, 0, pdfWidth, pdfHeight);

  const arrayBuffer = pdf.output('arraybuffer');
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function detectInitialLang(): FeedbackFormData['lang'] {
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

function MultiSelectDropdown({ options, selected, onChange, placeholder }: {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
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
          {selected.length === 0 ? placeholder : `${selected.length} ${selected.length === 1 ? 'selected' : 'selected'}`}
        </span>
        <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto bg-white border border-stone-300 rounded shadow-lg">
          {options.length === 0 ? (
            <div className="px-2 py-2 text-sm text-stone-400 italic">No options</div>
          ) : options.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-stone-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="h-3.5 w-3.5 rounded border-stone-300 accent-red-600"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [viewMode, setViewMode] = useState<'feedback' | 'admin'>('feedback');
  const [feedbackSubView, setFeedbackSubView] = useState<FeedbackSubView>('coachees');
  const [listTab, setListTab] = useState<'coachees' | 'games' | 'rcOverview'>('coachees');
  const [listPage, setListPage] = useState(0);
  const LIST_PAGE_SIZE = 50;
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
  const [selectedRcName, setSelectedRcName] = useState<string | null>(null);
  const [rcCoachSummaryData, setrcCoachSummaryData] = useState<rcCoachSummary[]>([]);
  const [rcCoachSummaryLoading, setrcCoachSummaryLoading] = useState(false);
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
  const [seasonStartYear, setSeasonStartYear] = useState<number>(() => {
    try { const sv = localStorage.getItem('svrz_season_v2'); const n = sv ? parseInt(sv, 10) : NaN; if (Number.isFinite(n)) return n; } catch { /* ignore */ }
    return curSeasonYear;
  });
  const seasonFrom = `${seasonStartYear}-09-01`;
  const seasonTo = `${seasonStartYear + 1}-04-30`;
  const seasonOptions = Array.from(new Set([seasonStartYear, curSeasonYear, curSeasonYear + 1, curSeasonYear + 2].filter((y) => y >= curSeasonYear))).sort((a, b) => a - b);
  const [emailTestMode, setEmailTestMode] = useState(false);
  // Per-coachee level/role targets (drives "watch at their level" game filtering).
  const [coacheeTargets, setCoacheeTargets] = useState<CoacheeTargetMap>({});
  // When true, ignore Niveau targets and show every game (escape hatch).
  const [showAllLevels, setShowAllLevels] = useState(false);
  // Read admin settings: email test-mode banner + default season + coachee targets.
  // A saved season pref older than the admin default is stale (new season started) — snap forward.
  useEffect(() => {
    getSettings().then((s) => {
      setEmailTestMode(Boolean(s.test_mode));
      setCoacheeTargets(s.coachee_targets ?? {});
      try {
        if (s.default_season) {
          const saved = parseInt(localStorage.getItem('svrz_season_v2') || '', 10);
          if (!Number.isFinite(saved) || saved < s.default_season) {
            setSeasonStartYear(s.default_season);
            localStorage.removeItem('svrz_season_v2');
          }
        }
      } catch { /* ignore */ }
    }).catch(() => { /* ignore */ });
  }, []);
  const [gameViewMode, setGameViewMode] = useState<'list' | 'calendar'>('list');
  const [expandedGameId, setExpandedGameId] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [gameFilterNeedsObs, setGameFilterNeedsObs] = useState(true);
  const [gameFilterShowInactive, setGameFilterShowInactive] = useState(false);
  const [gameFilterRd, setGameFilterRd] = useState(false);
  const [gameFilterLd, setGameFilterLd] = useState(false);
  const [gameFilterRcAssigned, setGameFilterRcAssigned] = useState(false);
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
  const [showJson, setShowJson] = useState(false);
  const [eligibleGames, setEligibleGames] = useState<EligibleGame[]>([]);
  const [rcPeople, setRcPeople] = useState<RefereeCoachPerson[]>([]);
  const [calendarGames, setCalendarGames] = useState<CalendarGameStatus[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [selectedCoacheeName, setSelectedCoacheeName] = useState('');
  const [selectedCoacheeLevel, setSelectedCoacheeLevel] = useState('');
  const [selectedCoacheeId, setSelectedCoacheeId] = useState('');
  const [loadingGames, setLoadingGames] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [coacheeGames, setCoacheeGames] = useState<CoacheeGame[]>([]);
  const [loadingCoacheeGames, setLoadingCoacheeGames] = useState(false);
  const [loadingCoachees, setLoadingCoachees] = useState(false);
  const [actionTargetCoachee, setActionTargetCoachee] = useState<Coachee | null>(null);
  const [detailCoachee, setDetailCoachee] = useState<Coachee | null>(null);
  const [detailNotes, setDetailNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [feedbackPickerCoachee, setFeedbackPickerCoachee] = useState<Coachee | null>(null);
  const [coacheeFeedbacks, setCoacheeFeedbacks] = useState<FeedbackRecord[]>([]);
  const [loadingCoacheeFeedbacks, setLoadingCoacheeFeedbacks] = useState(false);
  const [showAllPastGames, setShowAllPastGames] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [backendNotice, setBackendNotice] = useState('');
  const [adminAuthLoading, setAdminAuthLoading] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminAuthEmail, setAdminAuthEmail] = useState('');
  const [adminLoginEmail, setAdminLoginEmail] = useState('');
  const [adminLoginPassword, setAdminLoginPassword] = useState('');
  const [adminAuthNotice, setAdminAuthNotice] = useState('');
  const printableRef = useRef<HTMLDivElement | null>(null);
  const emptyForm1SRRef = useRef<HTMLDivElement | null>(null);
  const emptyForm2SRRef = useRef<HTMLDivElement | null>(null);
  const [showEmptyFormModal, setShowEmptyFormModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [sigModalOpen, setSigModalOpen] = useState(false);
  const [sigSlug, setSigSlug] = useState('');
  const [sigError, setSigError] = useState('');
  const sigPadRef = useRef<SignaturePadHandle>(null);
  const updateSignature = (data: string) => setFormData(prev => ({ ...prev, signature: data }));
  const openSignatureModal = async () => {
    setSigModalOpen(true); setSigSlug(''); setSigError('');
    try {
      const context = [formData.meta.mannschaften, formData.meta.liga, `${formData.role} ${formData.meta.srName}`.trim()].filter(Boolean).join(' · ');
      const started = await startSignature(context, formData.meta.srName);
      setSigSlug(started.slug);
    } catch { setSigError(formData.lang === 'DE' ? 'Konnte nicht gestartet werden.' : 'Could not start.'); }
  };
  const saveSignatureHere = async () => {
    if (!sigPadRef.current || sigPadRef.current.isEmpty()) return;
    const data = sigPadRef.current.toDataURL();
    updateSignature(data);
    if (sigSlug) { try { await submitSignatureSession(sigSlug, data, formData.meta.srName); } catch { /* ignore */ } }
    setSigModalOpen(false);
  };
  useEffect(() => {
    if (!sigModalOpen || !sigSlug) return;
    const id = setInterval(async () => {
      try { const sess = await getSignatureSession(sigSlug); if (sess.signed && sess.data) { setFormData(prev => ({ ...prev, signature: sess.data })); setSigModalOpen(false); } } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(id);
  }, [sigModalOpen, sigSlug]);
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

  useEffect(() => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    setBackendNotice('');
    // Load sequentially to avoid overwhelming PocketBase with concurrent requests (429)
    const loadAll = async () => {
      await refreshGames();
      await refreshCoachees();
      await refreshCalendarGames();
    };
    void loadAll();
  }, [formData.lang]);

  useEffect(() => {
    void refreshAdminAuthStatus();
  }, []);

  useEffect(() => {
    if (!selectedGame) {
      return;
    }
    const srName = getRefereeForRole(selectedGame, formData.role);
    // Match the coachee against the referee currently being observed (handles first/last name order)
    const coacheeById = coachees.find((c) => c.id === selectedCoacheeId);
    const normalizeName = (name: string) => name.toLowerCase().trim().split(/\s+/).sort().join(' ');
    const matchesNorm = (c: Coachee, norm: string) => {
      if (!norm) return false;
      if (normalizeName(c.full_name || '') === norm) return true;
      if (c.first_name && c.last_name && normalizeName(`${c.first_name} ${c.last_name}`) === norm) return true;
      return false;
    };
    const srNorm = normalizeName(srName || '');
    const coacheeByName = coachees.find((c) => matchesNorm(c, srNorm));
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
        ergebnis: selectedGame.game_result || prev.meta.ergebnis,
        srName: srName || prev.meta.srName,
        srNiveau: (coachee ? levelDisplay(coachee.referee_level, coachee.stage, ' - ').text : '') || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee?.groups) || prev.meta.gruppe,
        rc: selectedGame.assignedRc || prev.meta.rc,
      },
    }));
  }, [selectedGameId, selectedGame?.assignedRc, formData.role, coachees, selectedCoacheeId]);

  const updateMeta = (key: keyof typeof formData.meta, value: string) => {
    setFormData(prev => ({
      ...prev,
      meta: { ...prev.meta, [key]: value }
    }));
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

  const refreshGames = async () => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    setLoadingGames(true);
    setBackendNotice('');
    try {
      const games = await loadEligibleGames();
      setEligibleGames(games);
      listRefereeCoachPeople().then((people) => setRcPeople(people)).catch(() => {});
      if (games.length > 0 && !selectedGameId) {
        setSelectedGameId(games[0].id);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      setLoadingGames(false);
    }
  };

  const refreshAdminAuthStatus = async () => {
    setAdminAuthLoading(true);
    try {
      const status = await getAdminAuthStatus();
      setAdminAuthenticated(status.authenticated);
      setAdminAuthEmail(status.email || '');
      if (status.authenticated) {
        setAdminLoginPassword('');
      }
    } catch {
      setAdminAuthenticated(false);
      setAdminAuthEmail('');
    } finally {
      setAdminAuthLoading(false);
    }
  };

  const refreshCoachees = async () => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    setLoadingCoachees(true);
    setBackendNotice('');
    try {
      const items = await listCoachees();
      setCoachees(items);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      setLoadingCoachees(false);
    }
  };

  const refreshRcOverview = async () => {
    setRcOverviewLoading(true);
    try {
      const data = await loadRcOverview();
      setRcOverviewData(data);
    } catch {
      setRcOverviewData([]);
    } finally {
      setRcOverviewLoading(false);
    }
  };

  const handleSelectRc = async (rcName: string) => {
    setSelectedRcName(rcName);
    setrcCoachSummaryLoading(true);
    try {
      const data = await loadrcCoachSummary(rcName);
      setrcCoachSummaryData(data);
    } catch {
      setrcCoachSummaryData([]);
    } finally {
      setrcCoachSummaryLoading(false);
    }
  };

  const applyCoacheeToMeta = (coachee: Coachee) => {
    setFormData((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        srName: coachee.full_name || prev.meta.srName,
        srNiveau: levelDisplay(coachee.referee_level, coachee.stage, ' - ').text || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee.groups) || prev.meta.gruppe,
      },
    }));
  };

  const handleSelectGame = (game: EligibleGame | CoacheeGame) => {
    setSelectedGameId(game.id);
    setFeedbackLocked(false);
    setFeedbackSubView('feedbackForm');

    // Reset dual form storage
    setDualFormData({ '1. SR': null, '2. SR': null });

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
    setObservationTarget(target);
    setFormData(prev => {
      if (prev.role === role) return prev;
      const newSections = role === '1. SR'
        ? adjustSectionsFor2SR(prev.lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, has2)
        : (prev.lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
      return { ...prev, role, sections: newSections };
    });
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

  const loadCoacheeGames = async (coachee: Coachee) => {
    setLoadingCoacheeGames(true);
    setShowAllPastGames(false);
    setBackendNotice('');
    try {
      const [games, feedbacks] = await Promise.all([
        listCoacheeGames(coachee.id),
        listCoacheeFeedbacks(coachee.id),
      ]);
      setCoacheeGames(games);
      setCoacheeFeedbacks(feedbacks);
      setFeedbackSubView('coacheeGames');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      setLoadingCoacheeGames(false);
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
    const payload = record.feedback_json;
    if (payload) {
      setFormData(normalizeLoadedFeedback(payload));
      setObservationTarget(payload.role === '2. SR' ? '2SR' : '1SR');
    }
    const expandedGame = record.expand?.game;
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
      };
      setEligibleGames((prev) => (prev.some((item) => item.id === mappedGame.id) ? prev : [mappedGame, ...prev]));
      setSelectedGameId(mappedGame.id);
      setFeedbackLocked(false);
    }
    setFeedbackPickerCoachee(null);
    setActionTargetCoachee(null);
    setFeedbackSubView('feedbackForm');
  };

  const openFeedbackPicker = async (coachee: Coachee) => {
    setLoadingCoacheeFeedbacks(true);
    setBackendNotice('');
    try {
      const records = await listCoacheeFeedbacks(coachee.id);
      if (records.length === 1) {
        openFeedbackRecord(records[0]);
        return;
      }
      setCoacheeFeedbacks(records);
      setFeedbackPickerCoachee(coachee);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(localizeRuntimeError(reason, formData.lang));
    } finally {
      setLoadingCoacheeFeedbacks(false);
    }
  };

  const handleSelectCoachee = (coachee: Coachee) => {
    setDetailCoachee(coachee);
    setDetailNotes(coachee.notes || '');
    setSelectedCoacheeId(coachee.id);
    setSelectedCoacheeName(coachee.full_name || '');
    setSelectedCoacheeLevel(coachee.referee_level || '');
    applyCoacheeToMeta(coachee);
  };

  const handleSaveNotes = async () => {
    if (!detailCoachee) return;
    setSavingNotes(true);
    try {
      await updateCoachee(detailCoachee.id, { notes: detailNotes });
      setCoachees((prev) =>
        prev.map((c) => (c.id === detailCoachee.id ? { ...c, notes: detailNotes } : c))
      );
      setDetailCoachee((prev) => (prev ? { ...prev, notes: detailNotes } : prev));
      setBackendNotice(t.notesSaved);
    } catch {
      setBackendNotice(t.notesSaveError);
    } finally {
      setSavingNotes(false);
    }
  };

  const handleCoacheeAction = (coachee: Coachee) => {
    setDetailCoachee(null);
    const observationCount = coachee.observation_status?.count ?? coachee.observations_count ?? 0;
    if (observationCount === 0) {
      void loadCoacheeGames(coachee);
      return;
    }
    setActionTargetCoachee(coachee);
  };

  const coacheeBalls = (coachee: Coachee) => {
    const isActive = (coachee.stage || 'active') !== 'inactive';
    const status = coachee.observation_status;
    const balls: Array<{ color: string; title: string; key: string }> = [];
    if (isActive && (status?.hasNoObservation ?? false)) {
      balls.push({ key: 'none', color: 'bg-amber-100 text-amber-800', title: t.noObservation });
    }
    if (isActive && (status?.hasFurtherObservationNeeded ?? false)) {
      balls.push({ key: 'further', color: 'bg-orange-100 text-orange-800', title: t.furtherObservation });
    }
    if (status?.hasCompletedObservation) {
      balls.push({ key: 'done', color: 'bg-emerald-100 text-emerald-800', title: t.completedObservation });
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
    if (!printableRef.current) {
      return;
    }
    const imageData = await toPng(printableRef.current, {
      pixelRatio: 2,
      backgroundColor: '#ffffff',
    });

    // Decode image dimensions for PDF sizing
    const img = new Image();
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imageData; });
    // Custom page size so everything fits on a single page
    const pdfWidth = img.width * 0.75;
    const pdfHeight = img.height * 0.75;
    const pdf = new jsPDF({
      orientation: pdfWidth > pdfHeight ? 'l' : 'p',
      unit: 'pt',
      format: [pdfWidth, pdfHeight],
    });
    pdf.addImage(imageData, 'PNG', 0, 0, pdfWidth, pdfHeight);

    const file = new File([pdf.output('blob')], pdfFilename(formData), { type: 'application/pdf' });
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: t.title,
        files: [file],
      });
      return;
    }
    pdf.save(pdfFilename(formData));
  };

  const handleDownloadEmptyForm = async (choice: '1SR' | '2SR' | 'both') => {
    type PdfField = { fieldName: string; Rect: number[]; fontSize?: number; multiline?: boolean };
    setDownloadingEmptyForm(true);
    setShowEmptyFormModal(false);
    await new Promise(r => setTimeout(r, 100)); // let hidden forms render

    const refs = choice === '1SR' ? [emptyForm1SRRef]
      : choice === '2SR' ? [emptyForm2SRRef]
      : [emptyForm1SRRef, emptyForm2SRRef];

    const a4W = 595.28, a4H = 841.89, margin = 6;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const AcroForm = (jsPDF as unknown as { AcroForm: { TextField: new () => PdfField } }).AcroForm;
    const addField = (pdf as unknown as { addField: (fld: PdfField) => void }).addField.bind(pdf);
    let page = 0;
    for (const ref of refs) {
      if (!ref.current) continue;
      if (page > 0) pdf.addPage();
      page++;
      const imageData = await toPng(ref.current, { pixelRatio: 1.5, backgroundColor: '#ffffff' });
      const img = new Image();
      await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = imageData; });
      const usableW = a4W - margin * 2, usableH = a4H - margin * 2;
      const scale = Math.min(usableW / img.width, usableH / img.height);
      const imgW = img.width * scale, imgH = img.height * scale;
      const ox = (a4W - imgW) / 2; // centre horizontally on A4
      const oy = margin;
      pdf.addImage(imageData, 'PNG', ox, oy, imgW, imgH);
      const role = ref === emptyForm1SRRef ? '1SR' : '2SR';
      try {
        const cRect = ref.current.getBoundingClientRect();
        const k = imgW / ref.current.offsetWidth;
        ref.current.querySelectorAll<HTMLElement>('[data-pdf-field]').forEach((el) => {
          const fr = el.getBoundingClientRect();
          const fx = ox + (fr.left - cRect.left) * k;
          const fy = oy + (fr.top - cRect.top) * k;
          const fw = fr.width * k, fh = fr.height * k;
          if (fw < 3 || fh < 3) return;
          const tf = new AcroForm.TextField();
          tf.fieldName = `${role}_${el.getAttribute('data-pdf-field')}`;
          tf.Rect = [fx, fy, fw, fh];
          tf.fontSize = el.getAttribute('data-pdf-multiline') ? 9 : 10;
          if (el.getAttribute('data-pdf-multiline')) tf.multiline = true;
          addField(tf);
        });
      } catch (err) { console.warn('fillable fields skipped', err); }
    }
    pdf.save(choice === 'both' ? 'feedback-empty.pdf' : `feedback-${choice}-empty.pdf`);
    setDownloadingEmptyForm(false);
  };

  const handleManualUploadSubmit = async (form: HTMLFormElement) => {
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
        srZiel,
      },
    };

    // Convert file to base64
    const arrayBuf = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const fileBase64 = btoa(binary);

    setManualUploadSubmitting(true);
    setManualUploadNotice('');
    try {
      // We need a gameId. For manual upload, find or create a placeholder.
      // Use the spielNr to look up the game, or pass empty and let server handle it.
      const matchNo = feedbackData.meta.spielNr;
      const matchingGame = eligibleGames.find(g => g.matchNo === matchNo);
      const gameId = matchingGame?.id || '';

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
      setTimeout(() => setManualUploadCoachee(null), 2000);
    } catch (err: unknown) {
      setManualUploadNotice(`${t.manualUploadError} ${err instanceof Error ? err.message : ''}`);
    } finally {
      setManualUploadSubmitting(false);
    }
  };

  const submitSingleFeedback = async (fd: FeedbackFormData, tips: string): Promise<string> => {
    if (!selectedGame || !printableRef.current) throw new Error(t.noGames);
    // Force German for PDF screenshot and server-side email
    const originalLang = fd.lang;
    if (originalLang !== 'DE') {
      setFormData({ ...fd, lang: 'DE' as const });
      await new Promise(r => setTimeout(r, 200));
    } else {
      setFormData(fd);
      await new Promise(r => setTimeout(r, 100));
    }
    const base64 = await generatePdfBase64(printableRef.current, 1.5);
    const deFormData = { ...fd, lang: 'DE' as const };
    if (originalLang !== 'DE') {
      setFormData(prev => ({ ...prev, lang: originalLang }));
    }
    const result = await saveFeedbackToPocketBase({
      gameId: selectedGame.id,
      role: fd.role,
      formData: deFormData,
      pdfBase64: base64,
      pdfFilename: pdfFilename(deFormData),
      tipsAndTricks: tips,
    });
    if (result.emailSent) {
      return result.emailWarning
        ? `${fd.role}: ${t.saveOkEmail} (${result.emailWarning})`
        : `${fd.role}: ${t.saveOkEmail}`;
    }
    return `${fd.role}: ${t.saveOkNoEmail} ${result.emailError || 'Unknown error'}`;
  };

  const handleSaveFeedback = async () => {
    if (!selectedGame || !printableRef.current) {
      setBackendNotice(t.noGames);
      return;
    }
    setSavingFeedback(true);
    setBackendNotice('');
    try {
      if (dualMode) {
        // Dual submit: submit both roles sequentially
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
          notices.push(await submitSingleFeedback(fd, tips));
        }
        // Restore current role's form
        setFormData(formData);
        setBackendNotice(notices.join(' | '));
        setFeedbackLocked(true);
      } else {
        // Single submit (original logic)
        const notice = await submitSingleFeedback(formData, tipsAndTricks);
        setBackendNotice(notice.replace(`${formData.role}: `, ''));
        if (formData.results.secondBesuch !== 'Y') {
          setFeedbackLocked(true);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setBackendNotice(`${t.saveError} ${localizeRuntimeError(reason, formData.lang)}`);
    } finally {
      setSavingFeedback(false);
    }
  };

  const handleAdminLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAdminAuthLoading(true);
    setAdminAuthNotice('');
    try {
      const status = await loginAdmin({ email: adminLoginEmail, password: adminLoginPassword });
      setAdminAuthenticated(status.authenticated);
      setAdminAuthEmail(status.email || adminLoginEmail);
      setAdminLoginPassword('');
      setAdminAuthNotice(t.authLoginSuccess);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setAdminAuthenticated(false);
      setAdminAuthEmail('');
      setAdminAuthNotice(`${t.authLoginFailed} ${localizeRuntimeError(reason, formData.lang)}`);
    } finally {
      setAdminAuthLoading(false);
    }
  };

  const handleAdminLogout = async () => {
    setAdminAuthLoading(true);
    setAdminAuthNotice('');
    try {
      await logoutAdmin();
      setAdminAuthenticated(false);
      setAdminAuthEmail('');
      setAdminLoginPassword('');
      setAdminAuthNotice(t.authLoggedOut);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setAdminAuthNotice(`${t.authLogoutFailed} ${localizeRuntimeError(reason, formData.lang)}`);
    } finally {
      setAdminAuthLoading(false);
    }
  };

  const [tipsAndTricks, setTipsAndTricks] = useState('');
  const [feedbackLocked, setFeedbackLocked] = useState(false);
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

  const isGameRoleClosed = selectedGame?.feedbackClosedRoles?.includes(formData.role) ?? false;
  const formDisabled = feedbackLocked || isGameRoleClosed;

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
    }));
    setFeedbackLocked(false);
    setTipsAndTricks('');
    setDualFormData({ '1. SR': null, '2. SR': null });
    setShowConfirmModal(null);
  };

  const resetForm = () => {
    setShowConfirmModal('reset');
  };

  const changeObservationTarget = (target: '1SR' | '2SR' | 'both') => {
    if (target === observationTarget) return;
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
        meta: {
          ...prev.meta,
          srName: selectedGame ? getRefereeForRole(selectedGame, newRole) || '' : '',
          srNiveau: '',
          gruppe: '',
        },
      }));
      setTipsAndTricks('');
    }
  };

  const toggleRole = () => {
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
          meta: {
            ...prev.meta,
            srName: selectedGame ? getRefereeForRole(selectedGame, newRole) || '' : '',
            srNiveau: '',
            gruppe: '',
          },
        }));
        setTipsAndTricks('');
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
    setFormData(prev => {
      const newLang = prev.lang === 'DE' ? 'EN' : 'DE';
      let newSections;
      if (prev.role === '1. SR') {
        newSections = adjustSectionsFor2SR(newLang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN, gameHas2SR);
      } else {
        newSections = newLang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN;
      }

      // Map existing ratings to new sections
      const mappedSections = newSections.map((section, sIdx) => ({
        ...section,
        items: section.items.map((item, iIdx) => ({
          ...item,
          rating: prev.sections[sIdx]?.items[iIdx]?.rating || ''
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
    [coachees],
  );
  const coacheeLevels = useMemo(
    () => [...new Set(coachees.map((c) => levelDisplay(c.referee_level, c.stage).text))].sort(),
    [coachees],
  );
  const gameLeagues = useMemo(
    () => Array.from(new Set<string>(eligibleGames.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort(),
    [eligibleGames],
  );
  const gameCoacheeOptions = useMemo(
    () => Array.from(new Set<string>(
      eligibleGames.flatMap((g) => [g.firstReferee, g.secondReferee].filter(Boolean) as string[])
        .filter((name) => coacheeNames.has(normName(name)))
    )).sort(),
    [eligibleGames, coacheeNames],
  );
  const { games1SRCount, games2SRCount } = useMemo(() => {
    const now = new Date();
    const upcomingGames = eligibleGames.filter((g) => new Date(g.date) >= now);
    const sr1 = new Map<string, number>();
    const sr2 = new Map<string, number>();
    for (const g of upcomingGames) {
      const r1 = (g.firstReferee || '').toLowerCase().trim();
      const r2 = (g.secondReferee || '').toLowerCase().trim();
      if (r1) sr1.set(r1, (sr1.get(r1) || 0) + 1);
      if (r2) sr2.set(r2, (sr2.get(r2) || 0) + 1);
    }
    return { games1SRCount: sr1, games2SRCount: sr2 };
  }, [eligibleGames]);
  const filteredCoachees = useMemo(() => {
    const q = listSearch.toLowerCase();
    const filtered = coachees.filter((c) => {
      if (typeof c.season === 'number' && c.season !== seasonStartYear) return false;
      if (q && !(c.full_name || '').toLowerCase().includes(q) && !levelDisplay(c.referee_level, c.stage).text.toLowerCase().includes(q) && !(normalizeCoacheeGroup(c.groups) || '').toLowerCase().includes(q)) return false;
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
      if (listSortBy === 'name') return dir * (a.full_name || '').localeCompare(b.full_name || '');
      if (listSortBy === 'level') return dir * levelDisplay(a.referee_level, a.stage).text.localeCompare(levelDisplay(b.referee_level, b.stage).text);
      return dir * (statusPriority(a) - statusPriority(b));
    });
    return filtered;
  }, [coachees, listSearch, listFilterLevels, listFilterShowInactive, listFilterNeedsObs, listSortBy, listSortAsc, seasonStartYear]);
  // Lookup coachee by normalized name for game filtering
  const coacheeByName = useMemo(() => {
    const map = new Map<string, Coachee>();
    for (const c of coachees) {
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
  }, [coachees]);

  const filteredGames = useMemo(() => {
    const q = listSearch.toLowerCase();
    // Referees already covered this season: an RC took one of their games, so
    // none of their games need to stay on the open list.
    const coveredRefs = new Set<string>();
    for (const g of eligibleGames) {
      if (!g.assignedRc) continue;
      const sd = new Date(g.date);
      if (!Number.isNaN(sd.getTime()) && (sd < new Date(seasonFrom) || sd > new Date(seasonTo + 'T23:59:59'))) continue;
      for (const r of [g.firstReferee, g.secondReferee]) {
        if (!r) continue;
        // Resolve through the name map (handles "First Last" vs "Last First")
        // so coverage is keyed by the coachee's canonical full name.
        const cc = coacheeByName.get(normName(r));
        coveredRefs.add(normName(cc?.full_name || r));
      }
    }
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
        const match = gameFilterFunction.some((fn) =>
          fn === '1SR' ? r1IsCoachee : fn === '2SR' ? r2IsCoachee : false,
        );
        if (!match) return false;
      }
      if (gameFilterLeagues.length > 0 && !gameFilterLeagues.includes(g.league || '')) return false;
      if (gameFilterRd && !g.isRdGame) return false;
      if (gameFilterLd && !g.isLdGame) return false;
      // Games a coach has taken are hidden by default (they live under the RC in
      // the Referee Coaches tab); the toggle flips to showing only taken games.
      if (gameFilterRcAssigned ? !g.assignedRc : g.assignedRc) return false;
      if (gameFilterDateFrom) {
        const from = new Date(gameFilterDateFrom);
        if (new Date(g.date) < from) return false;
      }
      if (gameFilterDateTo) {
        const to = new Date(gameFilterDateTo + 'T23:59:59');
        if (new Date(g.date) > to) return false;
      }
      // Season bound (whole-app season scope)
      if (g.date) {
        const sd = new Date(g.date);
        if (!Number.isNaN(sd.getTime()) && (sd < new Date(seasonFrom) || sd > new Date(seasonTo + 'T23:59:59'))) return false;
      }
      // Coachee-aware filters: check if at least one referee passes
      if (gameFilterNeedsObs || !gameFilterShowInactive) {
        const refs = [g.firstReferee, g.secondReferee].filter(Boolean).map((r) => normName(r!));
        const refCoachees = refs.map((r) => coacheeByName.get(r)).filter(Boolean) as Coachee[];
        // If no referees are coachees at all, keep the game visible
        if (refCoachees.length > 0) {
          const hasEligibleRef = refCoachees.some((c) => {
            const isActive = (c.stage || 'active') !== 'inactive';
            if (!gameFilterShowInactive && !isActive) return false;
            if (gameFilterNeedsObs && !c.observation_status?.needsObservation) return false;
            // Covered by a planned observation → all their games leave the open list
            // (not when deliberately viewing taken games via the RC toggle).
            if (gameFilterNeedsObs && !gameFilterRcAssigned && coveredRefs.has(normName(c.full_name || ''))) return false;
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
        const anyTargeted = coacheeRefs.some((r) => isTargetActive(coacheeTargets[r.c.id], levelKey(r.c.referee_level, r.c.stage)));
        if (coacheeRefs.length > 0 && anyTargeted) {
          const keep = coacheeRefs.some((r) =>
            keepGame({ league: g.league || '', role: r.role, target: coacheeTargets[r.c.id], levelKey: levelKey(r.c.referee_level, r.c.stage) }));
          if (!keep) return false;
        }
      }
      return true;
    });
  }, [eligibleGames, listSearch, gameFilterCoachees, gameFilterLevels, gameFilterFunction, gameFilterLeagues, gameFilterDateFrom, gameFilterDateTo, gameFilterNeedsObs, gameFilterShowInactive, gameFilterRd, gameFilterLd, gameFilterRcAssigned, coacheeByName, coacheeNames, seasonFrom, seasonTo, showAllLevels, coacheeTargets]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 py-6 sm:py-8 px-4 print:bg-white print:p-0">
      {emailTestMode && (
        <div className="max-w-5xl mx-auto mb-3 no-print">
          <div className="flex items-center gap-2 rounded-xl bg-amber-100 border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-2">
            <Info size={14} /> {formData.lang === 'DE' ? 'Testmodus aktiv — es werden keine E-Mails versendet.' : 'Test mode on — no emails are sent.'}
          </div>
        </div>
      )}
      {/* UI Controls */}
      <div className="max-w-4xl mx-auto mb-6 flex flex-wrap gap-3 no-print">
        {viewMode === 'feedback' && feedbackSubView !== 'coachees' && (
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
        {gameHas2SR && (
          <div className="flex items-center gap-2">
            <div
              className="flex rounded-lg border border-stone-300 bg-white shadow-sm overflow-hidden"
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
                      ? (formData.lang === 'DE' ? 'Beide Schiedsrichter beobachten' : 'Observe both referees')
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
                  className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-red-700 transition-colors"
                >
                  <RefreshCw size={18} />
                  <span className="hidden sm:inline">{t.switchRole} {formData.role === '1. SR' ? '2. SR' : '1. SR'}</span>
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
          className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-lg shadow-sm border border-red-100 hover:bg-red-100 transition-colors"
        >
          <RefreshCw size={18} />
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
        {viewMode === 'admin' && adminAuthenticated && (
          <button
            onClick={() => void handleAdminLogout()}
            disabled={adminAuthLoading}
            className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-red-700 transition-colors disabled:opacity-50 ml-auto"
          >
            <LogOut size={18} />
            <span className="hidden sm:inline">{adminAuthLoading ? t.loading : t.adminLogout}</span>
          </button>
        )}
      </div>

      {viewMode === 'admin' && (
        adminAuthenticated ? (
          <AdminPanel lang={formData.lang} />
        ) : (
          <div className="max-w-md mx-auto bg-white border border-stone-200/70 shadow-card-lg rounded-2xl p-6 sm:p-7 no-print">
            <div className="flex items-start gap-3 mb-4">
              <ShieldAlert className="text-slate-700 mt-0.5" size={20} />
              <div>
                <h2 className="text-lg font-semibold text-stone-900">{t.adminLoginRequiredTitle}</h2>
                <p className="text-sm text-stone-600">
                  {t.adminLoginRequiredDesc}
                </p>
              </div>
            </div>
            <form onSubmit={handleAdminLogin} className="space-y-3">
              <label className="block text-xs text-stone-600">
                {t.email}
                <input
                  type="email"
                  value={adminLoginEmail}
                  onChange={(e) => setAdminLoginEmail(e.target.value)}
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-red-400 outline-none"
                  required
                />
              </label>
              <label className="block text-xs text-stone-600">
                {t.password}
                <input
                  type="password"
                  value={adminLoginPassword}
                  onChange={(e) => setAdminLoginPassword(e.target.value)}
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-red-400 outline-none"
                  required
                />
              </label>
              <button
                type="submit"
                disabled={adminAuthLoading}
                className="h-10 px-4 rounded bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <LogIn size={16} />
                <span>{adminAuthLoading ? t.loading : t.login}</span>
              </button>
            </form>
            {adminAuthEmail && (
              <p className="mt-3 text-xs text-stone-500">{t.currentSession}: {adminAuthEmail}</p>
            )}
            {adminAuthNotice && (
              <p className="mt-2 text-xs text-red-700">{adminAuthNotice}</p>
            )}
          </div>
        )
      )}

      {viewMode === 'feedback' && feedbackSubView === 'coachees' && (
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
            {/* Top row: language toggle + empty form download */}
            <div className="mb-3 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleLang}
                  className="h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                  title={t.languageToggleTitle}
                >
                  <Languages size={14} />
                  <span>{formData.lang}</span>
                </button>
                <button
                  onClick={() => { window.location.hash = '/admin'; }}
                  className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                >
                  <ShieldAlert size={14} />
                  <span className="hidden sm:inline">Admin</span>
                </button>
                <button
                  onClick={() => setShowInfoModal(true)}
                  className="sm:hidden h-9 inline-flex items-center justify-center px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors"
                  title={formData.lang === 'DE' ? 'Infos & Dokumente' : 'Info & documents'}
                  aria-label="Info"
                >
                  <Info size={14} />
                </button>
                <select
                  value={seasonStartYear}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); setSeasonStartYear(v); try { localStorage.setItem('svrz_season_v2', String(v)); } catch { /* ignore */ } }}
                  className="h-9 ml-auto sm:ml-0 rounded-lg border border-stone-200 bg-stone-50 text-stone-700 text-xs font-medium px-2.5 hover:bg-stone-100 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-red-500"
                  title={formData.lang === 'DE' ? 'Saison' : 'Season'}
                  aria-label={formData.lang === 'DE' ? 'Saison wählen' : 'Select season'}
                >
                  {seasonOptions.map((y) => (
                    <option key={y} value={y}>{`${y}/${String((y + 1) % 100).padStart(2, '0')}`}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => setShowEmptyFormModal(true)}
                disabled={downloadingEmptyForm}
                className="w-full sm:w-auto sm:ml-auto h-9 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg border border-stone-200 text-xs font-medium bg-stone-50 text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-50"
              >
                <Download size={14} />
                {downloadingEmptyForm ? t.loading : t.downloadEmptyForm}
              </button>
            </div>
            {/* Toggle tabs */}
            <div className="mb-3 grid grid-cols-3 gap-2">
              <button
                onClick={() => { setListTab('coachees'); setListSearch(''); setListPage(0); }}
                className={cn(
                  "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center",
                  listTab === 'coachees'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                {t.coacheePool}
              </button>
              <button
                onClick={() => { setListTab('games'); setListSearch(''); setListPage(0); }}
                className={cn(
                  "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center",
                  listTab === 'games'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                {t.gamePool}
              </button>
              <button
                onClick={() => { setListTab('rcOverview'); setSelectedRcName(null); if (rcOverviewData.length === 0) void refreshRcOverview(); }}
                className={cn(
                  "h-14 w-full px-3 text-sm font-medium rounded-xl transition-colors flex items-center justify-center text-center",
                  listTab === 'rcOverview'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                {t.rcOverview}
              </button>
            </div>

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
                    const activeFilterCount = [gameFilterCoachees.length > 0, gameFilterLevels.length > 0, gameFilterFunction.length > 0, gameFilterLeagues.length > 0, !!gameFilterDateFrom || !!gameFilterDateTo, gameFilterRd, gameFilterLd, gameFilterRcAssigned].filter(Boolean).length;
                    return (
                      <button
                        onClick={() => setFiltersOpen(!filtersOpen)}
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
                    <button
                      onClick={() => setGameFilterNeedsObs(!gameFilterNeedsObs)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", gameFilterNeedsObs ? "bg-red-600" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", gameFilterNeedsObs ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>{formData.lang === 'DE' ? 'Beobachtung nötig' : 'Needs observation'}</span>
                    </button>
                    <button
                      onClick={() => setGameFilterShowInactive(!gameFilterShowInactive)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", gameFilterShowInactive ? "bg-red-600" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", gameFilterShowInactive ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>{formData.lang === 'DE' ? 'Inaktive zeigen' : 'Show inactive'}</span>
                    </button>
                    <button
                      onClick={() => setGameFilterRd(!gameFilterRd)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", gameFilterRd ? "bg-amber-500" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", gameFilterRd ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>RD Game</span>
                    </button>
                    <button
                      onClick={() => setGameFilterLd(!gameFilterLd)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", gameFilterLd ? "bg-violet-500" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", gameFilterLd ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>LD Game</span>
                    </button>
                    <button
                      onClick={() => setGameFilterRcAssigned(!gameFilterRcAssigned)}
                      className="h-9 px-3 border border-stone-300 rounded-md bg-white text-sm text-stone-600 flex items-center gap-2 whitespace-nowrap hover:bg-stone-50 transition-colors cursor-pointer select-none"
                    >
                      <span className={cn("relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors", gameFilterRcAssigned ? "bg-green-500" : "bg-stone-300")}>
                        <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5", gameFilterRcAssigned ? "translate-x-4.5" : "translate-x-0.5")} />
                      </span>
                      <span>{formData.lang === 'DE' ? 'RC zugewiesen' : 'RC assigned'}</span>
                    </button>
                    <div className="flex-1 min-w-[140px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Coachee' : 'Coachee'}
                      </label>
                      <MultiSelectDropdown
                        options={gameCoacheeOptions}
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
                        options={['1SR', '2SR']}
                        selected={gameFilterFunction}
                        onChange={setGameFilterFunction}
                        placeholder={formData.lang === 'DE' ? 'Alle' : 'All'}
                      />
                    </div>
                    <div className="flex-1 min-w-[140px]">
                      <label className="block text-xs font-medium text-stone-500 mb-0.5">
                        {formData.lang === 'DE' ? 'Liga' : 'League'}
                      </label>
                      <MultiSelectDropdown
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
                {filteredCoachees.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-14 px-4 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400"><Users size={26} strokeWidth={1.75} /></div><p className="text-sm font-medium text-stone-500">{t.noCoachees}</p></div>
                ) : (
                  <>
                    <div className="sticky top-0 z-10 flex items-center gap-4 bg-stone-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200">
                      <span className="flex-1 cursor-pointer select-none" onClick={() => toggleListSort('name')}>{formData.lang === 'DE' ? 'Name' : 'Name'}{listSortBy === 'name' ? (listSortAsc ? ' ▲' : ' ▼') : ''}</span>
                      <span className="cursor-pointer select-none" onClick={() => toggleListSort('status')}>Status{listSortBy === 'status' ? (listSortAsc ? ' ▲' : ' ▼') : ''}</span>
                    </div>
                    <div className="divide-y divide-stone-200">
                      {filteredCoachees.slice(listPage * LIST_PAGE_SIZE, (listPage + 1) * LIST_PAGE_SIZE).map((coachee) => {
                        const balls = coacheeBalls(coachee);
                        const groupStr = normalizeCoacheeGroup(coachee.groups) || '';
                        const sr1 = games1SRCount.get((coachee.full_name || '').toLowerCase().trim()) || 0;
                        const sr2 = games2SRCount.get((coachee.full_name || '').toLowerCase().trim()) || 0;
                        return (
                          <div
                            key={coachee.id}
                            onClick={() => handleSelectCoachee(coachee)}
                            className={cn(
                              "px-3 py-2.5 cursor-pointer transition-colors",
                              selectedCoacheeId === coachee.id ? "bg-red-50" : "hover:bg-stone-50"
                            )}
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-sm text-stone-900">{coachee.full_name}</div>
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
                              </div>
                              <div className="flex flex-wrap items-center gap-1 pt-0.5">
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
                              </div>
                            </div>
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
                      <button disabled={listPage === 0} onClick={() => setListPage((p) => p - 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&laquo;</button>
                      <span>{listPage + 1} / {Math.ceil(filteredCoachees.length / LIST_PAGE_SIZE)}</span>
                      <button disabled={(listPage + 1) * LIST_PAGE_SIZE >= filteredCoachees.length} onClick={() => setListPage((p) => p + 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&raquo;</button>
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
                    onClick={() => setShowAllLevels((v) => !v)}
                    className={cn(
                      "ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors",
                      showAllLevels
                        ? "border-stone-200 text-stone-500 hover:bg-stone-100"
                        : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                    )}
                    title={formData.lang === 'DE'
                      ? 'Nur Spiele, die zum Niveau/Ziel der Coachees passen (Standard). Antippen, um alle Spiele zu zeigen.'
                      : "Only games matching the coachees' level/target (default). Tap to show all games."}
                  >
                    <Target size={14} />
                    {showAllLevels
                      ? (formData.lang === 'DE' ? 'Alle Spiele' : 'All games')
                      : (formData.lang === 'DE' ? 'Nur passende' : 'Matching only')}
                  </button>
                </div>

                {/* Games list view */}
                {gameViewMode === 'list' && (
                  <div className="border border-stone-200 rounded">
                    {filteredGames.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-3 py-14 px-4 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-full bg-stone-100 text-stone-400"><CalendarDays size={26} strokeWidth={1.75} /></div><p className="text-sm font-medium text-stone-500">{t.noGames}</p></div>
                    ) : (
                      <>
                        <div className="sticky top-0 z-10 grid grid-cols-[1fr_auto] items-center gap-2 bg-stone-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-stone-500 border-b border-stone-200">
                          <span>{formData.lang === 'DE' ? 'Spiel' : 'Game'}</span>
                          <span>{formData.lang === 'DE' ? 'Status' : 'Status'}</span>
                        </div>
                        <div className="divide-y-4 divide-stone-200">
                        {filteredGames.slice(listPage * LIST_PAGE_SIZE, (listPage + 1) * LIST_PAGE_SIZE).map((game) => {
                          const d = new Date(game.date);
                          const dateValid = !isNaN(d.getTime());
                          const dayOfWeek = dateValid ? d.toLocaleDateString(formData.lang === 'DE' ? 'de-CH' : 'en-GB', { weekday: 'short' }) : '';
                          const yearStr = window.innerWidth < 640 ? String(d.getFullYear()).slice(-2) : String(d.getFullYear());
                          const datePart = dateValid ? `${dayOfWeek} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${yearStr}` : (game.date || '-');
                          const timePart = dateValid ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
                          const isExpanded = expandedGameId === game.id;
                          const r1 = game.firstReferee || '';
                          const r2 = game.secondReferee || '';
                          const r1IsCoachee = coacheeNames.has(normName(r1));
                          const r2IsCoachee = r2 ? coacheeNames.has(normName(r2)) : false;
                          return (
                            <div key={game.id}>
                              <div
                                onClick={() => setExpandedGameId(isExpanded ? null : game.id)}
                                className={cn(
                                  "px-3 py-3.5 cursor-pointer transition-colors",
                                  isExpanded ? "bg-red-50" : "hover:bg-stone-50"
                                )}
                              >
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
                                  <ChevronDown size={14} className={cn("text-stone-400 transition-transform", isExpanded && "rotate-180")} />
                                </div>
                                {/* Row 2: league, match#, chips */}
                                <div className="flex items-center gap-1.5 text-sm text-stone-400 mt-0.5">
                                  <Tag size={14} className="w-3.5 text-stone-400 shrink-0" />
                                  <span><LeagueLabel text={game.league} /></span>
                                  {game.matchNo && <span>#{game.matchNo}</span>}
                                  {game.isRdGame && <span className="px-2 py-1 rounded text-xs font-bold leading-none bg-stone-900 text-white">{formData.lang === 'DE' ? 'RD Spiel' : 'RD Game'}</span>}
                                  {game.isLdGame && <span className="px-2 py-1 rounded text-xs font-bold leading-none bg-stone-900 text-white">{formData.lang === 'DE' ? 'LD Spiel' : 'LD Game'}</span>}
                                </div>
                                {/* Teams + result */}
                                {(() => {
                                  const resultParts = game.game_result?.split('|').map((s: string) => s.trim()).filter(Boolean);
                                  const mainResult = resultParts?.[0];
                                  const setResults = resultParts?.slice(1);
                                  return (
                                    <>
                                      <div className="mt-1 flex items-center gap-1.5">
                                        <Home size={14} className="w-3.5 text-stone-400 shrink-0" />
                                        <span className="text-base text-stone-800 truncate flex-1">{game.homeTeam}</span>
                                        {mainResult && <span className="text-sm font-bold text-stone-600 tabular-nums whitespace-nowrap">{mainResult.split(':')[0]?.trim()}</span>}
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <Navigation size={14} className="w-3.5 text-stone-400 shrink-0" />
                                        <span className="text-base text-stone-800 truncate flex-1">{game.awayTeam}</span>
                                        {mainResult && <span className="text-sm font-bold text-stone-600 tabular-nums whitespace-nowrap">{mainResult.split(':')[1]?.trim()}</span>}
                                      </div>
                                      {setResults && setResults.length > 0 && (
                                        <div className="pl-[20px] text-[11px] text-stone-400 tabular-nums">
                                          {setResults.map((s: string, i: number) => (
                                            <span key={i}>{i > 0 ? ' | ' : ''}{s}</span>
                                          ))}
                                        </div>
                                      )}
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
                                      r1IsCoachee ? <CoacheeName name={r1} /> : <span className="font-semibold text-stone-700">{r1}</span>
                                    ) : (
                                      <span className="text-stone-300">–</span>
                                    )}
                                  </div>
                                  {r2 && (
                                    <div className="flex items-center gap-1.5">
                                      <span className="w-3.5 shrink-0" />
                                      <span className="font-medium text-stone-400">2SR</span>
                                      {r2IsCoachee ? <CoacheeName name={r2} /> : <span className="font-semibold text-stone-700">{r2}</span>}
                                    </div>
                                  )}
                                </div>
                                {/* RC */}
                                {game.assignedRc && (
                                  <div className="mt-0.5 flex items-center gap-1.5 text-sm text-stone-500">
                                    <Eye size={14} className="w-3.5 text-stone-400 shrink-0" />
                                    <span className="font-medium text-stone-400">RC</span>
                                    <span className="font-bold text-stone-700">{game.assignedRc}</span>
                                  </div>
                                )}
                              </div>
                              {/* Expanded row */}
                              {isExpanded && (
                                <div className="px-3 pb-3 pt-1 bg-red-50 border-t border-red-100 space-y-2">
                                  {/* RC selector + actions */}
                                  <div className="flex flex-wrap items-center gap-3">
                                    <label className="text-xs font-medium text-stone-500">RC:</label>
                                    <select
                                      value={game.assignedRc || ''}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={async (e) => {
                                        const rcName = e.target.value;
                                        try {
                                          await assignRcToGame(game.id, rcName);
                                          setEligibleGames((prev) => prev.map((g) => g.id === game.id ? { ...g, assignedRc: rcName } : g));
                                        } catch (err) {
                                          setBackendNotice(err instanceof Error ? err.message : String(err));
                                        }
                                      }}
                                      className="h-9 px-3 text-sm border border-stone-300 rounded-md bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-red-400 transition-colors hover:border-stone-400 flex-1 min-w-[14rem] max-w-sm cursor-pointer"
                                    >
                                      <option value="">-</option>
                                      {rcPeople.map((rc) => (
                                        <option key={rc.id} value={rc.fullName}>{rc.fullName}</option>
                                      ))}
                                    </select>
                                    <button
                                      onClick={() => handleSelectGame(game)}
                                      disabled={!game.assignedRc}
                                      className={cn("h-9 px-3 text-sm font-medium rounded-md transition-colors", game.assignedRc ? "bg-slate-900 text-white hover:bg-slate-800 cursor-pointer" : "bg-stone-200 text-stone-400 cursor-not-allowed")}
                                    >
                                      <Eye size={14} className="inline mr-1.5 -mt-0.5" />
                                      {formData.lang === 'DE' ? 'Beobachtung starten' : 'Start observation'}
                                    </button>
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
                          <button disabled={listPage === 0} onClick={() => setListPage((p) => p - 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&laquo;</button>
                          <span>{listPage + 1} / {Math.ceil(filteredGames.length / LIST_PAGE_SIZE)}</span>
                          <button disabled={(listPage + 1) * LIST_PAGE_SIZE >= filteredGames.length} onClick={() => setListPage((p) => p + 1)} className="px-2 py-1 border rounded disabled:opacity-30 hover:bg-stone-50">&raquo;</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

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

            {/* RC Overview tab content */}
            {listTab === 'rcOverview' && (
              <div>
                {!rcOverviewLoading && !selectedRcName && rcOverviewData.length > 0 && (
                  <div className="flex justify-end mb-2">
                    <button
                      onClick={() => void refreshRcOverview()}
                      className="text-xs text-stone-400 hover:text-stone-600 flex items-center gap-1"
                    >
                      <RefreshCw size={12} />
                      {formData.lang === 'DE' ? 'Aktualisieren' : 'Refresh'}
                    </button>
                  </div>
                )}
                {rcOverviewLoading ? (
                  <p className="text-sm text-stone-500 py-4">{t.loading}</p>
                ) : selectedRcName ? (
                  <div>
                    <button
                      onClick={() => setSelectedRcName(null)}
                      className="flex items-center gap-1.5 text-sm text-stone-600 hover:text-stone-900 mb-4"
                    >
                      <ArrowLeft size={16} />
                      {t.rcBackToOverview}
                    </button>
                    <h3 className="text-base font-semibold text-stone-800 mb-4">{selectedRcName}</h3>
                    {rcCoachSummaryLoading ? (
                      <p className="text-sm text-stone-500">{t.loading}</p>
                    ) : rcCoachSummaryData.length === 0 ? (
                      <p className="text-sm text-stone-500">{t.rcNoData}</p>
                    ) : (
                      <div className="space-y-4">
                        {rcCoachSummaryData.map((cs) => (
                          <div key={cs.coacheeName} className="border border-stone-200 rounded-lg overflow-hidden">
                            <div className="bg-stone-50 px-4 py-2.5 flex items-center gap-3">
                              <span className="font-semibold text-sm text-stone-800">{cs.coacheeName}</span>
                              {cs.doneFeedbacks.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                  {cs.doneFeedbacks.length} {t.rcDone.toLowerCase()}
                                </span>
                              )}
                              {cs.outstandingGames.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                                  {cs.outstandingGames.length} {t.rcOutstanding.toLowerCase()}
                                </span>
                              )}
                              {cs.plannedGames.length > 0 && (
                                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                                  {cs.plannedGames.length} {t.rcPlanned.toLowerCase()}
                                </span>
                              )}
                            </div>
                            <div className="divide-y divide-stone-100">
                              {cs.doneFeedbacks.length > 0 && (
                                <div className="px-4 py-2">
                                  <p className="text-xs font-medium text-green-700 mb-1.5">{t.rcDoneFeedbacks}</p>
                                  {cs.doneFeedbacks.map((fb, i) => {
                                    const d = new Date(fb.gameDate);
                                    const dateStr = !isNaN(d.getTime()) ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}` : fb.gameDate;
                                    return (
                                      <div key={i} className="flex items-center gap-3 text-xs text-stone-600 py-0.5">
                                        <span className="font-medium text-stone-700 w-20">{dateStr}</span>
                                        <span className="text-stone-400 w-14">{fb.league}</span>
                                        <span className="flex-1 truncate">{fb.teams}</span>
                                        <span className="text-stone-400">{fb.role}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {cs.outstandingGames.length > 0 && (
                                <div className="px-4 py-2">
                                  <p className="text-xs font-medium text-amber-700 mb-1.5">{t.rcOutstandingGames}</p>
                                  {cs.outstandingGames.map((g, i) => {
                                    const d = new Date(g.gameDate);
                                    const dateStr = !isNaN(d.getTime()) ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}` : g.gameDate;
                                    return (
                                      <div key={i} className="flex items-center gap-3 text-xs text-stone-600 py-0.5">
                                        <span className="font-medium text-stone-700 w-20">{dateStr}</span>
                                        <span className="text-stone-400 w-14">{g.league}</span>
                                        <span className="flex-1 truncate">{g.teams}</span>
                                        <span className="text-stone-500">{g.refereeName}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {cs.plannedGames.length > 0 && (
                                <div className="px-4 py-2">
                                  <p className="text-xs font-medium text-red-700 mb-1.5">{t.rcPlannedGames}</p>
                                  {cs.plannedGames.map((g, i) => {
                                    const d = new Date(g.gameDate);
                                    const dateStr = !isNaN(d.getTime()) ? `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}` : g.gameDate;
                                    const eg = eligibleGames.find((x) => x.id === g.gameId);
                                    return (
                                      <div
                                        key={i}
                                        onClick={eg ? () => handleSelectGame(eg) : undefined}
                                        className={cn('flex items-center gap-3 text-xs text-stone-600 py-0.5', eg && 'cursor-pointer hover:bg-stone-50')}
                                        title={eg ? (formData.lang === 'DE' ? 'Beobachtung starten' : 'Start observation') : undefined}
                                      >
                                        <span className="font-medium text-stone-700 w-20">{dateStr}</span>
                                        <span className="text-stone-400 w-14">{g.league}</span>
                                        <span className="flex-1 truncate">{g.teams}</span>
                                        <span className="text-stone-500">{g.refereeName}</span>
                                        {eg && <Eye size={12} className="text-stone-400 shrink-0" />}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {cs.doneFeedbacks.length === 0 && cs.outstandingGames.length === 0 && cs.plannedGames.length === 0 && (
                                <div className="px-4 py-2 text-xs text-stone-400">{t.rcNoFeedbacks}</div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : rcOverviewData.length === 0 ? (
                  <p className="text-sm text-stone-500 py-4">{t.rcNoData}</p>
                ) : (
                  <div className="border border-stone-200 rounded divide-y divide-stone-200">
                    {rcOverviewData.map((rc) => (
                      <div
                        key={rc.id}
                        onClick={() => void handleSelectRc(rc.fullName)}
                        className="px-4 py-3 hover:bg-stone-50 cursor-pointer transition-colors"
                      >
                        <div className="font-medium text-sm text-stone-800">{rc.fullName}</div>
                        <div className="mt-1.5 flex items-center gap-2">
                          <span className="inline-flex items-center justify-center text-xs px-2.5 py-0.5 rounded-full bg-green-100 text-green-700" title={t.rcDone}>
                            {rc.done} {formData.lang === 'DE' ? 'erledigt' : 'done'}
                          </span>
                          <span className="inline-flex items-center justify-center text-xs px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700" title={t.rcOutstanding}>
                            {rc.outstanding} {formData.lang === 'DE' ? 'offen' : 'open'}
                          </span>
                          <span className="inline-flex items-center justify-center text-xs px-2.5 py-0.5 rounded-full bg-red-100 text-red-700" title={t.rcPlanned}>
                            {rc.planned} {formData.lang === 'DE' ? 'geplant' : 'planned'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {backendNotice && (
              <p className="text-sm mt-3 text-red-700">{backendNotice}</p>
            )}
          </div>

          <div className="bg-white p-4 rounded-2xl shadow-card border border-stone-200/70 mt-4 no-print">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400 mb-2">{formData.lang === 'DE' ? 'Nützliche Infos & Dokumente' : 'Useful info & documents'}</h3>
            <div className="flex flex-col gap-1.5">
              <a href="https://www.svrz.ch/_Resources/Persistent/8/6/d/d/86dd9a07156e7501b5e74ec3e0eeeab30975bcbd/Uebersicht%20SR-Niveau%20und%20Stufe.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Download size={14} /> {formData.lang === 'DE' ? 'SR-Niveau und Stufe (PDF)' : 'SR levels & stages (PDF)'}</a>
              <a href="https://www.svrz.ch/ausbildung/schiedsrichter-in/informationen" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:text-red-800 hover:underline w-fit"><Info size={14} /> {formData.lang === 'DE' ? 'SR-Informationen (svrz.ch)' : 'Referee info (svrz.ch)'}</a>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'coacheeGames' && (
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
              <p className="text-sm text-stone-500 p-4">{t.loading}</p>
            ) : coacheeGames.length === 0 ? (
              <p className="text-sm text-stone-500 p-4">{t.noCoacheeGames}</p>
            ) : (() => {
              const now = new Date();
              const viewCoachee = coachees.find((c) => c.id === selectedCoacheeId);
              const lvlKey = levelKey(viewCoachee?.referee_level, viewCoachee?.stage);
              const target = viewCoachee ? coacheeTargets[viewCoachee.id] : undefined;
              const matchesTarget = (g: CoacheeGame): boolean => {
                if (showAllLevels) return true;
                const roles: TargetRole[] = [];
                if (g.assignedRoles.includes('1. SR')) roles.push('1SR');
                if (g.assignedRoles.includes('2. SR')) roles.push('2SR');
                if (roles.length === 0) return true; // not an SR role (e.g. line judge) → keep
                if (!isTargetActive(target, lvlKey)) return true;
                return roles.some((role) => keepGame({ league: g.league || '', role, target, levelKey: lvlKey }));
              };
              const visibleGames = coacheeGames.filter(matchesTarget);
              const hiddenByTarget = coacheeGames.length - visibleGames.length;
              const upcomingGames = visibleGames.filter((game) => new Date(game.date) >= now);
              const allPastGames = visibleGames.filter((game) => new Date(game.date) < now);
              const feedbackByGameId = new Set(coacheeFeedbacks.map((f) => f.game).filter(Boolean));
              const pastGames = showAllPastGames ? allPastGames : allPastGames.filter((game) => feedbackByGameId.has(game.id));
              return (
                <div>
                  {(hiddenByTarget > 0 || (showAllLevels && isTargetActive(target, lvlKey))) && (
                    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800">
                      <span>
                        {showAllLevels
                          ? (formData.lang === 'DE' ? 'Alle Spiele werden angezeigt (Niveau-Filter aus).' : 'Showing all games (level filter off).')
                          : (formData.lang === 'DE'
                            ? `${hiddenByTarget} Spiel(e) ausserhalb des Niveaus ausgeblendet.`
                            : `${hiddenByTarget} game(s) outside the level hidden.`)}
                      </span>
                      <button
                        onClick={() => setShowAllLevels((v) => !v)}
                        className="shrink-0 normal-case font-medium px-2 py-0.5 border rounded border-emerald-300 hover:bg-emerald-100"
                      >
                        {showAllLevels
                          ? (formData.lang === 'DE' ? 'Nur passende' : 'Matching only')
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
                        const d = new Date(game.date);
                        const formatted = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                        return (
                          <button
                            key={game.id}
                            onClick={() => handleSelectGame(game)}
                            className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                          >
                            <div className="font-semibold text-stone-900 text-sm">
                              {game.matchNo} - {game.homeTeam} vs {game.awayTeam}
                            </div>
                            <div className="text-xs text-stone-500 mt-1">
                              {formatted} | {game.league} | {t.rolesLabel}: {game.assignedRoles.join(', ') || '-'}
                            </div>
                          </button>
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
                            const d = new Date(game.date);
                            const formatted = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                            const hasFeedback = feedbackByGameId.has(game.id);
                            return (
                              <button
                                key={game.id}
                                onClick={() => handleSelectGame(game)}
                                className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="font-semibold text-stone-900 text-sm">
                                    {game.matchNo} - {game.homeTeam} vs {game.awayTeam}
                                  </div>
                                  <span className={cn("text-xs px-2 py-0.5 rounded-full", hasFeedback ? "bg-emerald-100 text-emerald-700" : "bg-stone-100 text-stone-500")}>
                                    {hasFeedback ? (formData.lang === 'DE' ? 'Feedback' : 'Feedback') : (formData.lang === 'DE' ? 'Kein Feedback' : 'No feedback')}
                                  </span>
                                </div>
                                <div className="text-xs text-stone-500 mt-1">
                                  {formatted} | {game.league} | {t.rolesLabel}: {game.assignedRoles.join(', ') || '-'}
                                </div>
                              </button>
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

      {viewMode === 'feedback' && feedbackSubView === 'calendar' && (
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
            {sortedCalendarDays.length === 0 ? (
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

      {viewMode === 'feedback' && feedbackSubView === 'feedbackForm' && (
      <>
      {/* Main Form Container */}
      <div ref={printableRef} className="max-w-4xl mx-auto bg-white p-4 md:p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0 print:max-w-none print:mx-0">
        
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

        {/* Meta Data Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[1fr_1fr_1fr_2fr] print:grid-cols-[1fr_1fr_1fr_2fr] border-t border-l border-stone-900 mb-4">
          <MetaField label={t.matchNo} value={formData.meta.spielNr} onChange={v => updateMeta('spielNr', v)} />
          <MetaField label={t.league} value={formData.meta.liga} onChange={v => updateMeta('liga', v)} />
          <MetaField label={t.date} value={formData.meta.datum} onChange={v => updateMeta('datum', v)} />
          <MetaField label={t.location} value={formData.meta.ort} onChange={v => updateMeta('ort', v)} />
          
          <MetaField label={t.teams} value={formData.meta.mannschaften} onChange={v => updateMeta('mannschaften', v)} className="col-span-2 md:col-span-4 print:col-span-4" />

          <MetaField label={formData.role} value={formData.meta.srName} onChange={v => updateMeta('srName', v)} className="col-span-2" />
          <MetaField label={t.refLevel} value={formData.meta.srNiveau} onChange={v => updateMeta('srNiveau', v)} />
          <MetaField label={t.group} value={formData.meta.gruppe} onChange={v => updateMeta('gruppe', v)} />

          <MetaField label={t.rc} value={formData.meta.rc} onChange={v => updateMeta('rc', v)} className="col-span-2" />
          <ResultField label={t.result} value={formData.meta.ergebnis} onChange={v => updateMeta('ergebnis', v)} className="col-span-2" readOnly={!!selectedGame?.game_result} lang={formData.lang} />
        </div>

        {/* Legend */}
        <div className="mb-6 p-2 bg-stone-50 border border-stone-200 rounded flex items-center gap-2 text-[10px] text-stone-600 italic">
          <Info size={14} className="text-red-500 shrink-0" />
          {LEGEND[formData.lang]}
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
                  className={cn("h-8 px-2.5 border rounded text-xs font-bold transition-all", formData.results.spielniveau === v ? "bg-red-600 text-white border-red-600" : "bg-white border-stone-300 hover:bg-stone-100")}>
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
                    formData.results.motivation === v ? "bg-red-600 text-white border-red-600 font-bold" : "bg-white hover:bg-stone-100"
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
                    formData.results.einstufung === v ? "bg-red-600 text-white border-red-600 font-bold" : "bg-white hover:bg-stone-100"
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
                    formData.results.secondBesuch === v ? "bg-red-600 text-white border-red-600 font-bold" : "bg-white hover:bg-stone-100"
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
          <textarea
            className="w-full min-h-[3.5rem] text-xs leading-relaxed resize-y outline-none bg-white placeholder:text-stone-300 border border-stone-200 rounded p-2"
            placeholder={t.remarksPlaceholder}
            value={formData.results.bemerkungen}
            onChange={e => setFormData(prev => ({ ...prev, results: { ...prev.results, bemerkungen: e.target.value } }))}
          />
          {(([['highlights', t.highlights], ['improvements', t.improvements], ['goals', t.goalsNext]]) as ['highlights' | 'improvements' | 'goals', string][]).map(([key, label]) => (
            <div key={key}>
              <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{label}</h4>
              <textarea
                className="w-full min-h-[2.75rem] text-xs leading-relaxed resize-y outline-none bg-white placeholder:text-stone-300 border border-stone-200 rounded p-2"
                value={formData.results[key] || ''}
                onChange={e => setFormData(prev => ({ ...prev, results: { ...prev.results, [key]: e.target.value } }))}
              />
            </div>
          ))}
        </div>

        {/* Signature */}
        <div className="border-x border-b border-stone-900 p-4 flex items-end gap-4">
          <div className="flex-1 min-w-0">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-2">{formData.lang === 'DE' ? 'Unterschrift Schiedsrichter' : 'Referee signature'}</h4>
            {formData.signature ? (
              <img src={formData.signature} alt="Signature" className="h-20 max-w-full object-contain" />
            ) : (
              <div className="h-14 border-b border-stone-400" />
            )}
          </div>
          <div className="no-print flex flex-col gap-1.5 shrink-0">
            <button type="button" onClick={openSignatureModal} className="h-9 px-3 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700">{formData.lang === 'DE' ? 'Unterschrift einholen' : 'Capture signature'}</button>
            {formData.signature && <button type="button" onClick={() => updateSignature('')} className="h-8 px-3 rounded-lg border border-stone-200 text-xs text-stone-500 hover:bg-stone-100">{formData.lang === 'DE' ? 'Entfernen' : 'Remove'}</button>}
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-stone-100 text-[9px] text-right text-stone-400 italic">
          {t.version}: {t.versionDate} | Build {BUILD_INFO} | SVRZ Referee Coaching Tool
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

      {(feedbackLocked || isGameRoleClosed) && (
        <div className="max-w-4xl mx-auto mt-4 no-print">
          <div className="bg-stone-100 border border-stone-300 rounded-lg px-4 py-3 text-sm text-stone-600 font-medium">
            {isGameRoleClosed ? t.gameClosed : t.feedbackLocked}
          </div>
        </div>
      )}

      {/* Save to database */}
      {!feedbackLocked && !isGameRoleClosed && (
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
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
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
                {formData.lang === 'DE' ? 'Alle Bewertungen und Bemerkungen werden zurückgesetzt. Spieldaten bleiben erhalten.' : 'All ratings and remarks will be reset. Game data will be kept.'}
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
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-bold text-stone-900">{formData.lang === 'DE' ? 'Unterschrift' : 'Signature'}</h3>
              <button onClick={() => setSigModalOpen(false)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>
            {sigError ? (
              <p className="text-sm text-red-600 py-6 text-center">{sigError}</p>
            ) : !sigSlug ? (
              <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>
            ) : (
              <>
                <p className="text-[11px] text-stone-400 mb-1.5">{formData.lang === 'DE' ? 'Hier unterschreiben:' : 'Sign here:'}</p>
                <div className="rounded-lg border-2 border-dashed border-stone-300 bg-stone-50/50 h-36 overflow-hidden"><SignaturePad ref={sigPadRef} /></div>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => sigPadRef.current?.clear()} className="h-9 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100">{formData.lang === 'DE' ? 'Löschen' : 'Clear'}</button>
                  <button onClick={saveSignatureHere} className="flex-1 h-9 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700">{formData.lang === 'DE' ? 'Unterschrift speichern' : 'Save signature'}</button>
                </div>
                <div className="flex items-center gap-2 my-3"><div className="flex-1 h-px bg-stone-200" /><span className="text-[10px] uppercase text-stone-400 font-semibold">{formData.lang === 'DE' ? 'oder' : 'or'}</span><div className="flex-1 h-px bg-stone-200" /></div>
                <div className="flex flex-col items-center gap-2">
                  <div className="p-2 bg-white border border-stone-200 rounded-lg"><QRCodeSVG value={`${window.location.origin}${window.location.pathname}#/sign/${sigSlug}`} size={116} level="M" /></div>
                  <p className="text-[11px] text-stone-500 text-center">{formData.lang === 'DE' ? 'Mit dem Handy scannen und dort unterschreiben.' : 'Scan with a phone and sign there.'}</p>
                  <p className="text-[11px] text-amber-600 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {formData.lang === 'DE' ? 'Warte auf Unterschrift…' : 'Waiting for signature…'}</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showInfoModal && (
        <div onClick={() => setShowInfoModal(false)} className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-base font-bold text-stone-900">{formData.lang === 'DE' ? 'Infos & Dokumente' : 'Info & documents'}</h3>
              <button onClick={() => setShowInfoModal(false)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>
            <div className="flex flex-col gap-2.5">
              <a href="https://www.svrz.ch/_Resources/Persistent/8/6/d/d/86dd9a07156e7501b5e74ec3e0eeeab30975bcbd/Uebersicht%20SR-Niveau%20und%20Stufe.pdf" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Download size={15} /> {formData.lang === 'DE' ? 'SR-Niveau und Stufe (PDF)' : 'SR levels & stages (PDF)'}</a>
              <a href="https://www.svrz.ch/ausbildung/schiedsrichter-in/informationen" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-red-700 hover:underline"><Info size={15} /> {formData.lang === 'DE' ? 'SR-Informationen (svrz.ch)' : 'Referee info (svrz.ch)'}</a>
            </div>
          </div>
        </div>
      )}

      {showEmptyFormModal && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs p-6">
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

      {/* Hidden empty form renderers for PDF capture (always DE) */}
      <div className="fixed left-[-9999px] top-0">
        <EmptyFormPage ref={emptyForm1SRRef} role="1. SR" lang="DE" />
        <EmptyFormPage ref={emptyForm2SRRef} role="2. SR" lang="DE" />
      </div>

      {/* JSON Modal */}
      {viewMode === 'feedback' && showJson && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
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
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(formData, null, 2));
                  alert(t.copied);
                }}
                className="bg-red-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-200"
              >
                {t.copy}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'feedback' && detailCoachee && (
        <div onClick={() => setDetailCoachee(null)} className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-40 no-print">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 max-h-[85vh] overflow-auto">
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-base font-bold text-stone-900">{t.coacheeDetails}</h3>
              <button onClick={() => setDetailCoachee(null)} aria-label="Close" className="text-stone-400 hover:text-stone-600 text-2xl leading-none -mt-1 -mr-1 px-1">&times;</button>
            </div>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex justify-between">
                <span className="text-stone-500">{formData.lang === 'DE' ? 'Name' : 'Name'}</span>
                <span className="font-medium text-stone-900">{detailCoachee.full_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500">{t.level}</span>
                <span className="font-medium text-stone-900"><LevelText level={detailCoachee.referee_level} stage={detailCoachee.stage} /></span>
              </div>
              {detailCoachee.groups && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.group}</span>
                  <span className="font-medium text-stone-900">{normalizeCoacheeGroup(detailCoachee.groups)}</span>
                </div>
              )}
              {detailCoachee.phone && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.phone}</span>
                  <a href={`tel:${detailCoachee.phone}`} className="font-medium text-red-600 hover:underline">{detailCoachee.phone}</a>
                </div>
              )}
              {detailCoachee.email && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.emailLabel}</span>
                  <a href={`mailto:${detailCoachee.email}`} className="font-medium text-red-600 hover:underline">{detailCoachee.email}</a>
                </div>
              )}
            </div>

            <div className="mb-4">
              <label className="block text-sm font-semibold text-stone-700 mb-1">{t.notes}</label>
              <textarea
                value={detailNotes}
                onChange={(e) => setDetailNotes(e.target.value)}
                placeholder={t.notesPlaceholder}
                rows={4}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-y"
              />
              <button
                onClick={() => void handleSaveNotes()}
                disabled={savingNotes}
                className="mt-2 h-9 px-4 rounded bg-red-600 text-white hover:bg-red-700 text-sm disabled:opacity-50"
              >
                {savingNotes ? t.loading : t.saveNotes}
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  onClick={() => handleCoacheeAction(detailCoachee)}
                  className="flex-1 h-10 rounded bg-red-600 text-white hover:bg-red-700 text-sm"
                >
                  {t.openGames} / {t.openFeedback}
                </button>
                <button
                  onClick={() => setDetailCoachee(null)}
                  className="flex-1 h-10 rounded border border-stone-300 hover:bg-stone-50 text-sm"
                >
                  {t.closeMenu}
                </button>
              </div>
              <button
                onClick={() => { setManualUploadCoachee(detailCoachee); setDetailCoachee(null); }}
                className="h-10 w-full rounded border border-stone-300 hover:bg-stone-50 text-sm flex items-center justify-center gap-2 text-stone-600"
              >
                <Upload size={14} />
                {t.manualUpload}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'feedback' && actionTargetCoachee && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-40 no-print">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-4">
            <h3 className="text-sm font-semibold text-stone-900 mb-3">
              {t.chooseAction}: {actionTargetCoachee.full_name}
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  void loadCoacheeGames(actionTargetCoachee);
                  setActionTargetCoachee(null);
                }}
                className="flex-1 h-10 rounded border border-stone-300 hover:bg-stone-50 text-sm"
              >
                {t.openGames}
              </button>
              <button
                onClick={() => void openFeedbackPicker(actionTargetCoachee)}
                className="flex-1 h-10 rounded bg-red-600 text-white hover:bg-red-700 text-sm"
              >
                {loadingCoacheeFeedbacks ? t.loading : t.openFeedback}
              </button>
            </div>
            <button
              onClick={() => setActionTargetCoachee(null)}
              className="mt-3 w-full h-9 rounded border border-stone-300 hover:bg-stone-50 text-xs"
            >
              {t.closeMenu}
            </button>
          </div>
        </div>
      )}

      {viewMode === 'feedback' && feedbackPickerCoachee && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-4 max-h-[80vh] flex flex-col">
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
          notice={manualUploadNotice}
          submitting={manualUploadSubmitting}
          onSubmit={handleManualUploadSubmit}
          onClose={() => { setManualUploadCoachee(null); setManualUploadNotice(''); }}
        />
      )}
      <p className="mx-auto max-w-5xl mt-6 pb-2 text-center text-[10px] text-stone-400 no-print">
        Build {BUILD_INFO}
      </p>
    </div>
  );
}

/* ── Manual Upload Modal ── */
function ManualUploadModal({ coachee, coachees, rcPeople, notice, submitting, onSubmit, onClose }: {
  coachee: Coachee;
  coachees: Coachee[];
  rcPeople: RefereeCoachPerson[];
  notice: string;
  submitting: boolean;
  onSubmit: (form: HTMLFormElement) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<'1. SR' | '2. SR'>('1. SR');
  const [selectedGroups, setSelectedGroups] = useState<string[]>(
    () => (coachee.groups || '').split(',').map(g => g.trim()).filter(Boolean)
  );
  const [usePlusMinus, setUsePlusMinus] = useState(false);

  // Derive unique groups from all coachees
  const allGroups = useMemo(() => {
    const set = new Set<string>();
    coachees.forEach(c => {
      (normalizeCoacheeGroup(c.groups) || '').split(',').map(g => g.trim()).filter(Boolean).forEach(g => set.add(g));
    });
    return Array.from(set).sort();
  }, [coachees]);

  // Derive unique levels from all coachees (level - stage format)
  const allLevels = useMemo(() => {
    const set = new Set<string>();
    coachees.forEach(c => set.add(levelDisplay(c.referee_level, c.stage, ' - ').text));
    return Array.from(set).sort();
  }, [coachees]);

  const defaultLevel = levelDisplay(coachee.referee_level, coachee.stage, ' - ').text;

  const sections = role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE;

  const ratingOptions = usePlusMinus
    ? ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','E+','E','E-']
    : RATINGS;

  const toggleGroup = (g: string) => {
    setSelectedGroups(prev => prev.includes(g) ? prev.filter(x => x !== g) : [...prev, g]);
  };

  return (
    <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-4 border-b border-stone-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-900">
            Manuelle Beobachtung: {coachee.full_name}
          </h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-600 text-lg leading-none">&times;</button>
        </div>
        <form
          className="overflow-auto p-4 space-y-4 text-sm"
          onSubmit={(e) => { e.preventDefault(); void onSubmit(e.currentTarget); }}
        >
          {/* Hidden field for gruppe (populated from checkboxes) */}
          <input type="hidden" name="gruppe" value={selectedGroups.join(', ')} />

          {/* Rolle + Spiel-Nr. */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Rolle</span>
              <select name="role" value={role} onChange={e => setRole(e.target.value as '1. SR' | '2. SR')} className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="1. SR">1. SR</option>
                <option value="2. SR">2. SR</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Spiel-Nr.</span>
              <input name="spielNr" type="number" className="h-9 rounded border border-stone-300 px-2 text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
            </label>
          </div>

          {/* Liga + Datum */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Liga</span>
              <input name="liga" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Datum</span>
              <input name="datum" type="date" defaultValue={new Date().toISOString().split('T')[0]} className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* Ort + Mannschaften */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Ort</span>
              <input name="ort" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Mannschaften</span>
              <input name="mannschaften" type="text" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* Ergebnis: Sätze + Punkte */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Ergebnis (Sätze)</span>
              <input name="ergebnisSets" type="text" placeholder="3:1" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Ergebnis (Punkte)</span>
              <input name="ergebnisPoints" type="text" placeholder="25:20, 22:25, 25:18, 25:23" className="h-9 rounded border border-stone-300 px-2 text-sm" />
            </label>
          </div>

          {/* SR-Name + SR-Niveau */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">SR-Name</span>
              <select name="srName" defaultValue={coachee.full_name} className="h-9 rounded border border-stone-300 px-2 text-sm">
                {coachees.map(c => <option key={c.id} value={c.full_name}>{c.full_name}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">SR-Niveau</span>
              <select name="srNiveau" defaultValue={defaultLevel} className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="">—</option>
                {allLevels.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>

          {/* Referee Coach + Gruppe */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Referee Coach</span>
              <select name="rc" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="">—</option>
                {rcPeople.map(p => <option key={p.id} value={p.fullName}>{p.fullName}</option>)}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Gruppe</span>
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
              +/- Noten
            </button>
            <span className="text-xs text-stone-400">{usePlusMinus ? 'A+ bis E- verfügbar' : 'A bis E'}</span>
          </div>

          {/* Assessment sections */}
          {sections.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-bold text-stone-700 mb-1">{section.title}</p>
              <div className="space-y-1">
                {section.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <select
                      name={`rating-${item.id}`}
                      defaultValue=""
                      className="w-14 h-7 rounded border border-stone-300 px-1 text-xs text-center"
                    >
                      <option value="" disabled>—</option>
                      {ratingOptions.map(r => <option key={r} value={r}>{r}</option>)}
                      {NA_ELIGIBLE_IDS.has(item.id) && <option value="N/A">N/A</option>}
                    </select>
                    <span className="text-xs text-stone-700">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Bottom fields */}
          <div className="grid grid-cols-3 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Spielniveau</span>
              <select name="spielniveau" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="leicht">Leicht</option>
                <option value="normal">Normal</option>
                <option value="schwierig">Schwierig</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Motivation</span>
              <select name="motivation" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="up">↑</option>
                <option value="check">✓</option>
                <option value="down">↓</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">Ausblick</span>
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
              <span className="text-xs font-semibold text-stone-500 uppercase">2. Besuch</span>
              <select name="secondBesuch" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                <option value="Y">Ja</option>
                <option value="N">Nein</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-stone-500 uppercase">SR-Ziel</span>
              <select name="srZiel" defaultValue="" className="h-9 rounded border border-stone-300 px-2 text-sm">
                <option value="" disabled>—</option>
                {SR_ZIEL_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
          </div>

          {/* Bemerkungen */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">Bemerkungen</span>
            <textarea name="bemerkungen" rows={3} className="rounded border border-stone-300 px-2 py-1 text-sm resize-y" />
          </label>

          {/* Formular-Datei */}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-stone-500 uppercase">Formular-Datei (PDF/Bild)</span>
            <input name="formFile" type="file" accept=".pdf,image/*" className="text-sm" />
          </label>

          {/* Notice */}
          {notice && (
            <p className={cn("text-sm font-medium", notice.includes('gespeichert') ? "text-green-600" : "text-red-600")}>
              {notice}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 text-sm font-medium flex items-center justify-center gap-2"
          >
            {submitting ? 'Lädt...' : <><Send size={14} /> Hochladen und senden</>}
          </button>
        </form>
      </div>
    </div>
  );
}

const EmptyFormPage = React.forwardRef<HTMLDivElement, { role: '1. SR' | '2. SR'; lang: 'DE' | 'EN' }>(({ role, lang }, ref) => {
  const t = UI_STRINGS[lang];
  const sections = role === '1. SR'
    ? (lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN)
    : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
  return (
    <div ref={ref} className="bg-white flex flex-col" style={{ width: 794, minHeight: 1128, padding: '10px 14px' }}>
      {/* Header */}
      <div className="flex justify-between items-start gap-3 mb-4">
        <div className="flex gap-3 items-start">
          <SvrzLogo className="h-12" />
          <div>
            <p className="text-[8px] text-stone-500 uppercase tracking-wider font-semibold">SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch</p>
            <h1 className="text-xl font-bold mt-0.5 text-stone-900 flex items-center gap-2">
              {t.title}
              <span className="bg-stone-900 text-white px-2 py-0.5 rounded text-sm whitespace-nowrap shrink-0">{role}</span>
            </h1>
          </div>
        </div>
      </div>
      {/* Meta grid */}
      <div className="grid grid-cols-[1fr_1fr_1fr_2fr] border-t border-l border-stone-900 mb-3">
        {([[t.matchNo, 'matchNo'], [t.league, 'league'], [t.date, 'date'], [t.location, 'location']] as [string, string][]).map(([label, fn], i) => (
          <div key={i} className="border-r border-b border-stone-900 p-1 flex flex-col min-h-[36px]">
            <span className="block text-[7px] uppercase font-black text-stone-400 leading-none mb-0.5">{label}</span>
            <div data-pdf-field={fn} data-pdf-type="text" className="flex-1 min-h-[18px]" />
          </div>
        ))}
        <div className="col-span-4 border-r border-b border-stone-900 p-1 flex flex-col min-h-[36px]">
          <span className="block text-[7px] uppercase font-black text-stone-400 leading-none mb-0.5">{t.teams}</span>
          <div data-pdf-field="teams" data-pdf-type="text" className="flex-1 min-h-[18px]" />
        </div>
        {([[role, 'srRole'], [t.refLevel, 'refLevel'], [t.group, 'group'], [t.rc, 'rc']] as [string, string][]).map(([label, fn], i) => (
          <div key={i} className="border-r border-b border-stone-900 p-1 flex flex-col min-h-[36px]">
            <span className="block text-[7px] uppercase font-black text-stone-400 leading-none mb-0.5">{label}</span>
            <div data-pdf-field={fn} data-pdf-type="text" className="flex-1 min-h-[18px]" />
          </div>
        ))}
        <div className="col-span-4 border-r border-b border-stone-900 p-1 flex flex-col min-h-[36px]">
          <span className="block text-[7px] uppercase font-black text-stone-400 leading-none mb-0.5">{t.result}</span>
          <div data-pdf-field="result" data-pdf-type="text" className="flex-1 min-h-[18px]" />
        </div>
      </div>
      {/* Legend */}
      <div className="mb-3 p-1.5 bg-stone-50 border border-stone-200 rounded flex items-center gap-1.5 text-[8px] text-stone-600 italic">
        <Info size={10} className="text-red-500 shrink-0" />
        {LEGEND[lang]}
      </div>
      {/* Assessment sections */}
      <div className="space-y-3">
        {sections.map((section) => (
          <div key={section.title}>
            <div className="bg-stone-100 border-x border-t border-stone-900 px-2 py-1 font-bold text-[9px] uppercase tracking-wider text-stone-700 flex items-center gap-1.5">
              <ClipboardCheck size={10} />
              {section.title}
            </div>
            <table className="w-full border-collapse border border-stone-900">
              <thead>
                <tr className="bg-stone-50 text-[8px] uppercase font-bold text-stone-500">
                  <th className="p-1.5 text-left border-b border-stone-900">{t.criteria}</th>
                  {RATINGS.map(r => (
                    <th key={r} className={cn("w-8 border-l border-b border-stone-900 text-center", r === 'C' && "bg-stone-200")}>{r}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.items.map((item) => (
                  <tr key={item.id}>
                    <td className="p-1.5 text-[10px] border-b border-stone-900 leading-tight">{item.label}</td>
                    {RATINGS.map(r => (
                      <td key={r} className={cn("w-8 border-l border-b border-stone-900 text-center", r === 'C' && "bg-stone-200/50")} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      {/* Results row */}
      <div className="mt-4 border border-stone-900 bg-stone-50 grid grid-cols-5">
        {[
          { label: t.matchLevel, content: <div data-pdf-field="matchLevel" data-pdf-type="text" className="h-5" /> },
          { label: t.motivation, content: <div className="flex gap-1">{['↑', '✓', '↓'].map(v => <div key={v} className="w-6 h-6 border border-stone-300 rounded flex items-center justify-center text-sm font-bold text-stone-300">{v}</div>)}</div> },
          { label: t.rating, content: <div className="flex gap-1">{['↑', '✓', '↓'].map(v => <div key={v} className="w-6 h-6 border border-stone-300 rounded flex items-center justify-center text-sm font-bold text-stone-300">{v}</div>)}</div> },
          { label: t.secondVisit, content: <div className="flex gap-1">{['Y', 'N'].map(v => <div key={v} className="w-6 h-6 border border-stone-300 rounded flex items-center justify-center text-[9px] font-bold text-stone-300">{v}</div>)}</div> },
          { label: t.refGoal, content: <div data-pdf-field="refGoal" data-pdf-type="text" className="h-5" /> },
        ].map((cell, i) => (
          <div key={i} className={cn("p-2", i > 0 && "border-l border-stone-900")}>
            <h4 className="text-[8px] font-bold uppercase text-stone-500 mb-0.5">{cell.label}</h4>
            {cell.content}
          </div>
        ))}
      </div>
      {/* Remarks + Signatures + QR */}
      <div className="border-x border-b border-stone-900 grid grid-cols-[1fr_auto] flex-1">
        {/* Remarks (left) */}
        <div className="p-3 border-r border-stone-900 flex flex-col gap-2">
          <h3 className="font-bold border-b border-stone-900 pb-1 flex items-center gap-1.5 text-stone-800 text-sm">
            <MessageSquare size={14} />
            {t.remarks}
          </h3>
          <div data-pdf-field="remarks" data-pdf-type="text" data-pdf-multiline="1" className="min-h-[40px] border-b border-stone-200" />
          <div>
            <p className="text-[8px] font-black uppercase text-stone-400 mb-0.5">{t.highlights}</p>
            <div data-pdf-field="highlights" data-pdf-type="text" data-pdf-multiline="1" className="min-h-[28px] border-b border-stone-200" />
          </div>
          <div>
            <p className="text-[8px] font-black uppercase text-stone-400 mb-0.5">{t.improvements}</p>
            <div data-pdf-field="improvements" data-pdf-type="text" data-pdf-multiline="1" className="min-h-[28px] border-b border-stone-200" />
          </div>
          <div>
            <p className="text-[8px] font-black uppercase text-stone-400 mb-0.5">{t.goalsNext}</p>
            <div data-pdf-field="goals" data-pdf-type="text" data-pdf-multiline="1" className="min-h-[28px] border-b border-stone-200" />
          </div>
        </div>
        {/* Signatures + QR (right) */}
        <div className="p-3 flex flex-col justify-between" style={{ width: 200 }}>
          <div className="space-y-4">
            <div>
              <p className="text-[8px] font-bold uppercase text-stone-500 mb-6">Unterschrift Schiedsrichter</p>
              <div className="border-b border-stone-400" />
            </div>
            <div>
              <p className="text-[8px] font-bold uppercase text-stone-500 mb-6">Unterschrift Referee Coach</p>
              <div className="border-b border-stone-400" />
            </div>
          </div>
          <div className="flex items-end gap-2 mt-3">
            <QRCodeSVG
              value="https://docs.google.com/forms/d/e/1FAIpQLSe-UY2EknI02mkGwoPlFso9pcigGV5ceSt2Q3CKJaT6PQzzpA/viewform?usp=sf_link"
              size={48}
              level="L"
            />
            <p className="text-[7px] text-stone-400 leading-tight">Feedback-<br/>Umfrage</p>
          </div>
        </div>
      </div>
      <div className="mt-2 pt-1 border-t border-stone-100 text-[7px] text-right text-stone-400 italic">
        {t.version}: {t.versionDate} | Build {BUILD_INFO} | SVRZ Referee Coaching Tool
      </div>
    </div>
  );
});

function MetaField({ label, value, onChange, type = "text", className = "", readOnly = false }: { label: string, value: string, onChange: (v: string) => void, type?: string, className?: string, readOnly?: boolean }) {
  return (
    <div className={cn("border-r border-b border-stone-900 p-1.5 flex flex-col min-h-[48px]", className)}>
      <label className="block text-[8px] uppercase font-black text-stone-400 leading-none mb-1">{label}</label>
      <input
        type={type}
        className={cn("outline-none text-xs font-medium bg-transparent w-full", readOnly && "text-stone-500")}
        value={value}
        onChange={e => onChange(e.target.value)}
        readOnly={readOnly}
      />
    </div>
  );
}

function ResultField({ label, value, onChange, readOnly = false, lang, className = "" }: { label: string; value: string; onChange: (v: string) => void; readOnly?: boolean; lang: 'DE' | 'EN'; className?: string }) {
  const segs = (value || '').split('|');
  const sp = (segs[0] || '').split(/[:\-]/);
  const home = (sp[0] || '').replace(/\D/g, '').slice(0, 1);
  const away = (sp[1] || '').replace(/\D/g, '').slice(0, 1);
  const both = home !== '' && away !== '';
  const valid = (home === '3' && ['0', '1', '2'].includes(away)) || (away === '3' && ['0', '1', '2'].includes(home));
  const bad = both && !valid;
  const n = both ? Math.min(5, Number(home) + Number(away)) : 0;
  const existing = (segs[1] || '').trim() ? segs[1].split(',').map(x => x.trim()) : [];
  const sets = Array.from({ length: n }, (_, i) => {
    const p = (existing[i] || '').split(/[:\-]/);
    return { h: (p[0] || '').replace(/\D/g, '').slice(0, 2), a: (p[1] || '').replace(/\D/g, '').slice(0, 2) };
  });
  const build = (h: string, a: string, arr: { h: string; a: string }[]) => {
    const ss = (h || a) ? `${h}:${a}` : '';
    const ps = arr.map(s => (s.h || s.a) ? `${s.h}:${s.a}` : '').filter(Boolean).join(', ');
    onChange([ss, ps].filter(Boolean).join(' | '));
  };
  const c1 = (v: string) => v.replace(/[^0-3]/g, '').slice(0, 1);
  const c2 = (v: string) => v.replace(/\D/g, '').slice(0, 2);
  const setScore = (h: string, a: string) => {
    const nn = (h && a) ? Math.min(5, Number(h) + Number(a)) : 0;
    build(h, a, Array.from({ length: nn }, (_, i) => sets[i] || { h: '', a: '' }));
  };
  const setPoint = (i: number, side: 'h' | 'a', v: string) => {
    build(home, away, sets.map((s, idx) => idx === i ? { ...s, [side]: c2(v) } : s));
  };
  const sbox = cn('w-7 h-7 text-center text-sm font-bold rounded border outline-none focus:ring-2 focus:ring-red-500', bad ? 'border-red-500 bg-red-50 text-red-700' : 'border-stone-400');
  const pbox = 'w-7 h-6 text-center text-[11px] font-medium rounded border border-stone-300 outline-none focus:ring-2 focus:ring-red-500';
  const ROMAN = ['I', 'II', 'III', 'IV', 'V'];
  return (
    <div className={cn("border-r border-b border-stone-900 p-1.5 flex flex-col min-h-[48px]", className)}>
      <label className="block text-[8px] uppercase font-black text-stone-400 leading-none mb-1">{label}</label>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <input inputMode="numeric" maxLength={1} value={home} readOnly={readOnly} onChange={e => setScore(c1(e.target.value), away)} className={sbox} aria-label={lang === 'DE' ? 'Sätze Heim' : 'Home sets'} />
          <span className="text-stone-400 font-bold">:</span>
          <input inputMode="numeric" maxLength={1} value={away} readOnly={readOnly} onChange={e => setScore(home, c1(e.target.value))} className={sbox} aria-label={lang === 'DE' ? 'Sätze Gast' : 'Away sets'} />
          {bad && <span className="text-[9px] text-red-600 leading-tight ml-1 no-print">{lang === 'DE' ? 'Ein Satzstand muss 3 sein.' : 'One side must be 3.'}</span>}
        </div>
        {!bad && n > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[8px] uppercase font-semibold text-stone-400">+ {lang === 'DE' ? 'Sätze' : 'sets'}</span>
            {sets.map((s, i) => (
              <div key={i} className="flex items-center gap-0.5">
                <span className="text-[9px] font-semibold text-stone-400 mr-0.5">{ROMAN[i] ?? i + 1}</span>
                <input inputMode="numeric" maxLength={2} value={s.h} readOnly={readOnly} onChange={e => setPoint(i, 'h', e.target.value)} className={pbox} aria-label={`${lang === 'DE' ? 'Satz' : 'Set'} ${i + 1} ${lang === 'DE' ? 'Heim' : 'home'}`} />
                <span className="text-stone-300 text-[10px]">:</span>
                <input inputMode="numeric" maxLength={2} value={s.a} readOnly={readOnly} onChange={e => setPoint(i, 'a', e.target.value)} className={pbox} aria-label={`${lang === 'DE' ? 'Satz' : 'Set'} ${i + 1} ${lang === 'DE' ? 'Gast' : 'away'}`} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
