import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Download, FileJson, RefreshCw, ClipboardCheck, MessageSquare, Target, Info, Languages, Database, LogIn, LogOut, ShieldAlert, ChevronDown } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { INITIAL_DATA, FeedbackFormData, SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN, LEGEND, SR_ZIEL_OPTIONS, EligibleGame } from './types';
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
} from './lib/pocketbase';
import { cn } from './lib/utils';
import { normalizeCoacheeGroup } from './lib/coacheeGroup';
import swissVolleyLogo from './Swissvolley_logo.jpg';
import AdminPanel from './components/AdminPanel';

const RATINGS = ['A', 'B', 'C', 'D', 'E'];

const RATING_COLORS: Record<string, string> = {
  'A': 'bg-green-400 text-white',
  'B': 'bg-green-700 text-white',
  'C': 'bg-blue-600 text-white',
  'D': 'bg-yellow-400 text-stone-900',
  'E': 'bg-orange-500 text-white',
};

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
    refLevel: "SR-Niveau",
    rc: "RC (Coach)",
    group: "Gruppe",
    criteria: "Kriterien",
    matchLevel: "Spielniveau",
    motivation: "Motivation",
    rating: "Einstufung",
    secondVisit: "2. Besuch",
    remarks: "Bemerkungen",
    refGoal: "SR-Ziel",
    easy: "Leicht",
    normal: "Normal",
    difficult: "Schwierig",
    select: "Wählen...",
    remarksPlaceholder: "Hier Feedback, Beobachtungen und Verbesserungsvorschläge eingeben...",
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
    saveBackend: "In Datenbank speichern",
    saveOk: "Feedback wurde gespeichert.",
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
    refLevel: "Ref Level",
    rc: "RC (Coach)",
    group: "Group",
    criteria: "Criteria",
    matchLevel: "Match Level",
    motivation: "Motivation",
    rating: "Rating",
    secondVisit: "2nd Visit",
    remarks: "Remarks",
    refGoal: "Ref Goal",
    easy: "Easy",
    normal: "Normal",
    difficult: "Difficult",
    select: "Select...",
    remarksPlaceholder: "Enter feedback, observations and suggestions for improvement here...",
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
    saveBackend: "Save to Database",
    saveOk: "Feedback saved successfully.",
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
  }
};

type FeedbackSubView = 'coachees' | 'coacheeGames' | 'calendar' | 'feedbackForm';

