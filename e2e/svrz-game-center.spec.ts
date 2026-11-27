import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parseGameCenterGame, fetchGameCenterGame } from '../server/svrzGameCenter';

// The referee source that replaces the blocked VolleyManager login: the SVRZ
// public Game Center. The fixtures are SYNTHETIC — they mirror the real page's
// structure (the `self.__next_f.push([1,"…game…"])` RSC chunk and the game
// object's field names), with invented teams, halls and referees, so no real
// person's name or SV number lives in this repo. The parser was verified
// against the live site separately.
const played = readFileSync(new URL('./fixtures/game-center-played.html', import.meta.url), 'utf8');
const upcoming = readFileSync(new URL('./fixtures/game-center-upcoming.html', import.meta.url), 'utf8');

test.describe('SVRZ Game Center parsing', () => {
  test('pulls game number, schedule, teams, league and the result', () => {
    const g = parseGameCenterGame(played)!;
    expect(g).not.toBeNull();
    expect(g.match_no).toBe('999001');
    expect(g.match_date).toBe('2026-10-04 18:00:00');
    expect(g.home_team).toBe('Test Home TV');
    expect(g.away_team).toBe('Test Away VBC');
    expect(g.league).toBe('3L');
    expect(g.gender).toBe('m');
    expect(g.location).toContain('Test Hall');
    expect(g.location).toContain('8000 Zürich');
    expect(g.played).toBe(true);
    expect(g.game_result).toBe('3:0'); // 25:20, 25:18, 25:22
  });

  test('pulls both referees WITH their SV numbers — the field the iCal feeds lack', () => {
    const g = parseGameCenterGame(played)!;
    expect(g.first_referee).toBe('Max Muster');
    expect(g.first_referee_id).toBe('11111');
    expect(g.second_referee).toBe('Erika Beispiel');
    expect(g.second_referee_id).toBe('22222');
  });

  test('marks and line judges are absent, not invented', () => {
    const g = parseGameCenterGame(played)!;
    expect(g.is_rd_game).toBe(false);
    expect(g.is_rsv_game).toBe(false);
    expect(g.first_line_judge).toBe('');
    expect(g.second_line_judge).toBe('');
  });

  // The `status` field is NOT "played": the live site reports status 2 for both
  // upcoming and played games, so only the presence of a result may mark a game
  // played — else every future game would read as finished.
  test('an upcoming game (no result) is not played but still carries its referees', () => {
    const g = parseGameCenterGame(upcoming)!;
    expect(g.match_no).toBe('999002');
    expect(g.played).toBe(false);
    expect(g.game_result).toBe('');
    expect(g.first_referee_id).toBe('33333');
    expect(g.second_referee_id).toBe('44444');
  });

  test('a page with no game object (404/maintenance) parses to null, not a throw', () => {
    expect(parseGameCenterGame('<html><body>nope</body></html>')).toBeNull();
  });

  test('fetch builds the right URL and returns the parsed game', async () => {
    let called = '';
    const fakeFetch = (async (url: string) => {
      called = String(url);
      return new Response(played, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const g = await fetchGameCenterGame(999001, fakeFetch);
    expect(called).toBe('https://www.svrz.ch/game-center/game/999001');
    expect(g?.first_referee_id).toBe('11111');
  });

  test('fetch throws on a non-200 so a blocked/erroring page is never read as "no referees"', async () => {
    const fakeFetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchGameCenterGame(999001, fakeFetch)).rejects.toThrow(/503/);
  });
});
