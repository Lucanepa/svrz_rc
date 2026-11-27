// Games and their referees from the SVRZ public Game Center.
//
// Since 25.11.2026 VolleyManager's web server (185.195.199.53) refuses this
// server's address, so the login-based games sync is dead. The SVRZ Game Center
// (https://www.svrz.ch, a separate public site on a different host) shows every
// game of the region with its two referees and their SV numbers. This reads it
// the way its own page does; no login, no VolleyManager.
//
// How the page gets its data (found 27.11.2026): the schedule calls a Next.js
// server action — POST /game-center with a `Next-Action: <id>` header and the
// body `["?region=SVRZ&includeCup=1&dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD"]`.
// It answers in React's flight format; line `1:` is a JSON array of games, each
// with gameId (= the VolleyManager game number svrz_rc keys on), playDateUtc,
// teams, league, group, hall, referees {"1":{refereeId,firstName,lastName},…}
// and setResults. `dateEnd` is EXCLUSIVE.
//
// The action id is a build hash: it changes whenever svrz.ch redeploys. When the
// cached one stops answering with a game list, discoverActionId() reads the
// page's own scripts, tries each server reference in them, and keeps the one
// that returns games.
//
// Left empty in the rows it makes: line judges (SVRZ games have none; only NLA
// does, outside this sync's scope) and VolleyManager's RD/RSV observation marks
// (not published anywhere in the Game Center).

export type GameCenterGame = {
  gameId: number | string;
  playDate?: string;
  playDateUtc?: string;
  gender?: string;
  teams?: { home?: { caption?: string }; away?: { caption?: string } };
  league?: { caption?: string };
  group?: { caption?: string };
  hall?: {
    caption?: string; street?: string; number?: string | number; zip?: string | number; city?: string;
    latitude?: number; longitude?: number; plusCode?: string;
  };
  referees?: Record<string, { refereeId?: unknown; firstName?: string; lastName?: string } | null>;
  setResults?: Record<string, { home?: unknown; away?: unknown } | null>;
};

export const GAME_CENTER_BASE = process.env.SVRZ_GAME_CENTER_BASE || 'https://www.svrz.ch';
const TIMEOUT_MS = Number(process.env.SVRZ_GAME_CENTER_TIMEOUT_MS || 60_000);
const HEADERS = { 'User-Agent': 'svrz-rc-gamecenter/1.0', 'Accept-Language': 'de-CH,de;q=0.9' };

/** What the sync reads. The whole region, plus the one Swiss Volley
 *  competition VolleyManager used to list for SVRZ referees besides 1L. 1L is
 *  left out on purpose (owner, 27.11.2026). */
export const GAME_CENTER_SCOPES: Array<{ region: string; keep: (g: GameCenterGame) => boolean }> = [
  { region: 'SVRZ', keep: () => true },
  // shortcut: reads all of Swiss Volley's games in the window to keep ~20 cup
  // games (a few MB a night); filter by the cup's leagueId if that ever matters.
  { region: 'SV', keep: (g) => g.league?.caption === 'Mobiliar Volley Cup' },
];

/** The game list in a server-action answer, or null when the answer is not
 *  one (an error, or a different action). An empty list is a valid answer. */
export function parseActionGames(text: string): GameCenterGame[] | null {
  const line = text.split('\n').find((l) => l.startsWith('1:'));
  if (!line) return null;
  let value: unknown;
  try { value = JSON.parse(line.slice(2)); } catch { return null; }
  if (!Array.isArray(value)) return null;
  return value.every((g) => g && typeof g === 'object' && 'gameId' in g) ? value as GameCenterGame[] : null;
}

/** [dateStart, dateEnd) pairs of at most `days` days covering from..to
 *  (both YYYY-MM-DD, inclusive). dateEnd is exclusive at the Game Center, so the
 *  last pair ends the day AFTER `to`. */
export function dateChunks(from: string, to: string, days = 31): Array<[string, string]> {
  const day = 86_400_000;
  const end = Date.parse(`${to}T00:00:00Z`) + day;
  const out: Array<[string, string]> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t < end; t += days * day) {
    out.push([new Date(t).toISOString().slice(0, 10), new Date(Math.min(t + days * day, end)).toISOString().slice(0, 10)]);
  }
  return out;
}

let actionId = process.env.SVRZ_GC_GAMES_ACTION || '4f4a04331e8b7f7726ca7b74caf8b2e1358570d4';

async function callAction(id: string, query: string, fetchImpl: typeof fetch): Promise<GameCenterGame[] | null> {
  const res = await fetchImpl(`${GAME_CENTER_BASE}/game-center`, {
    method: 'POST',
    headers: { ...HEADERS, 'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify([query]),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  // Decoded as UTF-8 explicitly: the answer carries no charset, and "Rämi" must
  // not come back as "RÃ¤mi".
  return parseActionGames(Buffer.from(await res.arrayBuffer()).toString('utf8'));
}

/** Find the games action again after a svrz.ch redeploy: every server reference
 *  in the page's scripts, tried with `probe`, and the first that returns a
 *  NON-empty game list wins (another action can answer an empty array). */
async function discoverActionId(probe: string, fetchImpl: typeof fetch): Promise<string> {
  const page = await (await fetchImpl(`${GAME_CENTER_BASE}/game-center`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })).text();
  const scripts = [...new Set(page.match(/\/_next\/static\/chunks\/[^"'\s]+\.js/g) ?? [])];
  const ids = new Set<string>();
  for (const src of scripts) {
    const js = await (await fetchImpl(`${GAME_CENTER_BASE}${src}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })).text();
    for (const m of js.matchAll(/\.\$\)\("([0-9a-f]{40})"\)/g)) ids.add(m[1]);
  }
  for (const id of ids) {
    const games = await callAction(id, probe, fetchImpl).catch(() => null);
    if (games && games.length > 0) return id;
  }
  throw new Error(`Game Center: no server action among ${ids.size} answered with games — has svrz.ch changed its schedule?`);
}

/**
 * Every game in [from, to] (YYYY-MM-DD, inclusive) across GAME_CENTER_SCOPES,
 * one game per gameId. Sequential calls, a month per call. Throws if any call
 * fails, so a partial read is never taken for the whole schedule (the
 * missing-game watch relies on that).
 */
export async function fetchGameCenterGames(from: string, to: string, fetchImpl: typeof fetch = fetch): Promise<GameCenterGame[]> {
  const byId = new Map<string, GameCenterGame>();
  let rediscovered = false;
  for (const scope of GAME_CENTER_SCOPES) {
    for (const [start, end] of dateChunks(from, to)) {
      const query = `?region=${scope.region}&includeCup=1&dateStart=${start}&dateEnd=${end}`;
      let games = await callAction(actionId, query, fetchImpl);
      if (!games && !rediscovered) {
        rediscovered = true;
        actionId = await discoverActionId(`?region=SVRZ&includeCup=1&dateStart=${from}&dateEnd=${dateChunks(from, to, 100_000)[0][1]}`, fetchImpl);
        games = await callAction(actionId, query, fetchImpl);
      }
      if (!games) throw new Error(`Game Center did not answer with games for ${scope.region} ${start}..${end}`);
      for (const g of games) if (scope.keep(g)) byId.set(String(g.gameId), g);
    }
  }
  return [...byId.values()];
}

/** Test seam. */
export function __setActionId(id: string): void { actionId = id; }
