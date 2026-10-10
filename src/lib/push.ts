import { apiUrl } from './pocketbase';
import { isDemoMode } from './demo';

// Phone notifications (web push, asked 2026-10-10): the same news a coach is
// mailed about their games — a change, the Börse, a switch request — on the
// lock screen of each device they switch it on for. No app store, no account:
// Android in Chrome or Firefox; an iPhone or iPad (iOS 16.4+) only once the app
// is on the Home screen, which is Apple's rule, not ours. The service worker's
// half is public/push-sw.js.

export type PushState =
  /** No service worker or no Push API here (or the dev server, which registers none). */
  | 'unsupported'
  /** iPhone/iPad in a browser tab: possible once the app is on the Home screen. */
  | 'ios-home-screen'
  /** The coach said no in the browser; only the browser settings undo that. */
  | 'denied'
  | 'off'
  | 'on';

export function isIos(): boolean {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (isDemoMode() || !('serviceWorker' in navigator)) return 'unsupported';
  if (isIos() && !isStandalone()) return 'ios-home-screen';
  if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg?.pushManager) return 'unsupported';
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function post(path: string, body?: unknown): Promise<Response> {
  const r = await fetch(apiUrl(path), {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => null) as { error?: string } | null;
    throw new Error(err?.error || `HTTP ${r.status}`);
  }
  return r;
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  await post('/api/push/subscribe', { subscription: sub.toJSON(), ua: navigator.userAgent });
}

/** Ask the browser, subscribe, tell the server, and send a first test so the
 *  coach sees at once that it works. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
  const cfg = await fetch(apiUrl('/api/push/config'), { credentials: 'include' });
  const { publicKey, error } = await cfg.json().catch(() => ({})) as { publicKey?: string; error?: string };
  if (!cfg.ok || !publicKey) throw new Error(error || `HTTP ${cfg.status}`);
  const reg = await navigator.serviceWorker.ready;
  // A subscription made under another server key cannot be reused: drop it.
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => {});
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await sendSubscription(sub);
  await post('/api/push/test').catch(() => {});
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await post('/api/push/unsubscribe', { endpoint }).catch(() => {});
}

/** On sign-in: a device that has notifications on tells the server again
 *  whose they are — a shared tablet follows whoever signed in last, and a row
 *  the server dropped comes back. Quiet: it is housekeeping. */
export async function resyncPush(): Promise<void> {
  try {
    if ((await pushState()) !== 'on') return;
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sendSubscription(sub);
  } catch { /* the next sign-in tries again */ }
}
