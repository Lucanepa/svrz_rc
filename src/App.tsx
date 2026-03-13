import React, { useState, useEffect, useRef } from 'react';
import { Download, FileJson, Printer, RefreshCw, ClipboardCheck, MessageSquare, Target, Info, Languages, Database, CalendarDays, LogIn, LogOut, ShieldAlert } from 'lucide-react';
import html2canvas from 'html2canvas';
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

export default function App() {
  const [viewMode, setViewMode] = useState<'feedback' | 'admin'>('feedback');
  const [feedbackSubView, setFeedbackSubView] = useState<FeedbackSubView>('coachees');
  const [formData, setFormData] = useState<FeedbackFormData>(() => {
    const saved = localStorage.getItem('sr_feedback_data');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Robust merge to handle schema updates
        return {
          ...INITIAL_DATA,
          ...parsed,
          lang: parsed.lang || detectInitialLang(),
          results: { ...INITIAL_DATA.results, ...parsed.results },
          meta: { ...INITIAL_DATA.meta, ...parsed.meta }
        };
      } catch (e) {
        return { ...INITIAL_DATA, lang: detectInitialLang() };
      }
    }
    return { ...INITIAL_DATA, lang: detectInitialLang() };
  });
  const [showJson, setShowJson] = useState(false);
  const [eligibleGames, setEligibleGames] = useState<EligibleGame[]>([]);
  const [calendarGames, setCalendarGames] = useState<CalendarGameStatus[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [selectedCoacheeName, setSelectedCoacheeName] = useState('');
  const [selectedCoacheeId, setSelectedCoacheeId] = useState('');
  const [loadingGames, setLoadingGames] = useState(false);
  const [loadingCalendar, setLoadingCalendar] = useState(false);
  const [coachees, setCoachees] = useState<Coachee[]>([]);
  const [coacheeGames, setCoacheeGames] = useState<CoacheeGame[]>([]);
  const [loadingCoacheeGames, setLoadingCoacheeGames] = useState(false);
  const [loadingCoachees, setLoadingCoachees] = useState(false);
  const [actionTargetCoachee, setActionTargetCoachee] = useState<Coachee | null>(null);
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
    localStorage.setItem('sr_feedback_data', JSON.stringify(formData));
  }, [formData]);

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
        srNiveau: coachee.level || prev.meta.srNiveau,
        gruppe: normalizeCoacheeGroup(coachee.group) || prev.meta.gruppe,
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
    setSelectedCoacheeId(coachee.id);
    setSelectedCoacheeName(coachee.full_name || '');
    applyCoacheeToMeta(coachee);
    const observationCount = coachee.observation_status?.count ?? coachee.observations_count ?? 0;
    if (observationCount === 0) {
      void loadCoacheeGames(coachee);
      return;
    }
    setActionTargetCoachee(coachee);
  };

  const coacheeBalls = (coachee: Coachee) => {
    const isActive = coachee.is_active !== false;
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
    const canvas = await html2canvas(printableRef.current, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    });

    const imageData = canvas.toDataURL('image/png');
    const pdf = new jsPDF('p', 'pt', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imageWidth = pageWidth;
    const imageHeight = (canvas.height * imageWidth) / canvas.width;

    let heightLeft = imageHeight;
    let position = 0;

    pdf.addImage(imageData, 'PNG', 0, position, imageWidth, imageHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imageHeight;
      pdf.addPage();
      pdf.addImage(imageData, 'PNG', 0, position, imageWidth, imageHeight);
      heightLeft -= pageHeight;
    }

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

  const resetForm = () => {
    if (window.confirm(t.confirmReset)) {
      setFormData((prev) => ({
        ...INITIAL_DATA,
        lang: prev.lang,
        sections: prev.lang === 'DE' ? SECTIONS_1SR_DE : SECTIONS_1SR_EN,
      }));
    }
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

  return (
    <div className="app-dark min-h-screen bg-stone-100 py-8 px-4 print:bg-white print:p-0">
      {/* UI Controls */}
      <div className="max-w-4xl mx-auto mb-6 flex flex-wrap gap-3 no-print">
        <button
          onClick={() => setViewMode((prev) => (prev === 'feedback' ? 'admin' : 'feedback'))}
          className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-slate-800 transition-colors"
        >
          <Database size={18} />
          <span>{viewMode === 'feedback' ? t.modeAdmin : t.modeFeedback}</span>
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
        <button
          onClick={() => setFeedbackSubView('calendar')}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <CalendarDays size={18} />
          <span>{t.calendar}</span>
        </button>
        {feedbackSubView === 'feedbackForm' && (
          <>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <Printer size={18} />
          <span>{t.pdf}</span>
        </button>
        <button
          onClick={() => void handleDownloadPdf()}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <Download size={18} />
          <span>{t.downloadPdf}</span>
        </button>
        <button 
          onClick={() => setShowJson(!showJson)}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <FileJson size={18} />
          <span>{t.json}</span>
        </button>
        <button
          onClick={() => void handleSaveFeedback()}
          disabled={savingFeedback || !selectedGame}
          className="flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50"
        >
          <Database size={18} />
          <span>{savingFeedback ? t.loading : t.saveBackend}</span>
        </button>
        <button 
          onClick={toggleRole}
          className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-indigo-700 transition-colors"
        >
          <RefreshCw size={18} />
          <span>{t.switchRole} {formData.role === '1. SR' ? '2. SR' : '1. SR'}</span>
        </button>
        <button 
          onClick={resetForm}
          className="flex items-center gap-2 bg-red-50 text-red-600 px-4 py-2 rounded-lg shadow-sm border border-red-100 hover:bg-red-100 transition-colors ml-auto"
        >
          <RefreshCw size={18} />
          <span>{t.reset}</span>
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
            <span>{adminAuthLoading ? t.loading : t.adminLogout}</span>
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
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-indigo-400 outline-none"
                  required
                />
              </label>
              <label className="block text-xs text-stone-600">
                {t.password}
                <input
                  type="password"
                  value={adminLoginPassword}
                  onChange={(e) => setAdminLoginPassword(e.target.value)}
                  className="h-10 w-full mt-1 px-3 rounded border border-stone-300 bg-white focus-visible:ring-2 focus-visible:ring-indigo-400 outline-none"
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
              <p className="mt-2 text-xs text-indigo-700">{adminAuthNotice}</p>
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

          <div className="grid gap-4 md:grid-cols-2">
            <div className="bg-white p-6 shadow-xl border border-stone-200">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-stone-800">{t.coacheePool}</h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setFeedbackSubView('calendar')}
                  className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
                >
                  {t.calendar}
                </button>
                <button
                  onClick={() => void refreshCoachees()}
                  className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
                >
                  {loadingCoachees ? t.loading : t.loadCoachees}
                </button>
              </div>
            </div>
            <div className="max-h-[60vh] overflow-auto border border-stone-200 rounded">
              {coachees.length === 0 ? (
                <p className="text-sm text-stone-500 p-4">{t.noCoachees}</p>
              ) : (
                <div className="divide-y divide-stone-100">
                  {coachees.map((coachee) => (
                    <button
                      key={coachee.id}
                      onClick={() => handleSelectCoachee(coachee)}
                      className={cn(
                        "w-full text-left px-4 py-3 transition-colors cursor-pointer",
                        selectedCoacheeId === coachee.id ? "bg-indigo-900/40 border-l-2 border-indigo-400" : "hover:bg-stone-50"
                      )}
                    >
                      <div className="font-semibold text-stone-900 text-sm flex items-center justify-between gap-2">
                        <span>{coachee.full_name}</span>
                        <span className="flex items-center gap-1">
                          {coacheeBalls(coachee).map((ball) => (
                            <span
                              key={ball.key}
                              title={ball.title}
                              className={cn('w-3 h-3 rounded-full', ball.color)}
                            />
                          ))}
                        </span>
                      </div>
                      <div className="text-xs text-stone-500 mt-1">
                        {coachee.level || '-'} | {normalizeCoacheeGroup(coachee.group) || '-'}
                      </div>
                      <div className="text-[11px] text-stone-400 mt-1">
                        {coachee.is_active === false ? t.inactive : t.active}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white p-6 shadow-xl border border-stone-200">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-stone-800">{t.gamePool}</h2>
              <button
                onClick={() => void refreshGames()}
                className="text-xs px-2 py-1 border rounded border-stone-300 hover:bg-stone-50"
              >
                {loadingGames ? t.loading : t.loadGames}
              </button>
            </div>
            <div className="max-h-[60vh] overflow-auto border border-stone-200 rounded">
              {eligibleGames.length === 0 ? (
                <p className="text-sm text-stone-500 p-4">{t.noGames}</p>
              ) : (
                <div className="divide-y divide-stone-100">
                  {eligibleGames.map((game) => (
                    <button
                      key={game.id}
                      onClick={() => handleSelectGame(game)}
                      className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                    >
                      <div className="font-semibold text-stone-900 text-sm">
                        {game.matchNo} - {game.homeTeam} vs {game.awayTeam}
                      </div>
                      <div className="text-xs text-stone-500 mt-1">
                        {game.date} | {game.league} | {t.role1Short}: {game.firstReferee || '-'} | {t.role2Short}: {game.secondReferee || '-'}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {backendNotice && (
            <p className="text-sm mt-3 text-indigo-700 md:col-span-2">{backendNotice}</p>
          )}
          </div>
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'coacheeGames' && (
        <div className="max-w-4xl mx-auto bg-white p-6 shadow-xl border border-stone-200 no-print">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-stone-800">{t.coacheeGames}: {selectedCoacheeName || '-'}</h2>
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
            ) : (
              <div className="divide-y divide-stone-100">
                {coacheeGames.map((game) => (
                  <button
                    key={game.id}
                    onClick={() => handleSelectGame(game)}
                    className="w-full text-left px-4 py-3 hover:bg-stone-50 transition-colors cursor-pointer"
                  >
                    <div className="font-semibold text-stone-900 text-sm">
                      {game.matchNo} - {game.homeTeam} vs {game.awayTeam}
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      {game.date} | {game.league} | {t.rolesLabel}: {game.assignedRoles.join(', ') || '-'}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {backendNotice && (
            <p className="text-sm mt-3 text-indigo-700">{backendNotice}</p>
          )}
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'calendar' && (
        <div className="max-w-5xl mx-auto bg-white p-6 shadow-xl border border-stone-200 no-print">
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
            <p className="text-sm mt-3 text-indigo-700">{backendNotice}</p>
          )}
        </div>
      )}

      {viewMode === 'feedback' && feedbackSubView === 'feedbackForm' && (
      <>
      {/* Main Form Container */}
      <div ref={printableRef} className="max-w-4xl mx-auto bg-white p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0">
        
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div className="flex gap-4 items-start">
            <img 
              src={swissVolleyLogo}
              alt="Swiss Volley Region Zürich" 
              className="h-16 object-contain"
            />
            <div>
              <p className="text-[10px] text-stone-500 uppercase tracking-wider font-semibold">SVRZ | SR-Wesen | Referee Coaching | schiricoaching@svrz.ch</p>
              <h1 className="text-2xl font-bold mt-1 text-stone-900 flex items-center gap-3">
                {t.title} 
                <span className="bg-stone-900 text-white px-3 py-0.5 rounded text-lg">{formData.role}</span>
              </h1>
            </div>
          </div>
          <div className="text-right">
            <div className="text-red-600 font-black italic text-2xl leading-none tracking-tighter">Swiss Volley</div>
            <div className="text-[10px] font-bold text-stone-800 tracking-widest uppercase mt-1">REGION ZÜRICH</div>
          </div>
        </div>

        {/* Meta Data Grid */}
        <div className="grid grid-cols-4 border-t border-l border-stone-900 mb-4">
          <MetaField label={t.matchNo} value={formData.meta.spielNr} onChange={v => updateMeta('spielNr', v)} />
          <MetaField label={t.league} value={formData.meta.liga} onChange={v => updateMeta('liga', v)} />
          <MetaField label={t.date} value={formData.meta.datum} onChange={v => updateMeta('datum', v)} type="date" />
          <MetaField label={t.location} value={formData.meta.ort} onChange={v => updateMeta('ort', v)} />
          
          <MetaField label={t.teams} value={formData.meta.mannschaften} onChange={v => updateMeta('mannschaften', v)} className="col-span-4" />
          
          <MetaField label={formData.role} value={formData.meta.srName} onChange={v => updateMeta('srName', v)} className="col-span-2" />
          <MetaField label={t.refLevel} value={formData.meta.srNiveau} onChange={v => updateMeta('srNiveau', v)} className="col-span-2" />
          
          <MetaField label={t.rc} value={formData.meta.rc} onChange={v => updateMeta('rc', v)} className="col-span-2" />
          <MetaField label={t.group} value={formData.meta.gruppe} onChange={v => updateMeta('gruppe', v)} className="col-span-2" />
        </div>

        {/* Legend */}
        <div className="mb-6 p-2 bg-stone-50 border border-stone-200 rounded flex items-center gap-2 text-[10px] text-stone-600 italic">
          <Info size={14} className="text-indigo-500 shrink-0" />
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
        <div className="mt-8 border border-stone-900 bg-stone-50 grid grid-cols-4 divide-x divide-stone-900">
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
                    formData.results.motivation === v ? "bg-stone-900 text-white border-stone-900" : "bg-white hover:bg-stone-100"
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
                    formData.results.einstufung === v ? "bg-stone-900 text-white border-stone-900" : "bg-white hover:bg-stone-100"
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
                    formData.results.secondBesuch === v ? "bg-stone-900 text-white border-stone-900" : "bg-white hover:bg-stone-100"
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer: Remarks & SR-Ziel */}
        <div className="flex border-x border-b border-stone-900 h-72">
          {/* Remarks */}
          <div className="w-2/3 p-4 border-r border-stone-900 flex flex-col">
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
          
          {/* SR-Ziel Column */}
          <div className="w-1/3 p-4 flex flex-col">
            <h3 className="font-bold text-[10px] uppercase tracking-widest text-stone-500 mb-4 flex items-center gap-2">
              <Target size={14} />
              {t.refGoal}
            </h3>
            <div className="mb-4">
              <select 
                className="w-full bg-white border border-stone-200 rounded text-sm p-2 outline-none font-bold text-indigo-600"
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
            <div className="flex-grow border border-dashed border-stone-200 rounded p-2 flex items-center justify-center text-stone-300 italic text-[10px] text-center">
              {t.goalPlaceholder}
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-stone-100 text-[9px] text-right text-stone-400 italic">
          {t.version}: {t.versionDate} | SVRZ Referee Coaching Tool
        </div>
      </div>
      </>
      )}

      {/* JSON Modal */}
      {viewMode === 'feedback' && showJson && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 no-print">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
            <div className="p-6 border-b border-stone-100 flex justify-between items-center">
              <h2 className="text-xl font-bold text-stone-900 flex items-center gap-2">
                <FileJson className="text-indigo-600" />
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
                className="bg-indigo-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
              >
                {t.copy}
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
                className="flex-1 h-10 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-sm"
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
