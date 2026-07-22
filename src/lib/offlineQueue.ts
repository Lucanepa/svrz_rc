// Offline outbox for feedback submissions, backed by IndexedDB (PDFs are too
// large for localStorage). The APP owns the send loop — not Workbox Background
// Sync — so it reports ACCURATE status: an item is removed only on a real 2xx
// (or a 409 = server already recorded it); a network/transient failure keeps
// the item queued for retry; a permanent server error marks it `terminal` so it
// stops auto-retrying and is surfaced to the coach to discard or fix. Every item
// is tagged with the RC id that created it and is only ever sent back under that
// same identity — so a queued item can never be submitted as a different coach.

export type OutboxPayload = {
  gameId: string;
  role: '1. SR' | '2. SR';
  formData: unknown;
  pdfBase64: string;
  pdfFilename: string;
  tipsAndTricks: string;
  // Minted once per submission and carried through every retry, so the server
  // can recognise a replay of a request whose response was lost.
  submissionId: string;
};

/** Stable id for one submission attempt and all of its retries. */
export function newSubmissionId(): string {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
}

export type OutboxItem = {
  id: string;
  ownerId: string;     // RC id (or 'admin') that created it; only this identity may send it
  createdAt: number;
  label: string;       // human summary shown in the pending/failed list
  payload: OutboxPayload;
  terminal?: boolean;  // permanent failure — not auto-retried
  lastError?: string;
};

const DB_NAME = 'svrz-offline';
const STORE = 'feedback-outbox';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Resolve on transaction COMMIT (t.oncomplete), not request success, so a
// commit/abort failure (e.g. QuotaExceeded) rejects rather than falsely
// reporting success. The connection is closed on every terminal path.
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    let result: T;
    let settled = false;
    const done = (err?: unknown) => { if (settled) return; settled = true; db.close(); err ? reject(err) : resolve(result); };
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => { result = req.result as T; };
    req.onerror = () => done(req.error);
    t.oncomplete = () => done();
    t.onerror = () => done(t.error);
    t.onabort = () => done(t.error || new Error('IndexedDB transaction aborted'));
  }));
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueFeedback(payload: OutboxPayload, label: string, ownerId: string): Promise<void> {
  const item: OutboxItem = { id: genId(), ownerId, createdAt: Date.now(), label, payload };
  await run('readwrite', (s) => s.put(item));
}

async function allItems(): Promise<OutboxItem[]> {
  const all = (await run<OutboxItem[]>('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

// Items belonging to the current identity (owner). Others are left untouched —
// they will only ever be sent when their own owner is logged in.
export async function listOutbox(ownerId: string): Promise<OutboxItem[]> {
  return (await allItems()).filter((i) => i.ownerId === ownerId);
}

export async function outboxCounts(ownerId: string): Promise<{ pending: number; failed: number }> {
  try {
    const mine = await listOutbox(ownerId);
    return { pending: mine.filter((i) => !i.terminal).length, failed: mine.filter((i) => i.terminal).length };
  } catch {
    return { pending: 0, failed: 0 };
  }
}

export async function discardOutboxItem(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

// Clear the terminal flag so a fixed-up item (e.g. after the admin adds the
// coachee's email) is retried on the next flush.
export async function retryOutboxItem(id: string): Promise<void> {
  const item = (await run<OutboxItem | undefined>('readonly', (s) => s.get(id)));
  if (item) await run('readwrite', (s) => s.put({ ...item, terminal: false, lastError: undefined }));
}

async function removeItem(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
async function putItem(item: OutboxItem): Promise<void> {
  await run('readwrite', (s) => s.put(item));
}

// Outcome of one send attempt: sent/duplicate → remove; retry → keep for the
// next flush; failed → keep but mark terminal (permanent, stop retrying).
export type SendResult = { outcome: 'sent' | 'duplicate' | 'retry' | 'failed'; error?: string };

const FLUSH_LOCK = 'svrz-outbox-flush';
let flushing = false;

/**
 * The outbox is one IndexedDB store shared by every open client of this origin,
 * and each of them flushes on the 'online' event and on mount. A module-level
 * flag only ever stopped a tab from racing itself, so two open tabs replayed
 * the same queued feedback — two records, two mails to the referee. Web Locks
 * is the origin-wide equivalent; the flag stays as the fallback where it is
 * unavailable. The lock is taken before the queue is read, so the loser sees
 * the emptied queue rather than a stale copy of it.
 */
async function withFlushLock(run: () => Promise<number>): Promise<number> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    if (flushing) return 0;
    flushing = true;
    try { return await run(); } finally { flushing = false; }
  }
  // ifAvailable: if another client holds it, let that one finish instead of
  // queueing a second pass that would find nothing left to send.
  return (await locks.request(FLUSH_LOCK, { ifAvailable: true }, async (lock) => (lock ? run() : 0))) ?? 0;
}

// Send this owner's non-terminal items, oldest first. Guarded by a lock so
// overlapping triggers (online event, mount, manual, interval) never double-send.
export async function flushOutbox(
  ownerId: string,
  send: (p: OutboxPayload) => Promise<SendResult>,
  onChange?: () => void,
): Promise<{ sent: number; pending: number }> {
  const sent = await withFlushLock(async () => {
    let count = 0;
    for (const item of await listOutbox(ownerId)) {
      if (item.terminal) continue; // permanent failure — needs manual discard
      let res: SendResult;
      try { res = await send(item.payload); }
      catch (e) { res = { outcome: 'retry', error: e instanceof Error ? e.message : String(e) }; }
      if (res.outcome === 'sent' || res.outcome === 'duplicate') {
        await removeItem(item.id);
        count++;
      } else if (res.outcome === 'failed') {
        await putItem({ ...item, terminal: true, lastError: res.error });
      } else {
        await putItem({ ...item, lastError: res.error }); // retry: keep, try again next flush
      }
      onChange?.();
    }
    return count;
  });
  return { sent, pending: (await outboxCounts(ownerId)).pending };
}
