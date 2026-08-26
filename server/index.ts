import express, { Request, Response as ExpressResponse } from 'express';
import cors from 'cors';
import PocketBase from 'pocketbase';
import dotenv from 'dotenv';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import { createHash, createHmac, randomUUID, randomBytes, randomInt, timingSafeEqual, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { log, query as queryLogs, sessions as logSessions, ringStats, pruneLogFiles, record as recordLog, type LogLevel, type LogSource } from './logstore.ts';
// Shared with the survey page so the mailed copy can never drift from the form
// the coachee actually filled in. Pure data — no browser dependencies.
import { SURVEY_QUESTIONS, questionLabel, type SurveyLang } from '../src/lib/survey.ts';

dotenv.config({ path: '.env.local' });
dotenv.config();

// SMTP transport for feedback emails. Port 465 uses implicit TLS; any other
// port (e.g. 587) connects plaintext then upgrades — requireTLS forces that
// STARTTLS handshake so credentials are never sent in the clear. Hetzner blocks
// outbound 25/465 by default, so 587 is the working port here.
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = smtpPort === 465;
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.migadu.com',
  port: smtpPort,
  secure: smtpSecure,
  requireTLS: !smtpSecure,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  // Reuse connections instead of dialling per message. Sending several mails in
  // quick succession (a feedback batch, or a survey landing right after one)
  // was tripping "Greeting never received" — a fresh TCP+TLS handshake per mail
  // is exactly what a provider throttles.
  pool: true,
  maxConnections: 3,
});

// One retry on the transport-level failures — the connection never got a
// greeting, timed out, or was reset. A survey response is stored before this
// runs, so without a retry a single hiccup silently costs the notification and
// leaves only a log line behind. Never retries a rejection (bad address, auth):
// those fail the same way twice and the second attempt is just noise.
async function sendMailResilient(message: Parameters<typeof smtpTransport.sendMail>[0]) {
  try {
    return await smtpTransport.sendMail(message);
  } catch (error) {
    const code = String((error as { code?: string })?.code || '');
    const retriable = ['ETIMEDOUT', 'ECONNECTION', 'ECONNRESET', 'ESOCKET', 'EGREETING'].includes(code)
      || /greeting never received|timeout/i.test(String((error as Error)?.message || ''));
    if (!retriable) throw error;
    log.warn('smtp.retry', 'transport-level send failure — retrying once', { code });
    return await smtpTransport.sendMail(message);
  }
}

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn('[startup] SMTP not fully configured. Feedback email sending will fail at runtime.');
}

// Sender identity shown in recipients' inboxes: a friendly display name in front
// of the configured address. Used by every outbound mail (feedback, PIN, OTP).
const MAIL_FROM = {
  name: process.env.SMTP_FROM_NAME || 'SVRZ Referee Coaching',
  address: process.env.SMTP_FROM || 'rc_coaching@openvolley.app',
};
const MAIL_APP_URL = process.env.APP_PUBLIC_URL || 'https://svrz-rc.openvolley.app/';

process.on('unhandledRejection', (reason) => {
  log.error('process.unhandledRejection', 'Unhandled promise rejection', { error: reason });
});
process.on('uncaughtException', (err) => {
  log.error('process.uncaughtException', 'Uncaught exception', { error: err });
});

type AnyRecord = Record<string, unknown> & { id: string };

const app = express();
const port = Number(process.env.PORT || 8787);

// Trust exactly one proxy hop (the Cloudflare Tunnel in front of this origin),
// not every upstream — so client-supplied X-Forwarded-For cannot be trusted blindly.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false, crossOriginOpenerPolicy: false }));
// Default is the live frontend origin. It has now pointed at a dead domain
// twice (Codeberg, then GitHub Pages) — a stale fallback rejects the real
// frontend and surfaces in the browser as a bare "Failed to fetch" with no
// status, so keep this in step with wherever the app is actually served.
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'https://svrz-rc.openvolley.app')
  .split(',').map((o) => o.trim()).filter(Boolean);
// Once the app (svrz-rc.openvolley.app) and this API (svrz-rc-api.openvolley.app)
// share a registrable domain, the session cookies stop being third-party and can
// go back to SameSite=Lax — which is the whole fix for Safari/WebKit silently
// dropping them and bouncing a correct PIN back to the login screen.
//
// It is an env knob rather than a constant because the code ships before the DNS
// and Tunnel cutover: while the browser is still talking to a different site,
// only 'none' works. Flip to 'lax' in svrz-api.env once the new API hostname is
// live, and never before — 'lax' against a cross-site API logs everyone out.
const SESSION_SAMESITE: 'lax' | 'none' =
  process.env.SESSION_COOKIE_SAMESITE === 'lax' ? 'lax' : 'none';

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // A blocked origin surfaces in the browser as a bare "Failed to fetch" with
    // no status, so the server side is the only place it is diagnosable.
    log.error('cors.blocked', 'Origin not allowed by CORS', { origin, allowed: ALLOWED_ORIGINS });
    return cb(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  // The app stamps X-Svrz-Session/Device on API calls (log correlation), which
  // makes every request preflighted. A long max-age lets the browser cache that
  // OPTIONS instead of sending one per request.
  maxAge: 86_400,
}));
// A submitted feedback carries the finished PDF as base64 in the body. It is now
// drawn as vector text (see src/lib/feedbackPdf.ts) and lands around 100 KB
// whatever the coach's screen, rather than the multi-megabyte screenshot it used
// to be — but keep real headroom: hitting this limit costs a coach the whole
// filled-in form, and manual uploads still carry arbitrary scanned files.
// Only /api/feedback/submit carries a large body (the finished PDF as base64).
// Everything else — including every unauthenticated auth route — gets a small
// limit, so a hostile caller cannot make the server buffer and parse 32 MB
// before any handler or rate limit even runs. The client-log endpoint is
// skipped entirely: it mounts its own tight parsers, and reaching it through a
// global JSON parser once let its 256 kb text limit be sidestepped as JSON.
const generousJson = express.json({ limit: '32mb' });
const modestJson = express.json({ limit: '256kb' });
const BIG_BODY_PATH_RE = /^\/api\/feedback\/submit\/?$/i;
app.use((req: Request, res: ExpressResponse, next: (e?: unknown) => void) => {
  if (CLIENT_LOG_PATH_RE.test(req.path)) { next(); return; }
  (BIG_BODY_PATH_RE.test(req.path) ? generousJson : modestJson)(req, res, next);
});

// body-parser rejects an oversized body by throwing, which the generic handler
// reports as a bare 500 "Internal server error" — after a long upload, with no
// hint that the size was the problem. Name it.
app.use((err: unknown, _req: Request, res: ExpressResponse, next: (e?: unknown) => void) => {
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Das Formular ist zu gross zum Senden (PDF). Bitte im Support melden.' });
    return;
  }
  next(err);
});

// ── Request logging ───────────────────────────────────────────────────
// Every request gets an id that ties together each line emitted while handling
// it (`req.in` → any handler logs → `req.out`). Handlers reach their context
// through reqCtx(req).
type ReqCtx = { reqId: string; ip: string; user?: string; sid?: string; startedAt: number };
const reqCtxByReq = new WeakMap<Request, ReqCtx>();

function reqCtx(req: Request): ReqCtx {
  const existing = reqCtxByReq.get(req);
  if (existing) return existing;
  const fresh: ReqCtx = { reqId: randomBytes(4).toString('hex'), ip: clientIp(req), startedAt: Date.now() };
  reqCtxByReq.set(req, fresh);
  return fresh;
}

/** Names the identity a later handler resolved, so `req.out` can report it. */
function tagReqUser(req: Request, user: string): void {
  reqCtx(req).user = user;
}

// Bodies are logged, because "what exactly did the client send" is the question
// we actually need answered. Small ones inline (secrets stripped by redact());
// large ones (feedback PDFs) collapse to their shape so the log stays readable.
function bodySummary(body: unknown): unknown {
  if (body == null || typeof body !== 'object') return undefined;
  const keys = Object.keys(body as Record<string, unknown>);
  if (!keys.length) return undefined;
  let size = 0;
  try { size = JSON.stringify(body).length; } catch { size = -1; }
  if (size >= 0 && size <= 4_000) return body;
  return { _summary: true, bytes: size, keys };
}

// Matched before the generous JSON parser is mounted, so keep it next to it.
const CLIENT_LOG_PATH_RE = /^\/api\/client-logs\/?$/i;
const CLIENT_LOG_BODY_LIMIT = '256kb';

// Two routes carry something its author was promised stays with the RC chair:
// a coach's private note, and a referee's survey answers. This log is read by
// every admin, so their bodies are reduced to shape — and the survey's
// capability token is stripped from the URL for the same reason the iCal one
// is. redact() cannot help here: it keys off names like "password", and there
// is nothing secret-looking about "note" or "answers".
// Case-insensitive on purpose: Express routes case-insensitively by default, so
// PUT /API/feedback/<id>/president-note reaches the handler while req.path keeps
// the caller's spelling. Anchored patterns without /i then missed, and the note
// went to the log in full.
const CONFIDENTIAL_BODY_PATHS = [
  /^\/api\/feedback\/[^/]+\/president-note$/i,
  /^\/api\/survey\/[^/]+$/i,
];

function logBody(path: string, body: unknown): unknown {
  if (!CONFIDENTIAL_BODY_PATHS.some((re) => re.test(path))) return bodySummary(body);
  if (body == null || typeof body !== 'object') return undefined;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length ? { _confidential: true, keys } : undefined;
}

// A calendar token never expires and is the only credential its feed has, so
// the URL carrying it must not sit readable in the log the admin console shows.
// `me` is spared so the log still distinguishes the app asking for its own
// link from a calendar client polling the feed — the same line otherwise.
function redactIcalToken(url: string): string {
  return url
    .replace(/(\/api\/ical\/)(?!me(?:[/?]|$))[^/?]+/i, '$1<token>')
    // The survey token is the only credential its page has, and the page shows
    // (and accepts) one referee's answers about their coach.
    .replace(/(\/api\/survey\/)(?!responses(?:[/?]|$))[^/?]+/i, '$1<token>')
    // The signature slug was the one capability token left in the clear, and
    // the app polls its route every 3 seconds while a signature is open — so a
    // single visit wrote the slug into the log dozens of times. The route is
    // unauthenticated and returns the handwritten signature.
    .replace(/(\/api\/signature\/)(?!start(?:[/?]|$))[^/?]+/i, '$1<token>');
}

app.use((req: Request, res: ExpressResponse, next: () => void) => {
  const ctx = reqCtx(req);
  const sid = asText(req.headers['x-svrz-session']) || undefined;
  const did = asText(req.headers['x-svrz-device']) || undefined;
  if (sid) ctx.sid = sid;
  // The logging endpoints must not log themselves: the ingest fires on every
  // batch, and the admin console polls the reader every few seconds — each
  // would generate the traffic it is there to report.
  const noisy = req.path === '/api/client-logs' || req.path.startsWith('/api/admin/logs');
  if (!noisy) {
    log.info('req.in', `${req.method} ${redactIcalToken(req.originalUrl)}`, {
      method: req.method,
      path: redactIcalToken(req.path),
      query: Object.keys(req.query || {}).length ? req.query : undefined,
      body: logBody(req.path, req.body),
      ua: asText(req.headers['user-agent']) || undefined,
      referer: asText(req.headers.referer) || undefined,
      origin: asText(req.headers.origin) || undefined,
      hasRcCookie: Boolean(asText(req.headers.cookie).includes(RC_COOKIE)),
    }, { reqId: ctx.reqId, ip: ctx.ip, sid, did });
  }
  res.on('finish', () => {
    if (noisy) return;
    const ms = Date.now() - ctx.startedAt;
    const lvl: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[lvl]('req.out', `${req.method} ${redactIcalToken(req.originalUrl)} → ${res.statusCode} (${ms}ms)`, {
      method: req.method,
      path: redactIcalToken(req.path),
      status: res.statusCode,
      ms,
    }, { reqId: ctx.reqId, ip: ctx.ip, sid, did, user: ctx.user });
  });
  next();
});

const ADMIN_SESSION_COOKIE = 'svrz_admin_session';
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 1000 * 60 * 60 * 8);

// Fail closed: never sign sessions with an empty (attacker-known) HMAC key.
// If no secret is configured, generate a strong random per-process key so tokens
// remain unforgeable. Sessions won't survive a restart until ADMIN_SESSION_SECRET is set.
function resolveSessionSecret(): string {
  const explicit = process.env.ADMIN_SESSION_SECRET || process.env.POCKETBASE_ADMIN_PASSWORD || '';
  if (explicit) return explicit;
  console.error(
    '[startup] SECURITY: ADMIN_SESSION_SECRET is not set. Generated a random ephemeral key — '
    + 'every restart therefore invalidates all sessions AND every RC PIN, because the PIN salt '
    + 'is derived from this secret. Set ADMIN_SESSION_SECRET before going anywhere near production.',
  );
  return randomBytes(32).toString('hex');
}
const ADMIN_SESSION_SECRET = resolveSessionSecret();
const ADMIN_UI_PASSWORD = process.env.ADMIN_UI_PASSWORD || '';
// A username beside the password. Not a second secret — it is "admin" — but it
// lets a password manager store and fill this login like any other site, and a
// password-only POST is no longer enough on its own.
const ADMIN_UI_USERNAME = process.env.ADMIN_UI_USERNAME || 'admin';
// The chair's own pair, on the same form. Her channel is the one thing the
// admin password must not open, so it needs a credential of its own — and
// unlike the old per-person login it is one secret, not an account system.
const PRESIDENT_UI_USERNAME = process.env.PRESIDENT_UI_USERNAME || 'praesidium';
const PRESIDENT_UI_PASSWORD = process.env.PRESIDENT_UI_PASSWORD || '';
const TEST_MODE = process.env.TEST_MODE === '1' || process.env.TEST_MODE === 'true';
if (TEST_MODE) console.warn('[startup] TEST_MODE enabled — outbound emails are suppressed.');
if (!ADMIN_UI_PASSWORD) console.warn('[startup] ADMIN_UI_PASSWORD not set — admin console login disabled.');

// ── App login ────────────────────────────────────────────────────────
// Two ways in, one cookie. The everyday one is a single credential the whole
// team shares; the session it opens carries no identity at all until its holder
// says which RC they are (see /api/auth/rc/identify). The other is the original
// per-person e-mail + password, kept for the two things a secret everybody
// knows cannot carry: admin rights, and the chair's access to the surveys.
//
// WHICH of the two opened a session is recorded on the session itself, and
// every privilege check reads it. A shared session states who its holder says
// they are — never who they proved to be — so it is attribution (logs,
// ownership, the "my games" filter) and never authority.
const RC_COOKIE = 'svrz_rc_session';
const RC_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// The shared credential. There used to be a hardcoded fallback pair here, and
// because the env override was never set in production the live team password
// sat in a public repository for two weeks (2026-08-11 to 2026-08-26). There is
// no fallback any more: unset means the door is shut, which is the failure a
// deploy notices immediately instead of one nobody notices at all.
const SHARED_LOGIN_USERNAME_ENV = process.env.SHARED_LOGIN_USERNAME || 'Referee-Coaching';
const SHARED_LOGIN_PASSWORD_ENV = process.env.SHARED_LOGIN_PASSWORD || '';
if (!SHARED_LOGIN_PASSWORD_ENV) console.warn('[startup] SHARED_LOGIN_PASSWORD not set — the team login works only once a password is set in the admin console.');

// ── Stored credentials (hashed, changed from the admin console) ───────
// Passwords used to be readable strings in an env file, which meant rotating
// one was an ssh session and a container restart — so it did not happen. They
// now live in app_settings as a scrypt hash over a per-record random salt, and
// the admin console writes them. The env vars stay as the bootstrap: a slot
// that has never been set in the database falls back to its variable, so a
// fresh deployment still comes up with a way in.
//
// Hashed, not encrypted, and deliberately: nothing here ever needs to read a
// password back, only to check one. A team password nobody can recite is
// replaced, not recovered — which is the same operation as rotating it, and the
// console shows the new value once at the moment it is set.
type CredentialSlot = 'shared' | 'admin' | 'president';
type StoredCredential = { username: string; salt: string; hash: string; updatedAt: string; updatedBy: string };
type CredentialMap = Partial<Record<CredentialSlot, StoredCredential>>;
const CREDENTIALS_KEY = 'auth_credentials';
const MIN_SECRET_LENGTH = 10;

function hashSecret(secret: string, salt: string): string {
  return scryptSync(secret, salt, 64).toString('hex');
}

function makeCredential(username: string, password: string, updatedBy: string): StoredCredential {
  const salt = randomBytes(16).toString('hex');
  return { username, salt, hash: hashSecret(password, salt), updatedAt: new Date().toISOString(), updatedBy };
}

// Short TTL rather than none: a login is rate-limited to a trickle, but the
// reminder cron and a burst of Saturday sign-ins should not each cost a round
// trip. Every write invalidates it, so a rotated password takes effect at once.
let credentialsCache: { data: CredentialMap; expiresAt: number } | null = null;

async function readCredentials(): Promise<CredentialMap> {
  if (credentialsCache && credentialsCache.expiresAt > Date.now()) return credentialsCache.data;
  let data: CredentialMap = {};
  try {
    const rec = await getSettingRecord(CREDENTIALS_KEY);
    const parsed = rec ? JSON.parse(asText(rec.value)) : {};
    if (parsed && typeof parsed === 'object') data = parsed as CredentialMap;
  } catch (error) {
    // A malformed or unreachable record must not lock everyone out — fall
    // through to the env bootstrap rather than denying every login.
    console.error('[auth] could not read stored credentials:', error);
  }
  credentialsCache = { data, expiresAt: Date.now() + 60 * 1000 };
  return data;
}

async function writeCredentials(mutate: (current: CredentialMap) => CredentialMap): Promise<void> {
  await withSettingLock(CREDENTIALS_KEY, async () => {
    let current: CredentialMap = {};
    try {
      const rec = await getSettingRecord(CREDENTIALS_KEY);
      const parsed = rec ? JSON.parse(asText(rec.value)) : {};
      if (parsed && typeof parsed === 'object') current = parsed as CredentialMap;
    } catch { current = {}; }
    await setSetting(CREDENTIALS_KEY, JSON.stringify(mutate(current)));
  });
  credentialsCache = null;
}

// Checks one slot against the stored hash, falling back to the env pair for a
// slot never written. Both halves are always compared so the answer says
// nothing about which one was wrong, and the scrypt runs even when the slot is
// empty so an unconfigured slot cannot be told from a wrong password by how
// fast it answers.
async function verifyCredential(
  slot: CredentialSlot, username: string, password: string,
  envUsername: string, envPassword: string,
): Promise<{ ok: boolean; userMatched: boolean; configured: boolean }> {
  const norm = (v: string) => v.trim().toLowerCase();
  const stored = (await readCredentials())[slot];
  if (stored) {
    const userOk = constantTimeEquals(norm(username), norm(stored.username));
    const attempt = Buffer.from(hashSecret(password, stored.salt), 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    const passOk = attempt.length === expected.length && timingSafeEqual(attempt, expected);
    return { ok: userOk && passOk, userMatched: userOk, configured: true };
  }
  // Never configured: burn a comparable amount of work, then fall back to env.
  hashSecret(password, 'unconfigured-slot');
  if (!envPassword) return { ok: false, userMatched: false, configured: false };
  const userOk = constantTimeEquals(norm(username), norm(envUsername));
  const passOk = constantTimeEquals(password, envPassword);
  return { ok: userOk && passOk, userMatched: userOk, configured: true };
}

/** The username a slot currently answers to — what the console shows. */
async function credentialUsername(slot: CredentialSlot, envUsername: string): Promise<string> {
  return (await readCredentials())[slot]?.username || envUsername;
}
const GATE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const GATE_RATE_LIMIT_MAX = 10;
// Generic in-memory fixed-window rate limiter, keyed by an arbitrary string.
type RateLimitStore = Map<string, { count: number; resetAt: number }>;
function checkRateLimit(
  store: RateLimitStore,
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

// Charge further units against a bucket already checked this request. One
// request is not always one event: the client log endpoint takes a batch, and
// billing it as a single hit made the real ceiling the batch size times the
// nominal one.
function chargeRateLimit(store: RateLimitStore, key: string, units: number): void {
  const entry = store.get(key);
  if (entry && Date.now() < entry.resetAt) entry.count += Math.max(0, units);
}

// Is this bucket over budget, without spending from it? For limits that should
// only be charged when an attempt actually fails, so honest traffic can never
// exhaust the allowance meant for guessers.
function peekRateLimit(store: RateLimitStore, key: string, max: number): { allowed: boolean; retryAfterMs: number } {
  const entry = store.get(key);
  if (!entry || Date.now() >= entry.resetAt) return { allowed: true, retryAfterMs: 0 };
  if (entry.count >= max) return { allowed: false, retryAfterMs: entry.resetAt - Date.now() };
  return { allowed: true, retryAfterMs: 0 };
}

// Per-IP limiter for login endpoints (RC login + admin login).
const gateAttempts: RateLimitStore = new Map();
// Namespaced per route, not one bucket for all four sign-in doors. Sharing it
// meant ten sign-ins of ANY kind from one address in five minutes — a
// season-kickoff meeting on one office WiFi, every coach on the same NAT — 429'd
// the eleventh person on every flow at once, including the admin console.
// Charged on failure only: a successful sign-in is not evidence of an attack.
function checkGateRateLimit(ip: string, scope = 'gate') {
  return checkRateLimit(gateAttempts, `${scope}|${ip}`, GATE_RATE_LIMIT_MAX, GATE_RATE_LIMIT_WINDOW_MS);
}
function peekGateRateLimit(ip: string, scope = 'gate') {
  return peekRateLimit(gateAttempts, `${scope}|${ip}`, GATE_RATE_LIMIT_MAX);
}

// Single exit for every 429: sets Retry-After (so the client can say how long),
// and logs which bucket tripped — the detail that made this class of bug so hard
// to see from the outside.
function denyRateLimited(req: Request, res: ExpressResponse, bucket: string, retryAfterMs: number, extra?: Record<string, unknown>): void {
  const ctx = reqCtx(req);
  log.warn('ratelimit.deny', `${bucket} limit hit for ${ctx.ip}`, { bucket, retryAfterMs, path: req.path, ...extra }, { reqId: ctx.reqId, ip: ctx.ip, sid: ctx.sid });
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  res.status(429).json({ error: 'Zu viele Versuche.', retryAfterMs });
}

// Per-IP limiter for unauthenticated signature writes (capability-token endpoint).
const signatureAttempts: RateLimitStore = new Map();
const SIGNATURE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const SIGNATURE_RATE_LIMIT_MAX = 30;
function checkSignatureRateLimit(ip: string) {
  return checkRateLimit(signatureAttempts, ip, SIGNATURE_RATE_LIMIT_MAX, SIGNATURE_RATE_LIMIT_WINDOW_MS);
}

// Survey writes get their OWN bucket. Sharing the signature one would let a
// burst of survey submits lock a hall's shared IP out of signing — two
// unrelated features failing together is exactly the bug that's hardest to see.
const surveyAttempts: RateLimitStore = new Map();
const SURVEY_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const SURVEY_RATE_LIMIT_MAX = 20;
function checkSurveyRateLimit(ip: string) {
  return checkRateLimit(surveyAttempts, ip, SURVEY_RATE_LIMIT_MAX, SURVEY_RATE_LIMIT_WINDOW_MS);
}

// App-wide backstop for the team login. One secret for everybody means one
// bucket for everybody, so the cap is generous — high enough not to 429
// legitimate coaches on a busy match weekend, low enough to blunt a flood.
const sharedLoginGlobal: RateLimitStore = new Map();
const SHARED_GLOBAL_MAX = 1000;
const SHARED_GLOBAL_WINDOW_MS = 15 * 60 * 1000;

// There is one kind of app session: the team credential, optionally carrying
// the name its holder picked. The token used to record WHICH credential opened
// it, because a second, per-person login existed and proved identity. It no
// longer does, so every app session is a claim and there is nothing left to
// tell apart.
type RcSessionToken = { ok: boolean; rcId: string };
const NO_RC_SESSION: RcSessionToken = { ok: false, rcId: '' };

function createRcSessionToken(opts: { rcId?: string; name?: string }): string {
  const body = JSON.stringify({
    sub: randomUUID(),
    purpose: 'rc',
    rcId: opts.rcId || '',
    name: opts.name || '',
    exp: Date.now() + RC_TTL_MS,
  });
  const payload = base64UrlEncode(body);
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function verifyRcSession(req: Request): RcSessionToken {
  const token = getCookieValue(req, RC_COOKIE);
  if (!token) return NO_RC_SESSION;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return NO_RC_SESSION;
  const expectedSignature = signAdminSessionPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return NO_RC_SESSION;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as {
      purpose?: unknown; rcId?: unknown; exp?: unknown;
    };
    if (parsed.purpose !== 'rc') return NO_RC_SESSION;
    const exp = Number(parsed.exp);
    if (!Number.isFinite(exp) || exp < Date.now()) return NO_RC_SESSION;
    // A session with no RC on it is the normal state between signing in and
    // choosing a name — authenticated, deliberately nobody. Tokens minted
    // before this carried a mode and a PIN fingerprint; both are ignored now,
    // which keeps everyone signed in across the deploy and can only ever lose
    // privileges, never grant them.
    return { ok: true, rcId: asText(parsed.rcId) };
  } catch {
    return NO_RC_SESSION;
  }
}

function setRcSessionCookie(res: ExpressResponse, token: string): void {
  res.cookie(RC_COOKIE, token, {
    httpOnly: true,
    sameSite: SESSION_SAMESITE,
    secure: true,
    maxAge: RC_TTL_MS,
    path: '/',
  });
}

// Byte-wise, length-checked, constant-time string compare. Length is compared
// first because timingSafeEqual throws on a mismatch — which is how a wrong
// password once became a 500 (see the admin UI gate).
function constantTimeEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Periodic cleanup of stale rate-limit entries (every 10 min)
setInterval(() => {
  const now = Date.now();
  // Every bucket, not just the login ones: clientLogRl is fed by an
  // unauthenticated endpoint that any scanner can reach, so a forgotten map
  // grows one entry per source IP for the life of the process.
  for (const store of [gateAttempts, signatureAttempts, sharedLoginGlobal, surveyAttempts, clientLogRl, clientLogGlobalRl]) {
    for (const [ip, entry] of store) {
      if (now >= entry.resetAt) store.delete(ip);
    }
  }
  for (const [key, entry] of credChallenges) {
    if (now > entry.expiresAt) credChallenges.delete(key);
  }
}, 10 * 60 * 1000);

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signAdminSessionPayload(payload: string): string {
  return createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// Two different people sign in on the admin page and they are not the same
// role: 'admin' runs the console, 'president' opens only the chair's private
// channel (her notes and the survey answers), which admin rights deliberately
// do not reach. One cookie, so signing in as one replaces the other.
type ConsoleRole = 'admin' | 'president';

function createAdminSessionToken(email: string, role: ConsoleRole = 'admin'): string {
  const body = JSON.stringify({
    sub: randomUUID(),
    email,
    role,
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  const payload = base64UrlEncode(body);
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function getCookieValue(req: Request, cookieName: string): string {
  const cookieHeader = req.headers.cookie || '';
  const parts = cookieHeader.split(';').map((item) => item.trim()).filter(Boolean);
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    if (key !== cookieName) {
      continue;
    }
    const raw = part.slice(separatorIndex + 1);
    // A malformed escape ("%") makes decodeURIComponent throw, and it threw
    // outside the route handler's try — so `Cookie: svrz_rc_session=%` answered
    // 500 instead of 401 and wrote an unrate-limited error line per attempt.
    // The raw value simply fails signature verification, which is the right
    // outcome.
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return '';
}

function clearAdminSessionCookie(res: ExpressResponse) {
  res.cookie(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: SESSION_SAMESITE,
    secure: true,
    maxAge: 0,
    path: '/',
  });
}

function setAdminSessionCookie(res: ExpressResponse, token: string) {
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: SESSION_SAMESITE,
    secure: true,
    maxAge: ADMIN_SESSION_TTL_MS,
    path: '/',
  });
}

function verifyConsoleSession(req: Request): { ok: boolean; email?: string; role?: ConsoleRole } {
  const token = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (!token) {
    return { ok: false };
  }
  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return { ok: false };
  }
  const expectedSignature = signAdminSessionPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { email?: unknown; exp?: unknown; purpose?: unknown; role?: unknown };
    // Admin tokens never carry a purpose field — reject RC/other-purpose tokens
    // even if they somehow gained an email claim.
    if (parsed.purpose !== undefined) {
      return { ok: false };
    }
    const exp = Number(parsed.exp);
    if (!Number.isFinite(exp) || exp < Date.now()) {
      return { ok: false };
    }
    const email = asText(parsed.email);
    if (!email) {
      return { ok: false };
    }
    // Only 'president' is ever read as president. Tokens minted before roles
    // existed carry none and were all admin ones, so reading an absent role as
    // admin keeps those sessions alive across the deploy; an unrecognised value
    // can only lose privileges, never gain them.
    const role: ConsoleRole = parsed.role === 'president' ? 'president' : 'admin';
    return { ok: true, email, role };
  } catch {
    return { ok: false };
  }
}

/** True only for the console operator. The chair's session is NOT an admin. */
function verifyAdminSession(req: Request): { ok: boolean; email?: string } {
  const s = verifyConsoleSession(req);
  return s.ok && s.role === 'admin' ? { ok: true, email: s.email } : { ok: false };
}

/** True only for the chair. Grants her private channel and nothing else. */
function verifyPresidentSession(req: Request): { ok: boolean; email?: string } {
  const s = verifyConsoleSession(req);
  return s.ok && s.role === 'president' ? { ok: true, email: s.email } : { ok: false };
}

function clientIp(req: Request): string {
  // Cloudflare sets CF-Connecting-IP at the edge and overwrites any client-supplied
  // value, so it cannot be spoofed. Fall back to the direct socket address.
  // The leftmost X-Forwarded-For entry is attacker-controlled and must NOT be trusted
  // for security decisions (rate limiting).
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return req.socket.remoteAddress || 'unknown';
}

function safeError(error: unknown): string {
  log.error('api.error', 'unhandled error in a request handler', { error });
  return 'Internal server error';
}

// Same logging, but the caller is told what actually went wrong. Only for the
// admin-only VolleyManager routes: the person clicking those is the one who has
// to go fix the upstream account, and "Internal server error" sent them to the
// container log for every single failure — which is exactly the trip the admin
// console exists to save them. The message is ours (a thrown Error from the VM
// helpers) and length-capped — but note it CAN embed a slice of an upstream
// response body: the game-list and referee-list helpers interpolate up to
// 120–200 characters of it to make a 403 diagnosable. Every route that returns
// this sits behind requireAdminSession, and that admin already holds the
// VolleyManager account, so nothing is disclosed that they cannot see anyway.
// It is also persisted into app_settings under games_sync_status, so keep the
// cap: this text accumulates.
function upstreamError(error: unknown): string {
  log.error('api.error', 'upstream request failed', { error });
  const message = (error instanceof Error ? error.message : String(error)).trim();
  return message ? message.slice(0, 300) : 'Upstream request failed';
}

// ── RC identity session ──────────────────────────────────────────────
// Cached list of active RC people; also consulted on every RC-authenticated
// request so deactivating/deleting an RC revokes their session within the
// cache TTL. Invalidated by the admin rc-people CRUD endpoints.
type ActiveRcPerson = { id: string; fullName: string; email: string; isRcPresident: boolean };

// A session's tie to the PIN it was issued under (see resolveRcSession). Held
// OUTSIDE ActiveRcPerson on purpose: that object is handed to clients whole by
// /api/referee-coach-people, and a fingerprint is not safe to publish. PINs are
// six digits under one app-wide salt, so anyone holding a colleague's
// fingerprint can walk the million candidates offline and recover the PIN
// itself. Keyed by RC id, refreshed with the roster cache.
let rcPeopleCache: { data: ActiveRcPerson[]; expiresAt: number } | null = null;
// Ids the roster currently knows, for the synchronous check below.
const rcKnownIds = new Set<string>();

async function getActiveRcPeople(): Promise<ActiveRcPerson[]> {
  if (rcPeopleCache && Date.now() < rcPeopleCache.expiresAt) return rcPeopleCache.data;
  await ensureAdminAuth();
  const people = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
    collection.getFullList<AnyRecord>({ sort: 'last_name', filter: 'active = true' }),
  );
  const mapped = people.map((p) => ({
    id: p.id,
    fullName: `${asText(p.first_name)} ${asText(p.last_name)}`.trim(),
    email: asText(p.email),
    // Marks the chair's own record. It no longer grants anything — she reaches
    // her channel with her own password on the admin page — so it is a label
    // now, not a permission.
    isRcPresident: p.is_rc_president === true,
  }));
  rcKnownIds.clear();
  for (const p of mapped) rcKnownIds.add(p.id);
  rcPeopleCache = { data: mapped, expiresAt: Date.now() + 10 * 60 * 1000 };
  return mapped;
}

// The one place a cookie becomes a person. Signature, expiry, and then the name
// on the token has to still be an active RC — a deactivated coach's session
// stops resolving on the next request rather than at the 30-day expiry.
type RcSession = { person: ActiveRcPerson };

async function resolveRcSession(req: Request): Promise<RcSession | null> {
  const session = verifyRcSession(req);
  // No rcId: either no session at all, or one that has not named an RC yet.
  // Both are "nobody", which is what makes the app inert until the picker has
  // been answered — every requireRcSession endpoint 401s on this path.
  if (!session.ok || !session.rcId) return null;
  const person = (await getActiveRcPeople()).find((p) => p.id === session.rcId);
  if (!person) return null;
  return { person };
}

// Admin is the console session and nothing else. It used to also come from an
// is_admin flag on a person, reachable only through a per-person login — and
// when that login went, so did the only credential that could prove you were
// that person. A flag keyed to a name off a picker anyone can open is not a
// permission, so there is one door left and it has its own password.
async function resolveAdmin(req: Request): Promise<{ ok: boolean; email: string }> {
  const a = verifyAdminSession(req);
  return a.ok ? { ok: true, email: a.email || '' } : { ok: false, email: '' };
}

