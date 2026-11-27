// One VolleyManager account, three jobs that each need a different role.
//
// VM keeps the active role per ACCOUNT, not per session, and it persists across
// logins — so the games sync (RefereeDelegate), the contact sync (a club role)
// and the SR-Börse poller (RefAdmin:Referee) cannot be in flight together
// without one of them reading under another's role. Two of the three then fail
// in the worst possible way: not a 403, but a clean 200 with the wrong rows.
// The account is also shared with the wiedisync project, which this process
// cannot see at all.
//
// `withVmLock` is the answer for jobs that MUST run: they queue. `tryVmLock` is
// the answer for the poller, which runs many times a day and should drop its
// turn rather than pile up behind a job that is already talking to VM.
//
// The distinction matters because the obvious implementation — reuse the
// existing chainOnKey — has no try-acquire form: it queues unconditionally. A
// poller on a queue with no timeout is a deadlock with extra steps, and the one
// it would deadlock is the 05:00 games import.

/** How long any single VolleyManager request may take before it is abandoned.
 *  Node's fetch has NO default timeout: a connection dropped mid-response by a
 *  NAT table never resolves and never rejects. Without this, one half-open
 *  socket would hold the lock for the life of the process. */
export const VM_REQUEST_TIMEOUT_MS = Number(process.env.VM_REQUEST_TIMEOUT_MS || 45000);

/** How long a whole job may hold the lock. A job that overruns it does not get
 *  cancelled — it cannot be, it may be mid-write — but it stops blocking the
 *  others, which is the failure we actually care about. */
export const VM_JOB_TIMEOUT_MS = Number(process.env.VM_JOB_TIMEOUT_MS || 15 * 60 * 1000);

type Holder = { label: string; since: number };

let holder: Holder | null = null;
let waiters: Array<() => void> = [];
let jobTimeoutMs = VM_JOB_TIMEOUT_MS;

function release(mine: Holder): void {
  if (holder !== mine) return; // a takeover already happened; not ours to release
  holder = null;
  const next = waiters.shift();
  if (next) next();
}

/** True while any VM job holds the lock. Exported for the admin status card. */
export function vmLockHeldBy(): { label: string; heldMs: number } | null {
  return holder ? { label: holder.label, heldMs: Date.now() - holder.since } : null;
}

function takeoverIfStale(): void {
  if (!holder) return;
  if (Date.now() - holder.since < jobTimeoutMs) return;
  // The previous job has outrun its deadline. Let it finish in the background —
  // release() checks identity, so its eventual release is a no-op — and hand the
  // lock on, because a stuck job must not take the nightly import with it.
  holder = null;
}

/**
 * Run `fn` with exclusive access to the VolleyManager account, queueing behind
 * whatever holds it. For work that must not be skipped: the games sync, the
 * contact sync, and the two manual sync endpoints.
 */
export function withVmLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  takeoverIfStale();
  if (!holder) {
    const mine: Holder = { label, since: Date.now() };
    holder = mine;
    return (async () => fn())().finally(() => release(mine));
  }
  return new Promise<T>((resolve, reject) => {
    waiters.push(() => {
      const mine: Holder = { label, since: Date.now() };
      holder = mine;
      (async () => fn())().then(resolve, reject).finally(() => release(mine));
    });
  });
}

// FLAT, not a discriminated union: this tsconfig has no `strict`, so a boolean
// literal tag does not narrow and `result.blockedBy` would be unreachable to the
// checker inside `if (!result.ran)`.
export type TryVmLockResult<T> = { ran: boolean; value: T | undefined; blockedBy: string };

/**
 * Run `fn` only if the account is free right now; otherwise skip this turn.
 * Returns `{ ran: false, blockedBy }` rather than throwing, so a poller can
 * record an honest "skipped" instead of an error, and — crucially — never
 * queues, so a slow VM cannot leave 40 pending polls stacked in front of the
 * 05:00 import.
 */
export function tryVmLock<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<TryVmLockResult<T>> {
  takeoverIfStale();
  if (holder) return Promise.resolve({ ran: false, value: undefined, blockedBy: holder.label });
  const mine: Holder = { label, since: Date.now() };
  holder = mine;
  return (async () => ({ ran: true, value: await fn(), blockedBy: '' }))().finally(() => release(mine));
}

// ── When VolleyManager blocks the address ────────────────────────────
//
// 25.11.2026: VolleyManager's web server started refusing this server's address
// with its stock "403 Forbidden" page, before the app is even reached. The
// retries and polls kept knocking (one blocked nightly run was ~36 requests),
// which is the opposite of what a blocked client should do. Now the first such
// answer stops every VolleyManager call; the next nightly run is the one probe.

/** Thrown instead of a request while the address is blocked. */
export class VmBlockedError extends Error {}

/** 23 h, not 24: a block found by the 01:00 sync must let the next 01:00 sync
 *  through as the probe, and that one starts a few seconds earlier in the hour. */
export const VM_BLOCK_PAUSE_MS = 23 * 60 * 60 * 1000;
let blockedUntil = 0;

/** The web server's own refusal page. VolleyManager's role 403s come from the
 *  app and never carry this title, so a wrong role cannot trip the stop. */
export function isWebServerBlock(body: string): boolean {
  return /<title>\s*403 Forbidden\s*<\/title>/i.test(body);
}

/**
 * fetch with a deadline, for every VolleyManager call — and the one place that
 * stops calling once VolleyManager blocks the address (above).
 *
 * Callers that already pass their own `signal` keep it — this only fills in the
 * timeout when there is none, so an abortable job stays abortable.
 */
export async function vmFetch(url: string, init: RequestInit = {}, timeoutMs = VM_REQUEST_TIMEOUT_MS): Promise<Response> {
  if (Date.now() < blockedUntil) {
    throw new VmBlockedError(`VolleyManager blocks this server's address: no VolleyManager calls until ${new Date(blockedUntil).toISOString()} (restart svrz-api to try sooner)`);
  }
  const res = await fetch(url, init.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 403 && isWebServerBlock(await res.clone().text())) {
    blockedUntil = Date.now() + VM_BLOCK_PAUSE_MS;
    throw new VmBlockedError(`VolleyManager's web server refused this address (403 Forbidden, ${new URL(url).pathname}): VolleyManager calls stop for ${VM_BLOCK_PAUSE_MS / 3_600_000} h`);
  }
  return res;
}

/** Test seam: drop all lock state. Never call this from request handling. */
export function __resetVmLock(): void {
  holder = null;
  waiters = [];
  jobTimeoutMs = VM_JOB_TIMEOUT_MS;
  blockedUntil = 0;
}

/** Test seam: shorten the takeover deadline so the stuck-job path is testable
 *  without waiting fifteen minutes. Never call this from request handling. */
export function __setVmJobTimeoutMs(ms: number): void {
  jobTimeoutMs = ms;
}
