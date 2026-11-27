import { test, expect } from '@playwright/test';
import { parseActionGames, dateChunks, fetchGameCenterGames, __setActionId, type GameCenterGame } from '../server/svrzGameCenter';
import { transformGameCenterGame, refereesSeen, storedMatchDate } from '../server/gamesSync';

// The games source that replaced the blocked VolleyManager login: the SVRZ
// public Game Center's own schedule action. All data here is SYNTHETIC — the
// shapes are the live ones (checked 27.11.2026), the teams, halls and referees
// are invented, so no real person's name or SV number lives in this repo.

const game = (over: Partial<GameCenterGame> & Record<string, unknown> = {}): GameCenterGame => ({
  gameId: 999001,
  playDate: '2026-10-04 18:00:00',
  playDateUtc: '2026-10-04T16:00:00Z',
  gender: 'm',
  teams: { home: { caption: 'Test Home TV' }, away: { caption: 'Test Away VBC' } },
  league: { caption: '3L' },
  group: { caption: 'Männer 3. Liga Gruppe A' },
  hall: { caption: 'Test Hall', street: 'Teststrasse', number: '1', zip: 8000, city: 'Zürich', latitude: 47.1, longitude: 8.2, plusCode: '8FVC9G00+AA' },
  referees: { '1': { refereeId: 11111, firstName: 'Max', lastName: 'Muster' }, '2': { refereeId: 22222, firstName: 'Erika', lastName: 'Beispiel' } },
  setResults: { '1': { home: 25, away: 20 }, '2': { home: 18, away: 25 }, '3': { home: 25, away: 22 }, '4': { home: 25, away: 23 } },
  ...over,
});

/** A server-action answer the way svrz.ch sends it: React flight lines. */
const flight = (games: unknown) => `0:["$@1",["build",null]]\n1:${JSON.stringify(games)}\n`;

test.describe('Game Center action answers', () => {
  test('line 1 is the game list', () => {
    expect(parseActionGames(flight([game()]))?.[0].gameId).toBe(999001);
  });
  test('an empty list is a valid answer (a window with no games)', () => {
    expect(parseActionGames(flight([]))).toEqual([]);
  });
  test('an error or another action is not a game list', () => {
    expect(parseActionGames('0:["$@1",["b",null]]\n1:E{"digest":"1"}\n')).toBeNull();
    expect(parseActionGames(flight({ team: [] }))).toBeNull();
    expect(parseActionGames(flight([{ leagueId: 1 }]))).toBeNull();
    expect(parseActionGames('<html>nope</html>')).toBeNull();
  });
});

test.describe('date windows (dateEnd is exclusive at the Game Center)', () => {
  test('one day asks for [day, next day)', () => {
    expect(dateChunks('2026-11-01', '2026-11-01')).toEqual([['2026-11-01', '2026-11-02']]);
  });
  test('a long window is contiguous chunks that end the day after `to`', () => {
    const c = dateChunks('2026-11-01', '2027-01-04', 31);
    expect(c).toEqual([['2026-11-01', '2026-12-02'], ['2026-12-02', '2027-01-02'], ['2027-01-02', '2027-01-05']]);
  });
});

test.describe('fetching the region', () => {
  test.beforeEach(() => __setActionId('a'.repeat(40)));

  test('reads SVRZ whole and Swiss Volley for 1L and the Mobiliar Cup only, one row per game', async () => {
    const asked: string[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body))[0] as string;
      asked.push(q);
      const list = q.includes('region=SVRZ')
        ? [game({ gameId: 1 }), game({ gameId: 2 })]
        : [game({ gameId: 2, league: { caption: 'Mobiliar Volley Cup' } }), game({ gameId: 3, league: { caption: 'Mobiliar Volley Cup' } }),
          game({ gameId: 4, league: { caption: '1L' } }), game({ gameId: 5, league: { caption: 'NLB' } })];
      return new Response(flight(list), { status: 200 });
    }) as unknown as typeof fetch;
    const games = await fetchGameCenterGames('2026-11-01', '2026-11-07', fake);
    expect(games.map((g) => g.gameId).sort()).toEqual([1, 2, 3, 4]);
    expect(asked).toEqual([
      '?region=SVRZ&includeCup=1&dateStart=2026-11-01&dateEnd=2026-11-08',
      '?region=SV&includeCup=1&dateStart=2026-11-01&dateEnd=2026-11-08',
    ]);
  });

  test('a failed call fails the whole read, so a partial schedule is never taken for all of it', async () => {
    let n = 0;
    const fake = (async (url: string) => {
      n += 1;
      if (String(url).endsWith('/game-center') && n === 1) return new Response(flight([game()]), { status: 200 });
      if (String(url).endsWith('/game-center')) return new Response('', { status: 503 });
      return new Response('<html></html>', { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchGameCenterGames('2026-11-01', '2026-11-07', fake)).rejects.toThrow();
  });

  test('after a svrz.ch redeploy it finds the new action id in the page scripts', async () => {
    const NEW = 'b'.repeat(40);
    const OTHER = 'c'.repeat(40);
    const fake = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') {
        const id = (init.headers as Record<string, string>)['Next-Action'];
        if (id === NEW) return new Response(flight([game()]), { status: 200 });
        if (id === OTHER) return new Response(flight([]), { status: 200 }); // another action, empty answer
        return new Response('', { status: 404 }); // the stale id
      }
      if (u.endsWith('/game-center')) return new Response('<script src="/_next/static/chunks/854-x.js"></script>', { status: 200 });
      return new Response(`var c=(0,l.$)("${OTHER}"),d=(0,l.$)("${NEW}");`, { status: 200 });
    }) as unknown as typeof fetch;
    const games = await fetchGameCenterGames('2026-11-01', '2026-11-01', fake);
    expect(games.length).toBe(1);
  });
});

