import { invoke } from '@tauri-apps/api/core';
import { apiUrl } from './pocketbase';
import { isDemoMode } from './demo';
import { IS_NATIVE } from './native';

// Phone notifications (web push, asked 2026-10-10): the same news a coach is
// mailed about their games — a change, the Börse, a switch request — on the
// lock screen of each device they switch it on for. No app store, no account:
// Android in Chrome or Firefox; an iPhone or iPad (iOS 16.4+) only once the app
// is on the Home screen, which is Apple's rule, not ours. The service worker's
// half is public/push-sw.js.
//
// The installed Android app (2026-11-02) has no service worker: there the
// subscription comes from the app itself (src-tauri/src/push.rs, PushPlugin.kt
// — a UnifiedPush app such as ntfy, or Google's push through Play services) and
// goes to the same /api/push/subscribe row. The desktop app has none.

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

/** The installed Android app (not a browser on Android). */
function isAndroidApp(): boolean {
  return IS_NATIVE && /Android/i.test(navigator.userAgent);
}

type NativeSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type NativeState = { permission: 'granted' | 'denied' | 'default'; subscription: NativeSubscription | null };

const nativeState = () => invoke<NativeState>('plugin:push|state');

export async function pushState(): Promise<PushState> {
  if (isDemoMode()) return 'unsupported';
  if (isAndroidApp()) {
    try {
      const s = await nativeState();
      if (s.permission === 'denied') return 'denied';
      return s.subscription ? 'on' : 'off';
    } catch {
      return 'unsupported';
    }
  }
  if (!('serviceWorker' in navigator)) return 'unsupported';
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

async function sendSubscription(sub: PushSubscription | NativeSubscription): Promise<void> {
  const subscription = 'toJSON' in sub ? sub.toJSON() : sub;
  await post('/api/push/subscribe', { subscription, ua: navigator.userAgent });
}

async function serverKey(): Promise<string> {
  const cfg = await fetch(apiUrl('/api/push/config'), { credentials: 'include' });
  const { publicKey, error } = await cfg.json().catch(() => ({})) as { publicKey?: string; error?: string };
  if (!cfg.ok || !publicKey) throw new Error(error || `HTTP ${cfg.status}`);
  return publicKey;
}

/** The Android app's refusal as the Error message PushOption reads: `denied`,
 *  `no-distributor`, `distributor-silent:<app name>`, else Android's words. */
function nativeError(raw: unknown): Error {
  const e = (raw ?? {}) as { code?: string; message?: string };
  if (e.code === 'denied') return new Error('denied');
  if (e.code === 'no-distributor') return new Error('no-distributor');
  if (e.code === 'distributor-silent') return new Error(`distributor-silent:${e.message || 'UnifiedPush'}`);
  return new Error(e.message || String(raw));
}

/** Ask the browser, subscribe, tell the server, and send a first test so the
 *  coach sees at once that it works. */
export async function enablePush(): Promise<void> {
  if (isAndroidApp()) {
    const publicKey = await serverKey();
    let subscription: NativeSubscription;
    try {
      ({ subscription } = await invoke<{ subscription: NativeSubscription }>('plugin:push|subscribe', { vapidPublicKey: publicKey }));
    } catch (error) {
      throw nativeError(error);
    }
    await sendSubscription(subscription);
    await post('/api/push/test').catch(() => {});
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
  const publicKey = await serverKey();
  const reg = await navigator.serviceWorker.ready;
  // A subscription made under another server key cannot be reused: drop it.
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => {});
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await sendSubscription(sub);
  await post('/api/push/test').catch(() => {});
}

export async function disablePush(): Promise<void> {
  if (isAndroidApp()) {
    const { subscription } = await nativeState();
    if (subscription) await post('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
    await invoke('plugin:push|unsubscribe').catch(() => {});
    return;
  }
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
    if (isAndroidApp()) {
      const { subscription } = await nativeState();
      if (subscription) await sendSubscription(subscription);
      return;
    }
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sendSubscription(sub);
  } catch { /* the next sign-in tries again */ }
}

/** In the Android app, a tap on a notification opens the page it names (the
 *  API's `url`, an in-app path). The app holds that path until the page takes
 *  it: on start (a tap that launched the app), and when the app signals a tap
 *  while it was running (`svrz-push-tap`, PushPlugin.onNewIntent). */
export function watchNotificationTaps(): () => void {
  if (!isAndroidApp()) return () => {};
  const take = () => {
    void invoke<{ url: string | null }>('plugin:push|take_open_url').then(({ url }) => {
      if (!url || !url.startsWith('/') || url.startsWith('//')) return;
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }).catch(() => {});
  };
  take();
  window.addEventListener('svrz-push-tap', take);
  return () => window.removeEventListener('svrz-push-tap', take);
}
