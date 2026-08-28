// Offline outbox for feedback submissions, backed by IndexedDB (PDFs are too
// large for localStorage). The APP owns the send loop — not Workbox Background
// Sync — so it reports ACCURATE status: an item is removed only on a real 2xx
// (or a 409 = server already recorded it); a network/transient failure keeps
// the item queued for retry; a permanent server error marks it `terminal` so it
// stops auto-retrying and is surfaced to the coach to discard or fix. Every item
// is tagged with the RC id that created it and is only ever sent back under that
// same identity — so a queued item can never be submitted as a different coach.
// In-progress observation drafts deliberately do NOT live in a second store in
// this database but in their own (`formDraft.ts`): another store here means a
// DB_VERSION bump, and `openDb()` below has no `onblocked` handler, so an
// upgrade held open by a second window would surface as a rejected
// `enqueueFeedback` — the one write in this app whose failure loses a completed
// observation.

export type OutboxPayload = {
  /**
   * Stable across every replay of this item — it IS the outbox item's id. The
   * server stores it so a resend is recognised as the SAME submission instead
   * of being guessed at by a time window. Absent for an online submit, which
   * never enters the outbox.
   */
  submissionKey?: string;
  gameId: string;
  role: '1. SR' | '2. SR';
  formData: unknown;
  pdfBase64: string;
  pdfFilename: string;
  tipsAndTricks: string;
};

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
  const id = genId();
  // The id travels with the payload, so every retry of this item carries the
  // same key and the server can tell a replay from a genuine second visit.
  const item: OutboxItem = { id, ownerId, createdAt: Date.now(), label, payload: { ...payload, submissionKey: id } };
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

/**
 * What is queued for SOMEBODY ELSE on this device, grouped by owner.
 *
 * Every other reader filters to the current identity, which is right for
 * sending — an item may only be sent as the coach who wrote it. But it meant a
 * finished observation became invisible the moment the tablet changed hands:
 * coach A files with no reception, hands over, and from then on the pending
 * banner reads 0, no flush ever touches A's item, the coachee never receives
 * the report, and nothing on any screen mentions it. On shared hardware — which
 * is exactly what the "switch RC" button exists for — that is silent loss of
 * completed work.
 *
 * Nothing is deleted and nothing is sent under the wrong identity: this only
 * makes the item visible so someone can sign back in as its owner.
 */
export async function foreignOutboxSummary(ownerId: string): Promise<{ ownerId: string; count: number }[]> {
  try {
    const groups = new Map<string, number>();
    for (const item of await allItems()) {
      if (item.ownerId === ownerId || item.terminal) continue;
      groups.set(item.ownerId, (groups.get(item.ownerId) ?? 0) + 1);
    }
    return [...groups].map(([owner, count]) => ({ ownerId: owner, count }));
  } catch {
    return [];
  }
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

let flushing = false;

// The outbox lives in IndexedDB and is shared by every window on this origin,
// but a module-level flag only covers one of them — an installed PWA and a
// browser tab both flushing on the same 'online' event would send the queued
// observation twice, and the coachee would get two copies of the same mail.
// Web Locks are origin-wide, which is exactly the scope of the queue.
const OUTBOX_LOCK = 'svrz-outbox-flush';
async function withOutboxLock<T>(fn: () => Promise<T>, busy: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  return await locks.request(OUTBOX_LOCK, { ifAvailable: true }, async (lock) => (lock ? fn() : busy())) as T;
}

// Send this owner's non-terminal items, oldest first. Guarded by a lock so
// overlapping triggers (online event, mount, manual, interval) never double-send.
// `onSettled` reports what the loop actually did with each item, once per item:
// the caller keeps its own record of that submission (the draft store) in step
// with the queue instead of having to guess the per-item outcome from the sent
// count, which says nothing about WHICH items went.
export async function flushOutbox(
  ownerId: string,
  send: (p: OutboxPayload) => Promise<SendResult>,
  onChange?: () => void,
  onSettled?: (item: OutboxItem, outcome: SendResult['outcome']) => void,
): Promise<{ sent: number; pending: number }> {
  const idle = async () => ({ sent: 0, pending: (await outboxCounts(ownerId)).pending });
  if (flushing) return idle();
  return withOutboxLock(() => flushOwned(ownerId, send, onChange, onSettled), idle);
}

async function flushOwned(
  ownerId: string,
  send: (p: OutboxPayload) => Promise<SendResult>,
  onChange?: () => void,
  onSettled?: (item: OutboxItem, outcome: SendResult['outcome']) => void,
): Promise<{ sent: number; pending: number }> {
  if (flushing) return { sent: 0, pending: (await outboxCounts(ownerId)).pending };
  flushing = true;
  let sent = 0;
  try {
    for (const item of await listOutbox(ownerId)) {
      if (item.terminal) continue; // permanent failure — needs manual discard
      let res: SendResult;
      try { res = await send(item.payload); }
      catch (e) { res = { outcome: 'retry', error: e instanceof Error ? e.message : String(e) }; }
      if (res.outcome === 'sent' || res.outcome === 'duplicate') {
        await removeItem(item.id);
        sent++;
      } else if (res.outcome === 'failed') {
        await putItem({ ...item, terminal: true, lastError: res.error });
      } else {
        await putItem({ ...item, lastError: res.error }); // retry: keep, try again next flush
      }
      // After the store is settled, and never allowed to throw: this handler is
      // somebody else's bookkeeping, and a draft that fails to update must not
      // abort the send loop — the item it belongs to is already gone from the
      // queue, so a thrown error here would strand every item behind it.
      try { onSettled?.(item, res.outcome); } catch { /* a draft bookkeeping failure must never strand a sent item */ }
      onChange?.();
    }
  } finally {
    flushing = false;
  }
  return { sent, pending: (await outboxCounts(ownerId)).pending };
}
