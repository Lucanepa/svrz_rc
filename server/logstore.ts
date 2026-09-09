// Central log store for the API *and* for browser logs shipped by the app.
//
// Three sinks, on purpose:
//  1. stdout            — `docker compose logs -f svrz-api`, the fastest look.
//  2. in-memory ring    — what the admin console reads (no disk round-trip).
//  3. daily JSONL files — survives a container restart, which the ring does not.
//     Restarts are exactly when we lose the evidence we need (a redeploy right
//     after a user reports something), so the file sink is not optional.
//
// Everything written here goes through redact(): the log is read by humans in an
// admin UI, so passwords, PINs, OTP codes, session cookies and tokens must never
// reach it, no matter which call site is careless.

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// The real console, captured before anything patches it. `captureConsole()`
// below routes every console.* call in the process INTO this store, so a stray
// console.error in a library — or in a handler that never learned about log.* —
// stops being a line only `docker compose logs` ever sees. That patch would
// recurse straight back into record() if this module printed through the patched
// console, so every print here goes through these bound originals.
const nativeConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'server' | 'client';

export type LogEntry = {
  /** Monotonic-ish id, unique within a process run. Used for cursor polling. */
  seq: number;
  /** ISO-8601 UTC. */
  t: string;
  lvl: LogLevel;
  src: LogSource;
  /** Dotted event name: `req`, `auth.login`, `ui.click`, `net.fetch`, … */
  evt: string;
  msg?: string;
  /** Correlates every line emitted while handling one HTTP request. */
  reqId?: string;
  /** Browser session id (one per tab load) — correlates a user's whole visit. */
  sid?: string;
  /** Stable per-device id from localStorage — correlates across sessions. */
  did?: string;
  ip?: string;
  /** Who the request was authenticated as, when known. */
  user?: string;
  data?: Record<string, unknown>;
};

const RING_MAX = Number(process.env.LOG_RING_MAX || 20_000);
const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const FILE_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 30);
const LOG_TO_FILE = process.env.LOG_TO_FILE !== '0';
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVEL_ORDER[(process.env.LOG_LEVEL as LogLevel) || 'debug'] ?? 10;

const ring: LogEntry[] = [];
let seq = 0;

// Anything that wants to react to entries as they are written — today, the
// error-alert mailer. Kept deliberately dumb: a listener that throws must never
// take down the call site that was only trying to log something.
type EntryListener = (entry: LogEntry) => void;
const listeners: EntryListener[] = [];
export function onEntry(listener: EntryListener): void { listeners.push(listener); }

// ── Redaction ─────────────────────────────────────────────────────────
// Key-name match is the primary defence (we control most call sites and pass
// objects, not strings). Values are also length-capped so a stray PDF base64 or
// a giant HTML mail body can't blow up memory or the log file.
const SECRET_KEY = /(pass(word)?|pwd|pin|otp|code|secret|token|auth|cookie|session|bearer|apikey|api_key|signature|hash)/i;
const MAX_STRING = 2_000;
const MAX_DEPTH = 6;
const MAX_KEYS = 60;