function getRefereeForRole(game: EligibleGame, role: FeedbackFormData['role']) {
  return role === '1. SR' ? game.firstReferee : game.secondReferee;
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

function pdfFilename(formData: FeedbackFormData): string {
  const match = formData.meta.spielNr || 'feedback';
  const role = formData.role.replace('.', '').replace(/\s+/g, '');
  return `${match}-${role}.pdf`;
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
        className="h-9 w-full min-w-[120px] flex items-center justify-between gap-1 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-left"
      >
        <span className="truncate text-stone-700">{label}</span>
        <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-64 bg-white border border-stone-300 rounded shadow-lg p-3">
          <div className="flex gap-1.5 mb-3">
            <button
              type="button"
              onClick={() => setPreset(today, today)}
              className={cn("flex-1 h-8 text-xs rounded border", from === today && to === today ? "bg-blue-600 text-white border-blue-600" : "border-stone-300 hover:bg-stone-50")}
            >
              {isDE ? 'Heute' : 'Today'}
            </button>
            <button
              type="button"
              onClick={() => setPreset(tomorrow, tomorrow)}
              className={cn("flex-1 h-8 text-xs rounded border", from === tomorrow && to === tomorrow ? "bg-blue-600 text-white border-blue-600" : "border-stone-300 hover:bg-stone-50")}
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
                className="h-8 w-full px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              />
            </div>
            <div>
              <label className="block text-xs text-stone-500 mb-0.5">{isDE ? 'Bis' : 'To'}</label>
              <input
                type="date"
                value={to}
                onChange={(e) => onChangeTo(e.target.value)}
                className="h-8 w-full px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
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
        className="h-9 w-full flex items-center justify-between gap-1 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 text-left"
      >
        <span className="truncate text-stone-700">
          {selected.length === 0 ? placeholder : `${selected.length} ${selected.length === 1 ? 'selected' : 'selected'}`}
        </span>
        <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-48 overflow-auto bg-white border border-stone-300 rounded shadow-lg">
          {options.map((opt) => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-stone-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="h-3.5 w-3.5 rounded border-stone-300 accent-blue-600"
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
  const [listTab, setListTab] = useState<'coachees' | 'games'>('coachees');
  const [listPage, setListPage] = useState(0);
  const LIST_PAGE_SIZE = 50;
  const [listSearch, setListSearch] = useState('');
  const [listFilterLevel, setListFilterLevel] = useState('');
  const [listFilterNeedsObs, setListFilterNeedsObs] = useState(true);
  const [listFilterShowInactive, setListFilterShowInactive] = useState(false);
  const [gameFilterCoachees, setGameFilterCoachees] = useState<string[]>([]);
  const [gameFilterLeagues, setGameFilterLeagues] = useState<string[]>([]);
  const [gameFilterDateFrom, setGameFilterDateFrom] = useState('');
  const [gameFilterDateTo, setGameFilterDateTo] = useState('');
  const [formData, setFormData] = useState<FeedbackFormData>(() => ({
    ...INITIAL_DATA,
    lang: detectInitialLang(),
  }));
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
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [backendNotice, setBackendNotice] = useState('');
  const [adminAuthLoading, setAdminAuthLoading] = useState(false);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [adminAuthEmail, setAdminAuthEmail] = useState('');
  const [adminLoginEmail, setAdminLoginEmail] = useState('');
  const [adminLoginPassword, setAdminLoginPassword] = useState('');
  const [adminAuthNotice, setAdminAuthNotice] = useState('');
  const printableRef = useRef<HTMLDivElement | null>(null);

  const t = UI_STRINGS[formData.lang] || UI_STRINGS.DE;
  const selectedGame = eligibleGames.find((game) => game.id === selectedGameId) ?? null;



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
    void refreshGames();
    void refreshCoachees();
    void refreshCalendarGames();
  }, [formData.lang]);

  useEffect(() => {
    void refreshAdminAuthStatus();
  }, []);

  useEffect(() => {
    if (!selectedGame) {
      return;
    }
    const srName = getRefereeForRole(selectedGame, formData.role);
    setFormData((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        spielNr: selectedGame.matchNo || prev.meta.spielNr,
        liga: selectedGame.league || prev.meta.liga,
        datum: asInputDate(selectedGame.date) || prev.meta.datum,
        ort: selectedGame.location || prev.meta.ort,
        mannschaften: [selectedGame.homeTeam, selectedGame.awayTeam].filter(Boolean).join(' - '),
        srName: srName || prev.meta.srName,
      },
    }));
  }, [selectedGameId, formData.role]);

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
      results: { ...prev.results, [key]: value }
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

  const applyCoacheeToMeta = (coachee: Coachee) => {
    setFormData((prev) => ({
      ...prev,
      meta: {
        ...prev.meta,
        srName: coachee.full_name || prev.meta.srName,
        srNiveau: coachee.referee_level || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee.groups) || prev.meta.gruppe,
      },
    }));
  };

  const handleSelectGame = (game: EligibleGame | CoacheeGame) => {
    setSelectedGameId(game.id);
    setFeedbackSubView('feedbackForm');
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
    setBackendNotice('');
    try {
      const games = await listCoacheeGames(coachee.id);
      setCoacheeGames(games);
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
    const defaultSections =
      role === '1. SR'
        ? (lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN)
        : (lang === 'DE' ? SECTIONS_2SR_DE : SECTIONS_2SR_EN);
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
      balls.push({ key: 'none', color: 'bg-yellow-400', title: t.noObservation });
    }
    if (isActive && (status?.hasFurtherObservationNeeded ?? false)) {
      balls.push({ key: 'further', color: 'bg-yellow-500', title: t.furtherObservation });
    }
    if (status?.hasCompletedObservation) {
      balls.push({ key: 'done', color: 'bg-emerald-500', title: t.completedObservation });
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

  const handleSaveFeedback = async () => {
    if (!selectedGame) {
      setBackendNotice(t.noGames);
      return;
    }
    setSavingFeedback(true);
    setBackendNotice('');
    try {
      await saveFeedbackToPocketBase({
        game: selectedGame,
        role: formData.role,
        formData,
      });
      setBackendNotice(t.saveOk);
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
  const [showConfirmModal, setShowConfirmModal] = useState<'reset' | 'save' | null>(null);

  const doResetForm = () => {
    setFormData((prev) => ({
      ...prev,
      sections: prev.lang === 'DE'
        ? (prev.role === '1. SR' ? SECTIONS_1SR_DE : SECTIONS_2SR_DE)
        : (prev.role === '1. SR' ? SECTIONS_1SR_EN : SECTIONS_2SR_EN),
      results: { ...INITIAL_DATA.results },
    }));
    setShowConfirmModal(null);
  };

  const resetForm = () => {
    setShowConfirmModal('reset');
  };

  const toggleRole = () => {
    setFormData(prev => {
      const newRole = prev.role === '1. SR' ? '2. SR' : '1. SR';
      let newSections;
      if (newRole === '1. SR') {
        newSections = prev.lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN;
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
  };

  const toggleLang = () => {
    setFormData(prev => {
      const newLang = prev.lang === 'DE' ? 'EN' : 'DE';
      let newSections;
      if (prev.role === '1. SR') {
        newSections = newLang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN;
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
    () => new Set(coachees.map((c) => (c.full_name || '').toLowerCase().trim())),
    [coachees],
  );
  const coacheeLevels = useMemo(
    () => [...new Set(coachees.map((c) => c.referee_level).filter(Boolean))].sort(),
    [coachees],
  );
  const gameLeagues = useMemo(
    () => Array.from(new Set<string>(eligibleGames.map((g) => g.league).filter((l): l is string => Boolean(l)))).sort(),
    [eligibleGames],
  );
  const gameCoacheeOptions = useMemo(
    () => Array.from(new Set<string>(
      eligibleGames.flatMap((g) => [g.firstReferee, g.secondReferee].filter(Boolean) as string[])
        .filter((name) => coacheeNames.has(name.toLowerCase().trim()))
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
    return coachees.filter((c) => {
      if (q && !(c.full_name || '').toLowerCase().includes(q) && !(c.referee_level || '').toLowerCase().includes(q) && !(normalizeCoacheeGroup(c.groups) || '').toLowerCase().includes(q)) return false;
      if (listFilterLevel && (c.referee_level || '') !== listFilterLevel) return false;
      const isActive = (c.stage || 'active') !== 'inactive';
      if (!listFilterShowInactive && !isActive) return false;
      if (listFilterNeedsObs && !c.observation_status?.needsObservation) return false;
      return true;
    });
  }, [coachees, listSearch, listFilterLevel, listFilterShowInactive, listFilterNeedsObs]);
  const filteredGames = useMemo(() => {
    const q = listSearch.toLowerCase();
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
        const refs = [(g.firstReferee || '').toLowerCase().trim(), (g.secondReferee || '').toLowerCase().trim()];
        if (!gameFilterCoachees.some((c) => refs.includes(c.toLowerCase().trim()))) return false;
      }
      if (gameFilterLeagues.length > 0 && !gameFilterLeagues.includes(g.league || '')) return false;
      if (gameFilterDateFrom) {
        const from = new Date(gameFilterDateFrom);
        if (new Date(g.date) < from) return false;
      }
      if (gameFilterDateTo) {
        const to = new Date(gameFilterDateTo + 'T23:59:59');
        if (new Date(g.date) > to) return false;
      }
      return true;
    });
  }, [eligibleGames, listSearch, gameFilterCoachees, gameFilterLeagues, gameFilterDateFrom, gameFilterDateTo]);

  return (
    <div className="min-h-screen bg-stone-100 py-8 px-4 print:bg-white print:p-0">
      {/* UI Controls */}
      <div className="max-w-4xl mx-auto mb-6 flex flex-wrap gap-3 no-print">
        <button
          onClick={() => setViewMode((prev) => (prev === 'feedback' ? 'admin' : 'feedback'))}
          className="flex items-center gap-2 bg-slate-900 text-white px-3 py-2 sm:px-4 rounded-lg shadow-sm hover:bg-slate-800 transition-colors"
        >
          <Database size={18} />
          <span className="hidden sm:inline">{viewMode === 'feedback' ? t.modeAdmin : t.modeFeedback}</span>
        </button>
        {viewMode === 'feedback' && (
          <button
            onClick={toggleLang}
            className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
            title={t.languageToggleTitle}
          >
            <Languages size={18} />
            <span>{formData.lang === 'DE' ? 'EN' : 'DE'}</span>
          </button>
        )}
        {viewMode === 'feedback' && feedbackSubView !== 'coachees' && (
          <>
        <button
          onClick={() => setFeedbackSubView('coachees')}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <span>{t.lists}</span>
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
        <button
          onClick={toggleRole}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-blue-700 transition-colors"
        >
          <RefreshCw size={18} />
          <span className="hidden sm:inline">{t.switchRole} {formData.role === '1. SR' ? '2. SR' : '1. SR'}</span>
        </button>
        <button
          onClick={resetForm}
          className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-lg shadow-sm border border-red-100 hover:bg-red-100 transition-colors ml-auto"
        >
          <RefreshCw size={18} />
          <span className="hidden sm:inline">{t.reset}</span>
        </button>
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
          <div className="max-w-md mx-auto bg-white border border-stone-200 shadow-xl rounded-lg p-6 no-print">
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
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-blue-400 outline-none"
                  required
                />
              </label>
              <label className="block text-xs text-stone-600">
                {t.password}
                <input
                  type="password"
                  value={adminLoginPassword}
                  onChange={(e) => setAdminLoginPassword(e.target.value)}
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-blue-400 outline-none"
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
              <p className="mt-2 text-xs text-blue-700">{adminAuthNotice}</p>
            )}
          </div>
        )
      )}

      {viewMode === 'feedback' && feedbackSubView === 'coachees' && (
        <div className="max-w-5xl mx-auto no-print">
          <div className="bg-white p-4 shadow-xl border border-stone-200 mb-4 flex items-center gap-4">
            <img
              src={swissVolleyLogo}
              alt="Swiss Volley"
              className="h-14 w-auto object-contain"
            />
            <div>
              <h1 className="text-xl font-bold text-stone-900">{t.title}</h1>
              <p className="text-xs text-stone-500">Swiss Volley Region Zürich</p>
            </div>
          </div>

          <div className="bg-white p-3 sm:p-6 shadow-xl border border-stone-200">
            {/* Toggle tabs */}
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => { setListTab('coachees'); setListSearch(''); setListPage(0); }}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded transition-colors",
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
                  "px-3 py-1.5 text-sm font-medium rounded transition-colors",
                  listTab === 'games'
                    ? "bg-slate-900 text-white"
                    : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                )}
              >
                {t.gamePool}
              </button>
            </div>

            {/* Search & filters */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                type="text"
                value={listSearch}
                onChange={(e) => { setListSearch(e.target.value); setListPage(0); }}
                placeholder={formData.lang === 'DE' ? 'Suche...' : 'Search...'}
                className="h-9 flex-1 min-w-0 px-3 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
              />
              {listTab === 'coachees' && (
                <>
                  <select
                    value={listFilterLevel}
                    onChange={(e) => setListFilterLevel(e.target.value)}
                    className="h-9 px-2 text-sm border border-stone-300 rounded bg-white outline-none w-full sm:w-auto"
                  >
                    <option value="">{formData.lang === 'DE' ? 'Alle Stufen' : 'All levels'}</option>
                    {coacheeLevels.map((lvl) => (
                      <option key={lvl} value={lvl}>{lvl}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-sm text-stone-600 whitespace-nowrap cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={listFilterNeedsObs}
                      onChange={(e) => setListFilterNeedsObs(e.target.checked)}
                      className="h-4 w-4 rounded border-stone-300 accent-blue-600"
                    />
                    {formData.lang === 'DE' ? 'Beobachtung nötig' : 'Needs observation'}
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-stone-600 whitespace-nowrap cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={listFilterShowInactive}
                      onChange={(e) => setListFilterShowInactive(e.target.checked)}
                      className="h-4 w-4 rounded border-stone-300 accent-blue-600"
                    />
                    {formData.lang === 'DE' ? 'Inaktive zeigen' : 'Show inactive'}
                  </label>
                </>
              )}
            </div>

            {/* Games filters */}
            {listTab === 'games' && (
              <div className="flex flex-wrap items-end gap-2 mb-3">
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
                {(gameFilterCoachees.length > 0 || gameFilterLeagues.length > 0 || gameFilterDateFrom || gameFilterDateTo) && (
                  <button
                    onClick={() => { setGameFilterCoachees([]); setGameFilterLeagues([]); setGameFilterDateFrom(''); setGameFilterDateTo(''); }}
                    className="h-9 px-3 text-sm border border-stone-300 rounded hover:bg-stone-50 text-stone-600"
                  >
                    {formData.lang === 'DE' ? 'Filter zurücksetzen' : 'Clear filters'}
                  </button>
                )}
              </div>
            )}

            {/* Coachees table */}
            {listTab === 'coachees' && (
              <div className="max-h-[60vh] overflow-auto border border-stone-200 rounded">
                {filteredCoachees.length === 0 ? (
                  <p className="text-sm text-stone-500 p-4">{t.noCoachees}</p>
                ) : (
                  <table className="w-full text-base">
                    <thead className="sticky top-0 bg-stone-50 text-xs uppercase font-bold text-stone-500 border-b border-stone-200">
                      <tr>
                        <th className="text-left px-3 py-2.5">{formData.lang === 'DE' ? 'Name' : 'Name'}</th>
                        <th className="text-left px-3 py-2.5">{formData.lang === 'DE' ? 'Stufe' : 'Level'}</th>
                        <th className="text-left px-3 py-2.5 hidden md:table-cell">Stage</th>
                        <th className="text-left px-3 py-2.5 hidden md:table-cell">{t.group}</th>
                        <th className="text-center px-3 py-2.5">1SR</th>
                        <th className="text-center px-3 py-2.5">2SR</th>
                        <th className="text-center px-3 py-2.5 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200">
                      {filteredCoachees.slice(listPage * LIST_PAGE_SIZE, (listPage + 1) * LIST_PAGE_SIZE).map((coachee) => (
                        <tr
                          key={coachee.id}
                          onClick={() => handleSelectCoachee(coachee)}
                          className={cn(
                            "cursor-pointer transition-colors",
                            selectedCoacheeId === coachee.id ? "bg-blue-900/40" : "hover:bg-stone-50"
                          )}
                        >
                          <td className="px-3 py-2.5 font-semibold text-stone-900">{coachee.full_name}</td>
                          <td className="px-3 py-2.5 text-stone-600">{coachee.referee_level || '-'}</td>
                          <td className="px-3 py-2.5 text-stone-600 hidden md:table-cell">{coachee.stage || '-'}</td>
                          <td className="px-3 py-2.5 text-stone-600 hidden md:table-cell">{normalizeCoacheeGroup(coachee.groups) || '-'}</td>
                          <td className="px-3 py-2.5 text-center text-stone-600">{games1SRCount.get((coachee.full_name || '').toLowerCase().trim()) || '-'}</td>
                          <td className="px-3 py-2.5 text-center text-stone-600">{games2SRCount.get((coachee.full_name || '').toLowerCase().trim()) || '-'}</td>
                          <td className="px-3 py-2.5 text-center">
                            <span className="flex items-center justify-center gap-1">
                              {coacheeBalls(coachee).map((ball) => (
                                <span
                                  key={ball.key}
                                  title={ball.title}
                                  className={cn('w-3.5 h-3.5 rounded-full', ball.color)}
                                />
                              ))}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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

            {/* Games table */}
            {listTab === 'games' && (
              <div className="max-h-[60vh] overflow-auto border border-stone-200 rounded">
                {filteredGames.length === 0 ? (
                  <p className="text-sm text-stone-500 p-4">{t.noGames}</p>
                ) : (
                  <table className="w-full text-base">
                    <thead className="sticky top-0 bg-stone-50 text-xs uppercase font-bold text-stone-500 border-b border-stone-200">
                      <tr>
                        <th className="text-left px-3 py-2.5">{t.date}</th>
                        <th className="text-left px-3 py-2.5 hidden sm:table-cell">{t.matchNo}</th>
                        <th className="text-left px-3 py-2.5 hidden sm:table-cell">{t.league}</th>
                        <th className="text-left px-3 py-2.5">{t.teams}</th>
                        <th className="text-left px-3 py-2.5">{t.role1Short}</th>
                        <th className="text-left px-3 py-2.5">{t.role2Short}</th>
                        <th className="text-center px-3 py-2.5">RC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-200">
                      {filteredGames.slice(listPage * LIST_PAGE_SIZE, (listPage + 1) * LIST_PAGE_SIZE).map((game) => {
                        const d = new Date(game.date);
                        const dateValid = !isNaN(d.getTime());
                        const datePart = dateValid ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}` : (game.date || '-');
                        const timePart = dateValid ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
                        return (
                        <tr
                          key={game.id}
                          onClick={() => handleSelectGame(game)}
                          className="cursor-pointer hover:bg-stone-50 transition-colors"
                        >
                          <td className="px-3 py-2.5 text-stone-600 whitespace-nowrap">
                            <div>{datePart}</div>
                            {timePart && <div className="text-xs text-stone-400">{timePart}</div>}
                          </td>
                          <td className="px-3 py-2.5 font-semibold text-stone-900 hidden sm:table-cell">{game.matchNo}</td>
                          <td className="px-3 py-2.5 text-stone-600 hidden sm:table-cell">{game.league}</td>
                          <td className="px-3 py-2.5 text-stone-900">
                            <div>{game.homeTeam}</div>
                            <div>{game.awayTeam}</div>
                          </td>
                          <td className="px-3 py-2.5 text-stone-600">{game.firstReferee || '-'}</td>
                          <td className="px-3 py-2.5 text-stone-600">{game.secondReferee || '-'}</td>
                          <td className="px-3 py-2.5 text-center">
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
                              className="h-8 px-2 text-sm border border-stone-300 rounded bg-white outline-none focus-visible:ring-2 focus-visible:ring-blue-400 w-48 mx-auto"
                            >
                              <option value="">-</option>
                              {rcPeople.map((rc) => (
                                <option key={rc.id} value={rc.fullName}>{rc.fullName}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
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

            {backendNotice && (
              <p className="text-sm mt-3 text-blue-700">{backendNotice}</p>
            )}
          </div>
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'coacheeGames' && (
        <div className="max-w-4xl mx-auto bg-white p-3 sm:p-6 shadow-xl border border-stone-200 no-print">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-stone-800">
              {t.coacheeGames}: {selectedCoacheeName || '-'}
              {selectedCoacheeLevel && (
                <span className="ml-2 text-xs font-normal text-stone-500">({formData.lang === 'DE' ? 'Stufe' : 'Sublevel'}: {selectedCoacheeLevel})</span>
              )}
            </h2>
            <button
              onClick={() => setFeedbackSubView('coachees')}
              className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
            >
              {t.lists}
            </button>
          </div>
          <div className="max-h-[65vh] overflow-auto border border-stone-200 rounded">
            {loadingCoacheeGames ? (
              <p className="text-sm text-stone-500 p-4">{t.loading}</p>
            ) : coacheeGames.length === 0 ? (
              <p className="text-sm text-stone-500 p-4">{t.noCoacheeGames}</p>
            ) : (() => {
              const upcomingGames = coacheeGames.filter((game) => new Date(game.date) >= new Date());
              return upcomingGames.length === 0 ? (
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
              );
            })()}
          </div>
          {backendNotice && (
            <p className="text-sm mt-3 text-blue-700">{backendNotice}</p>
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
            <p className="text-sm mt-3 text-blue-700">{backendNotice}</p>
          )}
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'feedbackForm' && (
      <>
      {/* Main Form Container */}
      <div ref={printableRef} className="max-w-4xl mx-auto bg-white p-4 md:p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0 print:max-w-none print:mx-0">
        
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-6 print:flex-row">
          <div className="flex gap-4 items-start">
            <img 
              src={swissVolleyLogo}
              alt="Swiss Volley Region Zürich" 
              className="h-16 object-contain"
            />
            <div>
              <p className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch</p>
              <h1 className="text-xl sm:text-2xl font-bold mt-1 text-stone-900 flex items-center gap-3">
                {t.title} 
                <span className="bg-stone-900 text-white px-3 py-0.5 rounded text-lg">{formData.role}</span>
              </h1>
            </div>
          </div>
          <div className="text-left sm:text-right print:text-right">
            <div className="text-red-600 font-black italic text-2xl leading-none tracking-tighter">Swiss Volley</div>
            <div className="text-[10px] font-bold text-stone-800 tracking-widest uppercase mt-1">REGION ZÜRICH</div>
          </div>
        </div>

        {/* Meta Data Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 print:grid-cols-4 border-t border-l border-stone-900 mb-4">
          <MetaField label={t.matchNo} value={formData.meta.spielNr} onChange={v => updateMeta('spielNr', v)} />
          <MetaField label={t.league} value={formData.meta.liga} onChange={v => updateMeta('liga', v)} />
          <MetaField label={t.date} value={formData.meta.datum} onChange={v => updateMeta('datum', v)} type="date" />
          <MetaField label={t.location} value={formData.meta.ort} onChange={v => updateMeta('ort', v)} />
          
          <MetaField label={t.teams} value={formData.meta.mannschaften} onChange={v => updateMeta('mannschaften', v)} className="col-span-2 md:col-span-4 print:col-span-4" />
          
          <MetaField label={formData.role} value={formData.meta.srName} onChange={v => updateMeta('srName', v)} className="col-span-2" />
          <MetaField label={t.refLevel} value={formData.meta.srNiveau} onChange={v => updateMeta('srNiveau', v)} className="col-span-2" />
          
          <MetaField label={t.rc} value={formData.meta.rc} onChange={v => updateMeta('rc', v)} className="col-span-2" />
          <MetaField label={t.group} value={formData.meta.gruppe} onChange={v => updateMeta('gruppe', v)} className="col-span-2" />
        </div>

        {/* Legend */}
        <div className="mb-6 p-2 bg-stone-50 border border-stone-200 rounded flex items-center gap-2 text-[10px] text-stone-600 italic">
          <Info size={14} className="text-blue-500 shrink-0" />
          {LEGEND[formData.lang]}
        </div>

        {/* Assessment Sections */}
        <div className="space-y-6">
          {formData.sections.map((section, sIdx) => (
            <div key={section.title} className="overflow-hidden">
              <div className="bg-stone-100 border-x border-t border-stone-900 px-3 py-1.5 font-bold text-xs uppercase tracking-wider text-stone-700 flex items-center gap-2">
                <ClipboardCheck size={14} />
                {section.title}
              </div>
              <table className="w-full border-collapse border border-stone-900">
                <thead>
                  <tr className="bg-stone-50 text-[10px] uppercase font-bold text-stone-500">
                    <th className="p-2 text-left border-b border-stone-900">{t.criteria}</th>
                    {RATINGS.map(r => (
                      <th key={r} className={cn("w-10 border-l border-b border-stone-900 text-center", r === 'C' && "bg-stone-200")}>{r}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((item, iIdx) => (
                    <tr key={item.id} className="group hover:bg-stone-50 transition-colors">
                      <td className="p-2 text-xs border-b border-stone-900 leading-tight">{item.label}</td>
                      {RATINGS.map(r => {
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
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {/* Results Header Row */}
        <div className="mt-8 border border-stone-900 bg-stone-50 grid grid-cols-2 md:grid-cols-5 print:grid-cols-5 divide-x divide-stone-900">
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.matchLevel}</h4>
            <select 
              className="w-full bg-white border border-stone-200 rounded text-xs p-1 outline-none"
              value={formData.results.spielniveau}
              onChange={e => updateResult('spielniveau', e.target.value)}
            >
              <option value="">{t.select}</option>
              <option value="leicht">{t.easy}</option>
              <option value="normal">{t.normal}</option>
              <option value="schwierig">{t.difficult}</option>
            </select>
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
                    formData.results.motivation === v ? "bg-blue-600 text-white border-blue-600 font-bold" : "bg-white hover:bg-stone-100"
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
                    formData.results.einstufung === v ? "bg-blue-600 text-white border-blue-600 font-bold" : "bg-white hover:bg-stone-100"
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
                    formData.results.secondBesuch === v ? "bg-blue-600 text-white border-blue-600 font-bold" : "bg-white hover:bg-stone-100"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3">
            <h4 className="text-[10px] font-bold uppercase text-stone-500 mb-1">{t.refGoal}</h4>
            <select
              className="w-full bg-white border border-stone-200 rounded text-xs p-1 outline-none font-bold text-indigo-600"
              value={formData.results.srZiel}
              onChange={e => updateResult('srZiel', e.target.value)}
            >
              <option value="">{t.select}</option>
              {SR_ZIEL_OPTIONS.map(opt => {
                const label = (formData.lang === 'EN' && opt === 'Verbleib') ? 'Remain' : opt;
                return (
                  <option key={opt} value={opt}>{label}</option>
                );
              })}
            </select>
          </div>
        </div>

        {/* Full-width Remarks */}
        <div className="border-x border-b border-stone-900 p-4 min-h-[12rem] flex flex-col">
          <h3 className="font-bold border-b border-stone-900 mb-3 pb-1 flex items-center gap-2 text-stone-800">
            <MessageSquare size={16} />
            {t.remarks}
          </h3>
          <textarea
            className="flex-grow text-xs leading-relaxed resize-none outline-none bg-transparent placeholder:text-stone-300"
            placeholder={t.remarksPlaceholder}
            value={formData.results.bemerkungen}
            onChange={e => updateResult('bemerkungen', e.target.value)}
          />
        </div>

        <div className="mt-6 pt-4 border-t border-stone-100 text-[9px] text-right text-stone-400 italic">
          {t.version}: {t.versionDate} | SVRZ Referee Coaching Tool
        </div>
      </div>

      {/* Save to database */}
      <div className="max-w-4xl mx-auto mt-4 flex justify-end no-print">
        <button
          onClick={() => setShowConfirmModal('save')}
          disabled={savingFeedback || !selectedGame}
          className="flex items-center gap-2 bg-emerald-600 text-white px-6 py-3 rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 font-medium"
        >
          <Database size={18} />
          <span>{savingFeedback ? t.loading : t.saveBackend}</span>
        </button>
      </div>
      {backendNotice && (
        <p className="max-w-4xl mx-auto mt-2 text-sm text-blue-700 no-print">{backendNotice}</p>
      )}
      </>
      )}

      {/* Tips & Tricks (not saved to feedback, for email body later) */}
      {viewMode === 'feedback' && feedbackSubView === 'feedbackForm' && (
        <div className="max-w-4xl mx-auto mt-6 bg-white p-6 shadow-xl border border-stone-200 no-print">
          <h3 className="font-bold text-stone-800 mb-3 flex items-center gap-2">
            <Info size={16} />
            {formData.lang === 'DE' ? 'Tipps & Tricks' : 'Tips & Tricks'}
          </h3>
          <textarea
            className="w-full min-h-[8rem] text-sm leading-relaxed resize-none outline-none bg-stone-50 border border-stone-200 rounded p-3 placeholder:text-stone-300"
            placeholder={formData.lang === 'DE' ? 'Tipps und Tricks für den Schiedsrichter eingeben...' : 'Enter tips and tricks for the referee...'}
            value={tipsAndTricks}
            onChange={e => setTipsAndTricks(e.target.value)}
          />
        </div>
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
            <p className="text-sm text-stone-600 mb-6">
              {showConfirmModal === 'save'
                ? (formData.lang === 'DE' ? 'Das Feedback wird in der Datenbank gespeichert.' : 'The feedback will be saved to the database.')
                : (formData.lang === 'DE' ? 'Alle Bewertungen und Bemerkungen werden zurückgesetzt. Spieldaten bleiben erhalten.' : 'All ratings and remarks will be reset. Game data will be kept.')}
            </p>
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

      {/* JSON Modal */}
      {viewMode === 'feedback' && showJson && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
            <div className="p-6 border-b border-stone-100 flex justify-between items-center">
              <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2">
                <FileJson className="text-blue-600" />
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
                className="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
              >
                {t.copy}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'feedback' && detailCoachee && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-40 no-print">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 max-h-[85vh] overflow-auto">
            <h3 className="text-base font-bold text-stone-900 mb-4">
              {t.coacheeDetails}
            </h3>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex justify-between">
                <span className="text-stone-500">{formData.lang === 'DE' ? 'Name' : 'Name'}</span>
                <span className="font-medium text-stone-900">{detailCoachee.full_name}</span>
              </div>
              {detailCoachee.referee_level && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.level}</span>
                  <span className="font-medium text-stone-900">{detailCoachee.referee_level}</span>
                </div>
              )}
              {detailCoachee.stage && (
                <div className="flex justify-between">
                  <span className="text-stone-500">Stage</span>
                  <span className="font-medium text-stone-900">{detailCoachee.stage}</span>
                </div>
              )}
              {detailCoachee.groups && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.group}</span>
                  <span className="font-medium text-stone-900">{normalizeCoacheeGroup(detailCoachee.groups)}</span>
                </div>
              )}
              {detailCoachee.phone && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.phone}</span>
                  <a href={`tel:${detailCoachee.phone}`} className="font-medium text-blue-600 hover:underline">{detailCoachee.phone}</a>
                </div>
              )}
              {detailCoachee.email && (
                <div className="flex justify-between">
                  <span className="text-stone-500">{t.emailLabel}</span>
                  <a href={`mailto:${detailCoachee.email}`} className="font-medium text-blue-600 hover:underline">{detailCoachee.email}</a>
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
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
              <button
                onClick={() => void handleSaveNotes()}
                disabled={savingNotes}
                className="mt-2 h-9 px-4 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm disabled:opacity-50"
              >
                {savingNotes ? t.loading : t.saveNotes}
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => handleCoacheeAction(detailCoachee)}
                className="flex-1 h-10 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm"
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
                className="flex-1 h-10 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm"
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
    </div>
  );
}

function MetaField({ label, value, onChange, type = "text", className = "" }: { label: string, value: string, onChange: (v: string) => void, type?: string, className?: string }) {
  return (
    <div className={cn("border-r border-b border-stone-900 p-1.5 flex flex-col min-h-[48px]", className)}>
      <label className="block text-[8px] uppercase font-black text-stone-400 leading-none mb-1">{label}</label>
      <input 
        type={type}
        className="outline-none text-xs font-medium bg-transparent w-full" 
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}
