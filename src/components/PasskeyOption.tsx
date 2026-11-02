import { useEffect, useState } from 'react';
import { ChevronDown, Fingerprint, Loader2, Trash2 } from 'lucide-react';
import { listPasskeys, removePasskey, type PasskeyEntry } from '../lib/pocketbase';
import {
  forgetPasskeyOnDevice, isPasskeyAlreadyHere, isPasskeyCancel, markPasskeyOnDevice,
  passkeyIdOnDevice, passkeyOnDevice, passkeysPossible, setUpPasskey,
} from '../lib/passkeys';
import { confirmDialog, toast } from './ui';
import { cn } from '../lib/utils';

/** "02.11.2026" from the server's "2026-11-02 12:00:00.000Z" (or an ISO time). */
function shortDate(value: string, de: boolean): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(de ? 'de-CH' : 'en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Optionen → Anmeldung per Fingerabdruck (02.11.2026): the coach's passkeys,
 * one per device, with a way to set one up on this device and to remove any
 * of them. Removing is also the answer to the mail that says one was set up
 * under their name by somebody else. Hidden where a passkey cannot work at all
 * (the installed app, a browser without WebAuthn).
 */
export default function PasskeyOption({ lang, rcId }: { lang: 'DE' | 'EN'; rcId: string }) {
  const de = lang === 'DE';
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PasskeyEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [here, setHere] = useState(() => passkeyOnDevice(rcId));

  const load = async () => {
    setLoadError(false);
    try {
      const list = await listPasskeys();
      setEntries(list);
      // The key this device holds is gone or dead (the password changed, or it
      // was removed elsewhere): offer the set-up here again.
      const mine = passkeyIdOnDevice(rcId);
      if (mine && !list.some((p) => p.credentialId === mine && !p.outdated)) {
        markPasskeyOnDevice(rcId, false);
        setHere(false);
      }
    } catch {
      setEntries(null);
      setLoadError(true);
    }
  };

  // The list is asked for when the row is opened, not with the sheet: most
  // opens of Optionen are for something else.
  useEffect(() => { if (open && entries === null && !loadError) void load(); }, [open]);

  if (!passkeysPossible()) return null;

  const hereId = passkeyIdOnDevice(rcId);
  const live = (entries ?? []).filter((p) => !p.outdated);

  const setUp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const added = await setUpPasskey();
      if (added.onThisDevice) {
        markPasskeyOnDevice(rcId, true, added.credentialId);
        setHere(true);
      }
      toast.success(de ? 'Eingerichtet. Beim nächsten Mal genügt dein Fingerabdruck oder dein Gesicht.' : 'Set up. Next time your fingerprint or face is enough.');
      await load();
    } catch (error) {
      if (isPasskeyCancel(error)) return;
      if (isPasskeyAlreadyHere(error)) {
        markPasskeyOnDevice(rcId, true);
        setHere(true);
        toast.info(de ? 'Auf diesem Gerät ist die Anmeldung per Fingerabdruck schon eingerichtet.' : 'Fingerprint sign-in is already set up on this device.');
        return;
      }
      const status = (error as { status?: number }).status;
      toast.error(typeof status === 'number'
        ? (error as Error).message
        : (de ? 'Das Einrichten hat nicht geklappt.' : 'The set-up did not work.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: PasskeyEntry) => {
    const ok = await confirmDialog({
      title: de ? 'Passkey entfernen?' : 'Remove passkey?',
      message: de
        ? `„${entry.label}“ kann sich danach nicht mehr per Fingerabdruck anmelden. Das Team-Passwort bleibt.`
        : `"${entry.label}" can no longer sign in with a fingerprint after this. The team password stays.`,
      confirmLabel: de ? 'Entfernen' : 'Remove',
      cancelLabel: de ? 'Abbrechen' : 'Cancel',
      tone: 'danger',
      lang,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await removePasskey(entry.id);
      forgetPasskeyOnDevice(entry.credentialId);
      if (entry.credentialId && entry.credentialId === hereId) {
        markPasskeyOnDevice(rcId, false);
        setHere(false);
      }
      setEntries((list) => (list ?? []).filter((p) => p.id !== entry.id));
      toast.success(de ? 'Passkey entfernt.' : 'Passkey removed.');
    } catch (error) {
      toast.error((error as Error).message || (de ? 'Konnte nicht entfernt werden.' : 'Could not be removed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="passkey-option">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full min-h-12 inline-flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
        title={de
          ? 'Anmelden mit Fingerabdruck, Gesicht oder Geräte-PIN statt mit dem Team-Passwort.'
          : 'Sign in with your fingerprint, face or device PIN instead of the team password.'}
      >
        <Fingerprint size={18} />
        <span className="flex-1 text-left">{de ? 'Anmeldung per Fingerabdruck' : 'Fingerprint or face sign-in'}</span>
        <span className={cn('text-xs font-semibold', here ? 'text-emerald-600' : 'text-stone-400')}>
          {here ? (de ? 'An' : 'On') : (de ? 'Aus' : 'Off')}
        </span>
        <ChevronDown size={16} className={cn('shrink-0 text-stone-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="mx-4 mb-2 rounded-xl border border-stone-200 bg-stone-50 p-3 space-y-2">
          {entries === null && !loadError && (
            <p className="flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />{de ? 'Wird geladen…' : 'Loading…'}</p>
          )}
          {loadError && (
            <p className="text-xs text-red-600">
              {de ? 'Die Liste konnte nicht geladen werden.' : 'The list could not be loaded.'}{' '}
              <button type="button" onClick={() => void load()} className="underline">{de ? 'Erneut versuchen' : 'Try again'}</button>
            </p>
          )}
          {entries !== null && entries.length === 0 && (
            <p className="text-xs text-stone-500">{de ? 'Noch auf keinem Gerät eingerichtet.' : 'Not set up on any device yet.'}</p>
          )}
          {entries !== null && entries.length > 0 && (
            <ul className="space-y-1.5" data-testid="passkey-list">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 rounded-lg bg-white border border-stone-200 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-stone-800">
                      {entry.label}
                      {entry.credentialId && entry.credentialId === hereId && (
                        <span className="ml-1.5 text-[11px] font-semibold text-emerald-600">{de ? 'dieses Gerät' : 'this device'}</span>
                      )}
                    </p>
                    <p className="text-[11px] text-stone-500">
                      {entry.outdated
                        ? (de ? 'Abgelaufen: das Team-Passwort wurde danach geändert' : 'Expired: the team password changed after it')
                        : [
                          `${de ? 'Eingerichtet' : 'Set up'} ${shortDate(entry.created, de)}`,
                          entry.lastUsed ? `${de ? 'zuletzt' : 'last used'} ${shortDate(entry.lastUsed, de)}` : '',
                        ].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void remove(entry)}
                    disabled={busy}
                    aria-label={de ? `${entry.label} entfernen` : `Remove ${entry.label}`}
                    className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-full text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!here && (
            <button
              type="button"
              onClick={() => void setUp()}
              disabled={busy || (entries !== null && live.length >= 10)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-stone-300 px-3 py-2.5 text-sm font-semibold text-white"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Fingerprint size={16} />}
              {de ? 'Auf diesem Gerät einrichten' : 'Set up on this device'}
            </button>
          )}
          <p className="text-[11px] text-stone-400">
            {de
              ? 'Dein Fingerabdruck und dein Gesicht verlassen das Gerät nie. Nur auf deinem eigenen Gerät einrichten.'
              : 'Your fingerprint and your face never leave the device. Only set this up on your own device.'}
          </p>
        </div>
      )}
    </div>
  );
}
