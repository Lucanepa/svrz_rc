import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { NiveauAdmin, STR } from './components/AdminConsole';
import { resolveNiveauTable, type NiveauMatrix } from './lib/niveauTargets';


function Preview() {
  const [table, setTable] = useState<NiveauMatrix>(() => resolveNiveauTable(null));
  const [lang, setLang] = useState<'DE' | 'EN'>('DE');
  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 p-4">
      <div className="max-w-4xl mx-auto">
        <button onClick={() => setLang((l) => (l === 'DE' ? 'EN' : 'DE'))} className="mb-3 h-8 px-3 rounded-lg border border-stone-300 bg-white text-xs">{lang}</button>
        <NiveauAdmin t={STR[lang]} table={table} onTable={setTable} loading={false} />
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
