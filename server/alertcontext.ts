// Who an error happened to and what they did just before — for the alert mail
// (server/erroralerts.ts). Pure: it reads the entries it is given (the ring)
// and nothing else, so e2e/alert-context.spec.ts runs it without a server.
//
// Until 13.10.2026 an alert said what broke and when, and nothing about the
// person: a server error carried a name only on the two routes that tagged one,
// and the clicks that led to it were a `sid=` replay away in the console. The
// log already holds all of it, keyed by the visit's session id — the browser
// stamps every fetch with it (X-Svrz-Session) and ships its own lines under it.

import type { LogEntry } from './logstore.ts';
import { UNVERIFIED_PREFIX } from './logguard.ts';

export type AlertContext = {
  /** The name on the visit, if any line of it carries one (may be an
   *  `unverified:` claim — the mail shows it as one). */
  user?: string;
  /** False when the visit is known and nobody was signed in. */
  signedIn: boolean;
  /** "Android 14 · Chrome 130 · app · 384×832 · build 1a2b3c4". */
  device?: string;
  /** The page they were on when it happened. */
  page?: string;
  /** The last few things they did, oldest first: [clock time, what]. */
  steps: Array<[string, string]>;
};

export const ALERT_STEPS_MAX = 8;
const STEP_TEXT_MAX = 120;
// How far back a visit's lines count as "just before". Client lines carry the
// phone's own clock, so a few seconds after the error are allowed as well.
const LOOKBACK_MS = 15 * 60 * 1000;
const LOOKAHEAD_MS = 5_000;

const clip = (value: string, max = STEP_TEXT_MAX) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A user agent in a few words: system, browser, and whether it is the
 *  installed app's WebView. Unknown parts are left out rather than guessed. */
export function deviceSummary(ua: string): string {
  if (!ua) return '';
  const parts: string[] = [];
  const android = ua.match(/Android (\d+(?:\.\d+)?)/);
  const ios = ua.match(/(?:iPhone|CPU) OS (\d+)[._](\d+)/);
  if (android) parts.push(`Android ${android[1]}`);
  else if (/iPad/.test(ua)) parts.push(ios ? `iPad iOS ${ios[1]}.${ios[2]}` : 'iPad');
  else if (/iPhone/.test(ua)) parts.push(ios ? `iPhone iOS ${ios[1]}.${ios[2]}` : 'iPhone');
  else if (/Windows NT/.test(ua)) parts.push('Windows');
  else if (/Mac OS X/.test(ua)) parts.push('macOS');
  else if (/CrOS/.test(ua)) parts.push('ChromeOS');
  else if (/Linux/.test(ua)) parts.push('Linux');
  const version = (re: RegExp) => ua.match(re)?.[1];
  if (/; wv\)/.test(ua)) parts.push('Android WebView');
  else if (version(/Edg(?:A|iOS)?\/(\d+)/)) parts.push(`Edge ${version(/Edg(?:A|iOS)?\/(\d+)/)}`);
  else if (version(/SamsungBrowser\/(\d+)/)) parts.push(`Samsung Internet ${version(/SamsungBrowser\/(\d+)/)}`);
  else if (version(/(?:Firefox|FxiOS)\/(\d+)/)) parts.push(`Firefox ${version(/(?:Firefox|FxiOS)\/(\d+)/)}`);
  else if (version(/(?:Chrome|CriOS)\/(\d+)/)) parts.push(`Chrome ${version(/(?:Chrome|CriOS)\/(\d+)/)}`);
  else if (version(/Version\/(\d+(?:\.\d+)?).*Safari/)) parts.push(`Safari ${version(/Version\/(\d+(?:\.\d+)?).*Safari/)}`);
  else if (/AppleWebKit/.test(ua)) parts.push('WebKit');
  return parts.join(' · ') || clip(ua, 80);
}

/** One line of the visit as a step, or null for lines that are not something
 *  the person did (polls, debug noise, the error being reported). */
function step(e: LogEntry): string | null {
  const data = e.data ?? {};
  switch (e.evt) {
    case 'app.start': return 'opened the app';
    case 'nav.change': return e.msg ? `went to ${e.msg}` : null;
    case 'ui.click': return text(data.text) ? `clicked "${text(data.text)}"` : 'clicked';
    case 'ui.submit': return 'submitted a form';
    case 'net.offline': return 'went offline';
    case 'net.online': return 'came back online';
    case 'net.fetch':
    case 'req.out': {
      // Reads are the app's own polling; only a write, or a failure, is
      // something the person did or met.
      const msg = e.msg || '';
      const failed = / → [45]\d\d\b/.test(msg);
      if (!failed && /^(GET|HEAD|OPTIONS) /.test(msg)) return null;
      return msg || null;
    }
    default:
      if (e.lvl === 'error' || e.lvl === 'warn') return `${e.evt}: ${e.msg || ''}`.trim();
      return null;
  }
}

export function alertContext(ring: readonly LogEntry[], entry: LogEntry, clock: (iso: string) => string): AlertContext | null {
  // A cron job or a startup line belongs to no visit: nothing to say.
  let sid = entry.sid;
  if (!sid && entry.reqId) sid = ring.find((e) => e.reqId === entry.reqId && e.sid)?.sid;
  if (!sid && !entry.reqId) return null;

  const at = Date.parse(entry.t) || Date.now();
  const visit = ring.filter((e) => e.seq !== entry.seq && (sid ? e.sid === sid : e.reqId === entry.reqId));
  const before = visit
    .filter((e) => { const t = Date.parse(e.t); return t >= at - LOOKBACK_MS && t <= at + LOOKAHEAD_MS; })
    .sort((a, b) => a.t.localeCompare(b.t) || a.seq - b.seq);

  // A verified name beats a claim, and any name beats none.
  const names = [entry.user, ...visit.map((e) => e.user)].filter((u): u is string => Boolean(u));
  const user = names.find((u) => !u.startsWith(UNVERIFIED_PREFIX)) ?? names[0];

  const start = [...visit].reverse().find((e) => e.evt === 'app.start');
  const reqIn = visit.find((e) => e.evt === 'req.in' && text(e.data?.ua));
  const ua = text(start?.data?.ua) || text(reqIn?.data?.ua);
  const deviceParts = [deviceSummary(ua)];
  if (start?.data?.standalone === true) deviceParts.push('installed');
  if (text(start?.data?.viewport)) deviceParts.push(text(start?.data?.viewport).replace('x', '×'));
  if (text(start?.data?.build)) deviceParts.push(`build ${text(start?.data?.build).slice(0, 7)}`);
  const device = deviceParts.filter(Boolean).join(' · ') || undefined;

  // The browser's own lines say what the person did; the server's say only
  // what reached it. Use the server's when the browser has not shipped its
  // batch yet (or never will: the tab died with the error).
  const fromBrowser = before.some((e) => e.src === 'client');
  const steps: Array<[string, string]> = [];
  for (const e of before) {
    if (fromBrowser ? e.src !== 'client' : e.evt !== 'req.out') continue;
    const what = step(e);
    if (what) steps.push([clock(e.t), clip(what)]);
  }

  const lastNav = [...before].reverse().find((e) => e.evt === 'nav.change' || (e.evt === 'ui.click' && text(e.data?.path)));
  const page = (lastNav?.evt === 'nav.change' ? lastNav.msg : text(lastNav?.data?.path))
    || text(start?.data?.url)
    || text(reqIn?.data?.referer)
    || undefined;

  return {
    user,
    signedIn: Boolean(user),
    device,
    page: page ? clip(page) : undefined,
    steps: steps.slice(-ALERT_STEPS_MAX),
  };
}