async function requireAdminSession(req: Request, res: ExpressResponse, next: () => void) {
  if (verifyAdminSession(req).ok) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

// Identity of the RC session that authorized a request. Absent only for an
// admin console session — enforcement code treats "no rcAuth" as full access,
// so anything that reaches a handler without one had better be an admin.
type RcAuthInfo = { rcId: string; name: string };
const rcAuthByReq = new WeakMap<Request, RcAuthInfo>();

// Fails CLOSED: unlike the old shared gate there is no "auth disabled" mode.
async function requireRcSession(req: Request, res: ExpressResponse, next: () => void) {
  if (verifyAdminSession(req).ok) { next(); return; }
  try {
    const session = await resolveRcSession(req);
    if (session) {
      // Every app session gets its identity attached and is scoped to it (name
      // from the live record, so ownership checks survive a rename). The
      // exception used to be an admin-flagged person on a personal login; with
      // that login gone there is no app session that skips this, which is what
      // keeps the "no rcAuth means admin" convention above true.
      rcAuthByReq.set(req, { rcId: session.person.id, name: session.person.fullName });
      next();
      return;
    }
  } catch (error) {
    console.error('[auth] RC session check failed:', error);
    res.status(503).json({ error: 'Auth backend unavailable' });
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

const collectionCandidates = {
  games: unique([process.env.PB_GAMES_COLLECTION || 'games', 'games', 'svrz_games']),
  coachees: unique([process.env.PB_COACHEES_COLLECTION || 'coachees', 'coachees', 'svrz_coachees']),
  observations: unique([process.env.PB_OBSERVATIONS_COLLECTION || 'observations', 'observations', 'svrz_observations']),
  refereeCoachPeople: unique([process.env.PB_REFEREE_COACH_PEOPLE_COLLECTION || 'referee_coaches', 'referee_coaches', 'referee_coach_people']),
  refereeCoaches: unique([
    process.env.PB_REFEREE_COACH_FEEDBACK_COLLECTION || process.env.PB_REFEREE_COACHES_COLLECTION || 'referee_coach_feedbacks',
    'referee_coach_feedbacks',
    'svrz_referee_coach_feedbacks',
  ]),
};

const requiredEnv = ['POCKETBASE_URL', 'POCKETBASE_ADMIN_EMAIL', 'POCKETBASE_ADMIN_PASSWORD'] as const;
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`[startup] Missing env var: ${key}`);
  }
}

const pb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');
pb.autoCancellation(false);
const VM_BASE = process.env.VM_BASE || '';
const VM_BATCH_SIZE = 200;
const VM_SYNC_CRON = process.env.VM_SYNC_CRON || '0 5 * * *';
const VM_SYNC_TIMEZONE = process.env.VM_SYNC_TIMEZONE || 'Europe/Zurich';
const VM_SYNC_MAX_RETRIES = Number(process.env.VM_SYNC_MAX_RETRIES || 10);
const VM_SYNC_RETRY_DELAY_MS = Number(process.env.VM_SYNC_RETRY_DELAY_MS || 15000);
const RENDER_PROPERTIES = [
  'game.startingDateTime', 'gameDayOfWeek', 'game.number',
  'game.group.phase.league.leagueCategory.name',
  'game.group.phase.league.leagueCategory.shortName',
  'game.group.phase.league.leagueCategory.displayNameWithManagingAssociationShortName',
  'game.group.phase.league.gender',
  'game.group.phase.league.name',
  'game.group.phase.league.displayName',
  'game.group.name', 'game.group.displayName',
  'game.group.phase.name', 'game.group.phase.displayName',
  'game.encounter.teamHome.identifier', 'game.encounter.teamHome.name',
  'game.encounter.teamAway.identifier', 'game.encounter.teamAway.name',
  'game.hall.name', 'game.hall.displayName',
  'game.hall.primaryPostalAddress.combinedAddress',
  'game.hall.primaryPostalAddress.postalCode',
  'game.hall.primaryPostalAddress.city',
  'game.hall.primaryPostalAddress.geographicalLocation.plusCode',
  'game.hall.primaryPostalAddress.geographicalLocation.latitude',
  'game.hall.primaryPostalAddress.geographicalLocation.longitude',
  'activeFirstHeadRefereeName', 'activeSecondHeadRefereeName',
  'activeFirstLineJudgeName', 'activeSecondLineJudgeName',
  'refereeConvocations.*.indoorAssociationReferee.indoorReferee.person.displayName',
  'isSupervised', 'hasAtLeastOneRefereeIntendedToBeSupervised',
  'isLinesmanOneSupervised', 'isLinesmanTwoSupervised',
  'isLinesmanThreeSupervised', 'isLinesmanFourSupervised',
  'game.gameResultReportFromHomeTeam',
  'game.gameResultReportFromReferee',
  'game.gameResultReportFromChampionshipOwner',
];
// Note: this list only drives the columns VM renders — the search response
// carries every property of the object either way (verified against a captured
// browser session), which is why fields like `refereeSupervisorNeeded` can be
// read without asking for them.

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function asBoolean(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function extractPageTitle(html: string): string {
  const match = html.match(/<title>([^<]+)<\/title>/i);
  return asText(match?.[1]);
}

function snippetFromHtml(html: string, maxLength = 180): string {
  const collapsed = html.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, maxLength);
}

function isMissingCollectionError(error: unknown): boolean {
  const text = String(error ?? '');
  if (text.includes('Missing collection context')) return true;
  if (!text.includes('ClientResponseError 404')) return false;
  // PocketBase answers 404 for a missing *record* as well ("The requested
  // resource wasn't found."). That is a routine miss, not a wrong collection
  // name — walking on to the next candidate only buries it in an opaque 500.
  return !/wasn'?t found|was not found/i.test(text);
}

/** A 404 that means "no such record", as opposed to "no such collection". */
function isRecordNotFound(error: unknown): boolean {
  const text = String(error ?? '');
  return text.includes('ClientResponseError 404') && !text.includes('Missing collection context');
}

function isPocketBaseBadRequest(error: unknown): boolean {
  const text = String(error ?? '');
  return text.includes('ClientResponseError 400');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Official SVRZ logo, loaded once and embedded inline (CID) so it renders even
// when a client blocks remote images. null if the asset can't be read, in which
// case emails fall back to a text wordmark header.
const EMAIL_LOGO_CID = 'svrzlogo';
let emailLogo: Buffer | null | undefined;
function getEmailLogo(): Buffer | null {
  if (emailLogo !== undefined) return emailLogo;
  for (const p of ['server/assets/svrz-logo.png', 'src/assets/svrz-logo.png']) {
    try { emailLogo = readFileSync(p); return emailLogo; } catch { /* try next candidate */ }
  }
  console.warn('[email] SVRZ logo asset not found — using text header.');
  emailLogo = null;
  return emailLogo;
}
function emailAttachments(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  const logo = getEmailLogo();
  const logoAtt = logo ? [{ filename: 'svrz-logo.png', content: logo, cid: EMAIL_LOGO_CID }] : [];
  return [...extra, ...logoAtt];
}

// Branded SVRZ email shell: white header with the logo, a red accent rule, then
// the white card + footer. Inline styles + table-free layout so it renders
// across email clients. `bodyHtml` is the card content (trusted markup).
function emailShell(bodyHtml: string): string {
  const header = getEmailLogo()
    ? `<img src="cid:${EMAIL_LOGO_CID}" alt="Swiss Volley Region Zürich" width="150" style="display:block;width:150px;max-width:60%;height:auto;margin:0 auto;" />`
    : `<div style="font-size:19px;font-weight:800;letter-spacing:-0.4px;color:#dc2626;">Swiss Volley <span style="color:#57534e;">Region Zürich</span></div>`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #e7e5e4;border-bottom:none;border-radius:14px 14px 0 0;padding:26px 32px 22px;text-align:center;">
      ${header}
      <div style="font-size:10px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:#a8a29e;margin-top:12px;">Referee Coaching</div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#dc2626,#b91c1c);"></div>
    <div style="background:#ffffff;border:1px solid #e7e5e4;border-top:none;border-radius:0 0 14px 14px;padding:32px;">
      ${bodyHtml}
    </div>
    <div style="text-align:center;padding:16px 0;">
      <p style="margin:0;font-size:11px;color:#a8a29e;">Swiss Volley Region Zürich · Diese E-Mail wurde automatisch versendet.</p>
    </div>
  </div>
</body>
</html>`;
}

// ── Editable email templates (guided fields, admin-managed) ───────────
// Admins edit subject/heading/intro/outro (each supporting {{placeholders}});
// the branded shell, the data-driven detail rows and the attachments stay
// fixed, so a bad edit can never break rendering or leak raw HTML. Stored in
// app_settings as JSON under `email_template_<kind>`.
type EmailTemplateKind = 'feedback' | 'reminder';
type EmailTemplate = { subject: string; heading: string; intro: string; outro: string };

const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateKind, EmailTemplate> = {
  feedback: {
    subject: 'SR-Coaching Feedback – Spiel {{matchNo}} ({{date}})',
    heading: 'SR-Coaching Feedback',
    intro: 'Hallo {{coachee}}\n\nHier ist das Feedback zu deinem Einsatz als {{role}}. Der vollständige Bericht ist als PDF angehängt.',
    outro: 'Wir freuen uns über dein Feedback zum Coaching-Erlebnis:',
  },
  reminder: {
    subject: 'Coaching-Begleitung bei deinem nächsten Einsatz',
    heading: '',
    intro: `Liebe/r {{vorname}},

bei deinem nächsten Einsatz wirst du im Rahmen unseres Schiedsrichter-Coachings begleitet: {{coach}} ist als Coach vor Ort, um dich zu unterstützen und gemeinsam mit dir an deiner Weiterentwicklung zu arbeiten.

Einsatz-Details:

Datum: {{datum}}
Zeit: {{uhrzeit}}
Spiel: {{heim}} – {{gast}} ({{liga}})
Ort/Halle: {{halle}}

{{coachVorname}} meldet sich vor Ort kurz bei dir. Das Coaching ist keine Prüfung – im Anschluss nehmt ihr euch gemeinsam Zeit für ein Gespräch, um Stärken zu festigen und Ansatzpunkte für deine Entwicklung zu besprechen.

Bei Fragen oder falls sich am Einsatz etwas ändert, melde dich bitte rechtzeitig.`,
    outro: 'Sportliche Grüsse\n{{coach}}',
  },
};

// Replace {{placeholders}}; unknown keys render empty rather than leaking braces.
function renderPlaceholders(text: string, vars: Record<string, string>): string {
  // hasOwn, not a bare lookup: the key charset admits `constructor` and
  // `toString`, and an unguarded read walked the prototype chain and rendered
  // "function Object() { [native code] }" into the mail.
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_m, k: string) => (Object.hasOwn(vars, k) ? vars[k] : ''));
}

async function getEmailTemplate(kind: EmailTemplateKind): Promise<EmailTemplate> {
  const def = DEFAULT_EMAIL_TEMPLATES[kind];
  const rec = await getSettingRecord(`email_template_${kind}`);
  if (!rec) return def;
  try {
    const p = JSON.parse(asText(rec.value)) as Partial<EmailTemplate>;
    const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
    // Subject must never be blank (a blank subject is a broken mail); heading is
    // optional — blank simply renders no title line.
    const req = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v : d);
    return {
      subject: req(p.subject, def.subject),
      heading: str(p.heading, def.heading),
      intro: str(p.intro, def.intro),
      outro: str(p.outro, def.outro),
    };
  } catch { return def; }
}

// Mail templates render a wall clock to people standing in Swiss gyms, so the
// numbers have to be the region's — the container runs UTC, which would put
// every VolleyManager kick-off an hour or two early. icalMoment already knows
// the three shapes match_date arrives in; a bare date carries no clock at all.
function zonedParts(instant: number): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VM_SYNC_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(instant));
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: at('year'), month: at('month'), day: at('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: String(Number(at('hour')) % 24).padStart(2, '0'),
    minute: at('minute'),
  };
}

function fmtDateDe(value: string): string {
  const moment = icalMoment(value);
  if (!moment) return asText(value);
  if (moment.allDay) return `${moment.date.slice(6, 8)}.${moment.date.slice(4, 6)}.${moment.date.slice(0, 4)}`;
  const p = zonedParts(moment.instant);
  return `${p.day}.${p.month}.${p.year}`;
}

function fmtTimeDe(value: string): string {
  const moment = icalMoment(value);
  if (!moment || moment.allDay) return '';
  const p = zonedParts(moment.instant);
  return `${p.hour}:${p.minute}`;
}

// Values available as {{placeholders}} in the templates. The German names are
// the documented ones (listed in the admin editor); English aliases are kept so
// a template written either way keeps working.
function emailVars(o: {
  refereeName: string; rcName: string; matchNo: string; league: string;
  date: string; time: string; location: string; homeTeam: string; awayTeam: string; role: string;
}): Record<string, string> {
  const first = (n: string) => n.trim().split(/\s+/)[0] || '';
  return {
    vorname: first(o.refereeName), name: o.refereeName,
    coach: o.rcName, coachVorname: first(o.rcName),
    datum: o.date, uhrzeit: o.time,
    heim: o.homeTeam, gast: o.awayTeam, liga: o.league, halle: o.location,
    spielNr: o.matchNo, rolle: o.role,
    // English aliases
    coachee: o.refereeName, rc: o.rcName, date: o.date, time: o.time,
    location: o.location, homeTeam: o.homeTeam, awayTeam: o.awayTeam,
    match: `${o.homeTeam} – ${o.awayTeam}`, league: o.league, matchNo: o.matchNo, role: o.role,
  };
}

// Admin-edited prose → escaped HTML paragraphs (blank line = new paragraph).
function textBlockHtml(text: string): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  return t.split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 14px;font-size:14px;color:#44403c;line-height:1.6;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`,
  ).join('');
}

function detailRowsHtml(rows: Array<[string, string]>): string {
  const body = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;font-weight:600;white-space:nowrap;vertical-align:top;color:#57534e;">${escapeHtml(k)}</td><td style="padding:6px 0;color:#1c1917;">${escapeHtml(v)}</td></tr>`,
  ).join('');
  return body ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 18px;">${body}</table>` : '';
}

// Question above, answer below. Survey questions are full sentences — in the
// two-column layout of detailRowsHtml they squeezed the answer into a sliver
// on the right, so these get a row each.
function qaBlocksHtml(qa: Array<[string, string]>): string {
  const body = qa.filter(([, v]) => v).map(([q, a]) =>
    `<div style="margin:0 0 14px;">`
    + `<p style="margin:0 0 3px;font-size:13px;font-weight:600;color:#57534e;line-height:1.4;">${escapeHtml(q)}</p>`
    + `<p style="margin:0;font-size:14px;color:#1c1917;white-space:pre-wrap;line-height:1.5;">${escapeHtml(a)}</p>`
    + `</div>`,
  ).join('');
  return body ? `<div style="margin:0 0 18px;padding:14px 16px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:8px;">${body}</div>` : '';
}

// Render a template + data into the branded shell. Used by BOTH the post-match
// feedback mail and the day-before reminder, so they stay visually consistent.
function buildTemplatedEmail(opts: {
  tpl: EmailTemplate;
  vars: Record<string, string>;
  rows: Array<[string, string]>;
  qa?: Array<[string, string]>;
  tips?: string;
  surveyUrl?: string;
  footerNote?: string;
}): { subject: string; html: string; text: string } {
  const r = (s: string) => renderPlaceholders(s, opts.vars);
  const heading = r(opts.tpl.heading);
  const intro = r(opts.tpl.intro);
  const outro = r(opts.tpl.outro);
  const tips = (opts.tips || '').trim();
  const tipsHtml = tips
    ? `<div style="margin:18px 0;padding:14px 18px;border-left:4px solid #059669;background:#ecfdf5;border-radius:0 8px 8px 0;"><h2 style="margin:0 0 6px;font-size:14px;font-weight:600;color:#059669;">Tipps &amp; Tricks</h2><p style="margin:0;font-size:14px;color:#1e293b;white-space:pre-wrap;line-height:1.6;">${escapeHtml(tips)}</p></div>`
    : '';
  const surveyHtml = opts.surveyUrl
    ? `<div style="margin-top:20px;"><a href="${escapeHtml(opts.surveyUrl)}" style="display:inline-block;padding:10px 24px;background:#059669;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">Feedback geben</a></div>`
    : '';
  const footerHtml = opts.footerNote
    ? `<p style="margin:18px 0 0;font-size:12px;color:#a8a29e;">${escapeHtml(opts.footerNote)}</p>`
    : '';
  const html = emailShell(
    (heading.trim() ? `<h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#1c1917;">${escapeHtml(heading)}</h1>` : '')
    + textBlockHtml(intro)
    + detailRowsHtml(opts.rows)
    + qaBlocksHtml(opts.qa ?? [])
    + tipsHtml
    + textBlockHtml(outro)
    + surveyHtml
    + footerHtml,
  );
  let text = heading.trim() ? `${heading}\n\n` : '';
  if (intro.trim()) text += `${intro.trim()}\n\n`;
  for (const [k, v] of opts.rows) if (v) text += `${k}: ${v}\n`;
  for (const [q, a] of opts.qa ?? []) if (a) text += `\n${q}\n${a}\n`;
  if (tips) text += `\n--- Tipps & Tricks ---\n${tips}\n`;
  if (outro.trim()) text += `\n${outro.trim()}\n`;
  if (opts.surveyUrl) text += `\n${opts.surveyUrl}\n`;
  if (opts.footerNote) text += `\n${opts.footerNote}\n`;
  return { subject: r(opts.tpl.subject), html, text };
}

// Prominent monospace box for a PIN or one-time code.
function emailCodeBox(value: string): string {
  return `<div style="margin:24px 0;text-align:center;">
    <span style="display:inline-block;padding:16px 30px;background:#f5f5f4;border:1px solid #e7e5e4;border-radius:12px;font-size:30px;font-weight:700;letter-spacing:9px;color:#1c1917;font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(value)}</span>
  </div>`;
}

async function withCollection<T>(
  candidates: string[],
  action: (collection: ReturnType<typeof pb.collection>, collectionName: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (const collectionName of candidates) {
    try {
      return await action(pb.collection(collectionName), collectionName);
    } catch (error) {
      if (isMissingCollectionError(error)) {
        lastError = error;
        continue;
      }
      // Retry once on 429 (Too Many Requests) after a brief delay
      if (typeof error === 'object' && error !== null && (error as { status?: number }).status === 429) {
        await sleep(1000);
        try {
          return await action(pb.collection(collectionName), collectionName);
        } catch (retryError) {
          throw retryError;
        }
      }
      throw error;
    }
  }

  throw new Error(
    `Missing collection context. Tried collections: ${candidates.join(', ')}. Last error: ${String(lastError ?? 'n/a')}`,
  );
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CookieJar {
  private cookies: Record<string, string> = {};

  update(response: Response) {
    const typedHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    for (const cookieHeader of typedHeaders.getSetCookie?.() ?? []) {
      const match = cookieHeader.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.cookies[match[1]] = match[2];
      }
    }

    const fallback = response.headers.get('set-cookie');
    if (fallback) {
      for (const part of fallback.split(/,(?=\s*\w+=)/)) {
        const match = part.trim().match(/^([^=]+)=([^;]*)/);
        if (match) {
          this.cookies[match[1]] = match[2];
        }
      }
    }
  }

  set(name: string, value: string) {
    this.cookies[name] = value;
  }

  header(): string {
    return Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}

type VmTraceEntry = {
  step: string;
  requestUrl: string;
  status: number;
  redirected: boolean;
  location: string;
  pageTitle: string;
  bodySnippet: string;
};

async function ensureAdminAuth() {
  if (pb.authStore.isValid) {
    return;
  }
  const email = process.env.POCKETBASE_ADMIN_EMAIL || '';
  const password = process.env.POCKETBASE_ADMIN_PASSWORD || '';
  await pb.collection('_superusers').authWithPassword(email, password);
}

/**
 * Re-authenticate once when PocketBase rejects the token we hold.
 *
 * `isValid` only checks the JWT's own expiry, and nothing anywhere cleared the
 * store on a 401/403 — so rotating the superuser password (which the security
 * notes tell you to do on exposure) without restarting the container left every
 * call failing until the container restarted or the 14-day token ran out.
 * Returns true if a retry is worth making.
 */
async function reauthOnRejection(error: unknown): Promise<boolean> {
  const status = Number((error as { status?: unknown })?.status);
  if (status !== 401 && status !== 403) return false;
  pb.authStore.clear();
  try {
    await ensureAdminAuth();
    return true;
  } catch {
    return false;
  }
}

function mapIncomingGame(raw: Record<string, unknown>) {
  return {
    external_id: asText(raw.external_id ?? raw.game_id ?? raw.id ?? raw.uuid),
    match_no: asText(raw.match_no ?? raw.spiel_nr ?? raw.number ?? raw.gameNo),
    league: asText(raw.league ?? raw.liga ?? raw.competition),
    match_date: asText(raw.match_date ?? raw.date ?? raw.datum ?? raw.matchDate),
    location: asText(raw.location ?? raw.ort ?? raw.venue),
    home_team: asText(raw.home_team ?? raw.team_home ?? raw.home),
    away_team: asText(raw.away_team ?? raw.team_away ?? raw.away),
    first_referee: asText(raw.first_referee ?? raw.referee_1 ?? raw.sr1 ?? raw.r1),
    second_referee: asText(raw.second_referee ?? raw.referee_2 ?? raw.sr2 ?? raw.r2),
    first_line_judge: asText(raw.first_line_judge ?? raw.lj1),
    second_line_judge: asText(raw.second_line_judge ?? raw.lj2),
    is_rd_game: Boolean(raw.is_rd_game),
    is_ld_game: Boolean(raw.is_ld_game),
    is_rsv_game: Boolean(raw.is_rsv_game),
    maps_url: asText(raw.maps_url),
    game_result: asText(raw.game_result),
  };
}

async function upsertGame(gameData: ReturnType<typeof mapIncomingGame>) {
  await ensureAdminAuth();
  return withCollection(collectionCandidates.games, async (games) => {
    // Try every key in turn instead of committing to the first one. Filtering on
    // a column the collection doesn't declare *throws*, and `external_id` has
    // never existed in this schema — so that branch used to swallow the error
    // and fall through to create(), duplicating every game a sync re-touched.
    // match_no (VM's game number) is the real identity; match_date must stay out
    // of the key because a postponed game changes date and would duplicate.
    const filters = [
      gameData.external_id ? `external_id = "${escapeFilterValue(gameData.external_id)}"` : '',
      gameData.match_no ? `match_no = "${escapeFilterValue(gameData.match_no)}"` : '',
    ].filter(Boolean);

    let existing: AnyRecord | null = null;
    for (const filter of filters) {
      try {
        existing = await games.getFirstListItem<AnyRecord>(filter);
        break;
      } catch {
        existing = null; // no match, or the column doesn't exist — try the next key
      }
    }

    // PocketBase drops keys the collection doesn't declare instead of erroring,
    // so a column added here only lands once it exists in the schema too
    // (deploy/hetzner/seed/setup-schema.mjs).
    if (existing) {
      // VolleyManager publishes the score days after the match, so a sync that
      // runs before it does carries an empty one. That absence is not news —
      // blanking the record would throw away a score already on it, whether an
      // earlier sync or a coach typing it into the feedback form put it there.
      return games.update(existing.id, gameData.game_result
        ? gameData
        : { ...gameData, game_result: asText(existing.game_result) });
    }
    return games.create(gameData);
  });
}

async function followRedirects(
  url: string,
  jar: CookieJar,
  init: RequestInit = {},
  maxRedirects = 10,
  trace?: VmTraceEntry[],
  step = 'request',
): Promise<{ response: Response; body: string }> {
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  let currentUrl = url;
  let currentInit = init;

  for (let i = 0; i < maxRedirects; i += 1) {
    const response = await fetch(currentUrl, {
      ...currentInit,
      headers: {
        'User-Agent': userAgent,
        Cookie: jar.header(),
        ...(currentInit.headers ?? {}),
      },
      redirect: 'manual',
    });
    jar.update(response);
    const body = await response.text();
    const location = response.headers.get('location') || '';
    trace?.push({
      step,
      requestUrl: currentUrl,
      status: response.status,
      redirected: response.status >= 300 && response.status < 400,
      location,
      pageTitle: extractPageTitle(body),
      bodySnippet: snippetFromHtml(body),
    });

    if (response.status >= 300 && response.status < 400) {
      if (!location) {
        break;
      }
      currentUrl = location.startsWith('http') ? location : `${VM_BASE}${location}`;
      currentInit = {};
      continue;
    }

    return { response, body };
  }

  throw new Error(`Too many redirects while requesting ${url}`);
}

// Cache VM session to avoid re-login on every sync retry (valid for 30 min)
type VmSession = { jar: CookieJar; csrfToken: string; windowUniqueId: string };
let vmCsrfCache: (VmSession & { cachedAt: number }) | null = null;
const VM_CSRF_CACHE_TTL_MS = 30 * 60 * 1000;


// ── VolleyManager roles ──────────────────────────────────────────────
// One VM account, and no single role can do both jobs. Measured 2026-08-12
// against the production account:
//
//   role                                     refereegame   addressviewer
//   Indoorvolleyball.RefAdmin:RefereeDelegate    200           403
//   SportManager.Indoorvolleyball:*(club)        403           200
//   everything else                              403           403
//
// So the games sync needs the referee-delegate role and the contact sync needs
// a club one, and whichever a human last picked in the VM UI decides whether
// either works. That is how the games import died unnoticed for three weeks.
// Each job now switches the session into the role it needs before it starts.
//
// The value is an *attribute value* id, not a role name: it is the
// `persistenceObjectIdentifier` of an entry in
// `party.groupedEligibleAttributeValues` (visible at
// `GET /api/sportmanager.security/api%5cparty?party[__identity]=<partyId>`,
// which the account menu calls). They are per-account, so they are overridable
// — if VM_USERNAME ever changes, re-read them there and set these.
const VM_ROLE_FOR_GAMES = process.env.VM_ROLE_ATTRIBUTE_GAMES
  || 'e693b8cf-3fda-4a8d-b091-b3c7dae850ec'; // Indoorvolleyball.RefAdmin:RefereeDelegate
const VM_ROLE_FOR_CONTACTS = process.env.VM_ROLE_ATTRIBUTE_CONTACTS
  || 'ed24d37c-5444-4c5d-b602-623eff84d400'; // SportManager.Indoorvolleyball:PlayingScheduleResponsible

/**
 * Point the logged-in session at a particular role. Best effort: if the switch
 * fails, the caller's own page fetch will fail with a clearer message than
 * anything this could throw, and the session may already be on the right role
 * (in which case the switch is unnecessary anyway).
 */
async function vmSwitchRole(jar: CookieJar, csrfToken: string, attributeValueId: string): Promise<boolean> {
  if (!attributeValueId || !csrfToken) return false;
  try {
    const body = new URLSearchParams();
    body.set('attributeValueAsArray[0]', attributeValueId);
    body.set('__csrfToken', csrfToken);
    const res = await fetch(`${VM_BASE}/api/sportmanager.security/api%5cparty/switchRoleAndAttribute`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        Origin: VM_BASE,
        Referer: `${VM_BASE}/`,
        Cookie: jar.header(),
      },
      body: body.toString(),
    });
    if (!res.ok) {
      console.warn(`[vm] role switch to ${attributeValueId} returned ${res.status}`);
      return false;
    }
    console.log(`[vm] switched the session to role attribute ${attributeValueId}`);
    return true;
  } catch (error) {
    console.warn('[vm] role switch failed:', error);
    return false;
  }
}

async function vmLogin(username: string, password: string): Promise<VmSession> {
  if (vmCsrfCache && (Date.now() - vmCsrfCache.cachedAt) < VM_CSRF_CACHE_TTL_MS) {
    console.log('[vm] Using cached CSRF token');
    // The role lives on the VM session, not on this cache, so a contact sync
    // in between will have moved the very session being reused here onto a club
    // role. Re-assert before handing it back, or the second job of the day
    // quietly runs as the wrong person.
    await vmSwitchRole(vmCsrfCache.jar, vmCsrfCache.csrfToken, VM_ROLE_FOR_GAMES);
    return { jar: vmCsrfCache.jar, csrfToken: vmCsrfCache.csrfToken, windowUniqueId: vmCsrfCache.windowUniqueId };
  }
  return vmLoginWithTrace(username, password);
}

async function vmLoginWithTrace(
  username: string,
  password: string,
  trace?: VmTraceEntry[],
): Promise<VmSession> {
  const jar = new CookieJar();
  // Pre-set language cookie — VM expects it (browser always sends it)
  jar.set('language', 'de');
  const { body: loginHtml } = await followRedirects(`${VM_BASE}/login`, jar, {}, 10, trace, 'login-page');

  const hiddenFields: Record<string, string> = {};
  const hiddenRegex = /name="([^"]+)"[^>]*value="([^"]*?)"/g;
  for (const match of loginHtml.matchAll(hiddenRegex)) {
    hiddenFields[match[1]] = match[2];
  }

  hiddenFields['__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]'] = username;
  hiddenFields['__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]'] = password;

  await followRedirects(
    `${VM_BASE}/sportmanager.security/authentication/authenticate`,
    jar,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(hiddenFields).toString(),
    },
    10,
    trace,
    'authenticate',
  );

  // Visit dashboard — required to establish session permissions before referee-index
  const { body: dashboardHtml } = await followRedirects(`${VM_BASE}/`, jar, {}, 10, trace, 'dashboard');

  // The dashboard opens under every role and carries a CSRF token, which is
  // what lets us ask for the one role that can read the game list below.
  const dashboardCsrf = dashboardHtml.match(/data-csrf-token="([^"]+)"/)?.[1] ?? '';
  await vmSwitchRole(jar, dashboardCsrf, VM_ROLE_FOR_GAMES);

  const tokenPatterns = [
    /data-csrf-token="([^"]+)"/,
    /name="__csrfToken"[^>]*value="([^"]+)"/,
    /name="_csrf"[^>]*value="([^"]+)"/,
    /meta\s+name="csrf-token"\s+content="([^"]+)"/,
  ];

  // Retry CSRF page fetch — VM sometimes returns 403 if session isn't propagated yet
  const csrfRetries = 5;
  const csrfRetryDelayMs = 3000;
  let lastTitle = 'unknown';
  let lastLoginHint = '';

  for (let attempt = 1; attempt <= csrfRetries; attempt += 1) {
    if (attempt > 1) {
      console.warn(`[vm] CSRF page attempt ${attempt}/${csrfRetries} — retrying in ${csrfRetryDelayMs}ms...`);
      await sleep(csrfRetryDelayMs);
    }

    const { body: refereeHtml } = await followRedirects(
      `${VM_BASE}/indoorvolleyball.refadmin/refereegame/index`,
      jar,
      {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
          Referer: `${VM_BASE}/`,
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      10,
      trace,
      `referee-index-attempt-${attempt}`,
    );

    for (const pattern of tokenPatterns) {
      const match = refereeHtml.match(pattern);
      if (match?.[1]) {
        const wuidMatch = refereeHtml.match(/data-window-unique-id="([^"]+)"/);
        const windowUniqueId = wuidMatch?.[1] || '';
        vmCsrfCache = { jar, csrfToken: match[1], windowUniqueId, cachedAt: Date.now() };
        return { jar, csrfToken: match[1], windowUniqueId };
      }
    }

    const titleMatch = refereeHtml.match(/<title>([^<]+)<\/title>/i);
    lastTitle = titleMatch?.[1] || 'unknown';
    lastLoginHint = refereeHtml.includes('/login') ? 'Likely redirected to login (credentials/permissions).' : 'No login redirect hint detected.';
  }

  throw new Error(`Could not extract CSRF token after login (${csrfRetries} attempts). Page title: "${lastTitle}". ${lastLoginHint}`);
}

function buildVmSearchBody(csrfToken: string, offset: number, limit: number, from: string, to: string): string {
  const params = new URLSearchParams();
  params.set('searchConfiguration[propertyFilters][0][propertyName]', 'game.startingDateTime');
  params.set('searchConfiguration[propertyFilters][0][dateRange][from]', from);
  params.set('searchConfiguration[propertyFilters][0][dateRange][to]', to);
  params.set('searchConfiguration[customFilters]', '');
  params.set('searchConfiguration[propertyOrderings][0][propertyName]', 'game.startingDateTime');
  params.set('searchConfiguration[propertyOrderings][0][descending]', 'false');
  params.set('searchConfiguration[propertyOrderings][0][isSetByUser]', 'true');
  params.set('searchConfiguration[offset]', String(offset));
  params.set('searchConfiguration[limit]', String(limit));
  params.set('searchConfiguration[textSearchOperator]', 'AND');
  RENDER_PROPERTIES.forEach((property, index) => {
    params.set(`propertyRenderConfiguration[${index}]`, property);
  });
  params.set('__csrfToken', csrfToken);
  return params.toString();
}

// ── Referee contact details from VolleyManager ───────────────────────
// The SVRZ referee XLSX carries no email column, so imported coachees have no
// address — and POST /api/feedback hard-fails without one, at the very end of
// a filled-in form. VM's "Schiedsrichterliste" (refereeAddressViewer) holds an
// email and phone for every licensed referee, so pull them from there as a
// follow-up step to the import.
type VmRefereeContact = { firstName: string; lastName: string; email: string; phone: string; level: string };

const VM_CONTACT_COLUMNS = [
  'person.lastName',
  'person.firstName',
  'person.primaryEmailAddress.emailAddress',
  'person.primaryPhoneNumber.normalizedLocalNumber',
  // Niveau (N1..N4). The XLSX's Niveau column is a snapshot of import day, so a
  // promotion since then leaves us showing the old level for a whole season —
  // seven coachees were stale when this was added (2026-08-23). The path comes
  // from VM's public label catalogue (`activeSeasonalRefereeData…refereeLevel.name`
  // = "Niveau"); this search returns ONLY the columns asked for, so it has to be
  // requested explicitly.
  //
  // The Niveau*stufe* (the "-3" in "N4-3") is NOT available here: it lives on
  // IndoorAssociationReferee, and that API answers 403 under every role this
  // account can hold. `stage` therefore stays whatever the import set.
  'activeSeasonalRefereeData.activeIndoorRefereeLevel.refereeLevel.name',
];
const VM_CONTACT_PAGE_SIZE = 400;

