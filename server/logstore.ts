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
let fileSinkBroken = false;

if (LOG_TO_FILE && !existsSync(LOG_DIR)) {
  try { mkdirSync(LOG_DIR, { recursive: true }); }
  catch (error) { fileSinkBroken = true; console.error('[logstore] cannot create LOG_DIR, file sink disabled:', error); }
}

function currentLogFile(): string {
  return path.join(LOG_DIR, `svrz-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

async function flushToFile(): Promise<void> {
  flushTimer = null;
  if (!fileQueue.length || fileSinkBroken) return;
  const batch = fileQueue;
  fileQueue = [];
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(currentLogFile(), batch.join(''), 'utf8');
  } catch (error) {
    // Never let logging take the server down; degrade to stdout only.
    fileSinkBroken = true;
    console.error('[logstore] file sink failed, disabling it:', error);
  }
}

function scheduleFlush(): void {
  if (flushTimer || fileSinkBroken) return;
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
    console.error('[logstore] prune failed:', error);
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

export function record(input: Omit<LogEntry, 'seq' | 't'> & { t?: string }): LogEntry | null {
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

  const line = stdoutLine(entry);
  if (entry.lvl === 'error') console.error(line);
  else if (entry.lvl === 'warn') console.warn(line);
  else console.log(line);

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
