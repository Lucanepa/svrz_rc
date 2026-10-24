// The dialog a signature is drawn in, on the coach's device.
//
// It closes only on purpose (Jennifer, 23.10.2026: "as soon as your hand
// touches outside the signature field, it deletes the writing and closes the
// field"). On an iPad the writing hand rests beside the field, and iOS turns a
// palm or fingertip on the old backdrop into a click that closed the dialog and
// took the ink with it. Now the backdrop does nothing; the dialog ends on
// "Unterschrift speichern", or on Abbrechen / × / Escape — at once with an
// empty pad, after an explicit "Verwerfen" with ink on it.
//
// The buttons sit ABOVE the pad, out from under the resting hand, and a finger
// tap anywhere in the panel is ignored while the Pencil is writing. App.tsx
// keeps the state (which form, the drafts, the phone relay); this file is the
// markup and the close policy.

import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, Copy, Eraser, Hand, Send, Undo2, Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import SignaturePad, { isSignatureEmpty, type SigStroke, type SignaturePadHandle, type SignaturePadStats } from './SignaturePad';
import AppSpinner from './AppSpinner';
import { confirmDialog } from './ui';
import { getConfirmSnapshot, settleConfirm } from './ui/store';
import { cn } from '../lib/utils';

/** What the "or sign on a phone" section shows. */
export type SignatureRelay =
  | { kind: 'demo' }
  | { kind: 'offline' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; shareLabel: string; canShare: boolean; hint: string; onShare(): void };

export type SignatureSaveStats = SignaturePadStats & { fingerToo: boolean };

type Props = {
  lang: 'DE' | 'EN';
  title: string;
  initialStrokes?: SigStroke[];
  onDraftChange(strokes: SigStroke[]): void;
  onSave(dataUrl: string, stats: SignatureSaveStats): void;
  /** Closing with nothing worth keeping, or after "Verwerfen". */
  onDiscard(): void;
  /** The coach's kept signature, offered when it was taken off this form. */
  remembered?: { image: string; onUse(): void } | null;
  relay: SignatureRelay;
};

