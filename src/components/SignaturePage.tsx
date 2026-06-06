import { useEffect, useRef, useState } from 'react';
import { Loader2, Check, Eraser } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { getSignatureSession, submitSignatureSession } from '../lib/pocketbase';

function slugFromHash(): string { const m = window.location.hash.match(/#\/sign\/([A-Za-z0-9]+)/); return m ? m[1] : ''; }

export default function SignaturePage() {
  const slug = slugFromHash();
  const padRef = useRef<SignaturePadHandle>(null);
  const [ctx, setCtx] = useState<{ context: string; signer: string } | null>(null);
  const [name, setName] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'done' | 'error'>('loading');

  useEffect(() => {
    if (!slug) { setState('error'); return; }
    getSignatureSession(slug).then((s) => { setCtx({ context: s.context, signer: s.signer }); setName(s.signer || ''); setState(s.signed ? 'done' : 'ready'); }).catch(() => setState('error'));
  }, [slug]);

  const save = async () => {
    if (!padRef.current || padRef.current.isEmpty()) return;
    setState('saving');
    try { await submitSignatureSession(slug, padRef.current.toDataURL(), name.trim()); setState('done'); }
    catch { setState('error'); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100 flex flex-col items-center p-4">
      <div className="w-full max-w-md mt-6">
        <div className="flex flex-col items-center mb-5"><SvrzLogo className="h-9 w-auto" /><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-3">Unterschrift / Signature</p></div>
        <div className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-5">
          {state === 'loading' && <div className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>}
          {state === 'error' && <p className="py-8 text-center text-sm text-red-600">Link ungültig oder abgelaufen.<br />Invalid or expired link.</p>}
          {state === 'done' && <div className="py-8 text-center"><div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3"><Check className="text-green-600" /></div><p className="text-sm font-medium text-stone-800">Unterschrift gespeichert.</p><p className="text-xs text-stone-400 mt-1">Signature saved — you can close this page.</p></div>}
          {(state === 'ready' || state === 'saving') && ctx && (
            <>
              {ctx.context && <p className="text-xs text-stone-500 mb-3 leading-snug">{ctx.context}</p>}
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-10 w-full px-3 mb-3 text-sm rounded-lg border border-stone-300 focus:outline-none focus:ring-2 focus:ring-red-500" />
              <p className="text-[11px] text-stone-400 mb-1.5">Hier unterschreiben / Sign here:</p>
              <div className="rounded-lg border-2 border-dashed border-stone-300 bg-stone-50/50"><SignaturePad ref={padRef} className="w-full h-44 block" /></div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => padRef.current?.clear()} className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg border border-stone-200 text-sm font-medium text-stone-600 hover:bg-stone-100"><Eraser size={15} /> Löschen</button>
                <button onClick={save} disabled={state === 'saving'} className="flex-1 inline-flex items-center justify-center gap-2 h-10 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:bg-stone-300">{state === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check size={16} />} Bestätigen / Confirm</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