async function fetchVmRefereeContacts(username: string, password: string): Promise<VmRefereeContact[]> {
  const jar = new CookieJar();
  jar.set('language', 'de');
  const { body: loginHtml } = await followRedirects(`${VM_BASE}/login`, jar, {}, 10);
  const hidden: Record<string, string> = {};
  for (const m of loginHtml.matchAll(/name="([^"]+)"[^>]*value="([^"]*?)"/g)) hidden[m[1]] = m[2];
  const authPrefix = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword]';
  hidden[`${authPrefix}[username]`] = username;
  hidden[`${authPrefix}[password]`] = password;
  await followRedirects(`${VM_BASE}/sportmanager.security/authentication/authenticate`, jar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(hidden).toString(),
  }, 10);
  const { body: dash } = await followRedirects(`${VM_BASE}/`, jar, {}, 10);
  // The address viewer opens under a CLUB role and 403s under the referee one —
  // the exact opposite of the game list (see VM_ROLE_FOR_GAMES). Whichever role
  // the last job left behind, put the session back where this one needs it.
  await vmSwitchRole(jar, dash.match(/data-csrf-token="([^"]+)"/)?.[1] ?? '', VM_ROLE_FOR_CONTACTS);

  // The CSRF token comes from the address-viewer page itself, not the refadmin
  // game list vmLogin() uses — that one 403s under this role.
  const viewerUrl = `${VM_BASE}/sportmanager.indoorvolleyball/refereeaddressviewer/index`;
  const { body: page } = await followRedirects(viewerUrl, jar, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  }, 10);
  const csrfToken = page.match(/data-csrf-token="([^"]+)"/)?.[1] ?? '';
  const windowUniqueId = page.match(/data-window-unique-id="([^"]+)"/)?.[1] ?? '';
  if (!csrfToken) {
    const title = page.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? 'unknown';
    throw new Error(`Could not open the VolleyManager referee list (page: "${title.slice(0, 60)}").`);
  }

  const url = `${VM_BASE}/api/sportmanager.indoorvolleyball/api%5crefereeaddressviewer/search`;
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain;charset=UTF-8',
    Accept: '*/*',
    Origin: VM_BASE,
    Referer: viewerUrl,
    'Window-Unique-Id': windowUniqueId,
    Cookie: jar.header(),
  };
  const body = (offset: number) => {
    const params = new URLSearchParams();
    params.set('searchConfiguration[customFilters]', '');
    params.set('searchConfiguration[offset]', String(offset));
    params.set('searchConfiguration[limit]', String(VM_CONTACT_PAGE_SIZE));
    params.set('searchConfiguration[textSearchOperator]', 'AND');
    VM_CONTACT_COLUMNS.forEach((property, index) => params.set(`propertyRenderConfiguration[${index}]`, property));
    params.set('__csrfToken', csrfToken);
    return params.toString();
  };

  const out: VmRefereeContact[] = [];
  let total = Infinity;
  // Paged by an explicit offset rather than by out.length: an item that carries
  // no `person` is skipped, so a page made of those would leave out.length
  // where it was and ask VolleyManager for the very same page forever.
  let offset = 0;
  while (offset < total) {
    const response = await fetch(url, { method: 'POST', headers, body: body(offset) });
    if (!response.ok) {
      throw new Error(`VolleyManager referee list failed: ${response.status} ${(await response.text()).slice(0, 120)}`);
    }
    const payload = await response.json() as { items?: unknown[]; totalItemsCount?: number };
    total = payload.totalItemsCount ?? 0;
    const items = payload.items ?? [];
    if (items.length === 0) break;
    offset += items.length;
    for (const raw of items) {
      const person = (raw as AnyRecord)?.person as AnyRecord | undefined;
      if (!person) continue;
      out.push({
        firstName: asText(person.firstName),
        lastName: asText(person.lastName),
        email: asText(deepGet(person, 'primaryEmailAddress', 'emailAddress')),
        phone: asText(deepGet(person, 'primaryPhoneNumber', 'normalizedLocalNumber')),
        // Niveau hangs off the item, not the person.
        level: asText(deepGet(raw as AnyRecord, 'activeSeasonalRefereeData', 'activeIndoorRefereeLevel', 'refereeLevel', 'name')),
      });
    }
  }
  return out;
}

// Both name orders, because the XLSX and VolleyManager disagree on which comes
// first and nothing downstream knows which one it is holding.
function nameKeyVariants(name: string): string[] {
  const norm = normalizeName(name);
  if (!norm) return [];
  const parts = norm.split(' ').filter(Boolean);
  if (parts.length < 2) return [norm];
  const reversed = [...parts].reverse().join(' ');
  return reversed === norm ? [norm] : [norm, reversed];
}

type VmContact = { email: string; phone: string; level?: string };
async function fetchAllVmGames(
  jar: CookieJar,
  csrfToken: string,
  from: string,
  to: string,
  windowUniqueId = '',
): Promise<{ items: unknown[]; total: number }> {
  const url = `${VM_BASE}/api/indoorvolleyball.refadmin/api%5celasticsearchrefereegame/searchForManagingAssociation`;
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Content-Type': 'text/plain;charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'de-CH,de;q=0.9,en;q=0.8',
    Origin: VM_BASE,
    Referer: `${VM_BASE}/indoorvolleyball.refadmin/refereegame/index`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    Cookie: jar.header(),
  };
  if (windowUniqueId) {
    headers['Window-Unique-Id'] = windowUniqueId;
  }

  console.log(`[vm] Fetching games from ${from} to ${to} — first batch...`);
  const firstResponse = await fetch(url, {
    method: 'POST',
    headers,
    body: buildVmSearchBody(csrfToken, 0, VM_BATCH_SIZE, from, to),
  });
  console.log(`[vm] First batch response: ${firstResponse.status}`);
  if (!firstResponse.ok) {
    const body = await firstResponse.text();
    throw new Error(`Upstream search failed: ${firstResponse.status} — ${body.slice(0, 200)}`);
  }

  const firstResult = await firstResponse.json() as { items?: unknown[]; totalItemsCount?: number };
  const items = [...(firstResult.items ?? [])];
  const total = firstResult.totalItemsCount ?? 0;
  console.log(`[vm] First batch: ${items.length} items, total: ${total}`);

  while (items.length < total) {
    console.log(`[vm] Fetching batch at offset ${items.length}/${total}...`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: buildVmSearchBody(csrfToken, items.length, VM_BATCH_SIZE, from, to),
    });
    console.log(`[vm] Batch response: ${response.status}`);
    if (!response.ok) {
      // Was a bare break, so a failure on page 2 of 4 returned a short list that
      // ran through the importer and was recorded as ok:true — the admin card
      // stayed green over a half-imported season, and its cross-check (the
      // newest game's `updated`) is refreshed by a partial run too. The first
      // page already throws on a bad status; the rest now behave the same.
      throw new Error(
        `VolleyManager game list failed at offset ${items.length}/${total}: ${response.status} ${(await response.text()).slice(0, 120)}`,
      );
    }
    const batch = await response.json() as { items?: unknown[] };
    const nextItems = batch.items ?? [];
    if (nextItems.length === 0) {
      break;
    }
    items.push(...nextItems);
    console.log(`[vm] Progress: ${items.length}/${total}`);
  }

  return { items, total };
}

function deepGet(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return current ?? null;
}

function gradeToScore(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  const scores: Record<string, number> = {
    'E-': 1,
    E: 2,
    'E+': 3,
    'D-': 4,
    D: 5,
    'D+': 6,
    'C-': 7,
    C: 8,
    'C+': 9,
    'B-': 10,
    B: 11,
    'B+': 12,
    'A-': 13,
    A: 14,
    'A+': 15,
  };
  return scores[normalized] ?? null;
}

function mapGameLevel(value: unknown): 'easy' | 'medium' | 'hard' | undefined {
  const normalized = asText(value).toLowerCase();
  if (normalized === 'leicht' || normalized === 'easy') {
    return 'easy';
  }
  if (normalized === 'normal' || normalized === 'medium') {
    return 'medium';
  }
  if (normalized === 'schwierig' || normalized === 'hard') {
    return 'hard';
  }
  return undefined;
}

function mapCoacheeFunction(role: unknown): '1SR' | '2SR' {
  return String(role) === '2. SR' ? '2SR' : '1SR';
}

function mapPromotion(value: unknown): 'promotion' | 'relegation' | 'same_level' | undefined {
  const normalized = asText(value);
  if (normalized === 'up') {
    return 'promotion';
  }
  if (normalized === 'down') {
    return 'relegation';
  }
  if (normalized === 'check') {
    return 'same_level';
  }
  return undefined;
}

function mapMotivation(value: unknown): 'high_motivated' | 'not_motivated' | 'in_order' | undefined {
  const normalized = asText(value);
  if (normalized === 'up') {
    return 'high_motivated';
  }
  if (normalized === 'down') {
    return 'not_motivated';
  }
  if (normalized === 'check') {
    return 'in_order';
  }
  return undefined;
}

function mapSrGoal(value: unknown): string | undefined {
  const raw = asText(value);
  if (!raw) {
    return undefined;
  }
  if (raw.toLowerCase() === 'verbleib' || raw.toLowerCase() === 'remain' || raw.toLowerCase() === 'same_level') {
    return 'same_level';
  }
  return raw;
}

function buildGradesPayload(formData: unknown) {
  const sections = Array.isArray((formData as { sections?: unknown[] })?.sections)
    ? (formData as { sections: Array<{ title?: string; items?: unknown[] }> }).sections
    : [];

  const byItemId: Record<string, { rating: string; score: number; section: string; label: string }> = {};
  const scoreSeries: number[] = [];

  for (const section of sections) {
    const sectionTitle = asText(section.title);
    const items = Array.isArray(section.items) ? section.items as Array<{ id?: string; label?: string; rating?: string }> : [];
    for (const item of items) {
      const rating = asText(item.rating);
      if (!rating) {
        continue;
      }
      const score = gradeToScore(rating);
      if (score === null) {
        continue;
      }
      const itemId = asText(item.id) || `${sectionTitle}:${asText(item.label)}`;
      byItemId[itemId] = {
        rating,
        score,
        section: sectionTitle,
        label: asText(item.label),
      };
      scoreSeries.push(score);
    }
  }

  const averageScore = scoreSeries.length > 0
    ? Math.round((scoreSeries.reduce((acc, v) => acc + v, 0) / scoreSeries.length) * 100) / 100
    : null;

  return {
    version: 1,
    scale: {
      'E-': 1,
      E: 2,
      'E+': 3,
      'D-': 4,
      D: 5,
      'D+': 6,
      'C-': 7,
      C: 8,
      'C+': 9,
      'B-': 10,
      B: 11,
      'B+': 12,
      'A-': 13,
      A: 14,
      'A+': 15,
    },
    by_item_id: byItemId,
    rated_items_count: scoreSeries.length,
    average_score: averageScore,
  };
}

// ── RC identity: id first, name as the fallback ──────────────────────────────
// Games and feedbacks were joined to their RC by display name alone. A name is
// not an identity: it changes, and two active coaches can normalise to the same
// string — at which point either can give away the other's game and read the
// other's feedback. Both rows now carry an id beside the name. Everything that
// decides *who* something belongs to goes through here, preferring the id and
// falling back to the name so rows written before the backfill keep working.
function rcRefMatches(recordId: unknown, recordName: unknown, person: RcAuthInfo): boolean {
  const id = asText(recordId);
  if (id) {
    if (id === person.rcId) return true;
    // A stored id that belongs to a live RC is authoritative — a different one
    // means a different person, fall through to no match. But an id that
    // resolves to NOBODY (the RC was deleted, or the id predates a data fix)
    // would otherwise strand the row forever; let the name answer for it.
    if (rcIdIsKnown(id)) return false;
  }
  const name = normalizeName(recordName);
  return Boolean(name) && name === normalizeName(person.name);
}

// Whether an id belongs to an RC the roster still knows. Reads the cache
// synchronously — populated on the first getActiveRcPeople of the request, which
// every rcRefMatches caller has already awaited.
function rcIdIsKnown(id: string): boolean {
  return rcKnownIds.has(id);
}

// True when either half says the game is taken — an id without a name, or a
// name without an id, both mean somebody holds it.
function rcRefPresent(recordId: unknown, recordName: unknown): boolean {
  return Boolean(asText(recordId) || normalizeName(recordName));
}

async function rcIdForName(rcName: unknown): Promise<string> {
  const key = normalizeName(rcName);
  if (!key) return '';
  try {
    return (await getActiveRcPeople()).find((p) => normalizeName(p.fullName) === key)?.id ?? '';
  } catch { return ''; }
}

async function resolveRefereeCoachPersonId(rcName: string): Promise<string> {
  const normalizedInput = normalizeName(rcName);
  if (!normalizedInput) {
    throw new Error('RC (coach) name is required to create observation.');
  }

  const people = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
    collection.getFullList<AnyRecord>({ sort: 'last_name' }),
  );

  const personFullName = (person: AnyRecord) => {
    const first = asText(person.first_name);
    const last = asText(person.last_name);
    return `${first} ${last}`.trim();
  };

  const exact = people.find((person) => normalizeName(personFullName(person)) === normalizedInput);
  if (exact) {
    return exact.id;
  }

  const tokens = normalizedInput.split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    const reversed = `${tokens[tokens.length - 1]} ${tokens.slice(0, -1).join(' ')}`;
    const byReverse = people.find((person) => normalizeName(personFullName(person)) === reversed);
    if (byReverse) {
      return byReverse.id;
    }
  }

  // No silent auto-create: a typo'd name would otherwise mint a phantom RC
  // record (which could never log in). Only admin submits reach this resolver.
  throw new Error(`Referee coach "${rcName}" not found — add them in the admin console first.`);
}

function extractRefereeName(item: Record<string, unknown>, convocationKey: string): string {
  const convocation = item[convocationKey];
  if (!convocation || typeof convocation !== 'object') {
    return '';
  }
  return asText(deepGet(convocation, 'indoorAssociationReferee', 'indoorReferee', 'person', 'displayName'));
}

function extractLineJudgeName(item: Record<string, unknown>, convocationKey: string): string {
  const convocation = item[convocationKey];
  if (!convocation || typeof convocation !== 'object') {
    return '';
  }
  return asText(
    deepGet(convocation, 'indoorAssociationReferee', 'indoorReferee', 'person', 'displayName')
      || deepGet(convocation, 'person', 'displayName'),
  );
}

function transformVmGame(item: Record<string, unknown>): Record<string, unknown> {
  const game = (item.game ?? {}) as Record<string, unknown>;
  const encounter = (game.encounter ?? {}) as Record<string, unknown>;
  const home = (encounter.teamHome ?? {}) as Record<string, unknown>;
  const away = (encounter.teamAway ?? {}) as Record<string, unknown>;
  const hall = (game.hall ?? {}) as Record<string, unknown>;
  const address = (hall.primaryPostalAddress ?? {}) as Record<string, unknown>;
  const group = (game.group ?? {}) as Record<string, unknown>;
  const phase = (group.phase ?? {}) as Record<string, unknown>;
  const league = (phase.league ?? {}) as Record<string, unknown>;
  const leagueCategory = (league.leagueCategory ?? {}) as Record<string, unknown>;

  const leagueShort = asText(leagueCategory.shortName || leagueCategory.name);
  const genderRaw = asText(league.gender).toUpperCase().trim();
  // Try explicit gender field first, then fall back to detecting from league/category names
  const leagueFullName = [asText(league.name), asText(league.displayName), asText(leagueCategory.name)].join(' ').toUpperCase();
  const genderSymbol = /^(MALE|M|HERREN|MEN|MÄNNER|MAENNER)$/.test(genderRaw) ? '♂'
    : /^(FEMALE|F|DAMEN|WOMEN|FRAUEN)$/.test(genderRaw) ? '♀'
    : /\b(HERREN|MEN|MÄNNER|MAENNER|MALE)\b/.test(leagueFullName) ? '♂'
    : /\b(DAMEN|WOMEN|FRAUEN|FEMALE)\b/.test(leagueFullName) ? '♀'
    : '';
  const groupDisplay = asText(group.displayName);
  const groupMatch = groupDisplay.match(/Gruppe\s+([A-Z0-9]+)/) || groupDisplay.match(/\|\s*([A-Z0-9]+)\s*$/);
  const groupSuffix = groupMatch ? groupMatch[1] : '';
  const leagueText = [leagueShort, genderSymbol, groupSuffix].filter(Boolean).join(' ');
  const firstReferee =
    extractRefereeName(item, 'activeRefereeConvocationFirstHeadReferee')
    || asText(item.activeFirstHeadRefereeName);
  const secondReferee =
    extractRefereeName(item, 'activeRefereeConvocationSecondHeadReferee')
    || asText(item.activeSecondHeadRefereeName);
  const firstLineJudge =
    extractLineJudgeName(item, 'activeRefereeConvocationFirstLineJudge')
    || asText(item.activeFirstLineJudgeName);
  const secondLineJudge =
    extractLineJudgeName(item, 'activeRefereeConvocationSecondLineJudge')
    || asText(item.activeSecondLineJudgeName);

  const isRdGame = Boolean(
    item.hasAtLeastOneRefereeIntendedToBeSupervised || item.isSupervised,
  );
  const isLdGame = Boolean(
    item.isLinesmanOneSupervised
    || item.isLinesmanTwoSupervised
    || item.isLinesmanThreeSupervised
    || item.isLinesmanFourSupervised,
  );
  // VM's "RSV-Markierung": the game was marked for a Referee Supervisor
  // assignment. Same intent as the RD markings above, just the other VM role —
  // both mean "somebody wants this game observed", so both auto-flag the game
  // for us (see /api/eligible-games). Sits on the refereeGame, not the game.
  const isRsvGame = Boolean(item.refereeSupervisorNeeded);

  // Extract geo data for maps link
  const geo = (address.geographicalLocation ?? {}) as Record<string, unknown>;
  const plusCode = asText(geo.plusCode);
  const lat = geo.latitude != null ? Number(geo.latitude) : null;
  const lng = geo.longitude != null ? Number(geo.longitude) : null;
  const mapsUrl = plusCode
    ? `https://www.google.com/maps/place/${encodeURIComponent(plusCode)}`
    : lat != null && lng != null
      ? `https://www.google.com/maps?q=${lat},${lng}`
      : '';

  // Extract game result — priority: championship > referee > home team
  const resultReport = (
    game.gameResultReportFromChampionshipOwner
    || game.gameResultReportFromReferee
    || game.gameResultReportFromHomeTeam
    || null
  ) as Record<string, unknown> | null;

  let gameResult = '';
  if (resultReport) {
    const homeSets: number[] = [];
    const awaySets: number[] = [];
    for (let s = 1; s <= 5; s += 1) {
      const h = resultReport[`homeTeamSet${s}Balls`];
      const a = resultReport[`awayTeamSet${s}Balls`];
      if (h != null && a != null) {
        homeSets.push(Number(h));
        awaySets.push(Number(a));
      }
    }
    if (homeSets.length > 0) {
      const homeWins = homeSets.filter((h, i) => h > awaySets[i]).length;
      const awayWins = awaySets.filter((a, i) => a > homeSets[i]).length;
      const setScores = homeSets.map((h, i) => `${h}:${awaySets[i]}`).join(' / ');
      gameResult = `${homeWins}:${awayWins} (${setScores})`;
    }
  }

  return {
    external_id: asText(game.number),
    match_no: asText(game.number),
    league: leagueText,
    match_date: asText(game.startingDateTime),
    location: [asText(hall.name), asText(address.combinedAddress), [asText(address.postalCode), asText(address.city)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    home_team: asText(home.name),
    away_team: asText(away.name),
    first_referee: firstReferee,
    second_referee: secondReferee,
    first_line_judge: firstLineJudge,
    second_line_judge: secondLineJudge,
    is_rd_game: isRdGame,
    is_ld_game: isLdGame,
    is_rsv_game: isRsvGame,
    maps_url: mapsUrl,
    game_result: gameResult,
    _assigned_people: [firstReferee, secondReferee, firstLineJudge, secondLineJudge],
  };
}

async function getCoacheeNameSet(prefetchedCoachees?: AnyRecord[]): Promise<Set<string>> {
  const coachees = prefetchedCoachees ?? await listCoacheesWithFallbackSort();
  const names = new Set<string>();

  const addVariant = (value: unknown) => {
    const normalized = normalizeName(value);
    if (normalized) {
      names.add(normalized);
    }
  };

  for (const coachee of coachees) {
    const firstName = asText(coachee.first_name ?? coachee.vorname);
    const lastName = asText(coachee.last_name ?? coachee.nachname);

    addVariant(coachee.full_name);
    addVariant(coachee.name);
    addVariant(coachee.coachee_name);
    addVariant(coachee.referee_name);
    addVariant(`${firstName} ${lastName}`.trim());
    addVariant(`${lastName} ${firstName}`.trim());
  }

  return names;
}

async function listCoacheesWithFallbackSort(): Promise<AnyRecord[]> {
  await ensureAdminAuth();
  try {
    return await withCollection(collectionCandidates.coachees, (collection) =>
      collection.getFullList<AnyRecord>({ sort: 'full_name' }),
    );
  } catch (error) {
    if (!isPocketBaseBadRequest(error)) {
      throw error;
    }
    // Older schemas may not expose `full_name`; retry without sort for compatibility.
    return withCollection(collectionCandidates.coachees, (collection) =>
      collection.getFullList<AnyRecord>({}),
    );
  }
}

async function getEligibleGames() {
  await ensureAdminAuth();
  const coacheeNameSet = await getCoacheeNameSet();

  if (coacheeNameSet.size === 0) return [];

  const matchesCoachee = (value: unknown) => {
    const text = normalizeName(value);
    return text ? coacheeNameSet.has(text) : false;
  };

  // Fetch all games in a single request and filter in-memory
  // to avoid PocketBase 414 (URI too long) and 429 (rate limit) errors
  const allGames = await (async () => {
    try {
      return await withCollection(collectionCandidates.games, (collection) =>
        collection.getFullList<AnyRecord>({
          sort: '-match_date',
          fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,assigned_rc_id,feedback_closed_roles,is_rd_game,is_ld_game,is_rsv_game,game_result,maps_url',
        }),
      );
    } catch (error) {
      // Some environments may temporarily miss one of the requested fields.
      // Retry without an explicit field projection for backward compatibility.
      if (!isPocketBaseBadRequest(error)) {
        throw error;
      }
      return withCollection(collectionCandidates.games, (collection) =>
        collection.getFullList<AnyRecord>({
          sort: '-match_date',
        }),
      );
    }
  })();

  const games = allGames.filter((game) =>
    matchesCoachee(game.first_referee) || matchesCoachee(game.second_referee),
  );

  return games.map((game) => ({
    id: game.id,
    matchNo: asText(game.match_no),
    league: asText(game.league),
    date: asText(game.match_date),
    location: asText(game.location),
    homeTeam: asText(game.home_team),
    awayTeam: asText(game.away_team),
    firstReferee: asText(game.first_referee),
    secondReferee: asText(game.second_referee),
    assignedRc: asText(game.assigned_rc),
    feedbackClosedRoles: Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [],
    isRdGame: Boolean(game.is_rd_game),
    isLdGame: Boolean(game.is_ld_game),
    isRsvGame: Boolean(game.is_rsv_game),
    game_result: asText(game.game_result),
    // The sync stores a precise plus-code/lat-lng link per venue. Left out of
    // the projection the UI fell back to a free-text Google search of the hall
    // name — the ambiguity the precise link exists to avoid.
    maps_url: asText(game.maps_url),
  }));
}

function getAssignedPeopleFromGameRecord(game: AnyRecord) {
  return {
    firstReferee: asText(game.first_referee),
    secondReferee: asText(game.second_referee),
    firstLineJudge: asText(game.first_line_judge),
    secondLineJudge: asText(game.second_line_judge),
  };
}

type CoacheeObservationSummary = {
  count: number;
  hasNoObservation: boolean;
  hasFurtherObservationNeeded: boolean;
  hasCompletedObservation: boolean;
  needsObservation: boolean;
  latestObservationAt: string;
};

async function getCoacheeObservationSummaryMap(opts?: { activeOverrides?: Map<string, boolean>; coachees?: AnyRecord[] }) {
  const coachees = opts?.coachees ?? await listCoacheesWithFallbackSort();

  // Fetch all observations in a single getFullList call to avoid 429 rate limiting
  const stats = new Map<string, { count: number; hasFurther: boolean; hasCompleted: boolean; latestAt: string }>();
  const allObservations = await (async () => {
    try {
      return await withCollection(collectionCandidates.observations, (collection) =>
        collection.getFullList<AnyRecord>({
          sort: '-created',
          fields: 'coachee,second_observation,created,updated',
          batch: 500,
        }),
      );
    } catch (error) {
      if (!isPocketBaseBadRequest(error)) {
        throw error;
      }
      try {
        // Older schemas may miss projected fields (e.g. second_observation).
        // Retry without field projection for compatibility.
        return await withCollection(collectionCandidates.observations, (collection) =>
          collection.getFullList<AnyRecord>({
            sort: '-created',
            batch: 500,
          }),
        );
      } catch (fallbackError) {
        if (!isPocketBaseBadRequest(fallbackError)) {
          throw fallbackError;
        }
        // Final compatibility fallback: avoid both projection and sort constraints.
        return withCollection(collectionCandidates.observations, (collection) =>
          collection.getFullList<AnyRecord>({
            batch: 500,
          }),
        );
      }
    }
  })();
  // The PB queries request sort '-created', but the last-resort fallback fetch
  // has no sort, and pre-migration records may have an empty created. Re-sort
  // here so "newest first" (which the latest-wins logic below depends on) holds
  // on every path.
  allObservations.sort((a, b) =>
    (asText(b.created) || asText(b.updated)).localeCompare(asText(a.created) || asText(a.updated)));
  for (const row of allObservations) {
    const coacheeId = asText(row.coachee);
    if (!coacheeId) continue;
    const existing = stats.get(coacheeId);
    const isSecond = asBoolean(row.second_observation, false);
    const createdAt = asText(row.created) || asText(row.updated);
    if (existing) {
      existing.count += 1;
      // hasFurther is decided by the newest observation only (rows arrive sorted
      // -created): a "further visit: no" on the latest visit closes the loop even
      // if an earlier visit requested one.
      if (!isSecond) existing.hasCompleted = true;
    } else {
      stats.set(coacheeId, {
        count: 1,
        hasFurther: isSecond,
        hasCompleted: !isSecond,
        latestAt: createdAt,
      });
    }
  }

  const summaryById = new Map<string, CoacheeObservationSummary>();
  for (const coachee of coachees) {
    const coacheeId = coachee.id;
    const st = stats.get(coacheeId);
    const stage = asText(coachee.stage) || 'active';
    const isActive = opts?.activeOverrides?.get(coacheeId) ?? (stage !== 'inactive');
    const count = st?.count ?? 0;

    summaryById.set(coacheeId, {
      count,
      hasNoObservation: count === 0,
      hasFurtherObservationNeeded: st?.hasFurther ?? false,
      hasCompletedObservation: st?.hasCompleted ?? false,
      needsObservation: isActive && (count === 0 || (st?.hasFurther ?? false)),
      latestObservationAt: st?.latestAt ?? '',
    });
  }

  return summaryById;
}

type SyncWindow = { from: string; to: string };

function resolveSyncWindow(input: { date?: unknown; from?: unknown; to?: unknown }): SyncWindow {
  const dateParam = asText(input.date);
  const fromParam = asText(input.from);
  const toParam = asText(input.to);

  if (fromParam && toParam) {
    return {
      from: `${fromParam}T00:00:00.000Z`,
      to: `${toParam}T23:59:59.000Z`,
    };
  }
  if (dateParam) {
    return {
      from: `${dateParam}T00:00:00.000Z`,
      to: `${dateParam}T23:59:59.000Z`,
    };
  }
  return getDefaultSyncRange();
}

// How far the unattended import reaches when nobody passes a window.
const VM_SYNC_BACK_DAYS = Number(process.env.VM_SYNC_BACK_DAYS || 14);
const VM_SYNC_AHEAD_DAYS = Number(process.env.VM_SYNC_AHEAD_DAYS || 120);

// This used to be a today-only range, and every shipped caller passes no window:
// the 05:00 cron calls runGamesSyncWithRetry() bare and the console's "Import
// now" posts {}. So the importer only ever saw the current day — no future
// fixture was ever imported, an RC could not see or claim a match before the
// morning it was played, and the 10:00 reminder looked for TOMORROW's games,
// which by construction had not been imported yet. It found nothing, every day,
// and said so in a log nobody reads.
//
// Backwards as well as forwards: a result or a late referee designation lands
// after the match, and a window that starts today would never pick it up.
function getDefaultSyncRange(): SyncWindow {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const back = Number.isFinite(VM_SYNC_BACK_DAYS) ? VM_SYNC_BACK_DAYS : 14;
  const ahead = Number.isFinite(VM_SYNC_AHEAD_DAYS) ? VM_SYNC_AHEAD_DAYS : 120;
  return {
    from: `${new Date(now - back * day).toISOString().slice(0, 10)}T00:00:00.000Z`,
    to: `${new Date(now + ahead * day).toISOString().slice(0, 10)}T23:59:59.000Z`,
  };
}

async function runGamesSync(windowInput: { date?: unknown; from?: unknown; to?: unknown } = {}) {
  const vmUsername = asText(process.env.VM_USERNAME);
  const vmPassword = asText(process.env.VM_PASSWORD);
  if (!vmUsername || !vmPassword) {
    throw new Error('Set VM_USERNAME and VM_PASSWORD in environment variables.');
  }

  const { from, to } = resolveSyncWindow(windowInput);
  const { jar, csrfToken, windowUniqueId } = await vmLogin(vmUsername, vmPassword);
  const { items } = await fetchAllVmGames(jar, csrfToken, from, to, windowUniqueId);
  const coacheeNames = await getCoacheeNameSet();

  const transformed = items
    .map((raw) => transformVmGame(raw as Record<string, unknown>))
    .filter((row) => asText(row.match_no));

  const matchedRows = transformed.filter((row) => {
    const assignedPeople = Array.isArray(row._assigned_people) ? row._assigned_people : [];
    return assignedPeople
      .map((name) => normalizeName(name))
      .some((name) => coacheeNames.has(name));
  });

  let imported = 0;
  for (const row of matchedRows) {
    const { _assigned_people: _unused, ...persistable } = row;
    await upsertGame(mapIncomingGame(persistable));
    imported += 1;
  }

  return {
    imported,
    totalFetched: items.length,
    from,
    to,
  };
}

// The outcome of the last games sync, so a broken one is visible to a human
// instead of only to whoever reads container logs. It went unnoticed for three
// weeks once: VolleyManager started answering 403 (the account's active VM role
// had been switched to a club one, which cannot see the association's referee
// games), the cron logged and moved on, and nothing in the app said a word.
const GAMES_SYNC_STATUS_KEY = 'games_sync_status';

export type GamesSyncStatus = {
  at: string;
  ok: boolean;
  imported?: number;
  totalFetched?: number;
  error?: string;
};

async function recordGamesSyncStatus(status: GamesSyncStatus): Promise<void> {
  // Best effort on purpose: failing to write the note must never turn a
  // successful sync into a failed request, nor mask the real error of a failed
  // one behind a bookkeeping error.
  try {
    await setSetting(GAMES_SYNC_STATUS_KEY, JSON.stringify(status));
  } catch (error) {
    console.error('[scheduler] could not record the games-sync status:', error);
  }
}

async function runGamesSyncWithRetry(windowInput: { date?: unknown; from?: unknown; to?: unknown } = {}) {
  let lastError: unknown = null;
  const totalAttempts = VM_SYNC_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.warn(`[scheduler] Retrying games sync (${attempt}/${totalAttempts})...`);
      }
      {
        const result = await runGamesSync(windowInput);
        await recordGamesSyncStatus({
          at: new Date().toISOString(),
          ok: true,
          imported: result.imported,
          totalFetched: result.totalFetched,
        });
        return result;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= totalAttempts) {
        break;
      }
      console.warn(
        `[scheduler] Games sync attempt ${attempt}/${totalAttempts} failed. Retrying in ${VM_SYNC_RETRY_DELAY_MS}ms...`,
      );
      await sleep(VM_SYNC_RETRY_DELAY_MS);
    }
  }

  await recordGamesSyncStatus({
    at: new Date().toISOString(),
    ok: false,
    error: lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError).slice(0, 300),
  });
  throw lastError;
}

