// Offline outbox for feedback submissions, backed by IndexedDB (PDFs are too
// large for localStorage). The APP owns the send loop — not Workbox Background
// Sync — so it can report ACCURATE status: an item is removed only on a real
// 2xx (or a 409, meaning the server already recorded it); a network failure or
// server error keeps the item queued and visible, so feedback is never silently
// lost and the coach is never falsely told it was sent.

export type OutboxPayload = {
  gameId: string;
  role: '1. SR' | '2. SR';
  formData: unknown;
  pdfBase64: string;
  pdfFilename: string;
  tipsAndTricks: string;
};

export type OutboxItem = {
  id: string;
  createdAt: number;
  label: string;       // human summary shown in the pending list
  payload: OutboxPayload;
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

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  }));
}

// Time-ordered unique id. Math.random is fine here (not a security context).
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueFeedback(payload: OutboxPayload, label: string): Promise<void> {
  const item: OutboxItem = { id: genId(), createdAt: Date.now(), label, payload };
  await run('readwrite', (s) => s.put(item));
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const all = (await run<OutboxItem[]>('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function outboxCount(): Promise<number> {
  try { return (await run<number>('readonly', (s) => s.count())) || 0; }
  catch { return 0; }
}

async function removeItem(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}

async function putItem(item: OutboxItem): Promise<void> {
  await run('readwrite', (s) => s.put(item));
}

// Outcome of trying to send one item. 'sent'/'duplicate' → remove; else keep.
export type SendResult = { outcome: 'sent' | 'duplicate' | 'retry' | 'failed'; error?: string };

let flushing = false;

// Serially send every queued item. Guarded by an in-process lock so overlapping
// triggers (online event + interval + manual) can't double-send an item.
export async function flushOutbox(
  send: (p: OutboxPayload) => Promise<SendResult>,
  onChange?: () => void,
): Promise<{ sent: number; remaining: number }> {
  if (flushing) return { sent: 0, remaining: await outboxCount() };
  flushing = true;
  let sent = 0;
  try {
    for (const item of await listOutbox()) {
      let res: SendResult;
      try { res = await send(item.payload); }
      catch (e) { res = { outcome: 'retry', error: e instanceof Error ? e.message : String(e) }; }
      if (res.outcome === 'sent' || res.outcome === 'duplicate') {
        await removeItem(item.id);
        sent++;
      } else {
        await putItem({ ...item, lastError: res.error || res.outcome });
      }
      onChange?.();
    }
  } finally {
    flushing = false;
  }
  return { sent, remaining: await outboxCount() };
}