function redactString(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING} chars]` : value;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: redactString(value.stack || '') };
  }
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      // Booleans under a secret-sounding key (hasRcCookie, authenticated…) carry
      // no secret material and are exactly the diagnostic bit we want.
      out[k] = SECRET_KEY.test(k) && typeof v !== 'boolean' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ── File sink ─────────────────────────────────────────────────────────
// Lines are batched and flushed on a timer: one appendFile per second beats one
// syscall per log line, and a crash loses at most a second of buffer.
let fileQueue: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
// A COOLDOWN, not a one-way latch. This was permanent: one transient
// appendFile error (a full disk that someone then cleared, a momentary EIO)
// disabled the durable JSONL sink and the retention sweep for the life of the
// process, with a single console.error nobody was watching. The container runs
// restart: unless-stopped, so it could stay off for weeks — and then a redeploy
// takes the in-memory ring with it and the evidence is gone twice over.
let fileSinkBroken = false;
let fileSinkRetryAt = 0;
const FILE_SINK_COOLDOWN_MS = 5 * 60 * 1000;
function fileSinkUsable(): boolean {
  if (!fileSinkBroken) return true;
  if (Date.now() < fileSinkRetryAt) return false;
  fileSinkBroken = false; // one more go; a still-broken sink re-arms below
  return true;
}

if (LOG_TO_FILE && !existsSync(LOG_DIR)) {
  try { mkdirSync(LOG_DIR, { recursive: true }); }
  catch (error) { fileSinkBroken = true; nativeConsole.error('[logstore] cannot create LOG_DIR, file sink disabled:', error); }
}

/**
 * YYYY-MM-DD in the process timezone (TZ=Europe/Zurich in the container).
 * toISOString() would name the file by UTC, so "today's log" started at 02:00
 * local and the last two hours of every evening landed in tomorrow's file —
 * which is not what anyone reading `svrz-<yesterday>.jsonl` means.
 */
export function localDate(when: Date = new Date()): string {
  return new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function logFileFor(date: string): string {
  return path.join(LOG_DIR, `svrz-${date}.jsonl`);
}

function currentLogFile(): string {
  return logFileFor(localDate());
}

async function flushToFile(): Promise<void> {
  flushTimer = null;
  if (!fileQueue.length || !fileSinkUsable()) return;
  const batch = fileQueue;
  fileQueue = [];
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(currentLogFile(), batch.join(''), 'utf8');
  } catch (error) {
    // Never let logging take the server down; degrade to stdout only — but come
    // back and try again, rather than staying off until the next deploy.
    fileSinkBroken = true;
    fileSinkRetryAt = Date.now() + FILE_SINK_COOLDOWN_MS;
    nativeConsole.error('[logstore] file sink failed, retrying in 5 min:', error);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { void flushToFile(); }, 1_000);
  flushTimer.unref?.();
}

/** Drop log files older than the retention window. Cheap; runs daily. */
export async function pruneLogFiles(): Promise<void> {
  if (!LOG_TO_FILE || fileSinkBroken) return;
  const cutoff = Date.now() - FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of await readdir(LOG_DIR)) {
      if (!name.startsWith('svrz-') || !name.endsWith('.jsonl')) continue;
      const full = path.join(LOG_DIR, name);
      if ((await stat(full)).mtimeMs < cutoff) await unlink(full);
    }
  } catch (error) {
    nativeConsole.error('[logstore] prune failed:', error);
  }
}

// ── Write path ────────────────────────────────────────────────────────
function stdoutLine(entry: LogEntry): string {
  const bits = [
    entry.t,
    entry.lvl.toUpperCase().padEnd(5),
    entry.src === 'client' ? 'CLIENT' : 'server',
    entry.evt,
  ];
  if (entry.reqId) bits.push(`req=${entry.reqId}`);
  if (entry.sid) bits.push(`sid=${entry.sid}`);
  if (entry.user) bits.push(`user=${entry.user}`);
  if (entry.msg) bits.push(`| ${entry.msg}`);
  const data = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : '';
  return `${bits.join(' ')}${data}`;
}

export function record(
  input: Omit<LogEntry, 'seq' | 't'> & { t?: string },
  /** false when the caller has already printed the line (see captureConsole). */
  echo = true,
): LogEntry | null {
  if ((LEVEL_ORDER[input.lvl] ?? 20) < MIN_LEVEL) return null;
  const entry: LogEntry = {
    ...input,
    data: input.data ? (redact(input.data) as Record<string, unknown>) : undefined,
    msg: input.msg ? redactString(input.msg) : undefined,
    seq: ++seq,
    t: input.t || new Date().toISOString(),
  };

  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);

  for (const listener of listeners) {
    try { listener(entry); } catch { /* a broken listener must not break logging */ }
  }

  if (echo) {
    const line = stdoutLine(entry);
    if (entry.lvl === 'error') nativeConsole.error(line);
    else if (entry.lvl === 'warn') nativeConsole.warn(line);
    else nativeConsole.log(line);
  }

  if (LOG_TO_FILE && !fileSinkBroken) {
    fileQueue.push(`${JSON.stringify(entry)}\n`);
    scheduleFlush();
  }
  return entry;
}

type Ctx = { reqId?: string; sid?: string; did?: string; ip?: string; user?: string; src?: LogSource };

function emit(lvl: LogLevel, evt: string, msg?: string, data?: Record<string, unknown>, ctx: Ctx = {}) {
  return record({ lvl, src: ctx.src || 'server', evt, msg, data, reqId: ctx.reqId, sid: ctx.sid, did: ctx.did, ip: ctx.ip, user: ctx.user });
}

export const log = {
  debug: (evt: string, msg?: string, data?: Record<string, unknown>, ctx?: Ctx) => emit('debug', evt, msg, data, ctx),
  info: (evt: string, msg?: string, data?: Record<string, unknown>, ctx?: Ctx) => emit('info', evt, msg, data, ctx),
  warn: (evt: string, msg?: string, data?: Record<string, unknown>, ctx?: Ctx) => emit('warn', evt, msg, data, ctx),
  error: (evt: string, msg?: string, data?: Record<string, unknown>, ctx?: Ctx) => emit('error', evt, msg, data, ctx),
};

// ── Console capture ───────────────────────────────────────────────────
// Carpet-bombing means the log is complete, not merely detailed: a
// `console.error('[auth] …')` in a handler, a deprecation warning from a
// dependency, a stack printed by a library — all of it used to exist only in
// the container's stdout, which a redeploy throws away. After this, every
// console call is ALSO an entry in the ring and in the daily JSONL, so the
// admin console and the CLI reader see the same reality as `docker logs`.
let consoleCaptured = false;

function describeConsoleArgs(args: unknown[]): { msg: string; data?: Record<string, unknown> } {
  const parts: string[] = [];
  const extras: unknown[] = [];
  for (const arg of args) {
    if (typeof arg === 'string') parts.push(arg);
    else if (arg instanceof Error) { parts.push(arg.message); extras.push(arg); }
    else if (arg == null || typeof arg !== 'object') parts.push(String(arg));
    else {
      extras.push(arg);
      try { parts.push(JSON.stringify(arg)); } catch { parts.push('[unserializable]'); }
    }
  }
  return {
    msg: parts.join(' ').slice(0, MAX_STRING),
    data: extras.length ? { args: extras } : undefined,
  };
}

/** Route console.* into the store. Idempotent; call once at startup. */
export function captureConsole(): void {
  if (consoleCaptured) return;
  consoleCaptured = true;
  const levelOf: Record<string, LogLevel> = { error: 'error', warn: 'warn', log: 'info', info: 'info', debug: 'debug' };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = (...args: unknown[]) => {
      nativeConsole[method](...args);
      try {
        const { msg, data } = describeConsoleArgs(args);
        // echo=false: the native call above already put it on stdout, and a
        // second copy would double every line the server prints.
        record({ lvl: levelOf[method], src: 'server', evt: `console.${method}`, msg: msg || undefined, data }, false);
      } catch { /* logging must never break the thing being logged */ }
    };
  }
}

/** Force the pending file batch out now — the read path calls this so a query
 *  for today sees the last second of activity, not just what the timer flushed. */
export async function flushNow(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flushToFile();
}

/** The in-memory tail, for readers that need entries the file sink may not hold
 *  (LOG_TO_FILE=0, or a sink in its cooldown). */
export function ringEntries(): LogEntry[] { return ring; }

export const logDir = (): string => LOG_DIR;
export const fileSinkEnabled = (): boolean => LOG_TO_FILE && !fileSinkBroken;

// ── Read path (admin console) ─────────────────────────────────────────
export type LogQuery = {
  limit?: number;
  /** Only entries with seq > since — lets the UI poll without re-fetching. */
  since?: number;
  level?: LogLevel;
  src?: LogSource;
  /** Case-insensitive substring over the whole serialized entry. */
  q?: string;
  sid?: string;
  evt?: string;
};

export function query(opts: LogQuery = {}): { entries: LogEntry[]; total: number; lastSeq: number } {
  const minLevel = opts.level ? LEVEL_ORDER[opts.level] : 0;
  const needle = opts.q?.trim().toLowerCase();
  const matched = ring.filter((e) => {
    if (opts.since != null && e.seq <= opts.since) return false;
    if (minLevel && LEVEL_ORDER[e.lvl] < minLevel) return false;
    if (opts.src && e.src !== opts.src) return false;
    if (opts.sid && e.sid !== opts.sid) return false;
    if (opts.evt && !e.evt.startsWith(opts.evt)) return false;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) return false;
    return true;
  });
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 5_000);
  return {
    entries: matched.slice(-limit),
    total: matched.length,
    lastSeq: seq,
  };
}

/** Distinct browser sessions seen in the ring, newest first — the session picker. */
export function sessions(): Array<{ sid: string; did?: string; user?: string; first: string; last: string; count: number; errors: number; ua?: string }> {
  const bySid = new Map<string, { sid: string; did?: string; user?: string; first: string; last: string; count: number; errors: number; ua?: string }>();
  for (const e of ring) {
    if (!e.sid) continue;
    const cur = bySid.get(e.sid);
    const ua = typeof e.data?.ua === 'string' ? e.data.ua : undefined;
    if (!cur) bySid.set(e.sid, { sid: e.sid, did: e.did, user: e.user, first: e.t, last: e.t, count: 1, errors: e.lvl === 'error' ? 1 : 0, ua });
    else {
      cur.last = e.t;
      cur.count++;
      if (e.lvl === 'error') cur.errors++;
      if (!cur.user && e.user) cur.user = e.user;
      if (!cur.ua && ua) cur.ua = ua;
      if (!cur.did && e.did) cur.did = e.did;
    }
  }
  return [...bySid.values()].sort((a, b) => b.last.localeCompare(a.last));
}

export function ringStats() {
  return { size: ring.length, max: RING_MAX, lastSeq: seq, dir: LOG_DIR, fileSink: LOG_TO_FILE && !fileSinkBroken };
}

// Best-effort flush so the last seconds of logs survive a `docker compose down`.
// Listening for a termination signal removes Node's default "just exit", so the
// handler has to finish the job itself — otherwise Ctrl+C in dev does nothing
// and every `docker compose up --build` waits out the grace period and ends in
// a SIGKILL through whatever write was in flight.
process.on('beforeExit', () => { void flushToFile(); });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void flushToFile().finally(() => {
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  });
}