async function runGamesSyncDebug(windowInput: { date?: unknown; from?: unknown; to?: unknown } = {}) {
  const vmUsername = asText(process.env.VM_USERNAME);
  const vmPassword = asText(process.env.VM_PASSWORD);
  if (!vmUsername || !vmPassword) {
    throw new Error('Set VM_USERNAME and VM_PASSWORD in environment variables.');
  }

  const { from, to } = resolveSyncWindow(windowInput);
  const { jar, csrfToken, windowUniqueId } = await vmLogin(vmUsername, vmPassword);
  const { items } = await fetchAllVmGames(jar, csrfToken, from, to, windowUniqueId);
  const coacheeNames = await getCoacheeNameSet();

  const transformed = items
    .map((raw) => transformVmGame(raw as Record<string, unknown>))
    .filter((row) => asText(row.match_no));
  const requestedMatchNo = asText((windowInput as Record<string, unknown>).matchNo ?? (windowInput as Record<string, unknown>).match_no);

  const matchedRows = transformed.filter((row) => {
    const assignedPeople = Array.isArray(row._assigned_people) ? row._assigned_people : [];
    return assignedPeople
      .map((name) => normalizeName(name))
      .some((name) => coacheeNames.has(name));
  });
  const unmatchedRows = transformed.filter((row) => {
    const assignedPeople = Array.isArray(row._assigned_people) ? row._assigned_people : [];
    return !assignedPeople
      .map((name) => normalizeName(name))
      .some((name) => coacheeNames.has(name));
  });

  const unmatchedNameCounts = new Map<string, number>();
  for (const row of unmatchedRows) {
    const assignedPeople = Array.isArray(row._assigned_people) ? row._assigned_people : [];
    for (const name of assignedPeople) {
      const displayName = asText(name);
      const normalized = normalizeName(displayName);
      if (!normalized || coacheeNames.has(normalized)) {
        continue;
      }
      unmatchedNameCounts.set(displayName, (unmatchedNameCounts.get(displayName) ?? 0) + 1);
    }
  }

  const topUnmatchedNames = [...unmatchedNameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([name, count]) => ({ name, count }));

  const matchNoLookup = requestedMatchNo
    ? transformed.find((row) => asText(row.match_no) === requestedMatchNo)
    : null;

  // Also find the raw VM item for the requested match number
  const rawMatchItem = requestedMatchNo
    ? (items as Record<string, unknown>[]).find(item => {
        const game = (item.game ?? {}) as Record<string, unknown>;
        return String(game.number) === requestedMatchNo;
      })
    : null;

  const requestedGame = matchNoLookup
    ? (() => {
        const assignedPeople = Array.isArray(matchNoLookup._assigned_people) ? matchNoLookup._assigned_people : [];
        const normalizedAssigned = assignedPeople.map((name) => normalizeName(name));
        const matchedNames = assignedPeople.filter((name) => coacheeNames.has(normalizeName(name)));
        return {
          match_no: asText(matchNoLookup.match_no),
          league: asText(matchNoLookup.league),
          match_date: asText(matchNoLookup.match_date),
          assigned_people: assignedPeople,
          normalized_assigned_people: normalizedAssigned,
          has_coachee_match: normalizedAssigned.some((name) => coacheeNames.has(name)),
          matched_people: matchedNames,
          raw: rawMatchItem ?? null,
        };
      })()
    : null;

  return {
    from,
    to,
    totalFetched: items.length,
    withMatch: matchedRows.length,
    withoutMatch: unmatchedRows.length,
    coacheeCount: coacheeNames.size,
    matchedSample: matchedRows.slice(0, 20).map((row) => ({
      match_no: asText(row.match_no),
      league: asText(row.league),
      match_date: asText(row.match_date),
      assigned_people: Array.isArray(row._assigned_people) ? row._assigned_people : [],
    })),
    unmatchedSample: unmatchedRows.slice(0, 20).map((row) => ({
      match_no: asText(row.match_no),
      league: asText(row.league),
      match_date: asText(row.match_date),
      assigned_people: Array.isArray(row._assigned_people) ? row._assigned_people : [],
    })),
    topUnmatchedNames,
    requestedMatchNo,
    requestedGame,
    // If gameNumbers array is provided, return raw data for each
    ...(Array.isArray((windowInput as Record<string, unknown>).gameNumbers)
      ? {
          rawGames: Object.fromEntries(
            ((windowInput as Record<string, unknown>).gameNumbers as string[]).map(gn => {
              const raw = (items as Record<string, unknown>[]).find(item => {
                const game = (item.game ?? {}) as Record<string, unknown>;
                return String(game.number) === String(gn);
              });
              return [String(gn), raw ?? null];
            }),
          ),
        }
      : {}),
  };
}

async function runVmAuthCheck(debug = false) {
  const vmUsername = asText(process.env.VM_USERNAME);
  const vmPassword = asText(process.env.VM_PASSWORD);
  if (!vmUsername || !vmPassword) {
    throw new Error('Set VM_USERNAME and VM_PASSWORD in environment variables.');
  }

  const trace: VmTraceEntry[] = [];
  let csrfToken = '';
  try {
    const result = await vmLoginWithTrace(vmUsername, vmPassword, debug ? trace : undefined);
    csrfToken = result.csrfToken;
  } catch (error) {
    if (debug) {
      const wrapped = new Error(String(error));
      (wrapped as Error & { trace?: VmTraceEntry[] }).trace = trace;
      throw wrapped;
    }
    throw error;
  }
  return {
    ok: true,
    csrfTokenFound: Boolean(csrfToken),
    ...(debug ? { trace } : {}),
  };
}

app.get('/api/health', async (_req: Request, res: ExpressResponse) => {
  try {
    const pbUrl = asText(process.env.POCKETBASE_URL);
    let reachable = false;
    let reachabilityError = '';
    try {
      const response = await fetch(`${pbUrl}/api/health`);
      reachable = response.ok;
      if (!reachable) {
        reachabilityError = `PocketBase /api/health returned ${response.status}`;
      }
    } catch (error) {
      reachabilityError = error instanceof Error ? error.message : String(error);
    }

    if (!reachable) {
      // Log details server-side; expose only a coarse stage to unauthenticated callers.
      console.error('[health] connectivity:', pbUrl, reachabilityError);
      res.status(500).json({ ok: false, error: { stage: 'connectivity' } });
      return;
    }

    // One cheap AUTHENTICATED read, not just ensureAdminAuth(). That call
    // short-circuits on any unexpired token, so a superuser password rotated in
    // the PocketBase admin UI left every real query failing while this endpoint
    // — and therefore any uptime probe watching it — stayed green.
    try {
      await ensureAdminAuth();
      await withCollection(['app_settings'], (c) => c.getList(1, 1, { fields: 'id', skipTotal: true }));
    } catch (probeError) {
      if (!(await reauthOnRejection(probeError))) throw probeError;
      await withCollection(['app_settings'], (c) => c.getList(1, 1, { fields: 'id', skipTotal: true }));
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[health] auth:', error);
    res.status(500).json({ ok: false, error: { stage: 'auth' } });
  }
});

app.get('/api/admin/auth/status', (req: Request, res: ExpressResponse) => {
  // The console asks this on load to decide between the login form and the
  // tabs, and `role` decides WHICH tabs: the chair sees only her own two.
  const session = verifyConsoleSession(req);
  res.json({ authenticated: session.ok, email: session.email || '', role: session.role || null });
});

app.post('/api/admin/auth/logout', (_req: Request, res: ExpressResponse) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

// ── Admin page gate (username + password -> console session) ──────────
// One form, two credentials. Which username was typed decides which role the
// session gets: the console operator, or the chair with her private channel.
// Both are checked on every attempt so the answer cannot say which name exists.
app.post('/api/admin/ui-login', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const rl = peekGateRateLimit(ctx.ip, 'admin-ui');
  if (!rl.allowed) { denyRateLimited(req, res, 'login:ip', rl.retryAfterMs, { kind: 'admin-ui' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Lower-cased before comparing: a phone keyboard capitalises the first letter
  // of a username field by default, and "Admin" failing to log in with the right
  // password is a support call nobody should have to make.
  const username = asText(body.username).trim();
  const password = asText(body.password);
  const asAdmin = await verifyCredential('admin', username, password, ADMIN_UI_USERNAME, ADMIN_UI_PASSWORD);
  const asPresident = await verifyCredential('president', username, password, PRESIDENT_UI_USERNAME, PRESIDENT_UI_PASSWORD);
  const role: ConsoleRole | null = asAdmin.ok ? 'admin' : asPresident.ok ? 'president' : null;
  if (!role) {
    checkGateRateLimit(ctx.ip, 'admin-ui'); // charged on failure only
    clearAdminSessionCookie(res);
    // `userMatched` is for the admin reading the log after a failed sign-in
    // ("was it the name or the password?"); the CALLER is told neither.
    log.warn('auth.admin-ui-login', 'rejected', {
      configured: asAdmin.configured || asPresident.configured,
      userMatched: asAdmin.userMatched || asPresident.userMatched,
    }, ctx);
    res.status(401).json({ error: 'Invalid credentials.' });
    return;
  }
  const who = role === 'president' ? 'president-ui' : 'admin-ui';
  setAdminSessionCookie(res, createAdminSessionToken(who, role));
  tagReqUser(req, who);
  log.info('auth.admin-ui-login', 'ok', { role }, ctx);
  res.json({ ok: true, role });
});

// ── Logging: browser ingest + admin read ──────────────────────────────
// Deliberately unauthenticated: the failures worth capturing (a login that
// won't go through, a password reset that dead-ends) all happen before there is
// a session. Abuse is bounded by a per-IP budget and hard caps on batch size.
const clientLogRl: RateLimitStore = new Map();
const CLIENT_LOG_MAX_BATCH = 200;
const CLIENT_LOG_EVENTS_PER_WINDOW = 3_000;
// A GLOBAL ceiling beside the per-IP one. Per-IP alone is ~12 MB per address
// per window (3,000 events x a 2,000-char msg + 2,048-char data), appended to
// /app/logs — which docker-compose bind-mounts from the same directory as
// pb_data. A filesystem filled by an unauthenticated endpoint makes every
// PocketBase write fail and every submit 500. Cheaper still: ~20k entries flush
// the whole in-memory ring, so the Protokoll you open to diagnose the flood
// contains nothing but the flood.
const CLIENT_LOG_GLOBAL_PER_WINDOW = 20_000;
const clientLogGlobalRl: RateLimitStore = new Map();
const CLIENT_LOG_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// Cap a client log entry's `data` at ~2 kb of serialized JSON. Anything larger
// is replaced with a marker, so a hostile caller cannot fill the ring by bytes.
const CLIENT_LOG_DATA_MAX = 2_048;
function boundedLogData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  let json = '';
  try { json = JSON.stringify(value); } catch { return { _dropped: 'unserializable' }; }
  if (json.length <= CLIENT_LOG_DATA_MAX) return value as Record<string, unknown>;
  return { _truncated: true, bytes: json.length, preview: json.slice(0, 200) };
}

// text/plain is parsed only here, never globally: a global text parser would
// turn every state-changing POST into a CORS-simple request and hand away the
// preflight that protects them from cross-site forgery. This endpoint only
// writes to the log, and sendBeacon can't preflight.
app.post('/api/client-logs',
  express.text({ type: 'text/plain', limit: CLIENT_LOG_BODY_LIMIT }),
  express.json({ limit: CLIENT_LOG_BODY_LIMIT }),
  (req: Request, res: ExpressResponse) => {
  const ip = clientIp(req);
  const globalRl = checkRateLimit(clientLogGlobalRl, 'global', CLIENT_LOG_GLOBAL_PER_WINDOW, CLIENT_LOG_WINDOW_MS);
  if (!globalRl.allowed) {
    // Answered 204 on purpose: browser log shipping is fire-and-forget, and a
    // 429 here would only make clients retry into a budget that is already full.
    res.status(204).end();
    return;
  }
  const rl = checkRateLimit(clientLogRl, ip, CLIENT_LOG_EVENTS_PER_WINDOW, CLIENT_LOG_WINDOW_MS);
  // Silently accept when over budget: a client that can't ship logs must never
  // start showing the user errors about logging.
  if (!rl.allowed) { res.status(202).json({ ok: true, dropped: true }); return; }
  // Either the JSON parser or the text parser produced req.body, depending on
  // whether this arrived as a fetch or as a beacon.
  const parsed = typeof req.body === 'string'
    ? (() => { try { return JSON.parse(req.body as string); } catch { return {}; } })()
    : req.body;
  const body = (parsed ?? {}) as { sid?: unknown; did?: unknown; user?: unknown; entries?: unknown };
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, CLIENT_LOG_MAX_BATCH) : [];
  // Bill the batch, not the request. Otherwise the nominal per-window budget
  // bought that many *batches* — enough to push every real line out of the ring
  // the admin console reads, which is the log you would go looking for after.
  if (entries.length > 1) chargeRateLimit(clientLogRl, ip, entries.length - 1);
  const sid = asText(body.sid).slice(0, 64) || undefined;
  const did = asText(body.did).slice(0, 64) || undefined;
  // This endpoint takes no session on purpose: a beacon fires after logout, and
  // before login there is nothing to authenticate with. So `user` is whatever
  // the caller typed — and unmarked, an anonymous POST could file lines in the
  // admin's Protokoll under a real coach's name. Mark it when no session backs it.
  const claimedUser = asText(body.user).slice(0, 120);
  const user = claimedUser
    ? (verifyRcSession(req).ok ? claimedUser : `unverified:${claimedUser}`)
    : undefined;
  for (const raw of entries) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const lvl = asText(e.lvl);
    recordLog({
      lvl: (CLIENT_LEVELS.has(lvl) ? lvl : 'info') as LogLevel,
      src: 'client',
      evt: asText(e.evt).slice(0, 60) || 'client',
      msg: asText(e.msg).slice(0, 2_000) || undefined,
      // The browser's own timestamp, so ordering survives batching and offline
      // buffering; falls back to arrival time.
      t: asText(e.t) || undefined,
      // Bounded before it enters the ring and the file sink: msg and evt are
      // already sliced, but `data` was passed through whole, so one unauthenticated
      // caller could inflate every entry to the batch/body limit and fill the log
      // by bytes even while staying under the per-entry COUNT cap.
      data: boundedLogData(e.data),
      sid,
      did,
      user,
      ip,
    });
  }
  res.json({ ok: true, accepted: entries.length });
});

app.get('/api/admin/logs', requireAdminSession, (req: Request, res: ExpressResponse) => {
  const q = req.query as Record<string, string | undefined>;
  res.set('Cache-Control', 'no-store');
  res.json({
    ...queryLogs({
      limit: q.limit ? Number(q.limit) : undefined,
      since: q.since ? Number(q.since) : undefined,
      level: q.level as LogLevel | undefined,
      src: q.src as LogSource | undefined,
      q: q.q,
      sid: q.sid,
      evt: q.evt,
    }),
    stats: ringStats(),
  });
});

app.get('/api/admin/logs/sessions', requireAdminSession, (_req: Request, res: ExpressResponse) => {
  res.set('Cache-Control', 'no-store');
  res.json({ sessions: logSessions() });
});

// ── App settings (default season, ...) ───────────────────────────────
// "No such setting yet" is the normal case and reads as null. Anything else —
// PocketBase unreachable, the collection missing, auth expired — must NOT read
// as an unset value: several settings are maps that get read, edited and
// written back whole, so a swallowed read error saves an empty map over the
// president's notes or the whole starred list.
async function getSettingRecord(key: string): Promise<AnyRecord | null> {
  // Every other data helper opens this way (getActiveRcPeople,
  // listCoacheesWithFallbackSort, getEligibleGames, upsertGame); these two
  // app_settings helpers were the exception, and it cost the daily reminder a
  // month. Route handlers call ensureAdminAuth() themselves, so a settings read
  // under an HTTP request was always authenticated and the gap stayed invisible
  // — but the 10:00 reminder cron's FIRST PocketBase call is this one, and with
  // nothing having authenticated the shared client it got "403: Only superusers
  // can perform this action" and died before it could even read
  // reminder_enabled. The games sync at 05:00 survived only by luck: it reaches
  // PocketBase through listCoacheesWithFallbackSort, which does authenticate.
  // ensureAdminAuth() is a no-op on a valid session, so this costs nothing.
  await ensureAdminAuth();
  try {
    return await withCollection(['app_settings'], (collection) =>
      collection.getFirstListItem<AnyRecord>(`key = "${escapeFilterValue(key)}"`));
  } catch (error) {
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

// Settings that are maps get read, edited and written back whole, so two
// requests touching the same key can each save over the other's edit. Chaining
// per key makes that sequence atomic — enough for a single API process, which
// is what runs.
function chainOnKey<T>(chains: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const queued = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = queued.catch(() => {});
  chains.set(key, tail);
  // Drop the entry once nothing is queued behind it: a map keyed by game id
  // would otherwise hold one settled promise per game ever touched.
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return queued;
}

const settingWrites = new Map<string, Promise<unknown>>();
function withSettingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return chainOnKey(settingWrites, key, fn);
}

// Games get the same treatment: taking a game and closing a feedback role both
// read the record, decide, and write back, so two requests for the same game
// would each act on what the other was about to change.
const gameWrites = new Map<string, Promise<unknown>>();
function withGameLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  return chainOnKey(gameWrites, gameId, fn);
}

// Acquire/release form of the same lock, for a body too long to read as a
// callback. Always release from a `finally`, or the next holder waits forever.
function acquireGameLock(gameId: string): Promise<() => void> {
  return new Promise((handOver) => {
    void chainOnKey(gameWrites, gameId, () => new Promise<void>((release) => handOver(() => release())));
  });
}

// Only the RCs on a half mandate are stored; everyone else follows the full
// season goal, so "not in the map" is the normal case and the only two values
// that survive a write are 'half' and (dropped) 'full'.
// A per-RC season goal ("Pensum"): a whole number of observations, 0 allowed.
// 'half' is still accepted because it is what settings written before the switch
// to free numbers contain — see goalForMandate in src/types.ts. Anything else,
// negative, or beyond a plainly unreasonable ceiling is dropped rather than
// stored, so a bad payload cannot put nonsense on the chair's overview.
const MANDATE_MAX = 200;
function sanitizeMandates(raw: unknown): Record<string, 'half' | number> {
  const out: Record<string, 'half' | number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id) continue;
    if (value === 'half') out[id] = 'half';
    else if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MANDATE_MAX) {
      out[id] = Math.trunc(value);
    }
  }
  return out;
}

async function setSetting(key: string, value: string): Promise<void> {
  const existing = await getSettingRecord(key);
  if (existing) await withCollection(['app_settings'], (c) => c.update(existing.id, { value }));
  else await withCollection(['app_settings'], (c) => c.create({ key, value }));
}

