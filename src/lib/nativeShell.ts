// What the installed app does that a browser tab gets for free, or that a tab
// never needed: links out of the app, files from the API, and updates.
//
// - A link to another site would replace the app inside its own window, with no
//   address bar and no Back. It opens in the system browser instead.
// - A link straight to an API file (a filed report) carries no session in the
//   installed app: the session lives in a header (lib/native.ts), and a plain
//   navigation cannot send one. Those are fetched and handed over as a file.
// - A bundled app does not change when `main` is pushed. It checks for a new
//   release itself, and when the API refuses this version (426) it says so and
//   offers the update, instead of failing request after request.
//
// Plain DOM, not React: the prompts must work on every root (app, admin
// console) and even when the React tree failed to mount.

import { IS_NATIVE, NATIVE_VERSION, UPDATE_REQUIRED_EVENT } from './native';
import { clientLog } from './logger';

const RELEASES_API = 'https://api.github.com/repos/Lucanepa/svrz_rc/releases/latest';
const RELEASES_PAGE = 'https://github.com/Lucanepa/svrz_rc/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
const de = () => !/^en/i.test(document.documentElement.lang || navigator.language || 'de');

async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch (error) {
    clientLog.warn('native.open', 'could not open link outside the app', { error: String(error) });
  }
}

function isExternal(url: URL): boolean {
  if (url.protocol === 'mailto:' || url.protocol === 'tel:' || url.protocol === 'sms:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.origin !== window.location.origin;
}

function apiBase(): string {
  return ((import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '').replace(/\/+$/, '');
}

/** An API file (a filed report's PDF), fetched with the session and saved. */
async function downloadApiFile(href: string, suggestedName: string): Promise<void> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '')?.[1];
  const name = suggestedName || (fromHeader ? decodeURIComponent(fromHeader) : 'dokument.pdf');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function interceptLinks(): void {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    const base = apiBase();
    if (base && url.href.startsWith(`${base}/api/`)) {
      event.preventDefault();
      void downloadApiFile(url.href, anchor.getAttribute('download') || '').catch((error) => {
        clientLog.warn('native.download', 'API file download failed', { error: String(error) });
      });
      return;
    }
    if (isExternal(url)) {
      event.preventDefault();
      void openExternal(url.href);
    }
  }, true);

  const originalOpen = window.open.bind(window);
  window.open = ((target?: string | URL, ...rest: unknown[]) => {
    try {
      const url = new URL(String(target ?? ''), window.location.href);
      if (isExternal(url)) { void openExternal(url.href); return null; }
    } catch { /* fall through */ }
    return originalOpen(target as string, ...(rest as [string?, string?]));
  }) as typeof window.open;
}

// ── Updates ───────────────────────────────────────────────────────────

/** Numeric compare of dotted versions; a leading `v` or `native-v` is ignored. */
export function newerVersion(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^[^\d]*/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

type UpdateOffer = { version: string; install: () => Promise<void> };

let banner: HTMLElement | null = null;

function showUpdate(offer: UpdateOffer | null, required: boolean): void {
  banner?.remove();
  const el = document.createElement('div');
  el.setAttribute('role', required ? 'alertdialog' : 'status');
  el.style.cssText = required
    ? 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(28,25,23,.72);font-family:inherit'
    : 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483646;display:flex;justify-content:center;font-family:inherit';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:420px;width:100%;background:#fff;color:#1c1917;border-radius:14px;padding:16px 18px;box-shadow:0 10px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.45';
  const title = document.createElement('strong');
  title.style.fontSize = '15px';
  const text = document.createElement('span');
  const d = de();
  if (required) {
    title.textContent = d ? 'Update erforderlich' : 'Update required';
    text.textContent = d
      ? 'Diese Version der App wird vom Server nicht mehr angenommen. Bitte aktualisiere sie — deine Entwürfe und die Warteschlange bleiben erhalten.'
      : 'The server no longer accepts this version of the app. Please update it — your drafts and queued reports are kept.';
  } else {
    title.textContent = d ? `Neue Version ${offer?.version ?? ''}` : `New version ${offer?.version ?? ''}`;
    text.textContent = d ? 'Eine neue Version der App ist bereit.' : 'A new version of the app is ready.';
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.textContent = offer
    ? (d ? 'Jetzt aktualisieren' : 'Update now')
    : (d ? 'Download-Seite öffnen' : 'Open download page');
  primary.style.cssText = 'background:#dc2626;color:#fff;border:0;border-radius:10px;padding:9px 14px;font-weight:600;font-size:14px;cursor:pointer';
  primary.onclick = () => {
    primary.disabled = true;
    primary.textContent = d ? 'Wird geladen…' : 'Downloading…';
    const run = offer ? offer.install() : openExternal(RELEASES_PAGE);
    void run.catch((error) => {
      clientLog.warn('native.update', 'update failed', { error: String(error) });
      void openExternal(RELEASES_PAGE);
    }).finally(() => { primary.disabled = false; primary.textContent = d ? 'Erneut versuchen' : 'Try again'; });
  };
  if (!required) {
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = d ? 'Später' : 'Later';
    later.style.cssText = 'background:transparent;color:#57534e;border:1px solid #d6d3d1;border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer';
    later.onclick = () => { el.remove(); banner = null; };
    row.append(later);
  }
  row.append(primary);
  card.append(title, text, row);
  el.append(card);
  document.body.append(el);
  banner = el;
}

/** Desktop: the Tauri updater (signed, installs in place). Android: the latest
 *  release's APK, opened in the browser to install. iOS has no installed app. */
async function findUpdate(): Promise<UpdateOffer | null> {
  if (isIos()) return null;
  if (!isAndroid()) {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
    };
  }
  const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) return null;
  const release = await res.json() as { tag_name?: string; assets?: { name?: string; browser_download_url?: string }[] };
  const version = String(release.tag_name || '');
  if (!newerVersion(version, NATIVE_VERSION)) return null;
  const apk = release.assets?.find((a) => /\.apk$/i.test(a.name || ''))?.browser_download_url;
  return { version: version.replace(/^[^\d]*/, ''), install: () => openExternal(apk || RELEASES_PAGE) };
}

async function checkForUpdate(required: boolean): Promise<void> {
  try {
    const offer = await findUpdate();
    if (offer || required) showUpdate(offer, required);
  } catch (error) {
    if (required) showUpdate(null, true);
    clientLog.debug('native.update', 'update check failed', { error: String(error) });
  }
}

let installed = false;

export function installNativeShell(): void {
  if (!IS_NATIVE || installed) return;
  installed = true;
  interceptLinks();
  let requiredShown = false;
  window.addEventListener(UPDATE_REQUIRED_EVENT, () => {
    if (requiredShown) return;
    requiredShown = true;
    void checkForUpdate(true);
  });
  const quiet = () => { if (!requiredShown && navigator.onLine) void checkForUpdate(false); };
  window.setTimeout(quiet, 10_000);
  window.setInterval(quiet, UPDATE_CHECK_INTERVAL_MS);
}
