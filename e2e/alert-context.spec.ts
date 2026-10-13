import { test, expect } from '@playwright/test';
import { alertContext, deviceSummary, ALERT_STEPS_MAX } from '../server/alertcontext';
import { callerBodyError } from '../server/logguard';
import type { LogEntry } from '../server/logstore';

/**
 * The error mail says who it happened to and what they did just before
 * (Luca, 13.10.2026: "also user, what they did etc."). Until then it named a
 * person only on the two routes that tagged one, and the clicks were a `sid=`
 * replay away in the console. The context is read off the ring by the visit's
 * session id; these pin how.
 */

let seq = 0;
const at = (hms: string) => `2026-10-13T${hms}.000Z`;
function line(over: Partial<LogEntry> & Pick<LogEntry, 'evt' | 't'>): LogEntry {
  return { seq: ++seq, lvl: 'info', src: 'client', ...over };
}
const clock = (iso: string) => iso.slice(11, 19);
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36';

test.describe('a server error during a visit', () => {
  const sid = 's-visit-1';
  const ring: LogEntry[] = [
    line({ t: at('16:30:00'), evt: 'app.start', sid, user: 'unverified:Anna Muster', data: { ua: PHONE, build: '1a2b3c4d5e', viewport: '384x832', standalone: true, url: 'https://svrz-rc.openvolley.app/' } }),
    line({ t: at('16:30:02'), evt: 'nav.change', msg: '/games', sid }),
    line({ t: at('16:30:03'), evt: 'net.fetch', msg: 'GET /api/games → 200 (40ms)', sid }),
    line({ t: at('16:31:10'), evt: 'ui.click', msg: 'click: Formular', sid, data: { text: 'Formular', path: '/games' } }),
    line({ t: at('16:31:11'), evt: 'nav.change', msg: '/form/402397/1sr', sid }),
    line({ t: at('16:33:40'), evt: 'ui.click', msg: 'click: Senden', sid, data: { text: 'Senden', path: '/form/402397/1sr' } }),
    line({ t: at('16:33:41'), evt: 'net.fetch', msg: 'POST /api/feedback/submit → 500 (900ms)', sid, user: 'Anna Muster' }),
    // Another visit, interleaved: never part of this one's story.
    line({ t: at('16:33:39'), evt: 'ui.click', sid: 's-other', user: 'Bruno Beispiel', data: { text: 'Abmelden' } }),
  ];
  const error = line({ t: at('16:33:41'), evt: 'req.fail', lvl: 'error', src: 'server', reqId: 'r1', sid, msg: 'POST /api/feedback/submit threw' });

  test('names the person — the verified name over the claim', () => {
    const ctx = alertContext([...ring, error], error, clock)!;
    expect(ctx.user).toBe('Anna Muster');
    expect(ctx.signedIn).toBe(true);
  });

  test('says which device, in a few words', () => {
    const ctx = alertContext([...ring, error], error, clock)!;
    expect(ctx.device).toBe('Android 14 · Chrome 130 · installed · 384×832 · build 1a2b3c4');
  });

  test('says on which page, and what they did — not the polls, not the other visit', () => {
    const ctx = alertContext([...ring, error], error, clock)!;
    expect(ctx.page).toBe('/form/402397/1sr');
    expect(ctx.steps).toEqual([
      ['16:30:00', 'opened the app'],
      ['16:30:02', 'went to /games'],
      ['16:31:10', 'clicked "Formular"'],
      ['16:31:11', 'went to /form/402397/1sr'],
      ['16:33:40', 'clicked "Senden"'],
      ['16:33:41', 'POST /api/feedback/submit → 500 (900ms)'],
    ]);
  });

  test('keeps only the last few steps', () => {
    const clicks = Array.from({ length: 20 }, (_, i) => line({ t: at(`16:2${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}`), evt: 'ui.click', sid, data: { text: `B${i}` } }));
    const ctx = alertContext([...clicks, error], error, clock)!;
    expect(ctx.steps).toHaveLength(ALERT_STEPS_MAX);
    expect(ctx.steps.at(-1)?.[1]).toBe('clicked "B19"');
  });
});

test('before the browser has shipped its clicks, the server side tells what reached it', () => {
  const sid = 's-visit-2';
  const ring: LogEntry[] = [
    line({ t: at('09:00:00'), evt: 'req.in', src: 'server', sid, reqId: 'a', data: { ua: PHONE, referer: 'https://svrz-rc.openvolley.app/notebook' } }),
    line({ t: at('09:00:00'), evt: 'req.out', src: 'server', sid, reqId: 'a', msg: 'GET /api/notebook → 200 (5ms)', user: 'Anna Muster' }),
    line({ t: at('09:00:30'), evt: 'req.out', src: 'server', sid, reqId: 'b', msg: 'PUT /api/notebook/pages/p1 → 200 (8ms)', user: 'Anna Muster' }),
  ];
  const error = line({ t: at('09:01:00'), evt: 'req.fail', lvl: 'error', src: 'server', sid, reqId: 'c', user: 'Anna Muster', msg: 'DELETE /api/notebook/pages/p1 threw' });
  const ctx = alertContext([...ring, error], error, clock)!;
  expect(ctx.steps).toEqual([['09:00:30', 'PUT /api/notebook/pages/p1 → 200 (8ms)']]);
  expect(ctx.device).toBe('Android 14 · Chrome 130');
  expect(ctx.page).toBe('https://svrz-rc.openvolley.app/notebook');
});

test('a visit nobody signed in to says so; a cron job has no visit at all', () => {
  const anon = line({ t: at('10:00:00'), evt: 'js.error', lvl: 'error', sid: 's-anon', msg: 'boom' });
  expect(alertContext([anon], anon, clock)).toMatchObject({ signedIn: false, user: undefined, steps: [] });
  const cron = line({ t: at('05:00:00'), evt: 'vm.sync', lvl: 'error', src: 'server', msg: 'VolleyManager unreachable' });
  expect(alertContext([cron], cron, clock)).toBeNull();
});

test('device names for the phones and laptops the coaches use', () => {
  expect(deviceSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1')).toBe('iPhone iOS 18.1 · Safari 18.1');
  expect(deviceSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Windows · Edge 131');
  expect(deviceSummary('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Linux · Firefox 133');
  expect(deviceSummary('Mozilla/5.0 (Linux; Android 14; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36')).toBe('Android 14 · Android WebView');
  expect(deviceSummary('')).toBe('');
});

test.describe('a body the caller broke off is not an error', () => {
  // What raw-body throws when the phone leaves mid-upload (13.10.2026, POST
  // /api/client-logs at 21:38): mailed as an error until this.
  test('a phone leaving mid-upload', () => {
    const aborted = Object.assign(new Error('request aborted'), { name: 'BadRequestError', type: 'request.aborted', status: 400 });
    expect(callerBodyError(aborted)).toBe('request.aborted');
  });

  test('a body over the limit', () => {
    expect(callerBodyError(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }))).toBe('entity.too.large');
  });

  test('our own stream bug and plain errors still are', () => {
    expect(callerBodyError(Object.assign(new Error('stream is not readable'), { type: 'stream.not.readable', status: 500 }))).toBeNull();
    expect(callerBodyError(new Error('boom'))).toBeNull();
    expect(callerBodyError(null)).toBeNull();
    expect(callerBodyError('request aborted')).toBeNull();
  });
});