// Effective email test mode: admin DB setting wins, else TEST_MODE env var.
async function isEmailTestMode(): Promise<boolean> {
  const rec = await getSettingRecord('test_mode');
  if (rec) return asText(rec.value) === '1';
  return TEST_MODE;
}
app.get('/api/settings', requireRcSession, async (_req: Request, res: ExpressResponse) => {
  try {
    const rec = await getSettingRecord('default_season');
    const groupsRec = await getSettingRecord('groups');
    let groups: string[] = [];
    try { groups = groupsRec ? JSON.parse(asText(groupsRec.value)) : []; } catch { groups = []; }
    const targetsRec = await getSettingRecord('coachee_targets');
    let coachee_targets: Record<string, unknown> = {};
    try { coachee_targets = targetsRec ? JSON.parse(asText(targetsRec.value)) : {}; } catch { coachee_targets = {}; }
    // Season observation goal: default_goal is what an RC owes unless
    // rc_mandates names them (by RC id) with their own number. Legacy entries
    // may still say 'half'.
    const mandatesRec = await getSettingRecord('rc_mandates');
    let rc_mandates: Record<string, 'half' | number> = {};
    try { rc_mandates = sanitizeMandates(mandatesRec ? JSON.parse(asText(mandatesRec.value)) : {}); } catch { rc_mandates = {}; }
    const defaultGoalRec = await getSettingRecord('default_goal');
    const default_goal = defaultGoalRec ? Number(asText(defaultGoalRec.value)) || null : null;
    let default_season = rec ? Number(asText(rec.value)) || null : null;
    if (default_season == null) {
      // No explicit default set — fall back to the latest season that has coachee data.
      try {
        await ensureAdminAuth();
        const seasons = await withCollection(collectionCandidates.coachees, (c) =>
          c.getFullList<AnyRecord>({ fields: 'season' }));
        const latest = Math.max(...seasons.map((s) => Number(s.season)).filter(Number.isFinite));
        if (Number.isFinite(latest)) default_season = latest;
      } catch { /* keep null */ }
    }
    res.json({ default_season, test_mode: await isEmailTestMode(), groups, coachee_targets, rc_mandates, default_goal });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.put('/api/admin/settings', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const body = (req.body ?? {}) as Record<string, unknown>;
    if ('default_season' in body) await setSetting('default_season', asText(body.default_season));
    if ('test_mode' in body) await setSetting('test_mode', body.test_mode ? '1' : '0');
    if ('groups' in body && Array.isArray(body.groups)) await setSetting('groups', JSON.stringify((body.groups as unknown[]).map((g) => String(g).trim()).filter(Boolean)));
    if ('coachee_targets' in body && body.coachee_targets && typeof body.coachee_targets === 'object') {
      await setSetting('coachee_targets', JSON.stringify(body.coachee_targets));
    }
    if ('rc_mandates' in body && body.rc_mandates && typeof body.rc_mandates === 'object') {
      await setSetting('rc_mandates', JSON.stringify(sanitizeMandates(body.rc_mandates)));
    }
    if ('default_goal' in body) {
      const n = Math.round(Number(body.default_goal));
      await setSetting('default_goal', Number.isFinite(n) && n > 0 ? String(n) : '');
    }
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// ── Credentials (admin) ───────────────────────────────────────────────
// Reading tells the console which usernames are live and when each password was
// last changed. It never returns a hash or a salt: there is nothing here that
// needs to travel to a browser, and a hash that never leaves the server cannot
// be cracked offline by whoever borrows an admin session.
const CREDENTIAL_SLOTS: CredentialSlot[] = ['shared', 'admin', 'president'];
const SLOT_ENV: Record<CredentialSlot, { username: string; password: string }> = {
  shared: { username: SHARED_LOGIN_USERNAME_ENV, password: SHARED_LOGIN_PASSWORD_ENV },
  admin: { username: ADMIN_UI_USERNAME, password: ADMIN_UI_PASSWORD },
  president: { username: PRESIDENT_UI_USERNAME, password: PRESIDENT_UI_PASSWORD },
};

// ── Second factor for a password change ───────────────────────────────
// Holding an admin session is enough to READ which usernames are live. It is
// deliberately NOT enough to change one: a borrowed laptop, a session left open
// on a shared machine, or a stolen console cookie would otherwise be able to
// lock the real admin out of every door at once — including the chair's, which
// admin rights are not supposed to reach at all. So a change costs a code that
// arrives somewhere else.
//
// The code is bound to the console cookie that asked for it, so it cannot be
// read out of one session's mailbox and spent from another.
const CRED_2FA_TTL_MS = 10 * 60 * 1000;
const CRED_2FA_MAX_ATTEMPTS = 5;
type CredChallenge = { slot: CredentialSlot; hash: string; salt: string; expiresAt: number; attempts: number };
const credChallenges = new Map<string, CredChallenge>();
const credChallengeRl: RateLimitStore = new Map();

// Where the code goes, per door. The chair's password and the two operational
// ones are guarded by different people, so they are guarded by different
// mailboxes: whoever can read the RC coaching mailbox cannot thereby reach for
// the chair's channel, and vice versa.
//
// There is deliberately NO fallback to POCKETBASE_ADMIN_EMAIL. That address is
// incidental — it is whatever the superuser account happened to be created
// with, and for most of this app's life that was rc-admin@svrz.local, a mailbox
// that does not exist. The fallback therefore did not fail: it "succeeded",
// logged success, and returned a masked address that read as ordinary, while
// the code was never coming. The address is a real one again now, which is
// exactly why it must not be relied on: whether the door out of a lost password
// works should not depend on how somebody once named a database account.
function credential2faRecipient(slot: CredentialSlot): string {
  const perSlot = process.env[`CREDENTIAL_2FA_EMAIL_${slot.toUpperCase()}`] || '';
  return (perSlot || process.env.CREDENTIAL_2FA_EMAIL || '').trim();
}

/** Keyed by the cookie, not the username: one session's code is useless in another. */
function credChallengeKey(req: Request): string {
  return createHash('sha256').update(getCookieValue(req, ADMIN_SESSION_COOKIE)).digest('hex');
}

/** j.doe@example.com -> j••••@example.com. Enough to recognise, not to learn. */
function maskEmail(address: string): string {
  const [user, domain] = address.split('@');
  if (!user || !domain) return '•••';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(3, user.length - 1))}@${domain}`;
}

async function sendCredentialCodeEmail(to: string, code: string, slotLabel: string): Promise<void> {
  if (await isEmailTestMode()) {
    // The code is printed rather than merely suppressed. Test mode turns off
    // every outbound mail, so without this a password change is not "mail-free"
    // — it is impossible, and the one environment where you want to rehearse
    // rotating a credential is the one where you cannot. Server console only:
    // never the activity log, which admins read and which ships off the box.
    console.log(`[cred-2fa] TEST_MODE — not sent to ${to}; code is ${code}`);
    return;
  }
  const html = emailShell(
    '<h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1c1917;">Bestätigungscode</h1>'
    + `<p style="margin:0 0 14px;font-size:14px;color:#44403c;">Jemand ändert gerade das Passwort für <strong>${escapeHtml(slotLabel)}</strong> in der Referee-Coaching-Administration. Mit diesem Code wird die Änderung bestätigt:</p>`
    + emailCodeBox(code)
    + '<p style="margin:22px 0 0;font-size:13px;color:#78716c;line-height:1.6;">Der Code ist 10 Minuten gültig und kann nur einmal verwendet werden. Hast du das nicht ausgelöst, wurde das Passwort NICHT geändert — aber jemand hat Zugriff auf eine Admin-Sitzung. Ändere in dem Fall umgehend das Admin-Passwort.</p>',
  );
  await sendMailResilient({
    from: MAIL_FROM,
    to,
    subject: 'Bestätigungscode – Passwortänderung SVRZ Referee Coaching',
    text: `Bestätigungscode für die Passwortänderung (${slotLabel}):\n\n    ${code}\n\n`
      + `Gültig für 10 Minuten, einmalig verwendbar.\n\n`
      + `Hast du das nicht ausgelöst, wurde nichts geändert — aber jemand hat Zugriff auf eine Admin-Sitzung. Ändere dann sofort das Admin-Passwort.\n\n${MAIL_APP_URL}`,
    html,
    attachments: emailAttachments(),
  });
}

app.post('/api/admin/credentials/challenge', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const rl = checkRateLimit(credChallengeRl, ctx.ip, 5, 15 * 60 * 1000);
  if (!rl.allowed) { denyRateLimited(req, res, 'cred-2fa:ip', rl.retryAfterMs); return; }
  const slot = asText((req.body ?? {}).slot) as CredentialSlot;
  if (!CREDENTIAL_SLOTS.includes(slot)) { res.status(400).json({ error: 'Unbekannter Zugang.' }); return; }
  const recipient = credential2faRecipient(slot);
  if (!recipient) {
    // Said plainly rather than as a 500: the operator needs to know this is a
    // missing setting, and that the env vars are still the way out.
    log.error('auth.credentials', 'no 2FA recipient configured', { slot }, ctx);
    res.status(503).json({ error: `Kein Empfänger für den Bestätigungscode konfiguriert (CREDENTIAL_2FA_EMAIL_${slot.toUpperCase()} oder CREDENTIAL_2FA_EMAIL).` });
    return;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(16).toString('hex');
  try {
    await sendCredentialCodeEmail(recipient, code, slot);
  } catch (error) {
    log.error('auth.credentials', 'could not send the confirmation code', { slot, error }, ctx);
    res.status(503).json({ error: 'Der Bestätigungscode konnte nicht gesendet werden.' });
    return;
  }
  credChallenges.set(credChallengeKey(req), {
    slot, salt, hash: hashSecret(code, salt), expiresAt: Date.now() + CRED_2FA_TTL_MS, attempts: 0,
  });
  log.info('auth.credentials', 'confirmation code sent', { slot, to: maskEmail(recipient) }, ctx);
  res.json({ ok: true, sentTo: maskEmail(recipient), expiresInMs: CRED_2FA_TTL_MS });
});

/** Spends the code. Returns an error string, or '' when the change may proceed. */
function consumeCredChallenge(req: Request, slot: CredentialSlot, code: string): string {
  const key = credChallengeKey(req);
  const entry = credChallenges.get(key);
  if (!entry) return 'Kein Bestätigungscode angefordert. Bitte einen neuen Code senden.';
  if (Date.now() > entry.expiresAt) { credChallenges.delete(key); return 'Der Code ist abgelaufen. Bitte einen neuen anfordern.'; }
  if (entry.attempts >= CRED_2FA_MAX_ATTEMPTS) { credChallenges.delete(key); return 'Zu viele Fehlversuche. Bitte einen neuen Code anfordern.'; }
  // The code was issued FOR one door. Without this, a code sent for the team
  // password would open the admin one, which is the more valuable of the two.
  if (entry.slot !== slot) { return 'Der Code gehört zu einem anderen Zugang.'; }
  const attempt = Buffer.from(hashSecret(code, entry.salt), 'hex');
  const expected = Buffer.from(entry.hash, 'hex');
  if (attempt.length !== expected.length || !timingSafeEqual(attempt, expected)) {
    entry.attempts += 1;
    return 'Code ungültig.';
  }
  credChallenges.delete(key); // single use
  return '';
}

app.get('/api/admin/credentials', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    const stored = await readCredentials();
    res.json({
      slots: CREDENTIAL_SLOTS.map((slot) => {
        const rec = stored[slot];
        return {
          slot,
          username: rec?.username || SLOT_ENV[slot].username,
          // 'db' means someone set it here; 'env' means it is still whatever the
          // deployment shipped with, which is the state worth flagging on screen.
          source: rec ? 'db' : SLOT_ENV[slot].password ? 'env' : 'unset',
          updatedAt: rec?.updatedAt || null,
          updatedBy: rec?.updatedBy || null,
        };
      }),
      minLength: MIN_SECRET_LENGTH,
    });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Writing one slot. Changing the admin password does NOT sign the current admin
// out — console cookies are signed with ADMIN_SESSION_SECRET, not with the
// password — so rotating it cannot lock the person doing the rotating out of
// the page they are standing on.
app.put('/api/admin/credentials', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slot = asText(body.slot) as CredentialSlot;
    if (!CREDENTIAL_SLOTS.includes(slot)) { res.status(400).json({ error: 'Unbekannter Zugang.' }); return; }
    const password = asText(body.password);
    const username = asText(body.username).trim() || (await credentialUsername(slot, SLOT_ENV[slot].username));
    if (!username) { res.status(400).json({ error: 'Benutzername fehlt.' }); return; }
    if (password.length < MIN_SECRET_LENGTH) {
      res.status(400).json({ error: `Das Passwort braucht mindestens ${MIN_SECRET_LENGTH} Zeichen.` });
      return;
    }
    // A password that contains its own username is the first thing anyone
    // guesses, and this form is exactly where that gets typed.
    if (password.toLowerCase().includes(username.toLowerCase())) {
      res.status(400).json({ error: 'Das Passwort darf den Benutzernamen nicht enthalten.' });
      return;
    }
    const codeError = consumeCredChallenge(req, slot, asText(body.code).trim());
    if (codeError) { log.warn('auth.credentials', 'rejected: 2FA', { slot, reason: codeError }, ctx); res.status(403).json({ error: codeError }); return; }
    const by = asText(verifyAdminSession(req).email) || 'admin';
    await writeCredentials((current) => ({ ...current, [slot]: makeCredential(username, password, by) }));
    // Rotating the team password means the old one is loose. Every calendar
    // feed token handed out under it is loose too — they were obtained by
    // picking a name behind that password — so they go at the same moment.
    // Coaches get a fresh URL from the calendar dialog; see issueIcalToken.
    let feedsRevoked = false;
    if (slot === 'shared') {
      try { await revokeAllIcalFeeds(); feedsRevoked = true; }
      catch (revokeErr) { log.error('auth.credentials', 'feed revocation failed', { error: String(revokeErr) }, ctx); }
    }
    // The VALUE is never logged — only that it moved, and who moved it.
    log.info('auth.credentials', 'password changed', { slot, username, by, feedsRevoked }, ctx);
    res.json({ ok: true, slot, username, feedsRevoked });
  } catch (error) {
    log.error('auth.credentials', 'could not store the credential', { error }, ctx);
    res.status(500).json({ error: safeError(error) });
  }
});

// ── RC people CRUD (admin) ────────────────────────────────────────────
app.get('/api/admin/rc-people', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.getFullList<AnyRecord>({ sort: 'last_name' }));
    res.json(people.map((p) => ({
      id: p.id, first_name: asText(p.first_name), last_name: asText(p.last_name),
      email: asText(p.email), phone: asText(p.phone), active: p.active !== false,
    })));
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Login resolves an RC by email, so a second record carrying the same address
// is not a duplicate row — it is one of the two people permanently unable to
// log in, with nothing on screen to say why.
async function emailTakenBy(email: string, exceptId: string): Promise<boolean> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  const people = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
    c.getFullList<AnyRecord>({ fields: 'id,email' }));
  return people.some((p) => p.id !== exceptId && asText(p.email).trim().toLowerCase() === wanted);
}

// Games and filed feedbacks reference an RC by display name, so a rename would
// otherwise orphan every game they hold and every observation they filed.
async function renameRcReferences(oldName: string, newName: string, rcId: string): Promise<void> {
  const from = normalizeName(oldName);
  if (!from || from === normalizeName(newName)) return;
  // A row carrying an id belongs to whoever that id names — so a row whose id is
  // set and is NOT this person is a same-named colleague's, and must be left
  // alone. Rows with no id yet are matched on the old name and stamped with the
  // id as they are renamed, so the ambiguity does not come back.
  const mine = (recId: unknown, recName: unknown) => {
    const id = asText(recId);
    if (id) return id === rcId;
    return normalizeName(recName) === from;
  };
  const games = await withCollection(collectionCandidates.games, (c) =>
    c.getFullList<AnyRecord>({ fields: 'id,assigned_rc,assigned_rc_id' }));
  for (const game of games) {
    if (!mine(game.assigned_rc_id, game.assigned_rc)) continue;
    await withCollection(collectionCandidates.games, (c) =>
      c.update(game.id, { assigned_rc: newName, assigned_rc_id: rcId }));
  }
  const feedbacks = await withCollection(collectionCandidates.refereeCoaches, (c) =>
    c.getFullList<AnyRecord>({ fields: 'id,rc_name,rc_id' }));
  for (const feedback of feedbacks) {
    if (!mine(feedback.rc_id, feedback.rc_name)) continue;
    await withCollection(collectionCandidates.refereeCoaches, (c) =>
      c.update(feedback.id, { rc_name: newName, rc_id: rcId }));
  }
  icalGamesCache.clear();
}

app.post('/api/admin/rc-people', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const d = req.body ?? {};
    const email = asText(d.email);
    if (await emailTakenBy(email, '')) {
      res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits einem anderen RC zugeordnet.' });
      return;
    }
    const created = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.create({ first_name: asText(d.first_name), last_name: asText(d.last_name),
        email, phone: asText(d.phone), active: d.active !== false }));
    rcPeopleCache = null;
    res.status(201).json(created);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.put('/api/admin/rc-people/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const id = String(req.params.id);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    if ('first_name' in raw) payload.first_name = asText(raw.first_name);
    if ('last_name' in raw) payload.last_name = asText(raw.last_name);
    if ('email' in raw) payload.email = asText(raw.email);
    if ('phone' in raw) payload.phone = asText(raw.phone);
    if ('active' in raw) payload.active = Boolean(raw.active);
    if ('email' in raw && await emailTakenBy(asText(raw.email), id)) {
      res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits einem anderen RC zugeordnet.' });
      return;
    }
    const before = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.getOne<AnyRecord>(id, { fields: 'id,first_name,last_name' }));
    const updated = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.update(id, payload)) as AnyRecord;
    rcPeopleCache = null;
    const oldName = `${asText(before.first_name)} ${asText(before.last_name)}`.trim();
    const newName = `${asText(updated.first_name)} ${asText(updated.last_name)}`.trim();
    try { await renameRcReferences(oldName, newName, id); }
    catch (renameErr) { console.error('[rc-rename] could not migrate references:', renameErr); }
    res.json(updated);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.delete('/api/admin/rc-people/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const id = String(req.params.id);
    await withCollection(collectionCandidates.refereeCoachPeople, (c) => c.delete(id));
    rcPeopleCache = null;
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// ── Coachee bulk import (parsed xlsx rows + season) ───────────────────
app.post('/api/coachees/import', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const body = req.body ?? {};
    const season = body.season == null || body.season === '' ? null : Number(body.season);
    const rows = Array.isArray(body.coachees) ? body.coachees : [];
    const existing = await withCollection(collectionCandidates.coachees, (c) =>
      c.getFullList<AnyRecord>({ fields: 'id,full_name,season' }));
    const byKey = new Map<string, AnyRecord>();
    for (const e of existing) byKey.set(`${normalizeName(e.full_name)}|${e.season ?? ''}`, e);
    let created = 0, updated = 0;
    for (const r of rows) {
      const full_name = asText(r.full_name) || `${asText(r.first_name)} ${asText(r.last_name)}`.trim();
      if (!full_name) continue;
      const payload: Record<string, unknown> = {
        full_name, first_name: asText(r.first_name), last_name: asText(r.last_name), season,
      };
      // Only touch a field when the file actually provided a value — a re-import
      // from a sheet without that column must not wipe what is maintained in the
      // app. Losing the email silently breaks submission: the feedback POST
      // hard-fails without one. The same held for the rest: a sheet carrying only
      // names and emails blanked every Niveau and every Gruppe it did not mention.
      //
      // stage was worse than blanked — it defaulted to the literal 'active'
      // whenever the sheet had no Stufe column. That is not a Stufe: levelKey()
      // only accepts a numeric one, so those coachees showed as "N4 – TBD" and
      // derived no Niveau rules at all — 20 of the 52 season-2026 coachees carried
      // it (fixed from the VolleyManager export on 2026-08-24). An unknown Stufe
      // is now simply empty.
      //
      // The cost of the guard: blanking a cell no longer clears the field, so a
      // Niveau, Stufe or Gruppe is cleared by editing the coachee in the console.
      // That beats the alternative, which cannot tell an empty cell from a column
      // the sheet never had.
      for (const field of ['notes', 'email', 'phone', 'referee_level', 'stage', 'groups'] as const) {
        const value = asText(r[field]);
        if (value) payload[field] = value;
      }
      const key = `${normalizeName(full_name)}|${season ?? ''}`;
      const ex = byKey.get(key);
      if (ex) { await withCollection(collectionCandidates.coachees, (c) => c.update(ex.id, payload)); updated++; }
      else {
        const rec = await withCollection(collectionCandidates.coachees, (c) => c.create({ notes: '', phone: '', referee_level: '', stage: '', groups: '', ...payload, feedback_entries: [] }));
        byKey.set(key, rec as AnyRecord); // duplicate rows in one file update instead of duplicating
        created++;
      }
    }
    // Importing a newer season makes it the app-wide default ("latest season with
    // data"). Guarded so a historical backfill or typo season can't move it.
    if (created > 0 && season != null && Number.isFinite(season)) {
      const now = new Date();
      const curSeasonYear = now.getMonth() <= 7 ? now.getFullYear() - 1 : now.getFullYear();
      const cur = Number(asText((await getSettingRecord('default_season'))?.value));
      const newerThanCurrent = !Number.isFinite(cur) || season > cur;
      const plausible = season >= curSeasonYear && season <= curSeasonYear + 2;
      if (newerThanCurrent && plausible) await setSetting('default_season', String(season));
    }
    res.json({ created, updated, total: rows.length });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Fills in coachee email/phone from the VolleyManager referee list. Meant to
// run right after an XLSX import, which carries neither.
app.post('/api/admin/coachees/sync-contacts', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const username = asText(process.env.VM_USERNAME);
    const password = asText(process.env.VM_PASSWORD);
    if (!username || !password) { res.status(400).json({ error: 'VM_USERNAME / VM_PASSWORD sind nicht gesetzt.' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const overwrite = Boolean(body.overwrite);
    const season = body.season == null || body.season === '' ? null : Number(body.season);

    const contacts = await fetchVmRefereeContacts(username, password);
    // Index under both name orders — the XLSX and VM disagree on which comes
    // first, and normalizeName already folds case and accents.
    //
    // Every key holds ALL its candidates, and the two orders are kept apart.
    // This was one map with `if (!byName.has(key)) set(key, c)`, so two
    // referees sharing a name — or whose names reverse into each other, which
    // the server's normalizeName does NOT fold together — collided and the one
    // VolleyManager happened to page first silently won. The other vanished
    // from the index, and a coachee with no address on file could be handed the
    // WRONG PERSON's address for good, with every later coaching report mailed
    // to a stranger and nothing anywhere reporting it. An ambiguous name is now
    // refused and returned to the caller instead of being resolved by paging
    // order; the forward order is tried first so an exact "Vorname Nachname"
    // always beats a reversed guess.
    const byNameForward = new Map<string, VmRefereeContact[]>();
    const byNameReversed = new Map<string, VmRefereeContact[]>();
    const indexUnder = (index: Map<string, VmRefereeContact[]>, key: string, contact: VmRefereeContact) => {
      if (!key) return;
      const bucket = index.get(key);
      if (bucket) bucket.push(contact); else index.set(key, [contact]);
    };
    for (const c of contacts) {
      indexUnder(byNameForward, normalizeName(`${c.firstName} ${c.lastName}`), c);
      indexUnder(byNameReversed, normalizeName(`${c.lastName} ${c.firstName}`), c);
    }

    const coachees = await listCoacheesWithFallbackSort();
    const scoped = season == null ? coachees : coachees.filter((c) => Number(c.season) === season);
    let updated = 0, alreadySet = 0, notFound = 0;
    const missing: string[] = [];
    // Names VolleyManager holds more than once. Reported, never guessed at.
    const ambiguous: string[] = [];

    const coacheeName = (coachee: AnyRecord) =>
      asText(coachee.full_name) || `${asText(coachee.first_name)} ${asText(coachee.last_name)}`.trim();
    const lookup = <T,>(index: Map<string, T>, coachee: AnyRecord): T | undefined =>
      index.get(normalizeName(coacheeName(coachee)))
      ?? index.get(normalizeName(`${asText(coachee.last_name)} ${asText(coachee.first_name)}`));

    // The same person listed twice is not an ambiguity — only genuinely
    // different people are. Compared on the fields we would actually write.
    const distinctPeople = (bucket: VmRefereeContact[]): VmRefereeContact[] => {
      const seen = new Map<string, VmRefereeContact>();
      for (const c of bucket) {
        const key = [c.firstName, c.lastName, c.email, c.phone].map((v) => normalizeName(v)).join('|');
        if (!seen.has(key)) seen.set(key, c);
      }
      return [...seen.values()];
    };

    /** A referee-list hit, or why there isn't one. Never picks between people. */
    const lookupContact = (coachee: AnyRecord): { hit?: VmRefereeContact; ambiguous?: boolean } => {
      const keys = [
        normalizeName(coacheeName(coachee)),
        normalizeName(`${asText(coachee.last_name)} ${asText(coachee.first_name)}`),
      ];
      for (const index of [byNameForward, byNameReversed]) {
        for (const key of keys) {
          const bucket = key ? index.get(key) : undefined;
          if (!bucket) continue;
          const people = distinctPeople(bucket);
          if (people.length > 1) return { ambiguous: true };
          return { hit: people[0] };
        }
      }
      return {};
    };
    // Never clobber a hand-corrected address unless explicitly asked to.
    const applyContact = async (coachee: AnyRecord, hit: VmContact) => {
      const patch: Record<string, unknown> = {};
      if (hit.email && (overwrite || !asText(coachee.email))) patch.email = hit.email;
      if (hit.phone && (overwrite || !asText(coachee.phone))) patch.phone = hit.phone;
      // Niveau follows the same rule as the contact fields. Only ever N1..N4
      // from VM; the Stufe half is not offered by that API, so `stage` is left
      // exactly as it was.
      if (hit.level && (overwrite || !asText(coachee.referee_level))) patch.referee_level = hit.level;
      // A write that would set every field to what it already holds is not an
      // update. Without this, `overwrite` reported all 52 matched coachees as
      // "updated" when nothing about them had changed.
      for (const [field, value] of Object.entries(patch)) {
        if (asText(coachee[field]) === asText(value)) delete patch[field];
      }
      if (Object.keys(patch).length === 0) { alreadySet++; return false; }
      await withCollection(collectionCandidates.coachees, (c) => c.update(coachee.id, patch));
      updated++;
      return true;
    };

    const unresolved: AnyRecord[] = [];
    for (const coachee of scoped) {
      const match = lookupContact(coachee);
      // Two different referees answer to this name. Writing either address is a
      // coin flip with somebody's personal report as the stake, so write
      // nothing and say so — an admin can pick the right one by hand.
      if (match.ambiguous) {
        if (ambiguous.length < 50) ambiguous.push(coacheeName(coachee));
        continue;
      }
      if (!match.hit) { unresolved.push(coachee); continue; }
      await applyContact(coachee, match.hit);
    }

    // Everyone the referee list did not cover. There is no second source: the
    // games pass that used to live here is gone.
    //
    // It read referee contacts off game convocations, and it could never work.
    // Measured 2026-08-24 over 300 games / 61 convocations under the
    // referee-delegate role — the only role that can open the game list at all:
    // ZERO carried a flat `emailAddress`, and ZERO carried the referee's own
    // address either. VolleyManager strips contact fields from convocation data
    // for every role this account can hold, which confirms the 2026-08-13 field
    // note. Re-ordering which of the two was preferred would therefore have
    // changed nothing, and the pass cost a full-season scrape and eight upstream
    // calls to find exactly nothing.
    //
    // It also carried real risk while it existed: pairing a name from one
    // convocation slot with an address from another is precisely how a coachee
    // ends up holding a stranger's e-mail. Kept behind a flag it was still one
    // `{"useGames": true}` away from running.
    //
    // If the account ever gains a role that can read the games AND see contacts,
    // this comes back deliberately — not by flipping a flag nobody has tested.
    notFound += unresolved.length;
    for (const coachee of unresolved) {
      if (missing.length < 50) missing.push(coacheeName(coachee));
    }

    res.json({
      refereesFetched: contacts.length,
      coachees: scoped.length,
      updated,
      alreadySet,
      notFound,
      missing,
      ambiguous,
    });
  } catch (error) {
    // What fails here is a VolleyManager login, the role switch or the referee
    // list itself, and the admin who pressed the button is the one who can fix
    // it — so name the step instead of sending them to the container log.
    res.status(500).json({ error: upstreamError(error) });
  }
});

// ── Auth endpoints (team session + console session) ──────────────────
app.get('/api/auth/me', async (req: Request, res: ExpressResponse) => {
  let rc: { id: string; name: string } | null = null;
  const session = verifyRcSession(req);
  // Every app session is the team credential now, so "shared" is simply
  // "signed in to the app". The field stays because the gate still needs to
  // tell an app session from a console one.
  const shared = session.ok;
  // Both privileges come from the console cookie, never from the app session:
  // the client mirrors the server's answer rather than a record's flag, so it
  // is never shown a door the API would slam.
  const surveyReader = verifyPresidentSession(req).ok;
  if (session.ok && session.rcId) {
    try {
      // resolveRcSession, not a bare lookup: it also re-checks that the name on
      // the token is still an active RC, so a deactivated coach's session stops
      // answering "logged in" instead of opening an app that then 401s.
      const resolved = await resolveRcSession(req);
      if (resolved) {
        rc = { id: resolved.person.id, name: resolved.person.fullName };
      }
    } catch (error) {
      // The session token is valid but PocketBase is unreachable. Fail with 503
      // (Cache-Control: no-store) rather than a 200 {rc:null}: a cached "logged
      // out" body would lock a valid session out of its own offline data.
      console.error('[auth/me] backend unavailable:', error);
      res.set('Cache-Control', 'no-store');
      res.status(503).json({ error: 'Auth backend unavailable' });
      return;
    }
  }
  // Admin comes from the console cookie and nowhere else now.
  const adminSession = verifyAdminSession(req);
  const admin = adminSession.ok ? { email: adminSession.email || '' } : null;
  // Lets the console hide the RC-feedback tab from everyone else. Read off the
  // person already loaded above; the server enforces the same flag on the
  // endpoint independently, so this only saves a pointless 403.
  //
  // needsIdentity is the third state the gate has to tell apart from "logged
  // in" and "logged out": signed in on the shared credential, but not yet
  // anybody. It also covers a session whose chosen RC has since been
  // deactivated — that sends them back to the picker, not to the login screen,
  // because their password is still perfectly good.
  res.json({ rc, admin, surveyReader, shared, needsIdentity: shared && !rc });
});

// The everyday way in: one username and password for the whole team. Opens a
// session that is deliberately NOBODY — every requireRcSession endpoint still
// answers 401 until /api/auth/rc/identify puts a name on it.
app.post('/api/auth/shared/login', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const ipRl = checkGateRateLimit(ctx.ip, 'shared-login');
  if (!ipRl.allowed) { denyRateLimited(req, res, 'login:ip', ipRl.retryAfterMs, { kind: 'shared' }); return; }
  // Read the app-wide budget, spend it only on a wrong answer — same reasoning
  // as the personal login, and it matters more here: one secret for everybody
  // means one bucket for everybody, so charging correct logins would let a
  // busy Saturday lock the whole region out.
  const globalRl = peekRateLimit(sharedLoginGlobal, 'global', SHARED_GLOBAL_MAX);
  if (!globalRl.allowed) { denyRateLimited(req, res, 'login:global', globalRl.retryAfterMs, { kind: 'shared' }); return; }
  const username = asText((req.body ?? {}).username).trim();
  const password = asText((req.body ?? {}).password);
  // Both halves are compared every time — no early return on a wrong username,
  // so the response says nothing about which half was wrong.
  const attempt = await verifyCredential(
    'shared', username, password, SHARED_LOGIN_USERNAME_ENV, SHARED_LOGIN_PASSWORD_ENV,
  );
  const userOk = attempt.userMatched;
  const passOk = attempt.ok;
  if (!attempt.ok) {
    checkRateLimit(sharedLoginGlobal, 'global', SHARED_GLOBAL_MAX, SHARED_GLOBAL_WINDOW_MS);
    // Which HALF was wrong, never what was typed. The username field is
    // prefilled and the password is the app's one shared secret, so a mistyped
    // login is most likely the secret landing in the wrong box — and the log is
    // read by humans in the admin console. The two booleans answer every
    // support question the string would have.
    log.warn('auth.shared-login', 'rejected', { userOk, passOk }, ctx);
    res.status(401).json({ error: 'Falscher Benutzername oder falsches Passwort.' });
    return;
  }
  log.info('auth.shared-login', 'ok', undefined, ctx);
  setRcSessionCookie(res, createRcSessionToken({}));
  res.json({ ok: true });
});

// The names the picker offers. Behind any valid session cookie, but NOT behind
// requireRcSession — that is precisely the gate a session which has not picked
// yet cannot pass. Carries names and ids only: it is the one roster endpoint
// reachable before the app knows who is asking.
app.get('/api/auth/rc/roster', async (req: Request, res: ExpressResponse) => {
  if (!verifyRcSession(req).ok && !verifyAdminSession(req).ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    res.json((await getActiveRcPeople()).map((p) => ({ id: p.id, fullName: p.fullName })));
  } catch (error) {
    log.error('auth.roster', 'could not load the RC roster', { error }, reqCtx(req));
    res.status(503).json({ error: 'Auth backend unavailable' });
  }
});

// Puts a name on a shared session. This is a claim, not a proof — everyone
// holding the shared credential could make any of them — so it decides what the
// session is ATTRIBUTED to (the log, ownership of games and feedbacks, the "my
// games" filter) and never what it may do beyond a plain coach.
//
// Re-callable on purpose: picking the wrong name on a shared tablet has to be
// fixable in the app, not by handing out new credentials.
app.post('/api/auth/rc/identify', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const session = verifyRcSession(req);
  if (!session.ok) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const rcId = asText((req.body ?? {}).rcId);
  try {
    const person = (await getActiveRcPeople()).find((p) => p.id === rcId);
    if (!person) {
      log.warn('auth.identify', 'rejected: unknown or inactive RC', { rcId }, ctx);
      res.status(400).json({ error: 'Unbekannter Referee Coach.' });
      return;
    }
    tagReqUser(req, person.fullName);
    log.info('auth.identify', 'shared session identified', { rcId: person.id, name: person.fullName }, ctx);
    setRcSessionCookie(res, createRcSessionToken({ rcId: person.id, name: person.fullName }));
    res.json({ ok: true, rc: { id: person.id, name: person.fullName } });
  } catch (error) {
    log.error('auth.identify', 'backend failure while identifying', { rcId, error }, ctx);
    res.status(503).json({ error: 'Auth backend unavailable' });
  }
});

app.post('/api/auth/rc/logout', (_req: Request, res: ExpressResponse) => {
  res.cookie(RC_COOKIE, '', {
    httpOnly: true,
    sameSite: SESSION_SAMESITE,
    secure: true,
    maxAge: 0,
    path: '/',
  });
  res.json({ ok: true });
});

// ---- Signature sessions (cross-device signing via slug capability token) ----
// Unsigned sessions expire so a leaked slug can't be (re)used indefinitely.
const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
// The capability endpoints are reached without a session, so nothing else on
// the request path has authenticated this process to PocketBase. Without the
// explicit call every signing link 404s after a restart until some logged-in
// route happens to run first.
async function getSignatureRecord(slug: string) {
  if (!slug || slug.length > 64) return null;
  try {
    await ensureAdminAuth();
    return await pb.collection('signatures').getFirstListItem(`slug = "${escapeFilterValue(slug)}"`);
  } catch { return null; }
}
function isSignatureExpired(rec: AnyRecord): boolean {
  if (Boolean(rec.signed)) return false; // signed records stay readable
  const created = Date.parse(asText(rec.created));
  return Number.isFinite(created) && (Date.now() - created) > SIGNATURE_TTL_MS;
}
app.post('/api/signature/start', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const slug = randomUUID().replace(/-/g, '');
    const context = asText((req.body ?? {}).context).slice(0, 300);
    const signer = asText((req.body ?? {}).signer).slice(0, 120);
    await pb.collection('signatures').create({ slug, context, signer, data: '', signed: false });
    res.json({ slug });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.get('/api/signature/:slug', async (req: Request, res: ExpressResponse) => {
  try {
    const rec = await getSignatureRecord(asText(req.params.slug)) as AnyRecord | null;
    if (!rec) { res.status(404).json({ error: 'Not found' }); return; }
    if (isSignatureExpired(rec)) { res.status(410).json({ error: 'Signature session expired' }); return; }
    res.json({ context: asText(rec.context), signer: asText(rec.signer), signed: Boolean(rec.signed), data: rec.signed ? asText(rec.data) : '' });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.post('/api/signature/:slug', async (req: Request, res: ExpressResponse) => {
  try {
    const rl = checkSignatureRateLimit(clientIp(req));
    if (!rl.allowed) { res.status(429).json({ error: 'Too many attempts.', retryAfterMs: rl.retryAfterMs }); return; }
    const data = asText((req.body ?? {}).data);
    const signer = asText((req.body ?? {}).signer).slice(0, 120);
    if (!data.startsWith('data:image/') || data.length > 2_000_000) { res.status(400).json({ error: 'Invalid signature' }); return; }
    const rec = await getSignatureRecord(asText(req.params.slug)) as AnyRecord | null;
    if (!rec) { res.status(404).json({ error: 'Not found' }); return; }
    if (isSignatureExpired(rec)) { res.status(410).json({ error: 'Signature session expired' }); return; }
    // Signatures are write-once: once signed, the capability can't overwrite it.
    if (Boolean(rec.signed)) { res.status(409).json({ error: 'Signature already captured' }); return; }
    await ensureAdminAuth();
    await pb.collection('signatures').update(rec.id, { data, signed: true, signer: signer || asText(rec.signer) });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// ---- Post-visit survey (the coachee's feedback ON the RC) ----
// Ported from the SVRZ Google Form "Feedback zu RC-Besuch". The link rides in
// the feedback mail as a capability token, so the coachee — a referee, not an
// app user — needs no login, and no name or match number travels in the URL:
// the token resolves all of it here.
//
// Identity keeps the original form's bargain. The name is prefilled for
// convenience, but "anonym absenden" drops it before it is ever stored, and no
// coachee relation is written either way. Match, date and RC always stay — a
// response nobody can place is a response nobody can act on.
const SURVEY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 d — a season's worth of slack
const SURVEY_COLLECTION = 'rc_visit_feedback';

// Who may READ the responses. Server env on purpose, never an app setting: the
// form promises "Einsicht hat nur die RC-Vorsitzende", and an admin who could
// name the reader from the admin console would simply be naming themselves.
// Admin rights are not enough here — this is the one view the role doesn't open.
// Reading is gated on the person, not on an address: matching a configured
// email against the one she happens to log in with fails silently and looks
// exactly like "not configured yet". The flag on her referee_coaches record IS
// the identity, so there is nothing to keep in sync.
//
// An admin session does NOT pass. Admin rights open every other view in this
// app; this is the one they must not.
//
// Nor does the team login: it lets anyone holding one password pick her name
// off a list, and a promise of confidentiality that a name-picker can satisfy
// is no promise at all. She signs in on the admin page with a password of her
// own, which is the only credential in the system that opens this.
function isSurveyReader(req: Request): boolean {
  return verifyPresidentSession(req).ok;
}

async function requireSurveyReader(req: Request, res: ExpressResponse, next: () => void) {
  try {
    // Nobody flagged yet fails CLOSED — a recoverable mistake, unlike the
    // alternative of defaulting open to everyone with admin rights.
    if (isSurveyReader(req)) { next(); return; }
  } catch (error) {
    console.error('[survey] reader check failed:', error);
    res.status(503).json({ error: 'Auth backend unavailable' });
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
}

// Where a submitted survey is mailed. Separate from is_rc_president on purpose:
// reading the collected responses in the tool and receiving them as they
// arrive are different jobs for different people.
const SURVEY_NOTIFY_EMAILS = (process.env.SURVEY_NOTIFY_EMAIL || '')
  .split(',').map((e) => e.trim()).filter(Boolean);

// Mails one submitted survey. Never throws: the coachee has already answered,
// and losing their response because SMTP hiccuped would be the worst outcome
// here — the tool stays the canonical copy either way.
async function sendSurveyNotification(rec: AnyRecord, answers: Record<string, string>, lang: SurveyLang): Promise<void> {
  if (SURVEY_NOTIFY_EMAILS.length === 0) return;
  try {
    const anonymous = Boolean(rec.anonymous);
    const matchNo = asText(rec.match_no);
    const date = asText(rec.match_date);
    const rows: Array<[string, string]> = [
      ['Schiedsrichter:in', anonymous ? '(anonym)' : asText(rec.referee_name)],
      ['Datum', date],
      ['Spiel Nr.', matchNo],
      ['Referee Coach', asText(rec.rc_name)],
    ];
    // Always German, whatever language the coachee answered in: this mail goes
    // to the RC commission, not back to the respondent. Only a free-text answer
    // stays in the words it was written in — `lang` just records which form was
    // used. Choice answers are stored as a stable value, so the German label is
    // always available.
    if (lang === 'EN') rows.push(['Sprache', 'auf Englisch ausgefüllt']);
    const qa: Array<[string, string]> = [];
    for (const q of SURVEY_QUESTIONS) {
      const value = answers[q.id];
      if (!value) continue; // unanswered: the form requires nothing
      const label = q.kind === 'choice'
        ? (q.options.find((o) => o.value === value)?.DE ?? value)
        : value;
      qa.push([questionLabel(q, 'DE'), label]);
    }
    const built = buildTemplatedEmail({
      tpl: {
        subject: `Feedback zu RC-Besuch – Spiel ${matchNo} (${date})`,
        heading: 'Feedback zu RC-Besuch',
        intro: anonymous
          ? 'Eine anonyme Rückmeldung ist eingegangen.'
          : 'Eine Rückmeldung ist eingegangen.',
        outro: '',
      },
      vars: {},
      rows,
      qa,
      footerNote: 'Automatisch vom SR-Coaching-System versendet.',
    });
    // Test mode redirects this like every other mail. Without it, testing the
    // survey flow quietly mails the real RC commission.
    const testMode = await isEmailTestMode();
    const testRecipient = process.env.FEEDBACK_TEST_RECIPIENT || '';
    if (testMode && !testRecipient) {
      log.warn('survey.notify_skipped', 'test mode on but no FEEDBACK_TEST_RECIPIENT — not mailing');
      return;
    }
    await sendMailResilient({
      from: MAIL_FROM,
      to: testMode ? testRecipient : SURVEY_NOTIFY_EMAILS.join(','),
      subject: testMode ? `[TEST] ${built.subject}` : built.subject,
      html: built.html,
      text: built.text,
      attachments: emailAttachments(),
    });
  } catch (error) {
    // The RAW error, not safeError(): this is our own log, and sanitising it is
    // how "Greeting never received" became an unhelpful "Internal server error"
    // that cost an afternoon to track down.
    log.warn('survey.notify_failed', 'survey stored but could not be mailed', {
      error: error instanceof Error ? error.message : String(error),
      code: String((error as { code?: string })?.code || ''),
    });
  }
}

const SURVEY_MAX_ANSWERS = 50;
const SURVEY_MAX_ANSWER_LEN = 5000;

// Same as the signature capability: no session on the request, so this is the
// only place that can authenticate the process to PocketBase.
async function getSurveyRecord(token: string) {
  if (!token || token.length > 64) return null;
  try {
    await ensureAdminAuth();
    return await pb.collection(SURVEY_COLLECTION).getFirstListItem(`token = "${escapeFilterValue(token)}"`);
  } catch { return null; }
}
function isSurveyExpired(rec: AnyRecord): boolean {
  if (Boolean(rec.submitted)) return false; // answered records stay readable
  const created = Date.parse(asText(rec.created));
  return Number.isFinite(created) && (Date.now() - created) > SURVEY_TTL_MS;
}

// Mints the row the mailed link points at. Deliberately never throws: a survey
// link is a nice-to-have, and failing to create one must not cost the coachee
// the feedback mail it was going to be attached to.
async function createSurveyToken(v: { referee: string; date: string; matchNo: string; rc: string }): Promise<string> {
  try {
    const token = randomUUID().replace(/-/g, '');
    await pb.collection(SURVEY_COLLECTION).create({
      token, referee_name: v.referee, match_date: v.date, match_no: v.matchNo,
      rc_name: v.rc, lang: '', anonymous: false, answers: {}, submitted: false,
    });
    return token;
  } catch (error) {
    log.warn('survey.mint_failed', 'could not mint survey token — mail goes out without the link', { error: safeError(error) });
    return '';
  }
}

app.get('/api/survey/:token', async (req: Request, res: ExpressResponse) => {
  try {
    const rec = await getSurveyRecord(asText(req.params.token)) as AnyRecord | null;
    if (!rec) { res.status(404).json({ error: 'Not found' }); return; }
    if (isSurveyExpired(rec)) { res.status(410).json({ error: 'Survey link expired' }); return; }
    res.json({
      referee: asText(rec.referee_name),
      date: asText(rec.match_date),
      matchNo: asText(rec.match_no),
      rc: asText(rec.rc_name),
      submitted: Boolean(rec.submitted),
    });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.post('/api/survey/:token', async (req: Request, res: ExpressResponse) => {
  try {
    const rl = checkSurveyRateLimit(clientIp(req));
    if (!rl.allowed) { denyRateLimited(req, res, 'survey', rl.retryAfterMs); return; }
    const rec = await getSurveyRecord(asText(req.params.token)) as AnyRecord | null;
    if (!rec) { res.status(404).json({ error: 'Not found' }); return; }
    if (isSurveyExpired(rec)) { res.status(410).json({ error: 'Survey link expired' }); return; }
    // Write-once, like signatures: the capability answers, it doesn't edit.
    if (Boolean(rec.submitted)) { res.status(409).json({ error: 'Survey already submitted' }); return; }

    const body = (req.body ?? {}) as AnyRecord;
    const anonymous = Boolean(body.anonymous);
    const lang = asText(body.lang) === 'EN' ? 'EN' : 'DE';
    // Only the question ids we ship, capped in count and length — the answers
    // blob is written by an unauthenticated caller.
    const raw = (body.answers ?? {}) as Record<string, unknown>;
    const answers: Record<string, string> = {};
    for (const key of Object.keys(raw).slice(0, SURVEY_MAX_ANSWERS)) {
      if (!/^[a-z_]{1,40}$/.test(key)) continue;
      const value = asText(raw[key]).slice(0, SURVEY_MAX_ANSWER_LEN);
      if (value) answers[key] = value;
    }

    await ensureAdminAuth();
    await pb.collection(SURVEY_COLLECTION).update(rec.id, {
      // Anonymous means the name is gone from the record, not merely hidden in
      // the UI — the row must not be able to betray them later.
      referee_name: anonymous ? '' : asText(rec.referee_name),
      anonymous, lang, answers,
      submitted: true, submitted_at: new Date().toISOString(),
    });
    // Built from what was STORED, not from the request, so an anonymous
    // submission cannot leak a name into the mail.
    await sendSurveyNotification({ ...rec, anonymous, referee_name: anonymous ? '' : asText(rec.referee_name) }, answers, lang);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Not under /api/admin on purpose — an admin session does NOT open this. Only
// the configured reader does, mirroring the promise the form makes the coachee.
// Its own path, not /api/survey/responses: that would be swallowed by the
// /api/survey/:token route above as token="responses".
app.get('/api/survey-responses', requireSurveyReader, async (_req: Request, res: ExpressResponse) => {
  try {
    const rows = await pb.collection(SURVEY_COLLECTION).getFullList<AnyRecord>({
      filter: 'submitted = true', sort: '-submitted_at',
    });
    res.json(rows.map((r) => {
      // A `json` field comes back as an object already (same as feedback_json).
      const answers = (r.answers && typeof r.answers === 'object' && !Array.isArray(r.answers))
        ? r.answers as Record<string, string>
        : {};
      return {
        id: asText(r.id),
        referee: asText(r.referee_name),
        anonymous: Boolean(r.anonymous),
        date: asText(r.match_date),
        matchNo: asText(r.match_no),
        rc: asText(r.rc_name),
        lang: asText(r.lang) || 'DE',
        submittedAt: asText(r.submitted_at),
        answers,
      };
    }));
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// ── Private notes to the RC president ─────────────────────────────────
// A coach's word to the chair about a visit they have already filed: the
// coachee's feedback is sent and closed, and this is what did NOT belong in it.
//
// Kept OUT of feedback_json on purpose. That object is what the PDF is drawn
// from and what the coachee receives, so a note living in it would be one
// refactor away from being mailed to the person it is about. Here it is a
// separate app_settings map (same key/value store as coachee_targets and
// rc_mandates — no schema change), keyed by the feedback record id and carrying
// the game/coachee labels the president's list needs, so reading the list costs
// one settings read instead of a join per row.
//
// One row per season rather than one row for all time: every save rewrites the
// whole value, and a single row would keep growing for as long as the tool is
// used. The season comes from the game, so a note always lands in the season it
// was played in.
const PRESIDENT_NOTES_PREFIX = 'president_notes_';
const PRESIDENT_NOTE_MAX = 5000;

type PresidentNoteEntry = {
  note: string; gameId: string; teams: string; league: string;
  gameDate: string; coacheeName: string; rcName: string;
  /** Who wrote the note — an admin may write on a feedback they did not file. */
  authorName: string;
  updatedAt: string;
};

/** Season a date belongs to, named by its starting year (Sept–Apr). */
function seasonOfDate(value: string): number {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().getFullYear();
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}

const presidentNotesKey = (season: number) => `${PRESIDENT_NOTES_PREFIX}${season}`;

function parseNoteMap(value: unknown): Record<string, PresidentNoteEntry> {
  try {
    const parsed = JSON.parse(asText(value));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, PresidentNoteEntry>
      : {};
  } catch { return {}; }
}

async function readPresidentNotes(season: number): Promise<Record<string, PresidentNoteEntry>> {
  const rec = await getSettingRecord(presidentNotesKey(season));
  return rec ? parseNoteMap(rec.value) : {};
}

/** Every season's notes, newest first — what the president's list shows. */
async function readAllPresidentNotes(): Promise<Array<PresidentNoteEntry & { id: string }>> {
  const rows = await withCollection(['app_settings'], (c) =>
    c.getFullList<AnyRecord>({ filter: `key ~ "${PRESIDENT_NOTES_PREFIX}"` }));
  return rows
    .flatMap((row) => Object.entries(parseNoteMap(row.value)).map(([id, entry]) => ({ id, ...entry })))
    .sort((a, b) => asText(b.updatedAt).localeCompare(asText(a.updatedAt)));
}

/** Drop a feedback's note wherever it lives — used when the feedback is deleted. */
async function deletePresidentNote(feedbackId: string): Promise<void> {
  const rows = await withCollection(['app_settings'], (c) =>
    c.getFullList<AnyRecord>({ filter: `key ~ "${PRESIDENT_NOTES_PREFIX}"` }));
  for (const row of rows) {
    const key = asText(row.key);
    const notes = parseNoteMap(row.value);
    if (!notes[feedbackId]) continue;
    await withSettingLock(key, async () => {
      const current = parseNoteMap((await getSettingRecord(key))?.value);
      delete current[feedbackId];
      await setSetting(key, JSON.stringify(current));
    });
  }
}

// Who the session actually is, even when it is an admin one. requireRcSession
// deliberately attaches no rcAuth to admins and admin-flagged RCs, so ownership
// questions that must still hold for them cannot use rcAuthByReq alone.
async function sessionRcIdentity(req: Request): Promise<RcAuthInfo | null> {
  const attached = rcAuthByReq.get(req);
  if (attached) return attached;
  const session = await resolveRcSession(req);
  return session ? { rcId: session.person.id, name: session.person.fullName } : null;
}

// Who may put words on a feedback's note, and who may read them back.
//
// These used to demand an identity that had been PROVEN — a per-person login —
// so that one coach could not rewrite another's confidential note under that
// colleague's name. That login is gone, and with it the only way to prove
// anything: an app session names whoever its holder picked off the roster.
// Keeping the old rule would have retired the feature for every coach, so the
// trade is now stated rather than enforced — a coach writes and reads back
// their OWN note under the name they claimed, which is the same trust the rest
// of their data already runs on. What did NOT move is the chair's side: reading
// the whole list still takes her own password (isSurveyReader), so the private
// channel stays private even though its authors are self-declared.
//
// Writing is open to admins on purpose — the note records its author separately,
// so the chair can tell an admin's words from the coach's.
async function mayWritePresidentNote(req: Request, record: AnyRecord): Promise<boolean> {
  if (!rcAuthByReq.get(req)) return true; // admin session, by the convention above
  const me = await sessionRcIdentity(req);
  return Boolean(me && rcRefMatches(record.rc_id, record.rc_name, me));
}

async function mayReadPresidentNote(req: Request, record: AnyRecord): Promise<boolean> {
  if (isSurveyReader(req)) return true;
  const me = await sessionRcIdentity(req);
  return Boolean(me && rcRefMatches(record.rc_id, record.rc_name, me));
}

async function getFeedbackForNote(id: string): Promise<AnyRecord> {
  return withCollection(collectionCandidates.refereeCoaches, (c) =>
    c.getOne<AnyRecord>(id, { expand: 'game,coachee' }));
}

app.get('/api/feedback/:id/president-note', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    let record: AnyRecord;
    try { record = await getFeedbackForNote(String(req.params.id)); }
    catch { res.status(404).json({ error: 'Feedback not found' }); return; }
    // The author reads it back to edit it; the president reads anyone's.
    if (!(await mayReadPresidentNote(req, record))) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const gameDate = asText(((record.expand ?? {}) as Record<string, AnyRecord | undefined>).game?.match_date);
    const notes = await readPresidentNotes(seasonOfDate(gameDate));
    res.json({ note: notes[record.id]?.note ?? '' });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.put('/api/feedback/:id/president-note', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    let record: AnyRecord;
    try { record = await getFeedbackForNote(String(req.params.id)); }
    catch { res.status(404).json({ error: 'Feedback not found' }); return; }
    if (!(await mayWritePresidentNote(req, record))) { res.status(403).json({ error: 'Forbidden' }); return; }

    const note = asText((req.body ?? {}).note).trim().slice(0, PRESIDENT_NOTE_MAX);
    const expand = (record.expand ?? {}) as Record<string, AnyRecord | undefined>;
    const game = expand.game;
    const coachee = expand.coachee;
    // An admin may write on a feedback another coach filed, so the note records
    // who wrote it separately from who filed the observation — the president
    // would otherwise read an admin's words as the coach's.
    const rcAuth = rcAuthByReq.get(req);
    const authorName = rcAuth?.name || asText(verifyAdminSession(req).email) || 'Admin';
    const key = presidentNotesKey(seasonOfDate(asText(game?.match_date)));

    await withSettingLock(key, async () => {
      const notes = parseNoteMap((await getSettingRecord(key))?.value);
      if (note) {
        notes[record.id] = {
          note,
          gameId: asText(record.game),
          teams: game ? `${asText(game.home_team)} vs ${asText(game.away_team)}` : '',
          league: asText(game?.league),
          gameDate: asText(game?.match_date),
          coacheeName: asText(coachee?.full_name) || asText(coachee?.name),
          rcName: asText(record.rc_name),
          authorName,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Clearing the box removes the note rather than filing an empty one.
        delete notes[record.id];
      }
      await setSetting(key, JSON.stringify(notes));
    });
    res.json({ ok: true, note });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// President-only, on the same gate as the survey responses: admin rights do not
// open this one either.
app.get('/api/president-notes', requireSurveyReader, async (_req: Request, res: ExpressResponse) => {
  try {
    res.json(await readAllPresidentNotes());
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// ── Games starred for observation (admin-picked priorities) ───────────
// Stored as a plain id list in app_settings, so highlighting a game needs no
// schema change. RCs see the star (and can filter by it); only admins set it.
//
// On top of that list, VolleyManager's own markings auto-flag a game: the RD
// markings ("RD-Spiel" / "SR zu beobachten") and the RSV one ("RSV-Markierung").
// VM wins — a game VM marked stays flagged and the admin star can only add to
// the set, never take away.
function isVmFlagged(game: { isRdGame?: boolean; isRsvGame?: boolean }): boolean {
  return Boolean(game.isRdGame || game.isRsvGame);
}

async function getStarredGameIds(): Promise<Set<string>> {
  const rec = await getSettingRecord('starred_games');
  if (!rec) return new Set();
  try {
    const arr = JSON.parse(asText(rec.value)) as unknown;
    return new Set(Array.isArray(arr) ? arr.map((v) => String(v)) : []);
  } catch { return new Set(); }
}

// Manually created games are tracked by id: guessing from the match number
// only works while the number is left blank (it defaults to TEST-nnnnnn), and
// a game given a real-looking number became impossible to find again.
async function getManualGameIds(): Promise<Set<string>> {
  const rec = await getSettingRecord('manual_games');
  if (!rec) return new Set();
  try {
    const arr = JSON.parse(asText(rec.value)) as unknown;
    return new Set(Array.isArray(arr) ? arr.map((v) => String(v)) : []);
  } catch { return new Set(); }
}

app.get('/api/eligible-games', requireRcSession, async (_req: Request, res: ExpressResponse) => {
  try {
    const [games, starred] = await Promise.all([getEligibleGames(), getStarredGameIds()]);
    res.json(games.map((g) => {
      const vmFlagged = isVmFlagged(g);
      return { ...g, vmFlagged, starred: vmFlagged || starred.has(String(g.id)) };
    }));
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// ── Manual games (admin) ──────────────────────────────────────────────
// VolleyManager is the normal source of games; this is the escape hatch for
// fixtures it doesn't carry — friendlies, ad-hoc entries, and throwaway games
// used to test the full observation → PDF → e-mail flow end to end.
app.post('/api/admin/games', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const d = (req.body ?? {}) as Record<string, unknown>;
    const matchDate = asText(d.match_date);
    if (!matchDate) { res.status(400).json({ error: 'match_date ist erforderlich.' }); return; }
    if (Number.isNaN(new Date(matchDate).getTime())) { res.status(400).json({ error: 'match_date ist kein gültiges Datum.' }); return; }
    const created = await withCollection(collectionCandidates.games, (c) => c.create<AnyRecord>({
      // A recognisable default so a manual game is obvious in any list.
      match_no: asText(d.match_no) || `TEST-${Date.now().toString().slice(-6)}`,
      league: asText(d.league),
      match_date: matchDate,
      location: asText(d.location),
      home_team: asText(d.home_team),
      away_team: asText(d.away_team),
      first_referee: asText(d.first_referee),
      second_referee: asText(d.second_referee),
      assigned_rc: asText(d.assigned_rc),
    }));
    await withSettingLock('manual_games', async () => {
      const manual = await getManualGameIds();
      manual.add(created.id);
      await setSetting('manual_games', JSON.stringify([...manual]));
    });
    res.status(201).json(created);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Lists the throwaway fixtures so they can be cleaned up later — the create
// form only knows about the one game it just made. `q` widens the search for a
// manual game that was given a real-looking match number.
app.get('/api/admin/games/manual', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const q = normalizeName(req.query.q);
    const manual = await getManualGameIds();
    const all = await withCollection(collectionCandidates.games, (c) => c.getFullList<AnyRecord>({
      sort: '-match_date',
      fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,assigned_rc_id',
    }));
    const hit = (g: AnyRecord) => {
      if (manual.has(g.id)) return true;
      // Games created before ids were tracked, plus anything the operator
      // searches for by hand.
      if (normalizeName(g.match_no).startsWith('test-')) return true;
      if (!q) return false;
      return [g.match_no, g.home_team, g.away_team, g.assigned_rc, g.first_referee, g.second_referee, g.match_date, g.league]
        .some((v) => normalizeName(v).includes(q));
    };
    res.json(all.filter(hit).slice(0, 50).map((g) => ({
      id: g.id, match_no: asText(g.match_no), league: asText(g.league), match_date: asText(g.match_date),
      home_team: asText(g.home_team), away_team: asText(g.away_team), assigned_rc: asText(g.assigned_rc),
    })));
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Deleting a game leaves any feedback that referenced it dangling, so this is
// meant for cleaning up a throwaway fixture, not for pruning real history.
app.delete('/api/admin/games/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const id = String(req.params.id);
    await withSettingLock('starred_games', async () => {
      const set = await getStarredGameIds();
      if (set.delete(id)) await setSetting('starred_games', JSON.stringify([...set]));
    });
    await withSettingLock('manual_games', async () => {
      const manual = await getManualGameIds();
      if (manual.delete(id)) await setSetting('manual_games', JSON.stringify([...manual]));
    });
    await withCollection(collectionCandidates.games, (c) => c.delete(id));
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.put('/api/admin/games/:id/star', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const id = String(req.params.id);
    const on = Boolean((req.body ?? {}).starred);
    // The whole list is read, edited and written back, so two stars in quick
    // succession would otherwise each save over the other's addition.
    await withSettingLock('starred_games', async () => {
      const set = await getStarredGameIds();
      if (on) set.add(id); else set.delete(id);
      await setSetting('starred_games', JSON.stringify([...set]));
    });
    // Un-starring only drops the manual entry — a game VM marked stays flagged,
    // so report the effective state rather than what was asked for.
    let vmFlagged = false;
    if (!on) {
      try {
        await ensureAdminAuth();
        const game = await withCollection(collectionCandidates.games, (collection) =>
          collection.getOne<AnyRecord>(id, { fields: 'is_rd_game,is_rsv_game' }),
        );
        vmFlagged = isVmFlagged({ isRdGame: Boolean(game.is_rd_game), isRsvGame: Boolean(game.is_rsv_game) });
      } catch { /* game gone or field missing — fall back to the manual state */ }
    }
    res.json({ ok: true, starred: on || vmFlagged, vmFlagged });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.get('/api/referee-coach-people', requireRcSession, async (_req: Request, res: ExpressResponse) => {
  try {
    // Projected, not whole: this list goes to every logged-in RC, so it carries
    // only what the picker needs. Shipping the record as-is is how the session
    // fingerprint leaked once already.
    res.json((await getActiveRcPeople()).map((p) => ({
      id: p.id, fullName: p.fullName, email: p.email,
    })));
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.put('/api/games/:id/assign-rc', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const gameId = String(req.params.id);
    const requestedRc = asText((req.body ?? {}).assignedRc);
    const rcAuth = rcAuthByReq.get(req);
    // The whole check-and-write runs under the game's lock: two RCs tapping
    // "übernehmen" at the same moment would otherwise both read the game as
    // free and the second write would quietly displace the first.
    const outcome = await withGameLock(gameId, async () => {
      let rcName = requestedRc;
      // Written beside the name so ownership stops depending on the spelling.
      let rcId = '';
      if (rcAuth) {
        // Non-admin RCs may only take games for themselves, and only give back
        // games they currently hold. Admin sessions have no rcAuth and skip this.
        const current = await withCollection(collectionCandidates.games, (collection) =>
          collection.getOne<AnyRecord>(gameId),
        );
        const heldByMe = rcRefMatches(current.assigned_rc_id, current.assigned_rc, rcAuth);
        const held = rcRefPresent(current.assigned_rc_id, current.assigned_rc);
        if (rcName === '') {
          if (held && !heldByMe) {
            return { status: 403, body: { error: 'Nur eigene Spiele können abgegeben werden.' } };
          }
        } else {
          if (normalizeName(rcName) !== normalizeName(rcAuth.name)) {
            return { status: 403, body: { error: 'Spiele können nur für dich selbst übernommen werden.' } };
          }
          if (held && !heldByMe) {
            return { status: 409, body: { error: 'Dieses Spiel wurde bereits von einem anderen RC übernommen.' } };
          }
          rcName = rcAuth.name; // write the canonical name from the RC record
          rcId = rcAuth.rcId;
        }
      } else if (rcName !== '') {
        // Admin assigning on someone's behalf: resolve the name they picked to
        // an id, so the row is id-backed however it was created.
        rcId = await rcIdForName(rcName);
      }
      const updated = await withCollection(collectionCandidates.games, (collection) =>
        // Giving a game back clears both halves; leaving a stale id behind would
        // keep the game "held" by someone whose name is already gone.
        collection.update(gameId, { assigned_rc: rcName, assigned_rc_id: rcName === '' ? '' : rcId }),
      );
      // Both sides of a handover change: clearing the lot beats working out who
      // the previous holder was, and the map holds one entry per RC.
      icalGamesCache.clear();
      return { status: 200, body: { ok: true, id: (updated as AnyRecord).id, assignedRc: asText((updated as AnyRecord).assigned_rc) } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// ── RC Overview ──────────────────────────────────────────────────────

// Season "2026" spans 2026-09-01 → 2027-04-30 (same window convention as the
// client-side games filter). Records without a parseable date are kept.
function seasonDateFilter(seasonRaw: unknown): ((dateText: string) => boolean) | null {
  const season = Number(asText(seasonRaw));
  if (!Number.isFinite(season) || season < 2000 || season > 2100) return null;
  const from = new Date(`${season}-09-01T00:00:00`);
  const to = new Date(`${season + 1}-04-30T23:59:59`);
  return (dateText: string) => {
    const d = new Date(dateText);
    if (Number.isNaN(d.getTime())) return true;
    return d >= from && d <= to;
  };
}

app.get('/api/rc-overview', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const inSeason = seasonDateFilter(req.query.season);
    // 1. RC people
    const allPeople = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
      collection.getFullList<AnyRecord>({ sort: 'last_name', filter: 'active = true' }),
    );
    // Every other coach's workload is an ADMIN surface. It used to be hidden
    // client-side while the endpoint still handed the whole table to anyone
    // holding a session -- one `curl` away, and one flipped boolean away in a
    // devtools console. Cut here, so a plain RC is served only their own row
    // (the Home dashboard is all that still reads this as a coach).
    // rcAuthByReq is absent for admin sessions, by the convention above.
    const rcAuth = rcAuthByReq.get(req);
    const people = rcAuth
      ? allPeople.filter((p) => rcRefMatches(p.id, `${asText(p.first_name)} ${asText(p.last_name)}`.trim(), rcAuth))
      : allPeople;
    // 2. All games
    const allGames = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date',
        fields: 'id,match_no,league,match_date,home_team,away_team,first_referee,second_referee,assigned_rc,assigned_rc_id,feedback_closed_roles,is_rd_game,is_ld_game',
      }),
    );
    // 3. All feedback records
    const allFeedbacks = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        fields: 'id,rc_name,rc_id,game,submitted_at',
      }),
    );

    const now = new Date();
    // Game ids that already have feedback, bucketed by whichever identity the
    // row carries: its rc_id once backfilled, its normalised name before that.
    // Each RC below reads both buckets, so a half-migrated table still counts
    // every feedback exactly once.
    const feedbackGameIdsByRc = new Map<string, Set<string>>();
    for (const fb of allFeedbacks) {
      const rcKey = asText(fb.rc_id) || normalizeName(fb.rc_name);
      if (!rcKey) continue;
      if (!feedbackGameIdsByRc.has(rcKey)) feedbackGameIdsByRc.set(rcKey, new Set());
      feedbackGameIdsByRc.get(rcKey)!.add(String(fb.game || ''));
    }

    const result = people.map((p) => {
      const fullName = `${asText(p.first_name)} ${asText(p.last_name)}`.trim();
      const rcKey = normalizeName(fullName);
      const self: RcAuthInfo = { rcId: String(p.id), name: fullName };
      const fbGameIds = new Set<string>([
        ...(feedbackGameIdsByRc.get(String(p.id)) ?? []),
        ...(feedbackGameIdsByRc.get(rcKey) ?? []),
      ]);

      let done = 0;
      let outstanding = 0;
      let planned = 0;

      for (const game of allGames) {
        if (!rcRefMatches(game.assigned_rc_id, game.assigned_rc, self)) continue;
        if (inSeason && !inSeason(asText(game.match_date))) continue;
        const gameDate = new Date(asText(game.match_date));
        const hasFeedback = fbGameIds.has(game.id);

        if (hasFeedback) {
          done++;
        } else if (gameDate < now) {
          outstanding++;
        } else {
          planned++;
        }
      }

      return { id: p.id, fullName, done, outstanding, planned };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/rc-overview/:rcName/coachees', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const rcAuth = rcAuthByReq.get(req);
    // A plain RC may only ever read their OWN detail. Rather than compare the
    // (name-keyed, collision-prone) URL param, ignore it entirely for non-admins
    // and pin the query to the session's own name — the id-backed identity.
    const rcName = rcAuth ? rcAuth.name : decodeURIComponent(String(req.params.rcName));
    const rcKey = normalizeName(rcName);
    const inSeason = seasonDateFilter(req.query.season);
    // Who this page is about, as an identity. For a plain RC it is the session;
    // for an admin reading someone's detail it is whoever that name resolves to.
    // Rows carrying an id are matched on it, so a rename — or a second coach
    // whose name folds to the same string — no longer moves games between pages.
    const subject: RcAuthInfo | null = rcAuth
      ?? (await rcIdForName(rcName).then((id) => (id ? { rcId: id, name: rcName } : null)));
    const isSubject = (recId: unknown, recName: unknown) =>
      subject ? rcRefMatches(recId, recName, subject) : normalizeName(recName) === rcKey;

    // Fetch all games assigned to this RC. game_result rides along so the Home
    // dashboard and the detail tabs can show the score without a second call —
    // it is one more column on a list this endpoint already reads whole.
    const allGames = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date',
        fields: 'id,match_no,league,match_date,home_team,away_team,first_referee,second_referee,assigned_rc,assigned_rc_id,feedback_closed_roles,is_rd_game,is_ld_game,game_result',
      }),
    );
    const rcGames = allGames.filter((g) =>
      isSubject(g.assigned_rc_id, g.assigned_rc) && (!inSeason || inSeason(asText(g.match_date))));

    // Fetch feedbacks for this RC
    const allFeedbacks = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-submitted_at',
        expand: 'game,coachee',
      }),
    );
    const rcFeedbacks = allFeedbacks.filter((fb) => isSubject(fb.rc_id, fb.rc_name));

    // Build feedback game IDs set
    const feedbackGameIds = new Set(rcFeedbacks.map((fb) => String(fb.game || '')));

    // Get coachee name set for referee matching
    const coacheeNameSet = await getCoacheeNameSet();

    // Group by coachee
    const coacheeMap = new Map<string, {
      coacheeName: string;
      coacheeId: string;
      doneFeedbacks: { gameDate: string; league: string; teams: string; role: string; submittedAt: string; result: string }[];
      outstandingGames: { gameId: string; gameDate: string; league: string; teams: string; refereeName: string; noCoachee?: boolean; result: string }[];
      plannedGames: { gameId: string; gameDate: string; league: string; teams: string; refereeName: string; noCoachee?: boolean; result: string }[];
    }>();

    const getOrCreate = (name: string, id: string) => {
      const key = normalizeName(name);
      if (!coacheeMap.has(key)) {
        coacheeMap.set(key, { coacheeName: name, coacheeId: id, doneFeedbacks: [], outstandingGames: [], plannedGames: [] });
      }
      return coacheeMap.get(key)!;
    };

    // Done feedbacks
    for (const fb of rcFeedbacks) {
      const expanded = fb.expand as Record<string, AnyRecord> | undefined;
      const coacheeRec = expanded?.coachee;
      const gameRec = expanded?.game;
      const coacheeName = asText(coacheeRec?.full_name || coacheeRec?.name);
      const coacheeId = String(coacheeRec?.id || '');
      if (!coacheeName) continue;
      if (inSeason && !inSeason(asText(gameRec?.match_date))) continue;
      const entry = getOrCreate(coacheeName, coacheeId);
      entry.doneFeedbacks.push({
        gameDate: asText(gameRec?.match_date),
        league: asText(gameRec?.league),
        teams: `${asText(gameRec?.home_team)} vs ${asText(gameRec?.away_team)}`,
        role: asText(fb.role_assessed),
        submittedAt: asText(fb.submitted_at),
        // Off the expanded game, not the feedback: the feedback's own copy is
        // whatever the coach typed at the time, while the game record is what
        // the sync keeps corrected.
        result: asText(gameRec?.game_result),
      });
    }

    // Outstanding & planned games (no feedback yet)
    const now = new Date();
    for (const game of rcGames) {
      if (feedbackGameIds.has(game.id)) continue;
      const gameDate = new Date(asText(game.match_date));
      const teams = `${asText(game.home_team)} vs ${asText(game.away_team)}`;
      const league = asText(game.league);
      const result = asText(game.game_result);

      // Match referees to coachees
      let matched = false;
      for (const ref of [game.first_referee, game.second_referee]) {
        const refName = asText(ref);
        if (!refName) continue;
        if (!coacheeNameSet.has(normalizeName(refName))) continue;
        matched = true;
        const entry = getOrCreate(refName, '');
        const gameEntry = { gameId: game.id, gameDate: asText(game.match_date), league, teams, refereeName: refName, result };
        if (gameDate < now) {
          entry.outstandingGames.push(gameEntry);
        } else {
          entry.plannedGames.push(gameEntry);
        }
      }
      // A game assigned to this RC whose referees are not (yet) coachees still
      // belongs on their list: /api/rc-overview counts it, so dropping it here
      // left the coach staring at "no data" while the badge promised a game.
      // Listed under the raw referee name — not clickable, since there is no
      // coachee to file an observation against.
      if (!matched) {
        const refNames = [game.first_referee, game.second_referee].map(asText).filter(Boolean);
        const label = refNames.join(' / ') || '?';
        const entry = getOrCreate(label, '');
        const gameEntry = { gameId: game.id, gameDate: asText(game.match_date), league, teams, refereeName: label, noCoachee: true, result };
        if (gameDate < now) {
          entry.outstandingGames.push(gameEntry);
        } else {
          entry.plannedGames.push(gameEntry);
        }
      }
    }

    const result = Array.from(coacheeMap.values()).sort((a, b) => a.coacheeName.localeCompare(b.coacheeName));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// What the last games sync did. The admin console shows it, so a sync that has
// stopped working is visible on a screen someone opens rather than only in the
// container log.
app.get('/api/admin/games/sync-status', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    // PocketBase is reached as superuser; without this every read below is a
    // 403 ("Only superusers can perform this action").
    await ensureAdminAuth();
    const rec = await getSettingRecord(GAMES_SYNC_STATUS_KEY);
    let status: GamesSyncStatus | null = null;
    try { status = rec ? JSON.parse(asText(rec.value)) as GamesSyncStatus : null; } catch { status = null; }
    // The newest game record is the honest cross-check: a status note can be
    // missing (nothing has run since this shipped) while the data is fine, and
    // it can say "ok" while every game it touched was already up to date.
    let newestGame = '';
    try {
      // Projected to two columns, so pulling the list to read its head is
      // cheap — getFullList has no "just the first row" mode.
      const [latest] = await withCollection(collectionCandidates.games, (c) =>
        c.getFullList<AnyRecord>({ sort: '-updated', fields: 'id,updated' }));
      newestGame = asText(latest?.updated);
    } catch { /* leave it blank rather than fail the whole readout */ }
    res.json({ status, newestGame, cron: process.env.VM_SYNC_CRON || '0 5 * * *' });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// A manual run records its outcome just like the nightly one does: the admin
// console reads that single note, so a sync started by hand has to leave the
// same trace or the card keeps showing last night's run as the latest word.
app.post('/api/games/sync', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSync(req.body ?? {});
    await recordGamesSyncStatus({
      at: new Date().toISOString(),
      ok: true,
      imported: result.imported,
      totalFetched: result.totalFetched,
    });
    res.json(result);
  } catch (error) {
    const message = upstreamError(error);
    await recordGamesSyncStatus({ at: new Date().toISOString(), ok: false, error: message });
    res.status(500).json({ error: message });
  }
});

app.post('/api/games/sync/debug', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSyncDebug(req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: upstreamError(error) });
  }
});

app.post('/api/vm/auth-check', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const debug = Boolean((req.body ?? {}).debug);
    const result = await runVmAuthCheck(debug);
    res.json(result);
  } catch (error) {
    const debug = Boolean((req.body ?? {}).debug);
    const trace = (error as Error & { trace?: VmTraceEntry[] })?.trace;
    res.status(500).json({
      error: safeError(error),
      ...(debug && trace ? { trace } : {}),
    });
  }
});

app.get('/api/coachees', requireRcSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const rows = await listCoacheesWithFallbackSort();
    const summaries = await getCoacheeObservationSummaryMap({ coachees: rows });
    const enriched = rows.map((row) => {
      const stage = asText(row.stage) || 'active';
      const isActive = stage !== 'inactive';
      const summary = summaries.get(row.id) ?? {
        count: 0,
        hasNoObservation: true,
        hasFurtherObservationNeeded: false,
        hasCompletedObservation: false,
        needsObservation: isActive,
        latestObservationAt: '',
      };
      return {
        ...row,
        referee_level: asText(row.referee_level),
        stage,
        groups: asText(row.groups),
        phone: asText(row.phone),
        last_feedback_at: asText(row.last_feedback_at),
        first_name: asText(row.first_name),
        last_name: asText(row.last_name),
        observations_count: summary.count,
        observation_status: summary,
      };
    });
    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.post('/api/coachees', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const data = req.body ?? {};
    const created = await withCollection(collectionCandidates.coachees, (collection) =>
      collection.create({
        full_name: asText(data.full_name),
        first_name: asText(data.first_name),
        last_name: asText(data.last_name),
        email: asText(data.email),
        phone: asText(data.phone),
        referee_level: asText(data.referee_level),
        stage: asText(data.stage) || 'active',
        groups: asText(data.groups),
        notes: asText(data.notes),
        season: data.season == null || data.season === '' ? null : Number(data.season),
        feedback_entries: Array.isArray(data.feedback_entries) ? data.feedback_entries : [],
      }),
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.put('/api/coachees/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    if ('full_name' in raw) payload.full_name = asText(raw.full_name);
    if ('first_name' in raw) payload.first_name = asText(raw.first_name);
    if ('last_name' in raw) payload.last_name = asText(raw.last_name);
    if ('email' in raw) payload.email = asText(raw.email);
    if ('phone' in raw) payload.phone = asText(raw.phone);
    if ('referee_level' in raw) payload.referee_level = asText(raw.referee_level);
    if ('stage' in raw) payload.stage = asText(raw.stage);
    if ('groups' in raw) payload.groups = asText(raw.groups);
    if ('notes' in raw) payload.notes = asText(raw.notes);
    if ('season' in raw) payload.season = raw.season == null || raw.season === '' ? null : Number(raw.season);
    if ('feedback_entries' in raw) payload.feedback_entries = raw.feedback_entries;
    const updated = await withCollection(collectionCandidates.coachees, (collection) =>
      collection.update(String(req.params.id), payload),
    );
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.delete('/api/coachees/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    await withCollection(collectionCandidates.coachees, (collection) =>
      collection.delete(String(req.params.id)),
    );
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/coachees/:id/games', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const coacheeId = asText(req.params.id);
    const coachee = await withCollection(collectionCandidates.coachees, (collection) =>
      collection.getOne<AnyRecord>(coacheeId),
    );
    const firstName = asText(coachee.first_name ?? coachee.vorname);
    const lastName = asText(coachee.last_name ?? coachee.nachname);
    const variants = new Set<string>([
      normalizeName(coachee.full_name),
      normalizeName(coachee.name),
      normalizeName(coachee.coachee_name),
      normalizeName(coachee.referee_name),
      normalizeName(`${firstName} ${lastName}`.trim()),
      normalizeName(`${lastName} ${firstName}`.trim()),
    ].filter(Boolean));

    const rawNames = [
      asText(coachee.full_name),
      asText(coachee.name),
      asText(coachee.coachee_name),
      asText(coachee.referee_name),
      `${firstName} ${lastName}`.trim(),
      `${lastName} ${firstName}`.trim(),
    ].filter(Boolean);
    const uniqueNames = [...new Set(rawNames)];

    const nameFilterParts = uniqueNames.flatMap((name) => {
      const escaped = escapeFilterValue(name);
      return [
        `first_referee = "${escaped}"`,
        `second_referee = "${escaped}"`,
        `first_line_judge = "${escaped}"`,
        `second_line_judge = "${escaped}"`,
      ];
    });

    // A coachee with no usable name anywhere leaves no filter at all, and
    // PocketBase reads an empty filter as "no filter" — so the endpoint answered
    // a nameless record with every game in the collection. Nothing to match on
    // means nothing matches.
    if (nameFilterParts.length === 0) { res.json([]); return; }

    const games = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date,-created',
        filter: nameFilterParts.join(' || '),
        fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,first_line_judge,second_line_judge,assigned_rc,assigned_rc_id,feedback_closed_roles,game_result,maps_url',
      }),
    );

    const starredIds = await getStarredGameIds();
    const result = games.map((game) => {
      const assigned = getAssignedPeopleFromGameRecord(game);
      const roleMap: Array<[string, string]> = [
        ['1. SR', assigned.firstReferee],
        ['2. SR', assigned.secondReferee],
        ['LJ1', assigned.firstLineJudge],
        ['LJ2', assigned.secondLineJudge],
      ];
      const assignedRoles = roleMap
        .filter((entry) => variants.has(normalizeName(entry[1])))
        .map((entry) => entry[0]);
      return {
        id: game.id,
        matchNo: asText(game.match_no),
        league: asText(game.league),
        date: asText(game.match_date),
        location: asText(game.location),
        homeTeam: asText(game.home_team),
        awayTeam: asText(game.away_team),
        firstReferee: assigned.firstReferee,
        secondReferee: assigned.secondReferee,
        firstLineJudge: assigned.firstLineJudge,
        secondLineJudge: assigned.secondLineJudge,
        assignedRoles,
        starred: starredIds.has(String(game.id)),
        // The client type has always promised these; without them the "already
        // taken by another RC" badge could never appear against the real API,
        // so two coaches could plan the same visit unaware of each other.
        assignedRc: asText(game.assigned_rc),
        feedbackClosedRoles: Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [],
        game_result: asText(game.game_result),
        maps_url: asText(game.maps_url),
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/coachees/:id/feedbacks', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const coacheeId = asText(req.params.id);
    const rows = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-submitted_at,-created',
        filter: `coachee = "${escapeFilterValue(coacheeId)}"`,
        expand: 'game,coachee',
      }),
    );
    // Scoped by coachee alone, this handed any RC every colleague's full
    // feedback_json — the written assessment, not just its existence. The
    // unfiltered view is the admin-gated /api/referee-coaches below; a plain RC
    // sees the ones they filed, the same rule /api/observations applies.
    const me = await sessionRcIdentity(req);
    res.json(me ? rows.filter((fb) => rcRefMatches(fb.rc_id, fb.rc_name, me)) : rows);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/referee-coaches', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const rows = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-submitted_at,-created',
        expand: 'game,coachee',
      }),
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/observations', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const filterParts: string[] = [];
    const coacheeId = asText(req.query.coacheeId);
    const gameId = asText(req.query.gameId);
    const refereeCoachId = asText(req.query.refereeCoachId);
    const promotion = asText(req.query.promotion);
    const motivation = asText(req.query.motivation);
    const coacheeFunction = asText(req.query.coacheeFunction);

    if (coacheeId) {
      filterParts.push(`coachee = "${escapeFilterValue(coacheeId)}"`);
    }
    if (gameId) {
      filterParts.push(`game = "${escapeFilterValue(gameId)}"`);
    }
    // A plain RC reads their own observations, whatever the query says. The
    // parameter was taken on trust, so any RC could hand over a colleague's id
    // and read their whole observation history, free-text remarks included —
    // the same trust /api/rc-overview/:rcName/coachees already refuses to place
    // in a URL. Admins keep the unrestricted view.
    const ownObservations = await sessionRcIdentity(req);
    if (ownObservations) {
      filterParts.push(`referee_coach = "${escapeFilterValue(ownObservations.rcId)}"`);
    } else if (refereeCoachId) {
      filterParts.push(`referee_coach = "${escapeFilterValue(refereeCoachId)}"`);
    }
    if (promotion) {
      filterParts.push(`promotion = "${escapeFilterValue(promotion)}"`);
    }
    if (motivation) {
      filterParts.push(`motivation = "${escapeFilterValue(motivation)}"`);
    }
    if (coacheeFunction) {
      filterParts.push(`coachee_function = "${escapeFilterValue(coacheeFunction)}"`);
    }

    const pageRaw = Number(req.query.page);
    const perPageRaw = Number(req.query.perPage);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 200) : 50;

    const result = await withCollection(collectionCandidates.observations, (collection) =>
      collection.getList<AnyRecord>(page, perPage, {
        sort: '-created',
        filter: filterParts.length > 0 ? filterParts.join(' && ') : undefined,
        expand: 'coachee,game,referee_coach',
      }),
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/observations/summary', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const coacheeId = asText(req.query.coacheeId);
    const gameId = asText(req.query.gameId);
    const filterParts: string[] = [];
    if (coacheeId) {
      filterParts.push(`coachee = "${escapeFilterValue(coacheeId)}"`);
    }
    if (gameId) {
      filterParts.push(`game = "${escapeFilterValue(gameId)}"`);
    }
    // Same rule as the list above: a plain RC's numbers are their own.
    const ownSummary = await sessionRcIdentity(req);
    if (ownSummary) {
      filterParts.push(`referee_coach = "${escapeFilterValue(ownSummary.rcId)}"`);
    }

    const filter = filterParts.length > 0 ? filterParts.join(' && ') : undefined;
    const gradeAverages: number[] = [];
    const byPromotion: Record<string, number> = {};
    const byMotivation: Record<string, number> = {};
    const byFunction: Record<string, number> = {};
    let totalObservations = 0;

    // Use getFullList to avoid 429 rate limiting from manual pagination
    const allObs = await withCollection(collectionCandidates.observations, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-created',
        filter,
        fields: 'grades,promotion,motivation,coachee_function',
        batch: 500,
      }),
    );
    for (const row of allObs) {
      totalObservations += 1;
      const avg = Number((row.grades as { average_score?: unknown } | undefined)?.average_score);
      if (Number.isFinite(avg)) {
        gradeAverages.push(avg);
      }
      const promotion = asText(row.promotion);
      if (promotion) {
        byPromotion[promotion] = (byPromotion[promotion] || 0) + 1;
      }
      const motivation = asText(row.motivation);
      if (motivation) {
        byMotivation[motivation] = (byMotivation[motivation] || 0) + 1;
      }
      const func = asText(row.coachee_function);
      if (func) {
        byFunction[func] = (byFunction[func] || 0) + 1;
      }
    }

    const averageGradeScore = gradeAverages.length > 0
      ? Math.round((gradeAverages.reduce((acc, value) => acc + value, 0) / gradeAverages.length) * 100) / 100
      : null;

    res.json({
      total_observations: totalObservations,
      average_grade_score: averageGradeScore,
      by_promotion: byPromotion,
      by_motivation: byMotivation,
      by_coachee_function: byFunction,
    });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.get('/api/games/calendar-status', requireRcSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const listCalendarGamesWithFallback = async () => {
      try {
        return await withCollection(collectionCandidates.games, (collection) =>
          collection.getFullList<AnyRecord>({
            sort: '-match_date',
            fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,first_line_judge,second_line_judge',
          }),
        );
      } catch (error) {
        if (!isPocketBaseBadRequest(error)) {
          throw error;
        }
        try {
          // Older schemas may not expose every projected field.
          // Retry without field projection for compatibility.
          return await withCollection(collectionCandidates.games, (collection) =>
            collection.getFullList<AnyRecord>({
              sort: '-match_date',
            }),
          );
        } catch (fallbackError) {
          if (!isPocketBaseBadRequest(fallbackError)) {
            throw fallbackError;
          }
          // Final compatibility fallback: avoid projection and sort constraints.
          return withCollection(collectionCandidates.games, (collection) =>
            collection.getFullList<AnyRecord>({}),
          );
        }
      }
    };

    let games: AnyRecord[] = [];
    let coachees: AnyRecord[] = [];
    let summaryById = new Map<string, CoacheeObservationSummary>();

    try {
      games = await listCalendarGamesWithFallback();
    } catch (error) {
      throw new Error(`calendar_status_stage:games_fetch failed: ${String(error)}`);
    }
    try {
      coachees = await listCoacheesWithFallbackSort();
    } catch (error) {
      throw new Error(`calendar_status_stage:coachees_fetch failed: ${String(error)}`);
    }
    try {
      summaryById = await getCoacheeObservationSummaryMap({ coachees });
    } catch (error) {
      throw new Error(`calendar_status_stage:observation_summary failed: ${String(error)}`);
    }

    const activeCoacheeByName = new Map<string, { id: string; full_name: string }>();
    for (const coachee of coachees) {
      if ((asText(coachee.stage) || 'active') === 'inactive') {
        continue;
      }
      const firstName = asText(coachee.first_name ?? coachee.vorname);
      const lastName = asText(coachee.last_name ?? coachee.nachname);
      const variants = [
        normalizeName(coachee.full_name),
        normalizeName(coachee.name),
        normalizeName(coachee.coachee_name),
        normalizeName(coachee.referee_name),
        normalizeName(`${firstName} ${lastName}`.trim()),
        normalizeName(`${lastName} ${firstName}`.trim()),
      ].filter(Boolean);
      for (const name of variants) {
        if (!activeCoacheeByName.has(name)) {
          activeCoacheeByName.set(name, { id: coachee.id, full_name: asText(coachee.full_name) });
        }
      }
    }

    const result = games.map((game) => {
      const assigned = getAssignedPeopleFromGameRecord(game);
      const assignedPeople = [
        assigned.firstReferee,
        assigned.secondReferee,
        assigned.firstLineJudge,
        assigned.secondLineJudge,
      ].filter(Boolean);

      const matchedCoachees = assignedPeople
        .map((name) => activeCoacheeByName.get(normalizeName(name)))
        .filter(Boolean) as Array<{ id: string; full_name: string }>;

      const statuses = matchedCoachees.map((coachee) => summaryById.get(coachee.id)).filter(Boolean) as CoacheeObservationSummary[];
      const hasOutstanding = statuses.some((status) => status.needsObservation);
      const hasCompleted = statuses.some((status) => status.hasCompletedObservation);

      return {
        id: game.id,
        matchNo: asText(game.match_no),
        league: asText(game.league),
        date: asText(game.match_date),
        location: asText(game.location),
        homeTeam: asText(game.home_team),
        awayTeam: asText(game.away_team),
        status: hasOutstanding ? 'outstanding' : hasCompleted ? 'completed' : 'none',
        hasOutstanding,
        hasCompleted,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// ── Calendar feed (iCal) ──────────────────────────────────────────────
// An RC subscribes once and the games they have taken — past and future — show
// up in whatever calendar they already live in. The feed is built from the live
// games table on request (behind the short cache below), so it never trails the
// nightly VolleyManager sync by more than a few minutes. How often a subscriber
// actually re-reads it is the calendar client's decision and not ours: Google
// and Apple both treat a publisher's refresh interval as a hint and poll on
// their own schedule. That is also why a plain download sits next to the
// subscription — a one-off file is the honest option for anyone who would
// rather not think about subscriptions at all.

const ICAL_TOKEN_VERSION = process.env.ICAL_TOKEN_VERSION || '1';
const ICAL_CACHE_TTL_MS = 5 * 60 * 1000;
// Nothing in the data says how long a match runs; two hours covers a five-set
// game and is the least surprising thing to see occupying a calendar slot.
const ICAL_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;

// The subscription URL carries no cookie, so the token in it IS the credential.
// It has to be stable — a URL that changed each time the dialog opened would
// silently strand every calendar already subscribed to the previous one — but
// it used to be derived from the RC's id ALONE, and that made it worse than a
// stable URL: it made it an unrevocable one.
//
// The hole that closes here: the team password is one secret everybody knows,
// so it gets rotated. Anyone holding it could pick any name off the picker,
// call /api/ical/me, and walk away with that coach's feed token — which then
// kept working forever, through the rotation, because nothing about it depended
// on the password it was obtained with. A credential you rotate turned into one
// you cannot. Deactivating the RC was the only revocation, and that locks the
// real coach out too.
//
// So the token now hangs off a per-person random secret kept in app_settings.
// Rotating the team password DROPS the whole map (see the credentials route),
// which is exactly right: you rotate because the old password is loose, and
// every feed handed out under it dies with it. A coach can also rotate just
// their own, and a fresh URL is one dialog away.
const ICAL_SECRETS_KEY = 'ical_secrets';
let icalSecretsCache: { data: Record<string, string>; expiresAt: number } | null = null;

async function readIcalSecrets(): Promise<Record<string, string>> {
  if (icalSecretsCache && icalSecretsCache.expiresAt > Date.now()) return icalSecretsCache.data;
  let data: Record<string, string> = {};
  try {
    const rec = await getSettingRecord(ICAL_SECRETS_KEY);
    const parsed = rec ? JSON.parse(asText(rec.value)) : {};
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, string>;
  } catch (error) {
    console.error('[ical] could not read feed secrets:', error);
  }
  icalSecretsCache = { data, expiresAt: Date.now() + 60 * 1000 };
  return data;
}

async function mutateIcalSecrets(mutate: (current: Record<string, string>) => Record<string, string>): Promise<void> {
  await withSettingLock(ICAL_SECRETS_KEY, async () => {
    let current: Record<string, string> = {};
    try {
      const rec = await getSettingRecord(ICAL_SECRETS_KEY);
      const parsed = rec ? JSON.parse(asText(rec.value)) : {};
      if (parsed && typeof parsed === 'object') current = parsed as Record<string, string>;
    } catch { current = {}; }
    await setSetting(ICAL_SECRETS_KEY, JSON.stringify(mutate(current)));
  });
  icalSecretsCache = null;
}

/** Every outstanding feed URL stops working. Called when the team password moves. */
async function revokeAllIcalFeeds(): Promise<void> {
  await mutateIcalSecrets(() => ({}));
}

function icalTokenFrom(rcId: string, secret: string): string {
  return createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`ical:v${ICAL_TOKEN_VERSION}:${rcId}:${secret}`)
    .digest('base64url');
}

// Minted on demand, and ONLY here — the lookup below never creates one, so
// probing /api/ical/<guess> cannot populate a secret for anybody.
async function issueIcalToken(rcId: string, rotate = false): Promise<string> {
  const existing = (await readIcalSecrets())[rcId];
  if (existing && !rotate) return icalTokenFrom(rcId, existing);
  const secret = randomBytes(24).toString('base64url');
  await mutateIcalSecrets((current) => ({ ...current, [rcId]: secret }));
  return icalTokenFrom(rcId, secret);
}

async function rcByIcalToken(token: string): Promise<ActiveRcPerson | null> {
  if (!token || token.length > 128) return null;
  const given = Buffer.from(token);
  const secrets = await readIcalSecrets();
  let found: ActiveRcPerson | null = null;
  for (const person of await getActiveRcPeople()) {
    const secret = secrets[person.id];
    // No secret means no feed was ever handed out for this person — and after a
    // revocation that is everyone, until they open the dialog again.
    if (!secret) continue;
    const expected = Buffer.from(icalTokenFrom(person.id, secret));
    // No early exit: every candidate is compared either way, so how long the
    // answer takes says nothing about which RC — or how many — nearly matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) found = person;
  }
  return found;
}

// match_date arrives in three shapes: an instant with a zone (VolleyManager),
// a bare wall-clock string, and a bare date (manually entered fixtures). Only
// the first is unambiguous — the other two mean local time to whoever wrote
// them, so they are read in the region's zone rather than in whatever zone the
// server happens to run in. VM_SYNC_TIMEZONE already names that zone for the
// cron schedules; a second setting could only drift out of step with it.
const ICAL_ZONED_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const ICAL_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ICAL_WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function localZoneOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: VM_SYNC_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second')) - instant;
}

// Wall clock in VM_SYNC_TIMEZONE -> the instant it names. Two passes, because
// the offset depends on the instant we are still solving for; the second pass
// settles the hours either side of a daylight-saving switch.
function wallClockToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  return naive - localZoneOffsetMs(naive - localZoneOffsetMs(naive));
}

// Deliberately flat rather than a `{allDay: true} | {allDay: false}` union:
// this tsconfig runs without strictNullChecks, and TypeScript will not narrow a
// false-valued discriminant there. `instant` is always the start; `date` is set
// only when the source gave a bare date and the event has no clock time.
type IcalMoment = { allDay: boolean; date: string; instant: number };

function icalMoment(value: string): IcalMoment | null {
  const text = asText(value);
  if (!text) return null;
  const dateOnly = ICAL_DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return { allDay: true, date: `${y}${mo}${d}`, instant: Date.UTC(+y, +mo - 1, +d) };
  }
  const timed = (instant: number): IcalMoment | null =>
    Number.isNaN(instant) ? null : { allDay: false, date: '', instant };
  if (ICAL_ZONED_RE.test(text)) {
    // PocketBase hands back "2026-03-21 14:00:00.000Z"; the T keeps that off
    // the engine's lenient fallback parser.
    return timed(new Date(text.replace(' ', 'T')).getTime());
  }
  const wall = ICAL_WALL_CLOCK_RE.exec(text);
  if (wall) {
    return timed(wallClockToInstant(+wall[1], +wall[2], +wall[3], +wall[4], +wall[5], Number(wall[6] || 0)));
  }
  return timed(new Date(text).getTime());
}

function icsStamp(instant: number): string {
  return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 caps a content line at 75 octets and continues it with CRLF + one
// space. The limit counts bytes, so folding walks back off any continuation
// byte rather than splitting a hall name mid-umlaut.
function icsFold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const chunks: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // a continuation line spends one octet on its leading space
  }
  return chunks.join('\r\n ');
}

type CalendarFeedGame = {
  id: string;
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  firstReferee: string;
  secondReferee: string;
  result: string;
  updated: string;
};

async function getGamesAssignedToRc(subject: RcAuthInfo): Promise<CalendarFeedGame[]> {
  if (!subject.rcId && !normalizeName(subject.name)) return [];
  await ensureAdminAuth();
  // Same shape as the other game reads: one full list, filtered in memory, so
  // PocketBase never sees a URI-length or rate-limit problem.
  const allGames = await (async () => {
    try {
      return await withCollection(collectionCandidates.games, (collection) =>
        collection.getFullList<AnyRecord>({
          sort: 'match_date',
          fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,assigned_rc_id,game_result,updated',
        }),
      );
    } catch (error) {
      if (!isPocketBaseBadRequest(error)) throw error;
      // Older schemas may not expose every projected field.
      return withCollection(collectionCandidates.games, (collection) =>
        collection.getFullList<AnyRecord>({}),
      );
    }
  })();

  return allGames
    .filter((game) => rcRefMatches(game.assigned_rc_id, game.assigned_rc, subject))
    .map((game) => ({
      id: String(game.id),
      matchNo: asText(game.match_no),
      league: asText(game.league),
      date: asText(game.match_date),
      location: asText(game.location),
      homeTeam: asText(game.home_team),
      awayTeam: asText(game.away_team),
      firstReferee: asText(game.first_referee),
      secondReferee: asText(game.second_referee),
      result: asText(game.game_result),
      updated: asText(game.updated),
    }));
}

type IcalLang = 'DE' | 'EN';

function buildRcCalendar(rcName: string, games: CalendarFeedGame[], lang: IcalLang): string {
  const de = lang === 'DE';
  const now = icsStamp(Date.now());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Swiss Volley Region Zürich//Referee Coaching//${lang}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`SVRZ RC – ${rcName}`)}`,
    `X-WR-CALDESC:${icsEscape(de ? 'Von dir übernommene Spiele (Referee Coaching)' : 'Games you have taken as referee coach')}`,
    `X-WR-TIMEZONE:${VM_SYNC_TIMEZONE}`,
    // Both spellings of the same request. Clients are free to ignore them, and
    // the popular ones do — this is a hint, never a guarantee.
    'X-PUBLISHED-TTL:PT12H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
  ];

  for (const game of games) {
    const moment = icalMoment(game.date);
    // An event with no placeable start is not an event. Dropping it beats
    // parking the game at the epoch in someone's calendar.
    if (!moment) continue;

    const teams = [game.homeTeam, game.awayTeam].filter(Boolean).join(' – ');
    const description = [
      [de ? 'Spiel' : 'Match', [game.matchNo, game.league].filter(Boolean).join(' · ')]
        .filter((part) => part).join(' '),
      game.firstReferee ? `${de ? '1. SR' : '1st ref'}: ${game.firstReferee}` : '',
      game.secondReferee ? `${de ? '2. SR' : '2nd ref'}: ${game.secondReferee}` : '',
      game.result ? `${de ? 'Resultat' : 'Result'}: ${game.result}` : '',
    ].filter(Boolean).join('\n');
    const modified = icalMoment(game.updated);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:game-${game.id}@svrz-rc`);
    // DTSTAMP tracks the record, not the render: re-serving an unchanged feed
    // must not look to a client like every event just changed.
    lines.push(`DTSTAMP:${modified ? icsStamp(modified.instant) : now}`);
    if (modified) lines.push(`LAST-MODIFIED:${icsStamp(modified.instant)}`);
    if (moment.allDay) {
      const dayAfter = new Date(moment.instant + 24 * 60 * 60 * 1000);
      lines.push(`DTSTART;VALUE=DATE:${moment.date}`);
      lines.push(`DTEND;VALUE=DATE:${dayAfter.toISOString().slice(0, 10).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART:${icsStamp(moment.instant)}`);
      lines.push(`DTEND:${icsStamp(moment.instant + ICAL_EVENT_DURATION_MS)}`);
    }
    lines.push(`SUMMARY:${icsEscape(`RC: ${teams || game.matchNo || (de ? 'Spiel' : 'Match')}`)}`);
    if (game.location) lines.push(`LOCATION:${icsEscape(game.location)}`);
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    lines.push(`URL:${icsEscape(MAIL_APP_URL)}`);
    lines.push('CATEGORIES:SVRZ Referee Coaching');
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(icsFold).join('\r\n')}\r\n`;
}

// A subscription URL is public and polled by machines. Without this, every poll
// would drag the whole games collection out of PocketBase. Five minutes is far
// below any client's refresh interval, so nobody sees a staler feed than they
// would have anyway — and the one moment the set really does change, taking or
// giving back a game, drops the cache outright rather than waiting it out.
// Cached as the game list, not as the rendered body, so the count the dialog
// shows and the events the file contains can never disagree.
const icalGamesCache = new Map<string, { games: CalendarFeedGame[]; expiresAt: number }>();

async function getCachedGamesForRc(person: ActiveRcPerson): Promise<CalendarFeedGame[]> {
  const cached = icalGamesCache.get(person.id);
  if (cached && cached.expiresAt > Date.now()) return cached.games;
  const games = await getGamesAssignedToRc({ rcId: person.id, name: person.fullName });
  icalGamesCache.set(person.id, { games, expiresAt: Date.now() + ICAL_CACHE_TTL_MS });
  return games;
}

// The URL has to be absolute and has to be the one the outside world can reach:
// a calendar client fetches it from anywhere except here.
function publicApiBase(req: Request): string {
  const configured = asText(process.env.API_PUBLIC_URL);
  if (configured) return configured.replace(/\/+$/, '');
  const forwardedProto = asText(req.headers['x-forwarded-proto']).split(',')[0].trim();
  const forwardedHost = asText(req.headers['x-forwarded-host']).split(',')[0].trim();
  return `${forwardedProto || req.protocol || 'https'}://${forwardedHost || asText(req.headers.host)}`;
}

function icalFileSlug(name: string): string {
  const slug = normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug ? `svrz-rc-${slug}` : 'svrz-rc';
}

app.get('/api/ical/me', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    const session = verifyRcSession(req);
    // A pure admin-console session has no RC record behind it, so there is no
    // "my games" to hand out: the feed belongs to a person, not to a role.
    const person = session.rcId ? (await getActiveRcPeople()).find((p) => p.id === session.rcId) : undefined;
    if (!person) {
      res.status(403).json({ error: 'Kalender-Abo gibt es nur für angemeldete RC.' });
      return;
    }
    const lang: IcalLang = asText(req.query.lang).toUpperCase() === 'EN' ? 'EN' : 'DE';
    const base = publicApiBase(req);
    // `rotate=1` is the "my link leaked / I handed my phone on" button: it mints
    // a new secret, so the URL every previously-subscribed calendar holds stops
    // resolving. Anything else reuses the standing one, which is what keeps a
    // working subscription working.
    const rotate = asText(req.query.rotate) === '1';
    if (rotate) log.info('ical.rotate', 'feed link regenerated', { rcId: person.id, name: person.fullName }, reqCtx(req));
    const path = `/api/ical/${await issueIcalToken(person.id, rotate)}.ics?lang=${lang.toLowerCase()}`;
    res.json({
      name: person.fullName,
      count: (await getCachedGamesForRc(person)).length,
      url: `${base}${path}`,
      // webcal:// is what makes a phone or desktop offer "subscribe" instead of
      // downloading the file once and never looking at it again.
      webcalUrl: `${base.replace(/^https?:/i, 'webcal:')}${path}`,
      downloadUrl: `${base}${path}&download=1`,
    });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// Public by design — a calendar client cannot log in. The token is the whole
// gate, which is why it is unguessable and why the request log redacts it.
app.get('/api/ical/:token', async (req: Request, res: ExpressResponse) => {
  try {
    const person = await rcByIcalToken(String(req.params.token || '').replace(/\.ics$/i, ''));
    if (!person) {
      res.status(404).type('text/plain').send('Unknown calendar.');
      return;
    }
    const lang: IcalLang = asText(req.query.lang).toUpperCase() === 'EN' ? 'EN' : 'DE';
    const body = buildRcCalendar(person.fullName, await getCachedGamesForRc(person), lang);
    const disposition = asText(req.query.download) === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `${disposition}; filename="${icalFileSlug(person.fullName)}.ics"`);
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.send(body);
  } catch (error) {
    log.error('ical.feed', 'Calendar feed failed', { error });
    // Calendar clients retry on 5xx and give up on a malformed body, so an
    // error must not come back dressed as JSON under a text/calendar promise.
    res.status(503).type('text/plain').send('Calendar temporarily unavailable.');
  }
});

app.post('/api/referee-coaches', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const b = (req.body ?? {}) as Record<string, unknown>;
    const created = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.create({
        game: asText(b.game), coachee: asText(b.coachee), rc_name: asText(b.rc_name),
        role_assessed: asText(b.role_assessed), feedback_json: b.feedback_json ?? {},
        submitted_at: asText(b.submitted_at),
      }),
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.put('/api/referee-coaches/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const b = (req.body ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    for (const k of ['game', 'coachee', 'rc_name', 'role_assessed', 'submitted_at'] as const) if (k in b) payload[k] = asText(b[k]);
    if ('feedback_json' in b) payload.feedback_json = b.feedback_json;
    const updated = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.update(String(req.params.id), payload),
    );
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.delete('/api/referee-coaches/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  const feedbackId = String(req.params.id);
  try {
    await ensureAdminAuth();
    // Read the record first: a submit writes four things together — the feedback
    // row, the game's closed-role flag, an observation, and an entry on the
    // coachee — and deleting only the row left the other three behind. The game
    // then showed the role as filed with nothing to open, and the coachee's
    // history counted a feedback that was gone.
    let record: AnyRecord | null = null;
    try {
      record = await withCollection(collectionCandidates.refereeCoaches, (c) =>
        c.getOne<AnyRecord>(feedbackId));
    } catch (readErr) {
      if (!isRecordNotFound(readErr)) throw readErr;
    }
    if (!record) { res.status(404).json({ error: 'Feedback not found' }); return; }

    const gameId = asText(record.game);
    const coacheeId = asText(record.coachee);
    const role = asText(record.role_assessed);

    await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.delete(feedbackId),
    );

    // Reopen the role — under the game lock, so it can't race a concurrent
    // submit for the same game.
    if (gameId && role) {
      try {
        await withGameLock(gameId, async () => {
          const game = await withCollection(collectionCandidates.games, (c) => c.getOne<AnyRecord>(gameId));
          const closed: string[] = Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [];
          if (closed.includes(role)) {
            await withCollection(collectionCandidates.games, (c) =>
              c.update(gameId, { feedback_closed_roles: closed.filter((r) => r !== role) }));
          }
        });
      } catch (e) { log.error('feedback.delete', 'reopen role failed', { feedbackId, gameId, role, error: String(e) }); }
    }

    // Drop the coachee's history entry that pointed at this feedback.
    if (coacheeId) {
      try {
        const coachee = await withCollection(collectionCandidates.coachees, (c) => c.getOne<AnyRecord>(coacheeId));
        const entries = Array.isArray(coachee.feedback_entries) ? coachee.feedback_entries as AnyRecord[] : [];
        const kept = entries.filter((e) => asText((e as AnyRecord).referee_coaches_id) !== feedbackId);
        if (kept.length !== entries.length) {
          await withCollection(collectionCandidates.coachees, (c) => c.update(coacheeId, { feedback_entries: kept }));
        }
      } catch (e) { log.error('feedback.delete', 'coachee entry cleanup failed', { feedbackId, coacheeId, error: String(e) }); }
    }

    // Delete the observation filed alongside — matched on the same game+coachee.
    if (gameId && coacheeId) {
      try {
        const obs = await withCollection(collectionCandidates.observations, (c) =>
          c.getFullList<AnyRecord>({ filter: `game = "${escapeFilterValue(gameId)}" && coachee = "${escapeFilterValue(coacheeId)}"` }));
        for (const o of obs) await withCollection(collectionCandidates.observations, (c) => c.delete(o.id));
      } catch (e) { log.error('feedback.delete', 'observation cleanup failed', { feedbackId, gameId, coacheeId, error: String(e) }); }
    }

    // The private note hangs off this feedback by id; left behind it would show
    // the president a note about a game that no longer exists, forever.
    try { await deletePresidentNote(feedbackId); }
    catch (noteErr) { log.error('feedback.delete', 'president-note cleanup failed', { feedbackId, error: String(noteErr) }); }
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// A scanned paper form may be a phone photo, not a PDF (the upload accepts
// ".pdf,image/*"). Declaring a JPEG as application/pdf makes mail clients
// refuse to preview the coachee's own feedback, so read the type off the bytes.
function sniffAttachmentType(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (buffer.length >= 4 && buffer.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && buffer.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 12) === 'ftypheic') return 'image/heic';
  return 'application/octet-stream';
}

const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
};

// Keep the extension honest too — a .pdf name on JPEG bytes fails the same way
// the wrong MIME type does.
// The filename is derived from the sniffed type, never trusted from the client.
// An unrecognised type used to fall through to application/octet-stream and then
// return the caller's name untouched, so a coach session could have an
// SPF/DKIM-aligned SVRZ mail deliver "SVRZ-Bericht.pdf.html" to a referee. The
// submit route now refuses anything that is not a known type, so `ext` is always
// present; the base name is stripped of any path and of its own extension.
function attachmentFilename(filename: string, contentType: string): string {
  const ext = ATTACHMENT_EXTENSIONS[contentType] || 'pdf';
  const base = String(filename || 'feedback')
    .split(/[/\\]/).pop()!            // no directory components
    .replace(/\.[^.]+$/, '')           // no caller-chosen extension
    .replace(/[^\w.\- ]+/g, '_')       // no quotes, CR/LF or control characters
    .slice(0, 120)
    .trim() || 'feedback';
  return `${base}.${ext}`;
}

// A submit that reached the server but whose response was lost gets replayed
// from the offline outbox. Roles that close are protected by the 409 guard, but
// a "second visit needed" submission closes nothing — so remember what was
// filed recently and answer a replay with the original outcome instead of
// creating a second record and mailing the coachee twice.
const RECENT_SUBMIT_TTL_MS = 30 * 60 * 1000;

// The only roles a feedback can be filed for.
const FEEDBACK_ROLES = ['1. SR', '2. SR'];

// nodemailer parses a header value as an address LIST, so one stored
// "referee@svrz.ch, someone@else" silently delivers the coaching report — full
// PDF, grades and remarks — to a second mailbox, and the sender sees a normal
// "sent". Addresses arrive from the xlsx import, the admin editor and
// VolleyManager's contact sync, none of which check the shape. Anything that is
// not exactly one address is treated as no address at all.
const SINGLE_EMAIL_RE = /^[^\s@,;:<>"]+@[^\s@,;:<>"]+\.[^\s@,;:<>"]+$/;
function singleAddress(value: unknown): string {
  const v = asText(value).trim();
  return SINGLE_EMAIL_RE.test(v) ? v : '';
}

// An exact replay of one outbox item, however long ago it was written. The
// 30-minute window below cannot see this case: a connection dropped AFTER the
// server committed leaves the client believing it never sent, and the item then
// waits for the next flush — commonly the following morning, since the only
// triggers are the `online` event, mount and the manual button. Same game, same
// role, hours apart is also exactly what a legitimate second visit looks like,
// so nothing but the key can tell them apart. Without it the referee received a
// second full report and PDF, and the chair's statistics counted the visit twice.
async function findSubmissionByKey(submissionKey: string): Promise<string> {
  if (!submissionKey) return '';
  try {
    const hit = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFirstListItem<AnyRecord>(
        `submission_key = "${escapeFilterValue(submissionKey)}"`,
        { fields: 'id' },
      ));
    return hit.id;
  } catch (error) {
    if (isRecordNotFound(error)) return '';
    console.error('[feedback-submit] submission-key lookup failed:', error);
    return '';
  }
}

async function findRecentSubmission(gameId: string, role: string): Promise<string> {
  const since = new Date(Date.now() - RECENT_SUBMIT_TTL_MS).toISOString();
  try {
    const hit = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFirstListItem<AnyRecord>(
        `game = "${escapeFilterValue(gameId)}" && role_assessed = "${escapeFilterValue(role)}" && submitted_at >= "${escapeFilterValue(since)}"`,
        { fields: 'id', sort: '-submitted_at' },
      ));
    return hit.id;
  } catch (error) {
    if (isRecordNotFound(error)) return '';
    // Never let the duplicate check itself block a legitimate submission.
    console.error('[feedback-submit] duplicate lookup failed:', error);
    return '';
  }
}

app.post('/api/feedback/submit', requireRcSession, async (req: Request, res: ExpressResponse) => {
  const { gameId, role, formData, pdfBase64, pdfFilename, tipsAndTricks, submissionKey } = req.body ?? {};

  // Phase 1 — Validation
  if (!gameId || !role || !formData || !pdfBase64) {
    res.status(400).json({ error: 'gameId, role, formData and pdfBase64 are required.' });
    return;
  }
  // formData must be a plain object — otherwise the identity override below is
  // silently skipped and the stored rc_name would disagree with the observation.
  if (typeof formData !== 'object' || Array.isArray(formData)) {
    res.status(400).json({ error: 'formData must be an object.' });
    return;
  }
  // Only the two real roles. Everything downstream treats "not 1. SR" as the
  // second referee and the closure guard only knows the roles already filed, so
  // an unrecognised role passed both: each new spelling filed another record,
  // another observation into the chair's statistics, and another mail to the
  // referee, with the submit-once 409 never firing.
  if (!FEEDBACK_ROLES.includes(String(role))) {
    res.status(400).json({ error: 'role must be "1. SR" or "2. SR".' });
    return;
  }

  // Validate PDF size (3MB decoded limit)
  const pdfBuffer = Buffer.from(String(pdfBase64), 'base64');
  if (pdfBuffer.length > 3 * 1024 * 1024) {
    res.status(400).json({ error: 'PDF exceeds 3MB size limit.' });
    return;
  }

  // Everything below reads the game, decides, and writes the decision back.
  // Without the lock two submits for the same game — one per role, or an
  // outbox replay racing the original — each check the same stale snapshot and
  // the later write drops the earlier role's closure.
  const releaseGame = await acquireGameLock(String(gameId));
  try {
    await ensureAdminAuth();

    // RC sessions submit under their own identity — the client-supplied RC
    // name is overridden so rc_name, the observation link, and the email all
    // carry the authenticated coach. Admin sessions may pass any name.
    const rcAuth = rcAuthByReq.get(req);
    if (rcAuth) {
      formData.meta = { ...(formData.meta ?? {}), rc: rcAuth.name };
    }

    // Fetch game and check closure
    const game = await withCollection(collectionCandidates.games, (collection) =>
      collection.getOne<AnyRecord>(String(gameId)),
    );

    // Ownership: a plain RC may only submit for a game that is unassigned or
    // already assigned to them — not one another RC has taken. This mirrors the
    // take/give-back allocation model and prevents locking out the rightful RC
    // (a submit closes the role) or emailing the coachee under a wrong RC.
    if (rcAuth
      && rcRefPresent(game.assigned_rc_id, game.assigned_rc)
      && !rcRefMatches(game.assigned_rc_id, game.assigned_rc, rcAuth)) {
      res.status(403).json({ error: 'Dieses Spiel ist einem anderen RC zugewiesen.' });
      return;
    }

    const closedRoles: string[] = Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [];
    if (closedRoles.includes(String(role))) {
      res.status(409).json({ error: `Feedback for role "${role}" has already been submitted for this game.` });
      return;
    }

    // A "second visit needed" submission deliberately leaves the role open, so
    // the 409 above cannot catch a replay of it. A genuine second observation
    // is days or weeks later, never minutes — anything inside the window is the
    // same submission arriving twice.
    // Exact first: a replayed outbox item is the same submission no matter how
    // much time has passed, and answering 409 is what makes the client drop it.
    const replayed = await findSubmissionByKey(asText(submissionKey));
    if (replayed) {
      res.status(409).json({
        error: `Feedback for role "${role}" was already submitted for this game.`,
        id: replayed,
      });
      return;
    }

    const recentDuplicate = await findRecentSubmission(String(game.id), String(role));
    if (recentDuplicate) {
      res.status(409).json({
        error: `Feedback for role "${role}" was already submitted for this game.`,
        id: recentDuplicate,
      });
      return;
    }

    // Resolve coachee and validate email
    const refereeName = role === '1. SR' ? asText(game.first_referee) : asText(game.second_referee);

    // The report says who it is about; the recipient is derived from the game
    // slot. Nothing tied the two together: meta.srName is a freely editable
    // field the server never read, so filing under the wrong role — the manual
    // upload dialog defaults its role select to "1. SR" — mailed one coachee's
    // complete written assessment to the other referee on the same match, and
    // recorded the observation against them too. The coach's OWN name was
    // already protected on both sides (readOnly in the UI, overridden above);
    // the person being assessed had neither guard.
    //
    // Compared both name orders, because the XLSX and VolleyManager disagree on
    // which comes first and nothing downstream knows which one it is holding.
    const claimedName = asText((formData.meta as AnyRecord | undefined)?.srName);
    if (refereeName && claimedName && !nameKeyVariants(claimedName).includes(normalizeName(refereeName))) {
      res.status(422).json({
        error: `Das Feedback ist auf "${claimedName}" ausgestellt, aber für die Rolle "${role}" ist in diesem Spiel "${refereeName}" eingetragen. Bitte Rolle oder Schiedsrichter korrigieren.`,
      });
      return;
    }

    if (!refereeName) {
      // A fixable data problem, not a server fault: as a 500 the outbox would
      // retry it forever instead of telling the coach what to correct.
      res.status(422).json({ error: `Im Spiel ist für die Rolle "${role}" kein Schiedsrichter eingetragen.` });
      return;
    }

    let coacheeResult: { collection: ReturnType<typeof pb.collection>; coachee: AnyRecord };
    try {
      // Season comes from the GAME, not from whatever the console has selected.
      coacheeResult = await findCoacheeRecord(refereeName, seasonOfDate(asText(game.match_date)));
    } catch (lookupError) {
      // The referee simply isn't on the coachee list — someone has to add them.
      // Answered as a 500 this looked like a server fault and the offline
      // outbox retried it forever instead of surfacing the fix.
      if (!isRecordNotFound(lookupError)) throw lookupError;
      res.status(422).json({ error: `"${refereeName}" ist nicht als Coachee erfasst. Bitte im Admin-Bereich anlegen.` });
      return;
    }
    const coachee = coacheeResult.coachee;
    const coacheeCollection = coacheeResult.collection;

    const coacheeEmail = singleAddress(coachee.email);
    if (!coacheeEmail) {
      res.status(400).json({
        error: asText(coachee.email)
          ? 'Die E-Mail-Adresse des Coachees ist ungültig (genau eine Adresse erwartet). Bitte im Admin-Panel korrigieren.'
          : 'Coachee has no email address. Add an email in the admin panel before submitting feedback.',
      });
      return;
    }

    // Phase 2 — Save (existing logic)
    const submittedAt = new Date().toISOString();
    const refereeCoachPersonId = rcAuth
      ? rcAuth.rcId
      : await resolveRefereeCoachPersonId(asText(formData.meta?.rc));

    const created = await withCollection<AnyRecord>(collectionCandidates.refereeCoaches, (collection) =>
      collection.create({
        game: game.id,
        coachee: coachee.id,
        rc_name: asText(formData.meta?.rc),
        // Same identity the observation is linked to, one line up: the session's
        // own id for an RC submit, the resolved name for an admin's.
        rc_id: refereeCoachPersonId,
        role_assessed: String(role),
        feedback_json: formData,
        submitted_at: submittedAt,
        // Empty for an online submit; set for anything that came through the
        // offline outbox, so a later replay of the same item is recognised.
        submission_key: asText(submissionKey),
      }),
    );

    // From here the feedback record exists but is not yet complete. If any of
    // the follow-up writes fails the whole set is undone before answering: an
    // abandoned half-record survives every outbox retry, so without this each
    // attempt leaves behind one more PDF-less feedback and observation.
    const attachmentType = sniffAttachmentType(pdfBuffer);
    // Only the types the report can legitimately be. Falling through to
    // application/octet-stream let an insider mail arbitrary bytes from the
    // official address under a name of their choosing.
    if (!(attachmentType in ATTACHMENT_EXTENSIONS)) {
      res.status(422).json({ error: 'Der Anhang ist kein PDF oder Bild.' });
      return;
    }
    const attachmentName = attachmentFilename(String(pdfFilename || 'feedback.pdf'), attachmentType);
    const priorEntries = Array.isArray(coachee.feedback_entries) ? coachee.feedback_entries : [];
    let observationId = '';
    try {
      await coacheeCollection.update(coachee.id, {
        feedback_entries: [
          ...priorEntries,
          {
            referee_coaches_id: created.id,
            game_id: game.id,
            submitted_at: submittedAt,
            role_assessed: role,
          },
        ],
        last_feedback_at: submittedAt,
      });

      const grades = buildGradesPayload(formData);
      const observationPayload: Record<string, unknown> = {
        coachee: coachee.id,
        referee_coach: refereeCoachPersonId,
        game: game.id,
        coachee_function: mapCoacheeFunction(role),
        grades,
        remarks: asText(formData.results?.bemerkungen),
      };

      const gameLevel = mapGameLevel(formData.results?.spielniveau);
      if (gameLevel) observationPayload.game_level = gameLevel;
      const promotion = mapPromotion(formData.results?.einstufung);
      if (promotion) observationPayload.promotion = promotion;
      const motivation = mapMotivation(formData.results?.motivation);
      if (motivation) observationPayload.motivation = motivation;
      const srGoal = mapSrGoal(formData.results?.srZiel);
      if (srGoal) observationPayload.sr_goal = srGoal;
      const gameResult = asText(formData.results?.einstufung);
      if (gameResult) observationPayload.game_result = gameResult;
      observationPayload.second_observation = asBoolean(formData.results?.secondBesuch, false);

      const observation = await withCollection<AnyRecord>(collectionCandidates.observations, (collection) =>
        collection.create(observationPayload),
      );
      observationId = observation.id;

      // Upload the filed document to the feedback record. A manual upload may
      // be a phone photo of a paper form, so the type comes from the bytes.
      const pdfFormData = new FormData();
      pdfFormData.append('pdf_file', new Blob([pdfBuffer], { type: attachmentType }), attachmentName);
      await withCollection(collectionCandidates.refereeCoaches, (collection) =>
        collection.update(created.id, pdfFormData),
      );
    } catch (writeError) {
      // Undo the half-written set so an outbox replay re-files cleanly instead
      // of stacking orphans. The coachee entry is RECOMPUTED (drop this
      // feedback's id) rather than restored from the pre-read snapshot: another
      // request may have appended to feedback_entries in between, and writing
      // the stale array back would erase that. If any undo step fails the
      // feedback row is deliberately LEFT — the replay then 409s on it rather
      // than creating a duplicate — and every failure is logged to the Protokoll.
      let rollbackClean = true;
      if (observationId) {
        try { await withCollection(collectionCandidates.observations, (c) => c.delete(observationId)); }
        catch (e) { rollbackClean = false; log.error('feedback.submit', 'rollback: observation delete failed', { feedbackId: created.id, observationId, error: String(e) }); }
      }
      try {
        const fresh = await withCollection(collectionCandidates.coachees, (c) => c.getOne<AnyRecord>(coachee.id));
        const cur = Array.isArray(fresh.feedback_entries) ? fresh.feedback_entries as AnyRecord[] : [];
        await coacheeCollection.update(coachee.id, {
          feedback_entries: cur.filter((e) => asText((e as AnyRecord).referee_coaches_id) !== created.id),
        });
      } catch (e) { rollbackClean = false; log.error('feedback.submit', 'rollback: coachee entry cleanup failed', { feedbackId: created.id, coacheeId: coachee.id, error: String(e) }); }
      if (rollbackClean) {
        try { await withCollection(collectionCandidates.refereeCoaches, (c) => c.delete(created.id)); }
        catch (e) { log.error('feedback.submit', 'rollback: feedback delete failed', { feedbackId: created.id, error: String(e) }); }
      } else {
        log.warn('feedback.submit', 'partial rollback — feedback row kept so a replay 409s instead of duplicating', { feedbackId: created.id });
      }
      throw writeError;
    }

    // Phase 3 — Email (best-effort)
    let emailSent = false;
    let emailError: string | null = null;
    let emailWarning: string | null = null;

    try {
      // Resolve RC email
      let rcEmail = '';
      try {
        const rcPerson = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
          collection.getOne<AnyRecord>(refereeCoachPersonId),
        );
        rcEmail = singleAddress(rcPerson.email);
      } catch {
        // RC person fetch failed — continue without RC email
      }

      if (!rcEmail) {
        emailWarning = 'RC has no email, sent without RC in CC';
      }

      // dd.MM.yyyy in the region's zone — the container runs UTC, which would
      // date a late-evening game to the day before.
      const matchDate = asText(game.match_date);
      const formattedDate = matchDate ? fmtDateDe(matchDate) : matchDate;

      const matchNo = asText(game.match_no);
      // Our own survey page, not a Google Form: one token per visit, so the
      // page can prefill the match details without putting them in the link.
      // An empty token (mint failed) simply drops the button from the mail.
      const surveyToken = await createSurveyToken({
        referee: refereeName,
        date: formattedDate,
        matchNo,
        rc: asText(formData.meta?.rc),
      });
      const surveyUrl = surveyToken ? `${MAIL_APP_URL}#/survey/${surveyToken}` : '';
      const feedbackTpl = await getEmailTemplate('feedback');
      // Rendered twice on purpose — see the two-message send below. The survey
      // token is a capability: whoever holds it can answer, once, as the
      // referee. It must not travel to anyone else.
      const renderFeedbackMail = (linkForThisCopy: string) => buildTemplatedEmail({
        tpl: feedbackTpl,
        vars: emailVars({
          refereeName,
          rcName: asText(formData.meta?.rc),
          matchNo,
          league: asText(game.league),
          date: formattedDate,
          time: fmtTimeDe(asText(game.match_date)),
          location: asText(game.location),
          homeTeam: asText(game.home_team),
          awayTeam: asText(game.away_team),
          role: String(role),
        }),
        rows: [
          ['Spiel Nr.', matchNo],
          ['Liga', asText(game.league)],
          ['Datum', formattedDate],
          ['Ort', asText(game.location)],
          ['Mannschaften', `${asText(game.home_team)} vs ${asText(game.away_team)}`],
          ['Beurteilte Rolle', String(role)],
          ['Referee Coach', asText(formData.meta?.rc)],
        ],
        tips: String(tipsAndTricks || ''),
        surveyUrl: linkForThisCopy,
        footerNote: 'Der vollständige Coaching-Feedback-Bericht ist als PDF angehängt.',
      });
      const built = renderFeedbackMail(surveyUrl);
      // The copy for everyone who is not the referee. Identical but for the link.
      const builtForCopies = surveyUrl ? renderFeedbackMail('') : built;
      const subject = built.subject;

      const isTestMode = process.env.FEEDBACK_EMAIL_TEST === '1';
      const testRecipient = process.env.FEEDBACK_TEST_RECIPIENT || '';

      // Asking for test mode and forgetting the recipient used to deliver the
      // test feedback to the real referee, the real RC and the commission —
      // the exact opposite of the request. Suppress loudly instead, the way the
      // survey notification already does.
      const misconfiguredTestMode = isTestMode && !testRecipient;
      if (misconfiguredTestMode) {
        console.warn('[feedback-email] FEEDBACK_EMAIL_TEST=1 without FEEDBACK_TEST_RECIPIENT — email suppressed.');
        emailWarning = 'FEEDBACK_EMAIL_TEST ist gesetzt, FEEDBACK_TEST_RECIPIENT fehlt — keine E-Mail gesendet.';
      }

      let mailTo: string;
      let mailCc: string[] | undefined;
      let mailBcc: string[] | undefined;
      let mailSubject: string;

      if (isTestMode && testRecipient) {
        // Test mode: redirect all emails to test recipient, no CC/BCC
        mailTo = testRecipient;
        mailCc = undefined;
        mailBcc = undefined;
        mailSubject = `[TEST] ${subject}`;
        console.log(`[feedback-email] TEST MODE: redirecting email from ${coacheeEmail} to ${testRecipient}`);
      } else {
        mailTo = coacheeEmail;
        // RC email in CC
        const ccList = rcEmail ? [rcEmail] : [];
        mailCc = ccList.length > 0 ? ccList : undefined;
        // Coaching address(es) (FEEDBACK_CC) in BCC. Comma-separated, so the
        // report can reach more than one mailbox — e.g. the coaching inbox and
        // the RC commission — without a code change.
        const bccList = asText(process.env.FEEDBACK_CC).split(',').map((e) => e.trim()).filter(Boolean);
        mailBcc = bccList.length > 0 ? bccList : undefined;
        mailSubject = subject;
      }

      const emailTestMode = await isEmailTestMode();
      if (emailTestMode || misconfiguredTestMode) {
        if (emailTestMode) console.log(`[feedback-email] TEST_MODE — outbound email suppressed (would send to ${mailTo})`);
        emailSent = false;
      } else {
        const attachments = emailAttachments([{
          filename: attachmentName,
          content: pdfBuffer,
          contentType: attachmentType,
        }]);
        // TWO messages, not one with Cc. The survey link is a one-shot
        // capability to answer AS the referee, and the RC in Cc is by
        // construction the very person that survey assesses — the button sat in
        // her own inbox. One click (curiosity is enough, malice not required)
        // burns the referee's token, the chair reads her answer as his, and his
        // genuine attempt then gets a 409. Merely opening the link also reveals
        // whether he has answered yet.
        await sendMailResilient({
          from: MAIL_FROM,
          replyTo: rcEmail || undefined,
          to: mailTo,
          subject: mailSubject,
          html: built.html,
          text: built.text,
          attachments,
        });
        // The referee has their report; a failure below must not report
        // otherwise.
        emailSent = true;

        const copyRecipients = [...(mailCc ?? []), ...(mailBcc ?? [])];
        if (copyRecipients.length > 0) {
          await sendMailResilient({
            from: MAIL_FROM,
            replyTo: rcEmail || undefined,
            to: copyRecipients,
            subject: mailSubject,
            html: builtForCopies.html,
            text: builtForCopies.text,
            attachments,
          });
        }
      }
    } catch (emailErr) {
      emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
      console.error('[feedback-email] Failed to send:', emailError);
    }

    // Phase 4 — Closure. closedRoles was read inside the game lock, so the
    // other role's closure cannot have landed in between.
    const gamePatch: Record<string, unknown> = {};
    if (formData.results?.secondBesuch !== 'Y') {
      gamePatch.feedback_closed_roles = [...closedRoles, String(role)];
    }
    // The score belongs to the match, not to the referee being observed, so the
    // coach who files the other role — possibly weeks later, from a different
    // session — should not have to type it in again. Keep whatever this form
    // carries: it is either filling the gap VolleyManager has not published yet,
    // or a deliberate correction (the field is read-only until unlocked). A
    // later sync re-asserts VolleyManager's own score if it ever has one.
    const typedResult = asText(formData.meta?.ergebnis);
    if (typedResult && typedResult !== asText(game.game_result)) {
      gamePatch.game_result = typedResult;
    }
    let closureFailed = false;
    if (Object.keys(gamePatch).length > 0) {
      // Retry a couple of times: this write closes the role and stores the typed
      // score. If it silently fails the role stays open — a second, duplicate
      // observation can be filed — and the score the coach typed is lost. So
      // report the failure to the client and log it to the Protokoll rather than
      // answering a clean 201 over a game left half-updated.
      for (let attempt = 1; attempt <= 3 && !closureFailed; attempt++) {
        try {
          await withCollection(collectionCandidates.games, (collection) =>
            collection.update(game.id, gamePatch),
          );
          // Missing break: every successful submit issued this write THREE
          // times, on the slowest request in the app, and a success followed by
          // two failures logged "closure write failed" about a closure that had
          // in fact landed.
          break;
        } catch (closeErr) {
          if (attempt === 3) {
            closureFailed = true;
            log.error('feedback.submit', 'closure write failed after retries — role may stay open', { feedbackId: created.id, gameId: game.id, role, error: String(closeErr) });
          }
        }
      }
    }

    // Phase 5 — Response
    res.status(201).json({
      id: created.id,
      emailSent,
      emailError,
      emailWarning,
      closureFailed,
    });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  } finally {
    releaseGame();
  }
});

// One-time migration: extract line judge names from source_payload, then clear it
// One-time backfill: fill assigned_rc_id / rc_id on rows written while the RC
// was identified by display name alone. Idempotent and safe to re-run — it only
// ever fills a blank id, never rewrites one, and never touches the names. Rows
// whose name matches no active RC are reported as `unresolved` and left as they
// are: the name fallback still serves them, and guessing would be worse.
app.post('/api/admin/migrate-rc-ids', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const people = await getActiveRcPeople();
    const idByName = new Map<string, string>();
    for (const p of people) {
      const key = normalizeName(p.fullName);
      // A name shared by two active RCs is exactly the ambiguity the id exists
      // to remove — refuse to guess which one owns the row.
      if (key) idByName.set(key, idByName.has(key) ? '' : p.id);
    }

    const backfill = async (
      collection: string[],
      idField: 'assigned_rc_id' | 'rc_id',
      nameField: 'assigned_rc' | 'rc_name',
    ) => {
      const rows = await withCollection(collection, (c) =>
        c.getFullList<AnyRecord>({ fields: `id,${idField},${nameField}` }));
      let filled = 0, already = 0, unresolved = 0, blank = 0;
      let columnVerified = false;
      for (const row of rows) {
        if (asText(row[idField])) { already++; continue; }
        const key = normalizeName(row[nameField]);
        if (!key) { blank++; continue; }
        const resolved = idByName.get(key);
        if (!resolved) { unresolved++; continue; }
        await withCollection(collection, (c) => c.update(row.id, { [idField]: resolved }));
        // PocketBase silently drops a write to a column the collection has not
        // declared, so "filled" would be a lie if setup-schema.mjs had not run.
        // Read the first fill back; if it did not stick, the column is missing —
        // stop and say so rather than report success over a no-op.
        if (!columnVerified) {
          const check = await withCollection(collection, (c) => c.getOne<AnyRecord>(row.id, { fields: `id,${idField}` }));
          if (asText(check[idField]) !== resolved) {
            throw new Error(`Column ${idField} does not exist on ${collection[0]} — run setup-schema.mjs before backfilling.`);
          }
          columnVerified = true;
        }
        filled++;
      }
      return { total: rows.length, filled, already, unresolved, blank };
    };

    const games = await backfill(collectionCandidates.games, 'assigned_rc_id', 'assigned_rc');
    const feedbacks = await backfill(collectionCandidates.refereeCoaches, 'rc_id', 'rc_name');
    // The calendar feed caches per RC and is now filtered by id.
    icalGamesCache.clear();
    res.json({ ok: true, games, feedbacks });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.post('/api/admin/migrate-source-payload', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    let migrated = 0;
    let skipped = 0;
    let page = 1;
    const perPage = 50;

    while (true) {
      const batch = await withCollection(collectionCandidates.games, (collection) =>
        collection.getList<AnyRecord>(page, perPage, { sort: 'created' }),
      );

      for (const game of batch.items) {
        const payload = game.source_payload;
        if (!payload || typeof payload !== 'object') {
          skipped += 1;
          continue;
        }

        const sp = payload as Record<string, unknown>;
        const firstLineJudge = asText(game.first_line_judge)
          || asText(sp.activeFirstLineJudgeName)
          || extractLineJudgeName(sp, 'activeRefereeConvocationFirstLineJudge');
        const secondLineJudge = asText(game.second_line_judge)
          || asText(sp.activeSecondLineJudgeName)
          || extractLineJudgeName(sp, 'activeRefereeConvocationSecondLineJudge');

        await withCollection(collectionCandidates.games, (collection) =>
          collection.update(game.id, {
            first_line_judge: firstLineJudge,
            second_line_judge: secondLineJudge,
            source_payload: null,
          }),
        );
        migrated += 1;
      }

      if (page >= batch.totalPages) break;
      page += 1;
    }

    res.json({ migrated, skipped });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// ── Day-before match reminder ─────────────────────────────────────────
// Once a day, mail every coachee who referees a game TOMORROW that an RC has
// already taken: "your next assignment will be coached". Sent TO the coachee
// with the RC in CC. If both referees of a game are coachees, each gets their
// own mail. Off by default (`reminder_enabled` setting) and additionally
// suppressed by email test mode, so it can never surprise anyone after deploy.
// 10:00 the day before the match (Europe/Zurich, see VM_SYNC_TIMEZONE).
const REMINDER_CRON = process.env.REMINDER_CRON || '0 10 * * *';

function shiftIsoDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Tomorrow" means tomorrow in the region, not in the container's UTC clock.
function getTomorrowDate(): string {
  const today = zonedParts(Date.now());
  return shiftIsoDate(`${today.year}-${today.month}-${today.day}`, 1);
}

// The calendar day a match falls on, read in the region's zone. match_date is a
// text column holding three different shapes, so this is the only comparison
// that treats them alike — a lexicographic `>=` filter silently drops both the
// bare dates manual fixtures get ("2026-09-26" sorts before
// "2026-09-26T00:00:00.000Z") and legacy space-separated wall-clock values.
function zonedDateOf(matchDate: string): string {
  const moment = icalMoment(matchDate);
  if (!moment) return '';
  if (moment.allDay) return `${moment.date.slice(0, 4)}-${moment.date.slice(4, 6)}-${moment.date.slice(6, 8)}`;
  const p = zonedParts(moment.instant);
  return `${p.year}-${p.month}-${p.day}`;
}

// Resolve a game's referee name to a coachee record (handles "First Last" vs
// "Last First"), mirroring the lookup the feedback submit uses.
// A referee is matched to a coachee by name, forwards and reversed. The filter
// used to name four columns — full_name plus the legacy aliases name,
// coachee_name and referee_name — but setup-schema.mjs, which IS the schema
// contract, declares only full_name, and so does the live database. PocketBase
// rejects a filter mentioning an undeclared column with a 400 for the WHOLE
// expression, matching clause included: so feedback submit answered 500 (which
// the outbox then replays forever) and the day-before reminder, whose lookup
// swallows errors, silently mailed nobody. Ask the collection what it actually
// has and build the filter from that, so either schema works.
const COACHEE_NAME_COLUMNS = ['full_name', 'name', 'coachee_name', 'referee_name'];
let coacheeNameColumnsCache: { cols: string[]; expiresAt: number } | null = null;

async function coacheeNameColumns(): Promise<string[]> {
  if (coacheeNameColumnsCache && Date.now() < coacheeNameColumnsCache.expiresAt) return coacheeNameColumnsCache.cols;
  let cols = ['full_name'];
  try {
    const meta = await withCollection(collectionCandidates.coachees, (c) => pb.collections.getOne(c.collectionIdOrName));
    const declared = new Set(((meta as AnyRecord).fields as AnyRecord[] ?? []).map((f) => asText(f.name)));
    const found = COACHEE_NAME_COLUMNS.filter((n) => declared.has(n));
    if (found.length) cols = found;
  } catch {
    // Can't read the collection meta — full_name alone is the one column every
    // schema in this repo declares, so it is the safe floor.
  }
  coacheeNameColumnsCache = { cols, expiresAt: Date.now() + 10 * 60 * 1000 };
  return cols;
}

function buildCoacheeNameFilter(refereeName: string, cols: string[]): string {
  const variants = [refereeName.trim()];
  const parts = refereeName.trim().split(/\s+/);
  if (parts.length >= 2) variants.push([...parts].reverse().join(' '));
  const clauses: string[] = [];
  for (const v of variants) {
    if (!v) continue;
    const esc = escapeFilterValue(v);
    for (const col of cols) clauses.push(`${col} = "${esc}"`);
  }
  return clauses.join(' || ');
}

async function coacheeNameFilterAsync(refereeName: string): Promise<string> {
  return buildCoacheeNameFilter(refereeName, await coacheeNameColumns());
}

// WHICH row, not just which name. Coachees are per-season records: importing
// 26/27 creates a SECOND row for a referee who was already there in 25/26, and
// the admin console only ever shows and edits the selected season's copy. A
// name-only lookup has no index to order it, so PocketBase answers in rowid
// order — the OLDEST row, last season's. That row may carry a stale address,
// and every feedback_entry, last_feedback_at and observations.coachee written
// against it attaches to the wrong season, so the current season's "needs
// observation" list never clears. The client already compensates for the
// duplicates (see the comment in App.tsx, "Insert the selected season's records
// last so they win"); the server never did.
//
// The game's own date decides the season, so a match played in the 26/27 window
// resolves the 26/27 coachee even if someone runs it with another season open.
async function findCoacheeRecord(
  refereeName: string,
  season: number | null,
): Promise<{ collection: ReturnType<typeof pb.collection>; coachee: AnyRecord }> {
  const nameFilter = await coacheeNameFilterAsync(refereeName);
  return withCollection(collectionCandidates.coachees, async (collection) => {
    if (season != null && Number.isFinite(season)) {
      try {
        return {
          collection,
          coachee: await collection.getFirstListItem<AnyRecord>(`(${nameFilter}) && season = ${Math.trunc(season)}`),
        };
      } catch (error) {
        // No row for THIS season: a referee carried over without being
        // re-imported, or a game outside the season window. Fall through rather
        // than refuse — a slightly stale row still beats no recipient at all.
        if (!isRecordNotFound(error)) throw error;
      }
    }
    // Newest season first, so a name matching several rows resolves to the most
    // recent one deterministically instead of by rowid.
    return {
      collection,
      coachee: await collection.getFirstListItem<AnyRecord>(nameFilter, { sort: '-season' }),
    };
  });
}

async function findCoacheeByRefereeName(refereeName: string, season: number | null): Promise<AnyRecord | null> {
  try {
    return (await findCoacheeRecord(refereeName, season)).coachee;
  } catch (error) {
    // Only "no such coachee" is an ordinary answer here. Swallowing everything
    // made a broken filter or an unreachable PocketBase look like "nobody on
    // this game is a coachee", so the run reported "0 sent, 0 skipped (of 0
    // due)" — byte-identical to a quiet Tuesday.
    if (isRecordNotFound(error)) return null;
    throw error;
  }
}

type ReminderPlan = {
  gameId: string; role: string; to: string; cc: string[];
  subject: string; text: string; html: string; coachee: string; rc: string; match: string;
};

// Build the reminders due for tomorrow. Sends nothing — so the admin UI can
// preview exactly what would go out (same contract as the demo's mail preview).
async function buildDueReminders(): Promise<ReminderPlan[]> {
  const target = getTomorrowDate();
  await ensureAdminAuth();
  // A day either side, because a stored value's text prefix and its zoned
  // calendar day can differ around midnight; the exact day is decided below.
  const candidates = await withCollection(collectionCandidates.games, (c) =>
    c.getFullList<AnyRecord>({
      filter: `match_date >= "${shiftIsoDate(target, -1)}" && match_date < "${shiftIsoDate(target, 2)}"`,
      sort: 'match_date',
    }));
  const games = candidates.filter((g) => zonedDateOf(asText(g.match_date)) === target);
  const tpl = await getEmailTemplate('reminder');
  const people = await getActiveRcPeople().catch(() => [] as ActiveRcPerson[]);
  const plans: ReminderPlan[] = [];
  for (const game of games) {
    if (!rcRefPresent(game.assigned_rc_id, game.assigned_rc)) continue; // only games an RC has taken
    // The id names the coach; the stored name is only what the mail prints, and
    // after a rename the two disagree until the next sync.
    const assignedId = asText(game.assigned_rc_id);
    const holder = assignedId
      ? people.find((p) => p.id === assignedId)
      : people.find((p) => normalizeName(p.fullName) === normalizeName(game.assigned_rc));
    const rcName = holder?.fullName || asText(game.assigned_rc);
    const rcEmail = singleAddress(holder?.email);
    for (const [roleLabel, refField] of [['1. SR', 'first_referee'], ['2. SR', 'second_referee']] as const) {
      const refereeName = asText(game[refField]);
      if (!refereeName) continue;
      const coachee = await findCoacheeByRefereeName(refereeName, seasonOfDate(asText(game.match_date)));
      const email = coachee ? singleAddress(coachee.email) : '';
      if (!coachee || !email) continue; // not a coachee, or no usable address on file
      const built = buildTemplatedEmail({
        tpl,
        vars: emailVars({
          refereeName: asText(coachee.full_name) || refereeName,
          rcName,
          matchNo: asText(game.match_no),
          league: asText(game.league),
          date: fmtDateDe(asText(game.match_date)),
          time: fmtTimeDe(asText(game.match_date)),
          location: asText(game.location),
          homeTeam: asText(game.home_team),
          awayTeam: asText(game.away_team),
          role: roleLabel,
        }),
        rows: [], // the reminder carries its details inline in the template text
      });
      plans.push({
        gameId: String(game.id), role: roleLabel, to: email, cc: rcEmail ? [rcEmail] : [],
        subject: built.subject, text: built.text, html: built.html,
        coachee: asText(coachee.full_name) || refereeName, rc: rcName,
        match: `${asText(game.home_team)} – ${asText(game.away_team)}`,
      });
    }
  }
  return plans;
}

async function runMatchReminders(): Promise<{ sent: number; skipped: number; suppressed: boolean; due: number }> {
  const enabled = asText((await getSettingRecord('reminder_enabled'))?.value) === '1';
  if (!enabled) return { sent: 0, skipped: 0, suppressed: true, due: 0 };
  const plans = await buildDueReminders();
  const testMode = await isEmailTestMode();
  if (testMode) {
    console.log(`[reminder] TEST_MODE — ${plans.length} reminder(s) suppressed`);
    return { sent: 0, skipped: plans.length, suppressed: true, due: plans.length };
  }
  const sentRec = await getSettingRecord('reminder_sent');
  let already: string[] = [];
  try { already = sentRec ? JSON.parse(asText(sentRec.value)) as string[] : []; } catch { already = []; }
  const seen = new Set(already);
  const stamp = getTomorrowDate();
  const fresh: string[] = [];
  let sent = 0, skipped = 0;
  for (const p of plans) {
    const key = `${stamp}:${p.gameId}:${p.role}`;
    if (seen.has(key)) { skipped++; continue; } // already reminded — never double-send
    try {
      // The pooled transport's stale-connection failure is exactly what this
      // wrapper retries. Without it one hiccup loses the reminder for good:
      // the next run is 24h later, by which time the match is in the past.
      await sendMailResilient({
        from: MAIL_FROM,
        to: p.to,
        cc: p.cc.length ? p.cc : undefined,
        replyTo: p.cc[0] || undefined,
        subject: p.subject,
        html: p.html,
        text: p.text,
        attachments: emailAttachments(),
      });
      fresh.push(key);
      sent++;
    } catch (err) {
      log.error('reminder.send', 'send failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (fresh.length) {
    // Keep only current/future stamps so the setting can't grow without bound.
    const keep = [...already, ...fresh].filter((k) => k.slice(0, 10) >= stamp);
    await setSetting('reminder_sent', JSON.stringify(keep));
  }
  return { sent, skipped, suppressed: false, due: plans.length };
}

// ── Email templates + reminder admin API ──────────────────────────────
app.get('/api/admin/email-templates', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    res.json({
      feedback: await getEmailTemplate('feedback'),
      reminder: await getEmailTemplate('reminder'),
      defaults: DEFAULT_EMAIL_TEMPLATES,
      reminder_enabled: asText((await getSettingRecord('reminder_enabled'))?.value) === '1',
      placeholders: ['vorname', 'name', 'coach', 'coachVorname', 'datum', 'uhrzeit', 'heim', 'gast', 'liga', 'halle', 'spielNr', 'rolle'],
    });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.put('/api/admin/email-templates', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Validate everything before writing anything: rejecting the reminder
    // template after the feedback one was already saved told the admin the save
    // had failed while half of their edits were live.
    const pending: Array<[EmailTemplateKind, EmailTemplate]> = [];
    for (const kind of ['feedback', 'reminder'] as EmailTemplateKind[]) {
      const tpl = body[kind];
      if (!tpl || typeof tpl !== 'object') continue;
      const t = tpl as Partial<EmailTemplate>;
      const clean: EmailTemplate = {
        subject: String(t.subject ?? '').slice(0, 300),
        heading: String(t.heading ?? '').slice(0, 300),
        intro: String(t.intro ?? '').slice(0, 8000),
        outro: String(t.outro ?? '').slice(0, 4000),
      };
      if (!clean.subject.trim()) { res.status(400).json({ error: `Betreff darf nicht leer sein (${kind}).` }); return; }
      pending.push([kind, clean]);
    }
    for (const [kind, clean] of pending) {
      await setSetting(`email_template_${kind}`, JSON.stringify(clean));
    }
    if ('reminder_enabled' in body) await setSetting('reminder_enabled', body.reminder_enabled ? '1' : '0');
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Preview (never sends) the reminders that tomorrow would produce.
app.get('/api/admin/reminders/preview', requireAdminSession, async (_req: Request, res: ExpressResponse) => {
  try {
    const plans = await buildDueReminders();
    res.json({
      enabled: asText((await getSettingRecord('reminder_enabled'))?.value) === '1',
      testMode: await isEmailTestMode(),
      reminders: plans.map(({ html: _html, ...rest }) => rest),
    });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Anything that escapes a handler (including the CORS origin rejection and
// malformed JSON bodies) lands here instead of Express's HTML default page.
app.use((err: unknown, req: Request, res: ExpressResponse, _next: (e?: unknown) => void) => {
  const ctx = reqCtx(req);
  const message = err instanceof Error ? err.message : String(err);
  const corsBlocked = message.includes('CORS');
  const badJson = err instanceof SyntaxError && 'body' in (err as object);
  log.error('req.fail', `${req.method} ${redactIcalToken(req.originalUrl)} threw`, {
    error: err,
    origin: asText(req.headers.origin) || undefined,
    kind: corsBlocked ? 'cors' : badJson ? 'bad-json' : 'unhandled',
  }, ctx);
  if (res.headersSent) return;
  if (corsBlocked) { res.status(403).json({ error: 'Origin not allowed.' }); return; }
  if (badJson) { res.status(400).json({ error: 'Malformed JSON body.' }); return; }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  log.info('startup', `API server listening on http://localhost:${port}`, {
    ringStats: ringStats(),
    allowedOrigins: ALLOWED_ORIGINS,
    testMode: TEST_MODE,
    node: process.version,
  });
  console.log(`[scheduler] games sync cron: "${VM_SYNC_CRON}" (${VM_SYNC_TIMEZONE})`);
  console.log(`[scheduler] match reminder cron: "${REMINDER_CRON}" (${VM_SYNC_TIMEZONE})`);

  // Daily log-file retention sweep (03:30 local).
  void pruneLogFiles();
  cron.schedule('30 3 * * *', () => { void pruneLogFiles(); }, { timezone: VM_SYNC_TIMEZONE });

  cron.schedule(
    REMINDER_CRON,
    async () => {
      try {
        const r = await runMatchReminders();
        if (r.suppressed) console.log('[reminder] disabled or test mode — nothing sent');
        else console.log(`[reminder] ${r.sent} sent, ${r.skipped} skipped (of ${r.due} due)`);
      } catch (error) {
        log.error('reminder.run', 'daily reminder run failed', { error: String(error) });
      }
    },
    { timezone: VM_SYNC_TIMEZONE },
  );

  cron.schedule(
    VM_SYNC_CRON,
    async () => {
      try {
        const result = await runGamesSyncWithRetry();
        console.log(`[scheduler] Synced ${result.imported}/${result.totalFetched} games (${result.from} -> ${result.to})`);
      } catch (error) {
        log.error('scheduler.sync', 'daily games sync failed', { error: String(error) });
      }
    },
    { timezone: VM_SYNC_TIMEZONE },
  );
});