test.describe('rows in the VolleyManager shape', () => {
  test('league wording matches what is stored, for every kind of league', () => {
    const league = (caption: string, group: string, gender = 'f') =>
      transformGameCenterGame(game({ league: { caption }, group: { caption: group }, gender })).league;
    expect(league('2L', 'Frauen 2. Liga')).toBe('2L ♀');
    expect(league('3L', 'Männer 3. Liga Gruppe A', 'm')).toBe('3L ♂ A');
    expect(league('5L', 'Frauen 5. Liga Gruppe D')).toBe('5L ♀ D');
    expect(league('1L', 'D')).toBe('1L ♀ D'); // 1L groups are a bare letter
    expect(league('1L', 'C', 'm')).toBe('1L ♂ C');
    expect(league('U23', 'Frauen U23 2. Stärkeklasse')).toBe('DU23 2. Liga');
    expect(league('U23', 'Männer U23 1. Stärkeklasse', 'm')).toBe('HU23 1. Liga');
    expect(league('SM Quali U23', 'SM Quali MU23 A', 'm')).toBe('SM Quali U23 ♂');
    expect(league('Züri Cup', 'Runde 3, Spiel 3')).toBe('Züri Cup ♀');
    expect(league('Mobiliar Volley Cup', 'Runde 4, Spiel 8')).toBe('Mobiliar Volley Cup ♀');
  });

  test('result, date, hall, maps link and referees as VolleyManager wrote them', () => {
    const row = transformGameCenterGame(game());
    expect(row.match_no).toBe('999001');
    expect(row.external_id).toBe('999001');
    expect(row.match_date).toBe('2026-10-04T16:00:00.000000+00:00');
    expect(row.game_result).toBe('3:1 (25:20 / 18:25 / 25:22 / 25:23)');
    expect(row.location).toBe('Test Hall, Teststrasse 1, 8000 Zürich');
    expect(row.maps_url).toBe('https://www.google.com/maps/place/8FVC9G00%2BAA');
    expect(row.first_referee).toBe('Max Muster');
    expect(row.first_referee_id).toBe('11111');
    expect(row.second_referee).toBe('Erika Beispiel');
    expect(row.second_referee_id).toBe('22222');
    expect(row.is_rd_game).toBe(false);
    expect(row.first_line_judge).toBe('');
  });

  test('an upcoming game with no referees yet has empty slots and no result', () => {
    const row = transformGameCenterGame(game({ referees: {}, setResults: {} }));
    expect(row.first_referee).toBe('');
    expect(row.second_referee_id).toBe('');
    expect(row.game_result).toBe('');
  });

  test('the stored date text', () => {
    expect(storedMatchDate('2026-11-06T19:00:00Z')).toBe('2026-11-06T19:00:00.000000+00:00');
    expect(storedMatchDate('')).toBe('');
  });
});

test.describe('referee directory', () => {
  test('the referee directory has everyone once, by SV number', () => {
    const rows = [
      transformGameCenterGame(game({ gameId: 1 })),
      transformGameCenterGame(game({ gameId: 2, referees: { '1': { refereeId: 11111, firstName: 'Max', lastName: 'Muster' } } })),
    ];
    expect(refereesSeen(rows).map((p) => `${p.id} ${p.name}`)).toEqual(['22222 Erika Beispiel', '11111 Max Muster']);
  });
});
