/**
 * Temporary debug script: fetch raw VM data for specific game numbers.
 * Usage: npx tsx debug-vm-game.ts 378325 382924
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const VM_BASE = process.env.VM_BASE || 'https://volleymanager.volleyball.ch';
const VM_USERNAME = process.env.VM_USERNAME!;
const VM_PASSWORD = process.env.VM_PASSWORD!;

class CookieJar {
  private cookies: Record<string, string> = {};

  update(response: Response) {
    const typedHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    for (const cookieHeader of typedHeaders.getSetCookie?.() ?? []) {
      const match = cookieHeader.match(/^([^=]+)=([^;]*)/);
      if (match) this.cookies[match[1]] = match[2];
    }
    const fallback = response.headers.get('set-cookie');
    if (fallback) {
      for (const part of fallback.split(/,(?=\s*\w+=)/)) {
        const match = part.trim().match(/^([^=]+)=([^;]*)/);
        if (match) this.cookies[match[1]] = match[2];
      }
    }
  }

  header(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function followRedirects(url: string, jar: CookieJar, init: RequestInit = {}, max = 10): Promise<{ response: Response; body: string }> {
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: 'manual' };
  for (let i = 0; i < max; i++) {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      Cookie: jar.header(),
      ...(typeof currentInit.headers === 'object' && !Array.isArray(currentInit.headers) ? currentInit.headers as Record<string, string> : {}),
    };
    const res = await fetch(currentUrl, { ...currentInit, headers });
    jar.update(res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
      currentInit = { redirect: 'manual' };
      continue;
    }
    const body = await res.text();
    return { response: res, body };
  }
  throw new Error(`Too many redirects: ${url}`);
}

async function login(): Promise<{ jar: CookieJar; csrfToken: string }> {
  const jar = new CookieJar();
  const { body: loginHtml } = await followRedirects(`${VM_BASE}/login`, jar);
  const hiddenFields: Record<string, string> = {};
  const hiddenRegex = /name="([^"]+)"[^>]*value="([^"]*?)"/g;
  for (const m of loginHtml.matchAll(hiddenRegex)) {
    hiddenFields[m[1]] = m[2];
  }
  hiddenFields['__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]'] = VM_USERNAME;
  hiddenFields['__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]'] = VM_PASSWORD;

  console.log(`  Login fields: ${Object.keys(hiddenFields).join(', ')}`);
  console.log(`  Username: ${VM_USERNAME}`);

  const authResult = await followRedirects(`${VM_BASE}/sportmanager.security/authentication/authenticate`, jar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(hiddenFields).toString(),
  });
  const authTitle = authResult.body.match(/<title>([^<]+)<\/title>/i);
  console.log(`  Auth result page: ${authTitle?.[1]?.trim() ?? 'unknown'}, cookies: ${jar.header().slice(0, 100)}...`);

  const tokenPatterns = [
    /data-csrf-token="([^"]+)"/,
    /name="__csrfToken"[^>]*value="([^"]+)"/,
    /name="_csrf"[^>]*value="([^"]+)"/,
    /meta\s+name="csrf-token"\s+content="([^"]+)"/,
  ];

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) {
      console.log(`  CSRF attempt ${attempt}/10, waiting 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
    const { body } = await followRedirects(
      `${VM_BASE}/indoorvolleyball.refadmin/refereegame/index`,
      jar,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
          Referer: `${VM_BASE}/`,
        },
      },
    );
    for (const p of tokenPatterns) {
      const m = body.match(p);
      if (m?.[1]) return { jar, csrfToken: m[1] };
    }
    // Debug: show what page we got
    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    console.log(`  Page title: ${titleMatch?.[1] ?? 'unknown'}, has login form: ${body.includes('/login')}`);
  }
  throw new Error('Failed to get CSRF token');
}

async function fetchGame(jar: CookieJar, csrfToken: string, gameNumber: string) {
  // Use date range search but very wide, and fetch all properties
  // The API returns all object properties regardless of render config
  const params = new URLSearchParams();
  // Use a very wide date range to find the game
  params.set('searchConfiguration[propertyFilters][0][propertyName]', 'game.startingDateTime');
  params.set('searchConfiguration[propertyFilters][0][dateRange][from]', '2024-08-01T00:00:00');
  params.set('searchConfiguration[propertyFilters][0][dateRange][to]', '2026-06-30T23:59:59');
  // Filter by game number via text search
  params.set('searchConfiguration[textSearch]', gameNumber);
  params.set('searchConfiguration[customFilters]', '');
  params.set('searchConfiguration[offset]', '0');
  params.set('searchConfiguration[limit]', '10');
  params.set('searchConfiguration[textSearchOperator]', 'AND');
  params.set('__csrfToken', csrfToken);

  const url = `${VM_BASE}/api/indoorvolleyball.refadmin/api%5celasticsearchrefereegame/searchForManagingAssociation`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${VM_BASE}/indoorvolleyball.refadmin/refereegame/index`,
      Cookie: jar.header(),
    },
    body: params.toString(),
  });

  if (!res.ok) {
    console.error(`Failed to fetch game ${gameNumber}: ${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
    return null;
  }
  const data = await res.json() as { items?: unknown[]; totalItemsCount?: number };
  console.log(`\n========== Game ${gameNumber}: ${data.totalItemsCount ?? 0} results ==========`);

  if (data.items && data.items.length > 0) {
    // Find the exact game by number
    const exact = (data.items as Record<string, unknown>[]).find(item => {
      const game = item.game as Record<string, unknown> | undefined;
      return game && String(game.number) === gameNumber;
    });
    const item = exact ?? data.items[0];
    console.log(JSON.stringify(item, null, 2));
  } else {
    console.log('No items found');
  }
  return data;
}

async function main() {
  const gameNumbers = process.argv.slice(2);
  if (gameNumbers.length === 0) {
    console.log('Usage: npx tsx debug-vm-game.ts <gameNumber1> [gameNumber2] ...');
    process.exit(1);
  }

  console.log('Logging into VolleyManager...');
  const { jar, csrfToken } = await login();
  console.log('Logged in successfully!\n');

  for (const gn of gameNumbers) {
    await fetchGame(jar, csrfToken, gn);
  }
}

main().catch(console.error);
