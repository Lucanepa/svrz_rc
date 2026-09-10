import { test, expect } from '@playwright/test';
import { withVmLock, tryVmLock, vmLockHeldBy, __resetVmLock, __setVmJobTimeoutMs } from '../server/vmlock';

/**
 * The mutual exclusion around the one shared VolleyManager account.
 *
 * Three jobs need three different roles on one login whose active role is
 * server-side state at VM and persists across sessions — the games sync, the
 * contact sync, and the SR-Börse poller. Overlap them and the loser reads under
 * the winner's role, which for two of the three does not 403: it answers 200
 * with the wrong rows. A silent wrong answer is the failure this file exists to
 * prevent, and it has already cost this project three weeks once.
 *
 * No browser needed, so it runs in milliseconds — the sw-reload-guard idiom.
 */

// A job that parks until the test lets it finish, so overlap is observable
// rather than inferred from timing.
function gate() {
  let open: () => void;
  const waited = new Promise<void>((r) => { open = r; });
  return { waited, open: () => open() };
}

test.describe('the VolleyManager account lock', () => {
  test.beforeEach(() => __resetVmLock());

  test('runs a single job immediately and reports who holds it', async () => {
    const g = gate();
    let started = false;
    const job = withVmLock('games-sync', async () => { started = true; await g.waited; return 'done'; });

    await Promise.resolve();
    expect(started).toBe(true);
    expect(vmLockHeldBy()?.label).toBe('games-sync');

    g.open();
    expect(await job).toBe('done');
    expect(vmLockHeldBy()).toBeNull();
  });

  test('never lets two must-run jobs touch the account at the same time', async () => {
    const order: string[] = [];
    const first = gate();

    const a = withVmLock('games-sync', async () => {
      order.push('a:start'); await first.waited; order.push('a:end');
    });
    const b = withVmLock('contacts-sync', async () => { order.push('b:start'); });

    await Promise.resolve();
    // b must not have started while a holds the account
    expect(order).toEqual(['a:start']);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  test('releases the account when a job throws, instead of wedging it', async () => {
    await expect(withVmLock('games-sync', async () => { throw new Error('VM 403'); }))
      .rejects.toThrow('VM 403');
    expect(vmLockHeldBy()).toBeNull();

    // the next job still gets in
    expect(await withVmLock('boerse-poll', async () => 'ok')).toBe('ok');
  });

  test('a queued job still runs after the one in front of it fails', async () => {
    const g = gate();
    const failing = withVmLock('games-sync', async () => { await g.waited; throw new Error('VM 403'); });
    const queued = withVmLock('contacts-sync', async () => 'ran anyway');

    g.open();
    await expect(failing).rejects.toThrow('VM 403');
    expect(await queued).toBe('ran anyway');
  });

  // The poller is the reason tryVmLock exists. chainOnKey — the lock primitive
  // already in server/index.ts — has no try-acquire form: it queues
  // unconditionally. A poller that queues would stack one pending run per
  // interval in front of the 05:00 games import for as long as VM is slow.
  test('the poller SKIPS rather than queues when the account is busy', async () => {
    const g = gate();
    let pollRan = false;

    const sync = withVmLock('games-sync', async () => { await g.waited; });
    const poll = await tryVmLock('boerse-poll', async () => { pollRan = true; });

    expect(poll).toEqual({ ran: false, blockedBy: 'games-sync' });
    expect(pollRan).toBe(false);

    g.open();
    await sync;
  });

  test('the poller runs when the account is free', async () => {
    const poll = await tryVmLock('boerse-poll', async () => 37);
    // `blockedBy` is '' rather than absent: the result is a FLAT type, because
    // this tsconfig has no `strict` and a boolean tag would not narrow.
    expect(poll).toEqual({ ran: true, value: 37, blockedBy: '' });
    expect(vmLockHeldBy()).toBeNull();
  });

  test('a poll that skipped does not leave the account marked busy', async () => {
    const g = gate();
    const sync = withVmLock('games-sync', async () => { await g.waited; });
    await tryVmLock('boerse-poll', async () => 'never');
    g.open();
    await sync;
    expect(vmLockHeldBy()).toBeNull();
  });

  // Node's fetch has no default timeout, so a connection dropped mid-response
  // never resolves and never rejects. Without a takeover, one half-open socket
  // in a 20-minute poller would hold the account for the life of the process
  // and take the nightly import with it — the lock added to make the shared
  // account safe would be what killed it.
  test('a job that outruns its deadline stops blocking the others', async () => {
    __setVmJobTimeoutMs(0);
    const stuck = gate();
    const hung = withVmLock('boerse-poll', async () => { await stuck.waited; return 'late'; });

    const rescued = await tryVmLock('games-sync', async () => 'got in');
    expect(rescued).toEqual({ ran: true, value: 'got in', blockedBy: '' });

    // the abandoned job still settles, and its release does not steal the lock
    // from whoever holds it by then
    stuck.open();
    expect(await hung).toBe('late');

    const after = gate();
    const holderNow = withVmLock('contacts-sync', async () => { await after.waited; });
    __setVmJobTimeoutMs(60_000);
    expect(vmLockHeldBy()?.label).toBe('contacts-sync');
    after.open();
    await holderNow;
  });
});
