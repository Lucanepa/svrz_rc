import { test, expect } from '@playwright/test';
import { fetchBoerseOffers, VM_ROLE_FOR_BOERSE } from '../server/boerse.ts';

// A fake VolleyManager behind the global fetch: enough pages for one poll to
// log in, read its role and search an empty börse. It counts logins, which is
// the whole point: VolleyManager blocked this server on 25.11.2026, likeliest
// for logging in afresh on every hourly poll.
function fakeVm() {
  const state = { logins: 0, liveSessions: new Set<string>(), searchStatus: 200 };
  const role = `$convertFromBackendToFrontend({&quot;activeAttributeValue&quot;:{&quot;persistenceObjectIdentifier&quot;:&quot;${VM_ROLE_FOR_BOERSE}&quot;}})`;
  const fetchStub = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const cookie = String((init.headers as Record<string, string> | undefined)?.Cookie ?? '');
    const session = cookie.match(/vm_session=([^;]+)/)?.[1] ?? '';
    const loggedIn = state.liveSessions.has(session);
    if (url.pathname === '/login') {
      return new Response('<input type="hidden" name="__trustedProperties" value="x">', { status: 200 });
    }
    if (url.pathname === '/sportmanager.security/authentication/authenticate') {
      state.logins += 1;
      const id = `s${state.logins}`;
      state.liveSessions.add(id);
      return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `vm_session=${id}; path=/` } });
    }
    if (url.pathname === '/') {
      return new Response(loggedIn ? `<div data-csrf-token="T" :active-party="${role}"></div>` : '<title>Login</title>', { status: 200 });
    }
    if (url.pathname === '/indoorvolleyball.refadmin/refereegameexchange/index') {
      return new Response('<div data-csrf-token="T"></div>', { status: loggedIn ? 200 : 403 });
    }
    if (url.pathname.endsWith('/search')) {
      return new Response(JSON.stringify({ items: [], totalItemsCount: 0 }), { status: state.searchStatus });
    }
    return new Response('', { status: 404 });
  };
  return { state, fetchStub };
}

test('one login serves the polls after it, until VolleyManager ends it, a poll fails, or 6 h pass', async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const vm = fakeVm();
  globalThis.fetch = vm.fetchStub as typeof fetch;
  const poll = () => fetchBoerseOffers({ base: 'https://vm.test', username: 'u', password: 'p' });
  try {
    await test.step('the first poll logs in, the second reuses it', async () => {
      expect((await poll()).ok).toBe(true);
      expect((await poll()).ok).toBe(true);
      expect(vm.state.logins).toBe(1);
    });
    await test.step('VolleyManager ended the session: the next poll logs in again', async () => {
      vm.state.liveSessions.clear();
      expect((await poll()).ok).toBe(true);
      expect(vm.state.logins).toBe(2);
    });
    await test.step('a failed poll keeps nothing: the next one logs in afresh', async () => {
      vm.state.searchStatus = 500;
      expect((await poll()).ok).toBe(false);
      vm.state.searchStatus = 200;
      expect((await poll()).ok).toBe(true);
      expect(vm.state.logins).toBe(3);
    });
    await test.step('past 6 h after its login the session is not reused', async () => {
      Date.now = () => realNow() + 6 * 60 * 60 * 1000 + 1000;
      expect((await poll()).ok).toBe(true);
      expect(vm.state.logins).toBe(4);
    });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});
