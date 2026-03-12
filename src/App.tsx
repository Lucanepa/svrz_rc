import React, { useState, useEffect, useRef } from 'react';
import { Download, FileJson, Printer, RefreshCw, ClipboardCheck, MessageSquare, Target, Info, Languages, Database } from 'lucide-react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { INITIAL_DATA, FeedbackFormData, SECTIONS_1SR_DE, SECTIONS_1SR_EN, SECTIONS_2SR_DE, SECTIONS_2SR_EN, LEGEND, SR_ZIEL_OPTIONS, EligibleGame } from './types';
import { hasPocketBaseConfig, loadEligibleGames, saveFeedbackToPocketBase } from './lib/pocketbase';
import { cn } from './lib/utils';
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
    switchRole: "Wechseln zu",
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
    secondVisit: "2nd Besuch",
    remarks: "Bemerkungen",
    refGoal: "SR-Ziel",
    easy: "Leicht",
    normal: "Normal",
    difficult: "Schwierig",
    select: "Wählen...",
    remarksPlaceholder: "Hier Feedback, Beobachtungen und Verbesserungsvorschläge eingeben...",
    goalPlaceholder: "Ziele werden basierend auf dem gewählten Niveau und den Bemerkungen festgelegt.",
    version: "Stand",
    close: "Schliessen",
    copy: "Kopieren",
    copied: "In die Zwischenablage kopiert!",
    confirmReset: "Möchten Sie alle Daten löschen?",
    gamePool: "Coachee-Spiele",
    loadGames: "Spiele laden",
    noGames: "Keine passenden Spiele gefunden.",
    selectedGame: "Ausgewähltes Spiel",
    downloadPdf: "PDF herunterladen",
    saveBackend: "In Datenbank speichern",
    saveOk: "Feedback wurde gespeichert.",
    saveError: "Speichern fehlgeschlagen.",
    loading: "Lädt...",
    pbMissing: "VITE_POCKETBASE_URL fehlt. Bitte in .env setzen.",
  },
  EN: {
    title: "Referee Coaching Feedback",
    switchRole: "Switch to",
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
    close: "Close",
    copy: "Copy",
    copied: "Copied to clipboard!",
    confirmReset: "Do you want to clear all data?",
    gamePool: "Coachee Games",
    loadGames: "Load Games",
    noGames: "No matching games found.",
    selectedGame: "Selected Game",
    downloadPdf: "Download PDF",
    saveBackend: "Save to Database",
    saveOk: "Feedback saved successfully.",
    saveError: "Saving failed.",
    loading: "Loading...",
    pbMissing: "VITE_POCKETBASE_URL is missing. Please set it in .env.",
  }
};

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

export default function App() {
  const [viewMode, setViewMode] = useState<'feedback' | 'admin'>('feedback');
  const [formData, setFormData] = useState<FeedbackFormData>(() => {
    const saved = localStorage.getItem('sr_feedback_data');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Robust merge to handle schema updates
        return {
          ...INITIAL_DATA,
          ...parsed,
          lang: parsed.lang || 'DE',
          results: { ...INITIAL_DATA.results, ...parsed.results },
          meta: { ...INITIAL_DATA.meta, ...parsed.meta }
        };
      } catch (e) {
        return INITIAL_DATA;
      }
    }
    return INITIAL_DATA;
  });
  const [showJson, setShowJson] = useState(false);
  const [eligibleGames, setEligibleGames] = useState<EligibleGame[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [showFeedbackSheet, setShowFeedbackSheet] = useState(false);
  const [loadingGames, setLoadingGames] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [backendNotice, setBackendNotice] = useState('');
  const printableRef = useRef<HTMLDivElement | null>(null);

  const t = UI_STRINGS[formData.lang] || UI_STRINGS.DE;
  const selectedGame = eligibleGames.find((game) => game.id === selectedGameId) ?? null;

  useEffect(() => {
    localStorage.setItem('sr_feedback_data', JSON.stringify(formData));
  }, [formData]);

  useEffect(() => {
    if (!hasPocketBaseConfig()) {
      setBackendNotice(t.pbMissing);
      return;
    }
    setBackendNotice('');
    void refreshGames();
  }, [formData.lang]);

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
      setBackendNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingGames(false);
    }
  };

  const handleSelectGame = (game: EligibleGame) => {
    setSelectedGameId(game.id);
    setShowFeedbackSheet(true);
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
      setBackendNotice(`${t.saveError} ${reason}`);
    } finally {
      setSavingFeedback(false);
    }
  };

  const resetForm = () => {
    if (window.confirm(t.confirmReset)) {
      setFormData(INITIAL_DATA);
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
    <div className="min-h-screen bg-stone-100 py-8 px-4 print:bg-white print:p-0">
      {/* UI Controls */}
      <div className="max-w-4xl mx-auto mb-6 flex flex-wrap gap-3 no-print">
        <button
          onClick={() => setViewMode((prev) => (prev === 'feedback' ? 'admin' : 'feedback'))}
          className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg shadow-sm hover:bg-slate-800 transition-colors"
        >
          <Database size={18} />
          <span>{viewMode === 'feedback' ? 'Admin' : 'Feedback'}</span>
        </button>
        {viewMode === 'feedback' && showFeedbackSheet && (
          <>
        <button
          onClick={() => setShowFeedbackSheet(false)}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <span>Games</span>
        </button>
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
          onClick={toggleLang}
          className="flex items-center gap-2 bg-white px-4 py-2 rounded-lg shadow-sm border border-stone-200 hover:bg-stone-50 transition-colors"
        >
          <Languages size={18} />
          <span>{formData.lang === 'DE' ? 'English' : 'Deutsch'}</span>
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
      </div>

      {viewMode === 'admin' && <AdminPanel />}

      {viewMode === 'feedback' && !showFeedbackSheet && (
        <div className="max-w-4xl mx-auto bg-white p-6 shadow-xl border border-stone-200 no-print">
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
                      {game.date} | {game.league} | 1SR: {game.firstReferee || '-'} | 2SR: {game.secondReferee || '-'}
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

      {viewMode === 'feedback' && showFeedbackSheet && (
      <>
      {/* Main Form Container */}
      <div ref={printableRef} className="max-w-4xl mx-auto bg-white p-8 shadow-xl border border-stone-200 print:shadow-none print:border-none print:p-0">
        
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div className="flex gap-4 items-start">
            <img 
              src="https://www.volleyball.ch/fileadmin/user_upload/man_uploads/Logo_SwissVolley_Zuerich.png" 
              alt="Swiss Volley Region Zürich" 
              className="h-16 object-contain"
              referrerPolicy="no-referrer"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
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
          {t.version}: 12. März 2026 | SVRZ Referee Coaching Tool
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
