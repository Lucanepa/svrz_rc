// What the API says to a person, in their language (asked 2026-10-14: a coach
// reading the app in English got "Davide Carina hat schon eine geplante
// Beobachtung …" when a take was refused).
//
// Every message a handler sends back is written in both languages at the place
// it is written: `say('Spiel nicht gefunden.', 'Game not found.')`. say()
// returns the German — what the handler logs, what req.out records, what the
// mute rules and the error groups in Protokoll match on, all unchanged — and
// remembers the English beside it. The response hook in index.ts then puts the
// English on the wire for a request that asked for it (`inLanguage`).
//
// Why not read the language inside say(): a handler behind its own body parser
// runs in that parser's stream callback, outside any per-request context, and
// would silently answer in German. The hook has the request in hand; say()
// does not need it.
//
// The app sends its own language as `Accept-Language` (src/lib/apiLang.ts) — a
// CORS-safelisted header, so it costs no preflight. A client that does not set
// it sends the browser's, which is the next best guess.

import type { Request, Response, NextFunction } from 'express';

export type Lang = 'DE' | 'EN';

/** German → English, for the messages said recently. A message with a name or
 *  a date in it is a new key each time, so the table is bounded: the oldest
 *  pairs go first, and a pair is needed only between say() and the response
 *  a few milliseconds later. */
const MAX_PAIRS = 2_000;
const english = new Map<string, string>();

/** The German, with the English remembered for the response hook. */
export function say(de: string, en: string): string {
  if (english.has(de)) english.delete(de); // re-insert: most recent last
  english.set(de, en);
  if (english.size > MAX_PAIRS) english.delete(english.keys().next().value as string);
  return de;
}

/** The English said for this German, if any. */
export function englishFor(de: string): string | undefined {
  return english.get(de);
}

/** The language an `Accept-Language` header asks for: English when its most
 *  wanted of German and English is English, German otherwise — the app's own
 *  default, and the language every message is written in first. */
export function langOf(header: unknown): Lang {
  const value = Array.isArray(header) ? header.join(',') : typeof header === 'string' ? header : '';
  let best: { lang: Lang; q: number } | null = null;
  for (const part of value.split(',')) {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const primary = tag.split('-')[0];
    if (primary !== 'de' && primary !== 'en') continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { lang: primary === 'en' ? 'EN' : 'DE', q };
  }
  return best?.lang ?? 'DE';
}

/** A JSON body as the asker reads it: the `error` swapped for its English when
 *  they asked for English and one was said. Anything else goes out as it is. */
export function inLanguage(payload: unknown, lang: Lang): unknown {
  if (lang !== 'EN' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  if (typeof body.error !== 'string') return payload;
  const en = englishFor(body.error);
  return en === undefined ? payload : { ...body, error: en };
}

/** The response hook: every `res.json` of this request goes out in the
 *  language its Accept-Language asks for. Mounted first in index.ts, so what
 *  answers before the routes speaks it too; the request log wraps it again and
 *  records the German. */
export function answerInAskersLanguage(req: Request, res: Response, next: NextFunction): void {
  const lang = langOf(req.headers['accept-language']);
  const send = res.json.bind(res);
  res.json = ((payload: unknown) => send(inLanguage(payload, lang))) as typeof res.json;
  next();
}
