import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';
import { confirmDialog, toast } from './ui';
import { cn } from '../lib/utils';

/**
 * Optionen → Benachrichtigungen (asked 2026-10-10): phone notifications on
 * THIS device for everything a coach is mailed about their games. One row in
 * the Options sheet, its state on the right. Hidden where it can never work
 * (no service worker, the demo); on an iPhone in a browser tab it says what
 * Apple asks for first.
 */
export default function PushOption({ lang }: { lang: 'DE' | 'EN' }) {
  const de = lang === 'DE';
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pushState().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, []);

  if (state === null || state === 'unsupported') return null;

  const label: Record<PushState, string> = {
    unsupported: '',
    'ios-home-screen': de ? 'Erst zum Home-Bildschirm' : 'Add to Home Screen first',
    denied: de ? 'Im Browser blockiert' : 'Blocked in the browser',
    off: de ? 'Aus' : 'Off',
    on: de ? 'An' : 'On',
  };

  const tap = async () => {
    if (busy) return;
    if (state === 'ios-home-screen') {
      toast.info(de
        ? 'Auf dem iPhone: in Safari „Teilen“ → „Zum Home-Bildschirm“, die App von dort öffnen und hier einschalten.'
        : 'On an iPhone: in Safari tap Share → “Add to Home Screen”, open the app from there and switch this on.');
      return;
    }
    if (state === 'denied') {
      toast.info(de
        ? 'Benachrichtigungen sind für diese Seite im Browser blockiert — in den Website-Einstellungen erlauben, dann hier einschalten.'
        : 'Notifications are blocked for this site in the browser — allow them in the site settings, then switch them on here.');
      return;
    }
    if (state === 'on') {
      const ok = await confirmDialog({
        title: de ? 'Benachrichtigungen ausschalten?' : 'Turn notifications off?',
        message: de ? 'Auf diesem Gerät kommen dann keine mehr. Die E-Mails bleiben.' : 'This device gets none after that. The e-mails stay.',
        confirmLabel: de ? 'Ausschalten' : 'Turn off',
        cancelLabel: de ? 'Abbrechen' : 'Cancel',
        lang,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (state === 'on') {
        await disablePush();
        setState('off');
        toast.success(de ? 'Benachrichtigungen ausgeschaltet.' : 'Notifications turned off.');
      } else {
        await enablePush();
        setState('on');
        toast.success(de ? 'Benachrichtigungen an — eine Testnachricht ist unterwegs.' : 'Notifications on — a test message is on its way.');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === 'denied') setState('denied');
      toast.error(msg === 'denied' || msg === 'dismissed'
        ? (de ? 'Nicht erlaubt — der Browser hat keine Benachrichtigungen zugelassen.' : 'Not allowed — the browser did not permit notifications.')
        : (de ? `Konnte nicht eingeschaltet werden: ${msg}` : `Could not be switched on: ${msg}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="push-option"
      data-state={state}
      onClick={() => void tap()}
      className="w-full min-h-12 inline-flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
      title={de
        ? 'Spieländerungen, SR-Börse und Tauschanfragen als Benachrichtigung auf diesem Gerät — zusätzlich zur E-Mail.'
        : 'Game changes, the SR-Börse and switch requests as notifications on this device — besides the e-mail.'}
    >
      {busy ? <Loader2 size={18} className="animate-spin" /> : state === 'on' ? <Bell size={18} /> : <BellOff size={18} />}
      <span className="flex-1 text-left">{de ? 'Benachrichtigungen' : 'Notifications'}</span>
      <span className={cn('text-xs font-semibold', state === 'on' ? 'text-emerald-600' : state === 'off' ? 'text-stone-400' : 'text-amber-600')}>
        {label[state]}
      </span>
    </button>
  );
}