export default function SignatureDialog({ lang, title, initialStrokes, onDraftChange, onSave, onDiscard, remembered, relay }: Props) {
  const de = lang === 'DE';
  const titleId = `${useId()}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const padBoxRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<SignaturePadHandle>(null);
  const [strokes, setStrokes] = useState<SigStroke[]>(() => initialStrokes ?? []);
  const [canUndo, setCanUndo] = useState(false);
  const [penLock, setPenLock] = useState(false);
  const [fingerToo, setFingerToo] = useState(false);
  const empty = isSignatureEmpty(strokes);

  // A discard confirm resolving after the dialog already went (the phone's
  // signature arrived, a navigation) must not close the NEXT one.
  const aliveRef = useRef(true);
  const confirmingRef = useRef(false);
  // The id of our own discard question while it is on screen. A dialog that
  // goes away under it (a Back swipe, the phone's signature) takes the
  // question with it instead of leaving it asking about nothing.
  const confirmIdRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (confirmIdRef.current) settleConfirm(confirmIdRef.current, false);
    };
  }, []);

  const callbacks = useRef({ onDiscard });
  callbacks.current = { onDiscard };
  const requestClose = async () => {
    if (confirmingRef.current) return;
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) { callbacks.current.onDiscard(); return; }
    confirmingRef.current = true;
    const queuedBefore = getConfirmSnapshot();
    const answer = confirmDialog({
      title: de ? 'Unterschrift verwerfen?' : 'Discard the signature?',
      message: de ? 'Was du gezeichnet hast, wird gelöscht.' : 'What you have drawn is deleted.',
      confirmLabel: de ? 'Verwerfen' : 'Discard',
      cancelLabel: de ? 'Weiter unterschreiben' : 'Keep signing',
      tone: 'danger',
      lang,
    });
    if (!queuedBefore) confirmIdRef.current = getConfirmSnapshot()?.id ?? 0;
    const ok = await answer;
    confirmIdRef.current = 0;
    confirmingRef.current = false;
    if (ok && aliveRef.current) callbacks.current.onDiscard();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // Escape is this dialog's own: capture phase, before App's window-level
  // handler, which would otherwise close it with the ink. While a confirm is on
  // screen the key is left to it (its "no" keeps signing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || getConfirmSnapshot()) return;
      e.stopPropagation();
      e.preventDefault();
      void requestCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Scroll lock and focus restore, the ConfirmDialog way, but on <html>: the
  // discard confirm locks <body> and restores whatever it found there, so had
  // both used <body>, a dialog closed under its confirm would leave the page
  // locked for good once the confirm restored the "hidden" it saw.
  useEffect(() => {
    const root = document.documentElement;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    // Into the dialog, so Enter on the button that opened it cannot open it again.
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      root.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused) && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, []);

  // While the Pencil writes, a palm dragging across the panel must not scroll
  // it out from under the pen. Non-passive, or preventDefault is ignored.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onMove = (e: TouchEvent) => { if (padRef.current?.isBusy()) e.preventDefault(); };
    panel.addEventListener('touchmove', onMove, { capture: true, passive: false });
    return () => panel.removeEventListener('touchmove', onMove, { capture: true });
  }, []);

  // A touch outside the pad while the pen is busy is the writing hand, not a
  // tap on Save or Löschen: its click is swallowed. Kept per pointer: one flag
  // for the whole panel was reset by the pen's next pointerdown on the pad, so
  // a palm resting on Save saved half a signature when it lifted. A click is
  // matched to the pointer that went down on what it hits (its own pointerType
  // reads "mouse" after a tap in WebKit), and a touch's click is swallowed if
  // the pen was busy when it went down or is busy now. Busy means on the glass
  // within the pen's trailing window; a Pencil hovering over the pad is not
  // (24.10.2026: Save looked dead to the other hand while the pen hovered).
  // A Pencil tap on a button always counts.
  const downsRef = useRef<{ type: string; target: Node; busy: boolean; at: number }[]>([]);
  const onPointerDownCapture = (e: ReactPointerEvent) => {
    const target = e.target as Node;
    // Strokes on the pad never become a click on a button.
    if (padBoxRef.current?.contains(target)) return;
    const now = performance.now();
    downsRef.current = [
      ...downsRef.current.filter((d) => now - d.at < 10_000).slice(-7),
      { type: e.pointerType, target, busy: e.pointerType === 'touch' && !!padRef.current?.isBusy(), at: now },
    ];
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    const hit = e.target as Node;
    const downs = downsRef.current;
    let i = downs.length - 1;
    while (i >= 0 && !(hit === downs[i].target || hit.contains(downs[i].target))) i -= 1;
    if (i < 0) return;
    const from = downs[i];
    downsRef.current = downs.filter((_, j) => j !== i);
    if (from.type !== 'touch' || !(from.busy || padRef.current?.isBusy())) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const save = () => {
    const pad = padRef.current;
    if (!pad || pad.isEmpty()) return;
    onSave(pad.toDataURL(), { ...pad.stats(), fingerToo });
  };

  const onPadChange = (next: SigStroke[], undoable: boolean) => {
    setStrokes(next);
    setCanUndo(undoable);
    onDraftChange(next);
  };

  const smallButton = 'inline-flex items-center justify-center gap-1.5 h-10 px-2.5 sm:px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div
      // Top-aligned, not centred: centred, the panel moved whenever something
      // below the pad changed height (the QR arriving, or the 8 s start
      // timeout turning the spinner into the offline note), and a pen in
      // mid-stroke went on drawing at another height of the pad (47 px off on
      // an iPad, 65 px on a phone). Only what is above the pad can move it now.
      className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-start justify-center p-4 pt-[max(1rem,6vh)] z-50 no-print"
      // Inert on purpose (no onClick): see the top of this file. touch-action
      // and overscroll keep a palm from scrolling or pinching the page behind.
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="signature-dialog"
        tabIndex={-1}
        onPointerDownCapture={onPointerDownCapture}
        onClickCapture={onClickCapture}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm sm:max-w-2xl p-4 max-h-[85vh] overflow-y-auto overscroll-contain select-none [-webkit-touch-callout:none] outline-none"
      >
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 id={titleId} className="text-base font-bold text-stone-900 min-w-0">{title}</h3>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={() => void requestClose()} className="h-9 px-3 rounded-lg text-xs font-medium text-stone-600 hover:bg-stone-100">
              {de ? 'Abbrechen' : 'Cancel'}
            </button>
            <button type="button" onClick={() => void requestClose()} aria-label={de ? 'Schliessen' : 'Close'} className="h-9 w-9 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 text-2xl leading-none">&times;</button>
          </div>
        </div>

        {remembered && (
          <div className="flex items-center gap-3 mb-3 p-2 rounded-lg border border-stone-200 bg-stone-50">
            <img src={remembered.image} alt={de ? 'Vorschau: gemerkte Unterschrift' : 'Preview: remembered signature'} className="h-10 w-24 object-contain shrink-0" />
            <button type="button" onClick={remembered.onUse} className="ml-auto h-9 px-3 rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-700 hover:bg-stone-100">
              {de ? 'Gemerkte Unterschrift verwenden' : 'Use remembered signature'}
            </button>
          </div>
        )}

        {/* Above the pad, out from under the hand that writes on it. The
            finger switch too: under the pad's corner, where a right hand
            rests, a palm lifting after a pause turned finger drawing on
            (24.10.2026). It appears in this row without moving the pad: same
            height as its neighbours, and Save keeps its place at the right. */}
        <div className="flex items-center gap-2 mb-2">
          <button type="button" onClick={() => padRef.current?.undo()} disabled={!canUndo} aria-label={de ? 'Rückgängig' : 'Undo'} title={de ? 'Rückgängig' : 'Undo'} className={smallButton}>
            <Undo2 size={15} /><span className="hidden sm:inline">{de ? 'Rückgängig' : 'Undo'}</span>
          </button>
          <button type="button" onClick={() => padRef.current?.clear()} disabled={strokes.length === 0} aria-label={de ? 'Löschen' : 'Clear'} title={de ? 'Löschen' : 'Clear'} className={smallButton}>
            <Eraser size={15} /><span className="hidden sm:inline">{de ? 'Löschen' : 'Clear'}</span>
          </button>
          {penLock && (
            // Only after a pen, and per open: the notebook's Finger switch is
            // always there and remembered per device, because a coach writes
            // pages with the Pencil for a whole season; this pad is signed by
            // whoever holds the iPad, and the next signer may have no pen.
            <button
              type="button"
              aria-pressed={fingerToo}
              onClick={() => setFingerToo((v) => !v)}
              aria-label={de ? 'Auch mit Finger' : 'Finger too'}
              title={de ? 'Finger zeichnet auch' : 'Finger draws too'}
              className={cn(smallButton, fingerToo && 'border-stone-800 bg-stone-800 text-white hover:bg-stone-700')}
            >
              <Hand size={15} /><span className="hidden sm:inline">{de ? 'Auch mit Finger' : 'Finger too'}</span>
            </button>
          )}
          {/* Short on a phone: with the switch beside it, the full German
              label wrapped onto two lines at 360-393 px. */}
          <button type="button" onClick={save} disabled={empty} aria-label={de ? 'Unterschrift speichern' : 'Save signature'} className="ml-auto shrink-0 whitespace-nowrap inline-flex items-center justify-center gap-1.5 h-10 px-4 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:bg-stone-300">
            <Check size={16} /><span className="sm:hidden">{de ? 'Speichern' : 'Save'}</span><span className="hidden sm:inline">{de ? 'Unterschrift speichern' : 'Save signature'}</span>
          </button>
        </div>

        <div
          ref={padBoxRef}
          className="mx-auto rounded-lg border-2 border-dashed border-stone-300 bg-stone-50/50 overflow-hidden"
          // The pad takes every swipe (it draws), so the panel scrolls only
          // where the pad is not. On a phone held sideways the full-width pad
          // filled all of the 85vh panel below the buttons and the phone
          // hand-off was out of reach; capped, there is room below and beside
          // it. No effect from a portrait phone up to a landscape iPad.
          style={{ maxWidth: 'calc((85vh - 10rem) * 2.5)' }}
        >
          <SignaturePad ref={padRef} initialStrokes={initialStrokes} onChange={onPadChange} onPenLockChange={setPenLock} fingerToo={fingerToo} />
        </div>

        {/* Text only: nothing to press where the writing hand rests. */}
        <p className="mt-1.5 text-[11px] text-stone-400">
          {penLock
            ? (de ? 'Stift erkannt — nur der Stift zeichnet.' : 'Pen detected — only the pen draws.')
            : (de ? 'Im Feld oben unterschreiben.' : 'Sign in the box above.')}
        </p>

        <RelaySection lang={lang} relay={relay} />
      </div>
    </div>
  );
}

function RelaySection({ lang, relay }: { lang: 'DE' | 'EN'; relay: SignatureRelay }) {
  const de = lang === 'DE';
  // Signing on a second device needs the server to relay the signature back,
  // so the QR cannot work in the demo: scanning it lands on a device with no
  // demo session, i.e. "link invalid or expired". Offer only what works.
  if (relay.kind === 'demo' || relay.kind === 'offline') {
    return (
      <p className="mt-3 pt-3 border-t border-stone-200 text-[11px] text-stone-500 text-center">
        {relay.kind === 'demo'
          ? (de
            ? 'Im Demo-Modus kannst du nur hier unterschreiben. Der QR-Code zum Unterschreiben auf dem Handy braucht den Server.'
            : 'In the demo you can only sign here. The QR code for signing on a phone needs the server.')
          : (de
            ? 'Unterschreiben auf dem Handy ist gerade nicht möglich (offline). Hier unterschreiben funktioniert.'
            : 'Signing on a phone isn’t available right now (offline). Signing here works.')}
      </p>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2 my-3"><div className="flex-1 h-px bg-stone-200" /><span className="text-[10px] uppercase text-stone-400 font-semibold">{de ? 'oder' : 'or'}</span><div className="flex-1 h-px bg-stone-200" /></div>
      {relay.kind === 'loading' ? (
        <div className="flex justify-center"><AppSpinner size={96} /></div>
      ) : (
        // A row on a tablet, so a landscape iPad fits the whole dialog
        // without scrolling; stacked on a phone.
        <div className="flex flex-col sm:flex-row items-center sm:items-start gap-2 sm:gap-4">
          <div className="p-2 bg-white border border-stone-200 rounded-lg shrink-0">
            <QRCodeSVG value={relay.url} size={116} level="M" className="w-[116px] h-[116px] sm:w-24 sm:h-24" />
          </div>
          <div className="flex flex-col items-center sm:items-start gap-2 min-w-0">
            <p className="text-[11px] text-stone-500 text-center sm:text-left">{de ? 'Mit dem Handy scannen und dort unterschreiben.' : 'Scan with a phone and sign there.'}</p>
            {/* Faster than holding a QR up at someone who is already packing
                their bag: the link lands in the referee's own phone. Still the
                same visit — this dialog is what watches the session, so it
                stays open until the ink arrives. */}
            <button
              type="button"
              onClick={relay.onShare}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100"
            >
              {relay.canShare ? <Send size={13} /> : <Copy size={13} />}
              {relay.shareLabel}
            </button>
            <p className="text-[11px] text-stone-400 text-center sm:text-left">{relay.hint}</p>
            <p className="text-[11px] text-amber-600 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {de ? 'Warte auf Unterschrift…' : 'Waiting for signature…'}</p>
          </div>
        </div>
      )}
    </>
  );
}
