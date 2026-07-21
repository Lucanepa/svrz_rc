import express, { Request, Response as ExpressResponse } from 'express';
import cors from 'cors';
import PocketBase from 'pocketbase';
import dotenv from 'dotenv';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import { createHmac, randomUUID, randomBytes, randomInt, timingSafeEqual, scryptSync } from 'node:crypto';
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
});

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  console.warn('[startup] SMTP not fully configured. Feedback email sending will fail at runtime.');
}

// Sender identity shown in recipients' inboxes: a friendly display name in front
// of the configured address. Used by every outbound mail (feedback, PIN, OTP).
const MAIL_FROM = {
  name: process.env.SMTP_FROM_NAME || 'SVRZ Referee Coaching',
  address: process.env.SMTP_FROM || 'rc_coaching@volleyball.lucanepa.com',
};
const MAIL_APP_URL = process.env.APP_PUBLIC_URL || 'https://lucanepa.github.io/svrz_rc/';

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
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || 'https://lucanepa.codeberg.page')
  .split(',').map((o) => o.trim()).filter(Boolean);
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
app.use(express.json({ limit: '8mb' }));

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

// A calendar token never expires and is the only credential its feed has, so
// the URL carrying it must not sit readable in the log the admin console shows.
// `me` is spared so the log still distinguishes the app asking for its own
// link from a calendar client polling the feed — the same line otherwise.
function redactIcalToken(url: string): string {
  return url.replace(/(\/api\/ical\/)(?!me(?:[/?]|$))[^/?]+/, '$1<token>');
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
      body: bodySummary(req.body),
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
    + 'set ADMIN_SESSION_SECRET to keep sessions valid across restarts.',
  );
  return randomBytes(32).toString('hex');
}
const ADMIN_SESSION_SECRET = resolveSessionSecret();
const ADMIN_UI_PASSWORD = process.env.ADMIN_UI_PASSWORD || '';
const TEST_MODE = process.env.TEST_MODE === '1' || process.env.TEST_MODE === 'true';
if (TEST_MODE) console.warn('[startup] TEST_MODE enabled — outbound emails are suppressed.');
if (!ADMIN_UI_PASSWORD) console.warn('[startup] ADMIN_UI_PASSWORD not set — admin console login disabled.');

// ── Per-RC PIN auth (replaces the old shared APP_PASSWORD gate) ──────
const RC_COOKIE = 'svrz_rc_session';
const RC_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const GATE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const GATE_RATE_LIMIT_MAX = 10;
// Password reset gets its own per-IP budget. It used to share the login bucket,
// which meant the very people who need a reset — the ones who just burned their
// attempts guessing — were locked out of the recovery flow too, and the 429 that
// came back rendered in the UI as "Verbindungsfehler". Brute force is still
// bounded here by the per-email start limiter (3 / 10 min), the 5-guess cap per
// issued code, and the global limiter.
const RESET_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RESET_RATE_LIMIT_MAX = 20;

// PINs are hashed with an app-wide salt derived from the session secret: one
// scrypt per login attempt, and PIN uniqueness across RCs is checkable by
// comparing stored hashes. Online brute force is handled by the per-IP and
// global rate limiters; rotating ADMIN_SESSION_SECRET invalidates all PINs.
const PIN_SALT = ADMIN_SESSION_SECRET.slice(0, 16).padEnd(16, '0');
function hashPin(pin: string): string {
  return scryptSync(pin, PIN_SALT, 64).toString('hex');
}

// Generates a fresh 6-digit PIN unique against the given people (by hash),
// stores its hash on the RC record, invalidates the people cache, and returns
// the cleartext exactly once. Shared by the admin rotate and the OTP reset.
async function rotateRcPin(rcId: string): Promise<string> {
  const people = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
    c.getFullList<AnyRecord>({ fields: 'id,pin_hash' }));
  const otherHashes = new Set(
    people.filter((p) => p.id !== rcId).map((p) => asText(p.pin_hash)).filter(Boolean),
  );
  let pin = '';
  for (let attempt = 0; attempt < 40 && !pin; attempt++) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (!otherHashes.has(hashPin(candidate))) pin = candidate;
  }
  if (!pin) throw new Error('Could not generate a unique PIN');
  await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
    c.update(rcId, { pin_hash: hashPin(pin) }));
  rcPeopleCache = null;
  return pin;
}

// Emails a freshly-issued PIN to the RC. Best-effort: returns whether it sent.
// Suppressed (like feedback mail) when the email test mode is on.
async function sendRcPinEmail(person: AnyRecord, pin: string): Promise<boolean> {
  const to = asText(person.email);
  if (!to) return false;
  if (await isEmailTestMode()) {
    console.log(`[rc-pin-email] TEST_MODE — suppressed (would send to ${to})`);
    return false;
  }
  const name = `${asText(person.first_name)} ${asText(person.last_name)}`.trim();
  const html = emailShell(
    `<h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1c1917;">Dein persönlicher PIN</h1>`
    + `<p style="margin:0 0 14px;font-size:14px;color:#44403c;">Hallo ${escapeHtml(name)}, mit diesem PIN meldest du dich in der Referee-Coaching-App an:</p>`
    + emailCodeBox(pin)
    + `<div style="text-align:center;margin:8px 0 4px;"><a href="${MAIL_APP_URL}" style="display:inline-block;padding:11px 28px;background:#dc2626;color:#ffffff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:600;">Zur App</a></div>`
    + `<p style="margin:22px 0 0;font-size:13px;color:#78716c;line-height:1.6;">Ein zuvor gesetzter PIN ist ab sofort ungültig. Bitte bewahre den PIN sicher auf und teile ihn mit niemandem.</p>`,
  );
  await smtpTransport.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Dein persönlicher PIN – SVRZ Referee Coaching',
    text: `Hallo ${name}\n\nDein persönlicher PIN für die SVRZ Referee-Coaching-App lautet:\n\n    ${pin}\n\nMelde dich damit unter ${MAIL_APP_URL} an. Ein zuvor gesetzter PIN ist ab sofort ungültig.\n\nBitte bewahre den PIN sicher auf und teile ihn nicht.\n\nSwiss Volley Region Zürich`,
    html,
    attachments: emailAttachments(),
  });
  return true;
}

// ── Forgot-PIN OTP (email one-time code → issues a new PIN) ───────────
// In-memory, single-container. A restart during the 10-min window just means
// "request a new code". Keyed by normalized email; stores a scrypt hash.
const RC_OTP_TTL_MS = 10 * 60 * 1000;
const RC_OTP_MAX_ATTEMPTS = 5;
const rcOtpStore = new Map<string, { hash: string; expiresAt: number; attempts: number }>();
const rcOtpStartAttempts: RateLimitStore = new Map();
const rcOtpGlobal: RateLimitStore = new Map();

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

// Per-IP limiter for login endpoints (RC login + admin login).
const gateAttempts: RateLimitStore = new Map();
function checkGateRateLimit(ip: string) {
  return checkRateLimit(gateAttempts, ip, GATE_RATE_LIMIT_MAX, GATE_RATE_LIMIT_WINDOW_MS);
}

// Per-IP limiter for the password-reset flow — deliberately separate from the
// login bucket (see RESET_RATE_LIMIT_MAX).
const resetAttempts: RateLimitStore = new Map();
function checkResetRateLimit(ip: string) {
  return checkRateLimit(resetAttempts, ip, RESET_RATE_LIMIT_MAX, RESET_RATE_LIMIT_WINDOW_MS);
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

// App-wide backstop limiter for logins. Credentials are now email + password
// (scrypt), so single-account brute force is infeasible and the cap is generous
// — high enough not to 429 legitimate coaches on a busy match weekend, low
// enough to blunt a distributed credential-stuffing flood.
const pinLoginGlobal: RateLimitStore = new Map();
const PIN_GLOBAL_MAX = 1000;
const PIN_GLOBAL_WINDOW_MS = 15 * 60 * 1000;

function createRcSessionToken(rcId: string, name: string): string {
  const body = JSON.stringify({ sub: randomUUID(), purpose: 'rc', rcId, name, exp: Date.now() + RC_TTL_MS });
  const payload = base64UrlEncode(body);
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function verifyRcSession(req: Request): { ok: boolean; rcId?: string } {
  const token = getCookieValue(req, RC_COOKIE);
  if (!token) return { ok: false };
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return { ok: false };
  const expectedSignature = signAdminSessionPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { purpose?: unknown; rcId?: unknown; exp?: unknown };
    if (parsed.purpose !== 'rc') return { ok: false };
    const exp = Number(parsed.exp);
    if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false };
    const rcId = asText(parsed.rcId);
    if (!rcId) return { ok: false };
    return { ok: true, rcId };
  } catch {
    return { ok: false };
  }
}

// Periodic cleanup of stale rate-limit entries (every 10 min)
setInterval(() => {
  const now = Date.now();
  for (const store of [gateAttempts, signatureAttempts, pinLoginGlobal, rcOtpStartAttempts, rcOtpGlobal]) {
    for (const [ip, entry] of store) {
      if (now >= entry.resetAt) store.delete(ip);
    }
  }
  for (const [email, entry] of rcOtpStore) {
    if (now > entry.expiresAt) rcOtpStore.delete(email);
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

function createAdminSessionToken(email: string): string {
  const body = JSON.stringify({
    sub: randomUUID(),
    email,
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
    return decodeURIComponent(part.slice(separatorIndex + 1));
  }
  return '';
}

function clearAdminSessionCookie(res: ExpressResponse) {
  res.cookie(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 0,
    path: '/',
  });
}

function setAdminSessionCookie(res: ExpressResponse, token: string) {
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: ADMIN_SESSION_TTL_MS,
    path: '/',
  });
}

function verifyAdminSession(req: Request): { ok: boolean; email?: string } {
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
    const parsed = JSON.parse(base64UrlDecode(payload)) as { email?: unknown; exp?: unknown; purpose?: unknown };
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
    return { ok: true, email };
  } catch {
    return { ok: false };
  }
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

// ── RC identity session ──────────────────────────────────────────────
// Cached list of active RC people; also consulted on every RC-authenticated
// request so deactivating/deleting an RC revokes their session within the
// cache TTL. Invalidated by the admin rc-people CRUD endpoints.
type ActiveRcPerson = { id: string; fullName: string; email: string; isAdmin: boolean; isRcPresident: boolean };
let rcPeopleCache: { data: ActiveRcPerson[]; expiresAt: number } | null = null;

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
    isAdmin: p.is_admin === true,
    // Reads the post-visit surveys. Deliberately absent from the admin console's
    // RC editor: a flag an admin can tick is a flag an admin can tick for
    // themselves, and this is the one view admin rights must not open.
    isRcPresident: p.is_rc_president === true,
  }));
  rcPeopleCache = { data: mapped, expiresAt: Date.now() + 10 * 60 * 1000 };
  return mapped;
}

// Resolves admin privilege from either a real admin-console session OR an RC
// PIN session whose person is flagged is_admin. This is the single source of
// truth for "is this request an admin".
async function resolveAdmin(req: Request): Promise<{ ok: boolean; email: string }> {
  const a = verifyAdminSession(req);
  if (a.ok) return { ok: true, email: a.email || '' };
  const s = verifyRcSession(req);
  if (s.ok && s.rcId) {
    try {
      const person = (await getActiveRcPeople()).find((p) => p.id === s.rcId);
      if (person?.isAdmin) return { ok: true, email: person.email || person.fullName };
    } catch (error) {
      console.error('[auth] admin resolve failed:', error);
    }
  }
  return { ok: false, email: '' };
}

async function requireAdminSession(req: Request, res: ExpressResponse, next: () => void) {
  if ((await resolveAdmin(req)).ok) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

// Identity of the RC session that authorized a request. Absent for admin
// sessions (real admins AND admin-flagged RCs) — enforcement code treats
// "no rcAuth" as full (admin) access.
type RcAuthInfo = { rcId: string; name: string };
const rcAuthByReq = new WeakMap<Request, RcAuthInfo>();

// Fails CLOSED: unlike the old shared gate there is no "auth disabled" mode.
async function requireRcSession(req: Request, res: ExpressResponse, next: () => void) {
  if (verifyAdminSession(req).ok) { next(); return; }
  const session = verifyRcSession(req);
  if (session.ok && session.rcId) {
    try {
      const person = (await getActiveRcPeople()).find((p) => p.id === session.rcId);
      if (person) {
        // Admin-flagged RCs get NO rcAuth, so the enforcement sites grant them
        // full access exactly like a real admin session. Plain RCs get their
        // identity attached (name from the live record, so ownership checks
        // stay correct after a rename).
        if (!person.isAdmin) rcAuthByReq.set(req, { rcId: person.id, name: person.fullName });
        next();
        return;
      }
    } catch (error) {
      console.error('[auth] RC session check failed:', error);
      res.status(503).json({ error: 'Auth backend unavailable' });
      return;
    }
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
  return text.includes('Missing collection context') || text.includes('ClientResponseError 404');
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
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
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

function fmtDateDe(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return asText(value);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function fmtTimeDe(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

// Render a template + data into the branded shell. Used by BOTH the post-match
// feedback mail and the day-before reminder, so they stay visually consistent.
function buildTemplatedEmail(opts: {
  tpl: EmailTemplate;
  vars: Record<string, string>;
  rows: Array<[string, string]>;
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
    + tipsHtml
    + textBlockHtml(outro)
    + surveyHtml
    + footerHtml,
  );
  let text = heading.trim() ? `${heading}\n\n` : '';
  if (intro.trim()) text += `${intro.trim()}\n\n`;
  for (const [k, v] of opts.rows) if (v) text += `${k}: ${v}\n`;
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

function getTodayRange(): { from: string; to: string } {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  return {
    from: `${dateStr}T00:00:00.000Z`,
    to: `${dateStr}T23:59:59.000Z`,
  };
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

async function verifyAdminCredentials(email: string, password: string): Promise<void> {
  const authPb = new PocketBase(process.env.POCKETBASE_URL || 'http://127.0.0.1:8090');
  const isAuthError = (error: unknown) => {
    const status = Number((error as { status?: unknown })?.status);
    return status === 400 || status === 401;
  };
  try {
    await authPb.admins.authWithPassword(email, password);
    return;
  } catch (error) {
    if (!isAuthError(error)) {
      throw error;
    }
    // PocketBase versions may use _superusers instead of admins.
  }
  try {
    await authPb.collection('_superusers').authWithPassword(email, password);
    return;
  } catch (error) {
    if (isAuthError(error)) {
      throw new Error('INVALID_ADMIN_CREDENTIALS');
    }
    throw error;
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
      return games.update(existing.id, gameData);
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

async function vmLogin(username: string, password: string): Promise<VmSession> {
  if (vmCsrfCache && (Date.now() - vmCsrfCache.cachedAt) < VM_CSRF_CACHE_TTL_MS) {
    console.log('[vm] Using cached CSRF token');
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
  await followRedirects(`${VM_BASE}/`, jar, {}, 10, trace, 'dashboard');

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
      break;
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
          fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles,is_rd_game,is_ld_game,is_rsv_game,game_result',
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
  return getTodayRange();
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

async function runGamesSyncWithRetry(windowInput: { date?: unknown; from?: unknown; to?: unknown } = {}) {
  let lastError: unknown = null;
  const totalAttempts = VM_SYNC_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        console.warn(`[scheduler] Retrying games sync (${attempt}/${totalAttempts})...`);
      }
      return await runGamesSync(windowInput);
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

    await ensureAdminAuth();
    res.json({ ok: true });
  } catch (error) {
    console.error('[health] auth:', error);
    res.status(500).json({ ok: false, error: { stage: 'auth' } });
  }
});

app.get('/api/admin/auth/status', async (req: Request, res: ExpressResponse) => {
  // Admin-flagged RC PIN sessions count as admin here too, so they can use the
  // admin console without the separate admin password.
  const admin = await resolveAdmin(req);
  res.json({ authenticated: admin.ok, email: admin.email });
});

app.post('/api/admin/auth/login', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const rl = checkGateRateLimit(ctx.ip);
  if (!rl.allowed) { denyRateLimited(req, res, 'login:ip', rl.retryAfterMs, { kind: 'admin' }); return; }
  const email = asText((req.body ?? {}).email);
  const password = asText((req.body ?? {}).password);
  if (!email || !password) {
    log.warn('auth.admin-login', 'missing email or password', { email }, ctx);
    res.status(400).json({ error: 'email and password are required.' });
    return;
  }
  try {
    await verifyAdminCredentials(email, password);
    const token = createAdminSessionToken(email);
    setAdminSessionCookie(res, token);
    tagReqUser(req, email);
    log.info('auth.admin-login', 'ok', { email }, ctx);
    res.json({ ok: true, email });
  } catch (error) {
    clearAdminSessionCookie(res);
    if (error instanceof Error && error.message === 'INVALID_ADMIN_CREDENTIALS') {
      log.warn('auth.admin-login', 'rejected: invalid credentials', { email }, ctx);
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    log.error('auth.admin-login', 'PocketBase auth unavailable', { email, error }, ctx);
    res.status(503).json({ error: 'PocketBase auth unavailable. Please try again.' });
  }
});

app.post('/api/admin/auth/logout', (_req: Request, res: ExpressResponse) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

// ── Admin UI password gate (single password -> admin session) ─────────
app.post('/api/admin/ui-login', (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const rl = checkGateRateLimit(ctx.ip);
  if (!rl.allowed) { denyRateLimited(req, res, 'login:ip', rl.retryAfterMs, { kind: 'admin-ui' }); return; }
  const password = asText((req.body ?? {}).password);
  const ok = Boolean(ADMIN_UI_PASSWORD) && password.length === ADMIN_UI_PASSWORD.length
    && timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_UI_PASSWORD));
  if (!ok) {
    clearAdminSessionCookie(res);
    log.warn('auth.admin-ui-login', 'rejected', { configured: Boolean(ADMIN_UI_PASSWORD) }, ctx);
    res.status(401).json({ error: 'Invalid password.' });
    return;
  }
  setAdminSessionCookie(res, createAdminSessionToken('admin-ui'));
  tagReqUser(req, 'admin-ui');
  log.info('auth.admin-ui-login', 'ok', undefined, ctx);
  res.json({ ok: true });
});

// ── Logging: browser ingest + admin read ──────────────────────────────
// Deliberately unauthenticated: the failures worth capturing (a login that
// won't go through, a password reset that dead-ends) all happen before there is
// a session. Abuse is bounded by a per-IP budget and hard caps on batch size.
const clientLogRl: RateLimitStore = new Map();
const CLIENT_LOG_MAX_BATCH = 200;
const CLIENT_LOG_EVENTS_PER_WINDOW = 3_000;
const CLIENT_LOG_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// text/plain is parsed only here, never globally: a global text parser would
// turn every state-changing POST into a CORS-simple request and hand away the
// preflight that protects them from cross-site forgery. This endpoint only
// writes to the log, and sendBeacon can't preflight.
app.post('/api/client-logs', express.text({ type: 'text/plain', limit: '256kb' }), (req: Request, res: ExpressResponse) => {
  const ip = clientIp(req);
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
  const sid = asText(body.sid).slice(0, 64) || undefined;
  const did = asText(body.did).slice(0, 64) || undefined;
  const user = asText(body.user).slice(0, 120) || undefined;
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
      data: (e.data && typeof e.data === 'object' ? e.data : undefined) as Record<string, unknown> | undefined,
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
async function getSettingRecord(key: string): Promise<AnyRecord | null> {
  try {
    return await withCollection(['app_settings'], (collection) =>
      collection.getFirstListItem<AnyRecord>(`key = "${escapeFilterValue(key)}"`));
  } catch { return null; }
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
    res.json({ default_season, test_mode: await isEmailTestMode(), groups, coachee_targets });
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
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
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
      has_pin: Boolean(asText(p.pin_hash)), is_admin: p.is_admin === true,
    })));
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Generates (or rotates) a unique 6-digit login PIN for one RC, emails it to
// the RC, and also returns the cleartext once (so the admin has a fallback if
// mail delivery is unreliable). Only the hash is stored.
app.post('/api/admin/rc-people/:id/pin', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const id = String(req.params.id);
    let person: AnyRecord;
    try {
      person = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
        c.getOne<AnyRecord>(id));
    } catch { res.status(404).json({ error: 'RC not found' }); return; }
    const pin = await rotateRcPin(id);
    let emailed = false;
    try { emailed = await sendRcPinEmail(person, pin); }
    catch (mailErr) { console.error('[rc-pin-email] admin rotate send failed:', mailErr); }
    res.json({ pin, emailed, email: asText(person.email) });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.post('/api/admin/rc-people', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const d = req.body ?? {};
    const created = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.create({ first_name: asText(d.first_name), last_name: asText(d.last_name),
        email: asText(d.email), phone: asText(d.phone), active: d.active !== false,
        is_admin: d.is_admin === true }));
    rcPeopleCache = null;
    res.status(201).json(created);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.put('/api/admin/rc-people/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {};
    if ('first_name' in raw) payload.first_name = asText(raw.first_name);
    if ('last_name' in raw) payload.last_name = asText(raw.last_name);
    if ('email' in raw) payload.email = asText(raw.email);
    if ('phone' in raw) payload.phone = asText(raw.phone);
    if ('active' in raw) payload.active = Boolean(raw.active);
    if ('is_admin' in raw) payload.is_admin = Boolean(raw.is_admin);
    const updated = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.update(String(req.params.id), payload));
    rcPeopleCache = null;
    res.json(updated);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});
app.delete('/api/admin/rc-people/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    await withCollection(collectionCandidates.refereeCoachPeople, (c) => c.delete(String(req.params.id)));
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
        full_name, first_name: asText(r.first_name), last_name: asText(r.last_name),
        referee_level: asText(r.referee_level), stage: asText(r.stage) || 'active',
        groups: asText(r.groups), season,
      };
      // Only touch notes when the file actually provided a value — a re-import
      // from a notes-less sheet must not wipe notes maintained in the app.
      if (asText(r.notes)) payload.notes = asText(r.notes);
      const key = `${normalizeName(full_name)}|${season ?? ''}`;
      const ex = byKey.get(key);
      if (ex) { await withCollection(collectionCandidates.coachees, (c) => c.update(ex.id, payload)); updated++; }
      else {
        const rec = await withCollection(collectionCandidates.coachees, (c) => c.create({ notes: '', ...payload, feedback_entries: [] }));
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

// ── Auth endpoints (per-RC PIN sessions) ─────────────────────────────
app.get('/api/auth/me', async (req: Request, res: ExpressResponse) => {
  let rc: { id: string; name: string } | null = null;
  let rcIsAdmin = false;
  let surveyReader = false;
  const session = verifyRcSession(req);
  if (session.ok && session.rcId) {
    try {
      const person = (await getActiveRcPeople()).find((p) => p.id === session.rcId);
      if (person) { rc = { id: person.id, name: person.fullName }; rcIsAdmin = person.isAdmin; surveyReader = person.isRcPresident; }
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
  // admin is set for a real admin session OR an admin-flagged RC session, so the
  // client's `isPrivileged` unlocks the same UI in both cases.
  const adminSession = verifyAdminSession(req);
  const admin = adminSession.ok
    ? { email: adminSession.email || '' }
    : (rcIsAdmin && rc ? { email: rc.name } : null);
  // Lets the console hide the RC-feedback tab from everyone else. Read off the
  // person already loaded above; the server enforces the same flag on the
  // endpoint independently, so this only saves a pointless 403.
  res.json({ rc, admin, surveyReader });
});

app.post('/api/auth/rc/login', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const ipRl = checkGateRateLimit(ctx.ip);
  if (!ipRl.allowed) {
    denyRateLimited(req, res, 'login:ip', ipRl.retryAfterMs, { email: asText((req.body ?? {}).email).trim().toLowerCase() });
    return;
  }
  const globalRl = checkRateLimit(pinLoginGlobal, 'global', PIN_GLOBAL_MAX, PIN_GLOBAL_WINDOW_MS);
  if (!globalRl.allowed) {
    denyRateLimited(req, res, 'login:global', globalRl.retryAfterMs);
    return;
  }
  const email = asText((req.body ?? {}).email).trim().toLowerCase();
  const password = asText((req.body ?? {}).password);
  if (!email || !password) {
    log.warn('auth.login', 'missing email or password', { email, hasPassword: Boolean(password) }, ctx);
    res.status(400).json({ error: 'E-Mail und Passwort erforderlich.' });
    return;
  }
  try {
    await ensureAdminAuth();
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
      collection.getFullList<AnyRecord>({ filter: 'active = true' }),
    );
    // Login with email + password; both must belong to the same active RC.
    // hashPin runs unconditionally (uniform timing) so response latency doesn't
    // reveal whether the email is a registered RC.
    const attempt = Buffer.from(hashPin(password), 'hex');
    const person = people.find((p) => asText(p.email).trim().toLowerCase() === email);
    let pwOk = false;
    if (person) {
      const stored = asText(person.pin_hash);
      if (stored) {
        const storedBuf = Buffer.from(stored, 'hex');
        pwOk = storedBuf.length === attempt.length && timingSafeEqual(storedBuf, attempt);
      }
    }
    const match = pwOk ? person! : undefined;
    if (!match) {
      // Distinguishing these two in the log (never in the response) is what
      // turns "she can't log in" into an answerable question.
      log.warn('auth.login', 'rejected', {
        email,
        reason: !person ? 'no-active-rc-with-this-email' : !asText(person.pin_hash) ? 'rc-has-no-password-set' : 'wrong-password',
        activeRcCount: people.length,
      }, ctx);
      res.status(401).json({ error: 'Falsche E-Mail oder falsches Passwort.' });
      return;
    }
    const name = `${asText(match.first_name)} ${asText(match.last_name)}`.trim();
    tagReqUser(req, name);
    log.info('auth.login', 'ok', { email, rcId: match.id, name }, ctx);
    res.cookie(RC_COOKIE, createRcSessionToken(match.id, name), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: RC_TTL_MS,
      path: '/',
    });
    res.json({ ok: true, name });
  } catch (error) {
    log.error('auth.login', 'backend failure during login', { email, error }, ctx);
    res.status(500).json({ error: safeError(error) });
  }
});

app.post('/api/auth/rc/logout', (_req: Request, res: ExpressResponse) => {
  res.cookie(RC_COOKIE, '', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 0,
    path: '/',
  });
  res.json({ ok: true });
});

// Forgot PIN, step 1: email a one-time code to a registered active RC. Always
// answers {ok:true} (no account enumeration). Rate-limited per IP and globally.
app.post('/api/auth/rc/forgot/start', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const ipRl = checkResetRateLimit(ctx.ip);
  if (!ipRl.allowed) { denyRateLimited(req, res, 'reset:ip', ipRl.retryAfterMs); return; }
  const globalRl = checkRateLimit(rcOtpGlobal, 'global', 100, 15 * 60 * 1000);
  if (!globalRl.allowed) { denyRateLimited(req, res, 'reset:global', globalRl.retryAfterMs); return; }
  const email = asText((req.body ?? {}).email).trim().toLowerCase();
  // Respond OK regardless, but only actually send when the email matches.
  // The log records what actually happened — the response deliberately cannot.
  const respondOk = (outcome: string, data?: Record<string, unknown>) => {
    log.info('auth.reset.start', outcome, { email, ...data }, ctx);
    res.json({ ok: true });
  };
  if (!email || !/\S+@\S+\.\S+/.test(email)) { respondOk('ignored: malformed email'); return; }
  // Per-email start limiter (independent of the per-IP one) to blunt targeted resets.
  const perEmail = checkRateLimit(rcOtpStartAttempts, email, 3, RC_OTP_TTL_MS);
  if (!perEmail.allowed) {
    // Silent to the caller (no enumeration), but a very real reason for "I never
    // got the code" — so it must be loud in the log.
    log.warn('ratelimit.deny', 'reset:email limit hit (no code sent, client sees success)', { bucket: 'reset:email', email, retryAfterMs: perEmail.retryAfterMs }, ctx);
    respondOk('suppressed: per-email limit');
    return;
  }
  try {
    await ensureAdminAuth();
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.getFullList<AnyRecord>({ filter: 'active = true' }));
    const person = people.find((p) => asText(p.email).trim().toLowerCase() === email);
    if (!person) {
      log.warn('auth.reset.start', 'no active RC with this email — nothing sent', { email, activeRcCount: people.length }, ctx);
    }
    if (person) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      rcOtpStore.set(email, { hash: hashPin(code), expiresAt: Date.now() + RC_OTP_TTL_MS, attempts: 0 });
      if (!(await isEmailTestMode())) {
        const html = emailShell(
          `<h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#1c1917;">Bestätigungscode</h1>`
          + `<p style="margin:0 0 14px;font-size:14px;color:#44403c;">Gib diesen Code in der App ein, um einen neuen PIN zu erhalten:</p>`
          + emailCodeBox(code)
          + `<p style="margin:0;font-size:13px;color:#78716c;text-align:center;">Der Code ist 10 Minuten gültig.</p>`
          + `<p style="margin:22px 0 0;font-size:13px;color:#a8a29e;line-height:1.6;">Wenn du das nicht angefragt hast, ignoriere diese E-Mail — dein PIN bleibt unverändert.</p>`,
        );
        await smtpTransport.sendMail({
          from: MAIL_FROM,
          to: asText(person.email),
          subject: 'Bestätigungscode – SVRZ Referee Coaching',
          text: `Dein Bestätigungscode lautet:\n\n    ${code}\n\nGib ihn in der App ein, um einen neuen PIN zu erhalten. Der Code ist 10 Minuten gültig.\n\nWenn du das nicht angefragt hast, ignoriere diese E-Mail — dein PIN bleibt unverändert.\n\n${MAIL_APP_URL}\nSwiss Volley Region Zürich`,
          html,
          attachments: emailAttachments(),
        });
        log.info('auth.reset.start', 'code emailed', { email, rcId: person.id, expiresInMs: RC_OTP_TTL_MS }, ctx);
      } else {
        log.warn('auth.reset.start', 'TEST_MODE — code generated but email suppressed', { email, rcId: person.id }, ctx);
      }
    }
  } catch (error) {
    // Includes SMTP failures: the user is told "code sent" either way, so this
    // log line is the only trace that the mail never left the building.
    log.error('auth.reset.start', 'failed before/while sending the code', { email, error }, ctx);
  }
  respondOk('done');
});

// Forgot password, step 2: verify the emailed code and set the chosen new
// password. Generic errors so a wrong email can't be probed.
app.post('/api/auth/rc/forgot/verify', async (req: Request, res: ExpressResponse) => {
  const ctx = reqCtx(req);
  const ipRl = checkResetRateLimit(ctx.ip);
  if (!ipRl.allowed) { denyRateLimited(req, res, 'reset:ip', ipRl.retryAfterMs); return; }
  const email = asText((req.body ?? {}).email).trim().toLowerCase();
  const code = asText((req.body ?? {}).code).trim();
  const newPassword = asText((req.body ?? {}).newPassword);
  // Validate the new password BEFORE consuming the one-time code, so a rejected
  // password doesn't force the user to request a fresh code.
  if (newPassword.length < 6) {
    log.warn('auth.reset.verify', 'rejected: password too short', { email, length: newPassword.length }, ctx);
    res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben.' });
    return;
  }
  const entry = rcOtpStore.get(email);
  // The response is deliberately one generic message; `reason` in the log is how
  // we tell "typed it wrong" from "we restarted and dropped the in-memory code".
  const fail = (reason: string, data?: Record<string, unknown>) => {
    log.warn('auth.reset.verify', `rejected: ${reason}`, { email, reason, ...data }, ctx);
    res.status(401).json({ error: 'Code ungültig oder abgelaufen.' });
  };
  if (!entry) { fail('no code on file (never requested, already used, or the server restarted since)'); return; }
  if (Date.now() > entry.expiresAt) { rcOtpStore.delete(email); fail('code expired', { ageMs: Date.now() - (entry.expiresAt - RC_OTP_TTL_MS) }); return; }
  if (entry.attempts >= RC_OTP_MAX_ATTEMPTS) { rcOtpStore.delete(email); fail('too many wrong codes for this one', { attempts: entry.attempts }); return; }
  entry.attempts++;
  const codeHash = Buffer.from(hashPin(code), 'hex');
  const stored = Buffer.from(entry.hash, 'hex');
  if (!/^\d{6}$/.test(code) || codeHash.length !== stored.length || !timingSafeEqual(codeHash, stored)) {
    fail(/^\d{6}$/.test(code) ? 'wrong code' : 'malformed code', { attempts: entry.attempts, codeLength: code.length });
    return;
  }
  rcOtpStore.delete(email); // single-use
  try {
    await ensureAdminAuth();
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.getFullList<AnyRecord>({ filter: 'active = true' }));
    const person = people.find((p) => asText(p.email).trim().toLowerCase() === email);
    if (!person) { fail('code was valid but the RC is no longer active'); return; }
    await withCollection(collectionCandidates.refereeCoachPeople, (c) =>
      c.update(person.id, { pin_hash: hashPin(newPassword) }));
    rcPeopleCache = null;
    tagReqUser(req, `${asText(person.first_name)} ${asText(person.last_name)}`.trim());
    log.info('auth.reset.verify', 'password set', { email, rcId: person.id }, ctx);
    res.json({ ok: true });
  } catch (error) {
    log.error('auth.reset.verify', 'backend failure while setting the password', { email, error }, ctx);
    res.status(500).json({ error: safeError(error) });
  }
});

// ---- Signature sessions (cross-device signing via slug capability token) ----
// Unsigned sessions expire so a leaked slug can't be (re)used indefinitely.
const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
async function getSignatureRecord(slug: string) {
  if (!slug || slug.length > 64) return null;
  try { return await pb.collection('signatures').getFirstListItem(`slug = "${escapeFilterValue(slug)}"`); }
  catch { return null; }
}
function isSignatureExpired(rec: AnyRecord): boolean {
  if (Boolean(rec.signed)) return false; // signed records stay readable
  const created = Date.parse(asText(rec.created));
  return Number.isFinite(created) && (Date.now() - created) > SIGNATURE_TTL_MS;
}
app.post('/api/signature/start', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
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
// app; this is the one they must not, so the check is the flag alone.
async function isSurveyReader(req: Request): Promise<boolean> {
  const session = verifyRcSession(req);
  if (!session.ok || !session.rcId) return false;
  const person = (await getActiveRcPeople()).find((p) => p.id === session.rcId);
  return Boolean(person?.isRcPresident);
}

async function requireSurveyReader(req: Request, res: ExpressResponse, next: () => void) {
  try {
    // Nobody flagged yet fails CLOSED — a recoverable mistake, unlike the
    // alternative of defaulting open to everyone with admin rights.
    if (await isSurveyReader(req)) { next(); return; }
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
    for (const q of SURVEY_QUESTIONS) {
      const value = answers[q.id];
      if (!value) continue; // unanswered: the form requires nothing
      const label = q.kind === 'choice'
        ? (q.options.find((o) => o.value === value)?.[lang] ?? value)
        : value;
      rows.push([questionLabel(q, lang), label]);
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
      footerNote: 'Automatisch vom SR-Coaching-System versendet.',
    });
    await smtpTransport.sendMail({
      from: MAIL_FROM,
      to: SURVEY_NOTIFY_EMAILS.join(','),
      subject: built.subject,
      html: built.html,
      text: built.text,
      attachments: emailAttachments(),
    });
  } catch (error) {
    log.warn('survey.notify_failed', 'survey stored but could not be mailed', { error: safeError(error) });
  }
}

const SURVEY_MAX_ANSWERS = 50;
const SURVEY_MAX_ANSWER_LEN = 5000;

async function getSurveyRecord(token: string) {
  if (!token || token.length > 64) return null;
  try { return await pb.collection(SURVEY_COLLECTION).getFirstListItem(`token = "${escapeFilterValue(token)}"`); }
  catch { return null; }
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
    const created = await withCollection(collectionCandidates.games, (c) => c.create({
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
    res.status(201).json(created);
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

// Deleting a game leaves any feedback that referenced it dangling, so this is
// meant for cleaning up a throwaway fixture, not for pruning real history.
app.delete('/api/admin/games/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const id = String(req.params.id);
    const set = await getStarredGameIds();
    if (set.delete(id)) await setSetting('starred_games', JSON.stringify([...set]));
    await withCollection(collectionCandidates.games, (c) => c.delete(id));
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.put('/api/admin/games/:id/star', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const id = String(req.params.id);
    const on = Boolean((req.body ?? {}).starred);
    const set = await getStarredGameIds();
    if (on) set.add(id); else set.delete(id);
    await setSetting('starred_games', JSON.stringify([...set]));
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
    res.json(await getActiveRcPeople());
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.put('/api/games/:id/assign-rc', requireRcSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const gameId = String(req.params.id);
    let rcName = asText((req.body ?? {}).assignedRc);
    const rcAuth = rcAuthByReq.get(req);
    if (rcAuth) {
      // Non-admin RCs may only take games for themselves, and only give back
      // games they currently hold. Admin sessions have no rcAuth and skip this.
      const current = await withCollection(collectionCandidates.games, (collection) =>
        collection.getOne<AnyRecord>(gameId),
      );
      const currentRc = normalizeName(current.assigned_rc);
      const self = normalizeName(rcAuth.name);
      if (rcName === '') {
        if (currentRc && currentRc !== self) {
          res.status(403).json({ error: 'Nur eigene Spiele können abgegeben werden.' });
          return;
        }
      } else {
        if (normalizeName(rcName) !== self) {
          res.status(403).json({ error: 'Spiele können nur für dich selbst übernommen werden.' });
          return;
        }
        if (currentRc && currentRc !== self) {
          res.status(409).json({ error: 'Dieses Spiel wurde bereits von einem anderen RC übernommen.' });
          return;
        }
        rcName = rcAuth.name; // write the canonical name from the RC record
      }
    }
    const updated = await withCollection(collectionCandidates.games, (collection) =>
      collection.update(gameId, { assigned_rc: rcName }),
    );
    // Both sides of a handover change: clearing the lot beats working out who
    // the previous holder was, and the map holds one entry per RC.
    icalGamesCache.clear();
    res.json({ ok: true, id: (updated as AnyRecord).id, assignedRc: asText((updated as AnyRecord).assigned_rc) });
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
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
      collection.getFullList<AnyRecord>({ sort: 'last_name', filter: 'active = true' }),
    );
    // 2. All games
    const allGames = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date',
        fields: 'id,match_no,league,match_date,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles,is_rd_game,is_ld_game',
      }),
    );
    // 3. All feedback records
    const allFeedbacks = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        fields: 'id,rc_name,game,submitted_at',
      }),
    );

    const now = new Date();
    // Build set of game IDs that have feedback, keyed by normalized rc_name
    const feedbackGameIdsByRc = new Map<string, Set<string>>();
    for (const fb of allFeedbacks) {
      const rcKey = normalizeName(fb.rc_name);
      if (!rcKey) continue;
      if (!feedbackGameIdsByRc.has(rcKey)) feedbackGameIdsByRc.set(rcKey, new Set());
      feedbackGameIdsByRc.get(rcKey)!.add(String(fb.game || ''));
    }

    const result = people.map((p) => {
      const fullName = `${asText(p.first_name)} ${asText(p.last_name)}`.trim();
      const rcKey = normalizeName(fullName);
      const fbGameIds = feedbackGameIdsByRc.get(rcKey) ?? new Set<string>();

      let done = 0;
      let outstanding = 0;
      let planned = 0;

      for (const game of allGames) {
        const assignedRc = normalizeName(game.assigned_rc);
        if (assignedRc !== rcKey) continue;
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

    // Fetch all games assigned to this RC
    const allGames = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date',
        fields: 'id,match_no,league,match_date,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles,is_rd_game,is_ld_game',
      }),
    );
    const rcGames = allGames.filter((g) =>
      normalizeName(g.assigned_rc) === rcKey && (!inSeason || inSeason(asText(g.match_date))));

    // Fetch feedbacks for this RC
    const allFeedbacks = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-submitted_at',
        expand: 'game,coachee',
      }),
    );
    const rcFeedbacks = allFeedbacks.filter((fb) => normalizeName(fb.rc_name) === rcKey);

    // Build feedback game IDs set
    const feedbackGameIds = new Set(rcFeedbacks.map((fb) => String(fb.game || '')));

    // Get coachee name set for referee matching
    const coacheeNameSet = await getCoacheeNameSet();

    // Group by coachee
    const coacheeMap = new Map<string, {
      coacheeName: string;
      coacheeId: string;
      doneFeedbacks: { gameDate: string; league: string; teams: string; role: string; submittedAt: string }[];
      outstandingGames: { gameId: string; gameDate: string; league: string; teams: string; refereeName: string }[];
      plannedGames: { gameId: string; gameDate: string; league: string; teams: string; refereeName: string }[];
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
      });
    }

    // Outstanding & planned games (no feedback yet)
    const now = new Date();
    for (const game of rcGames) {
      if (feedbackGameIds.has(game.id)) continue;
      const gameDate = new Date(asText(game.match_date));
      const teams = `${asText(game.home_team)} vs ${asText(game.away_team)}`;
      const league = asText(game.league);

      // Match referees to coachees
      for (const ref of [game.first_referee, game.second_referee]) {
        const refName = asText(ref);
        if (!refName) continue;
        if (!coacheeNameSet.has(normalizeName(refName))) continue;
        const entry = getOrCreate(refName, '');
        const gameEntry = { gameId: game.id, gameDate: asText(game.match_date), league, teams, refereeName: refName };
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

app.post('/api/games/sync', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSync(req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.post('/api/games/sync/debug', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSyncDebug(req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
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

    const games = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date,-created',
        filter: nameFilterParts.join(' || '),
        fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,first_line_judge,second_line_judge',
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
    res.json(rows);
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
    if (refereeCoachId) {
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
// Derived rather than stored, so it is stable: a URL that changed each time the
// dialog opened would silently strand every calendar already subscribed to the
// previous one. Deriving it from the RC's id also means deactivating an RC
// revokes their feed, since the lookup below only walks active people. Set
// ICAL_TOKEN_VERSION to something else to invalidate every feed at once.
function icalTokenFor(rcId: string): string {
  return createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`ical:v${ICAL_TOKEN_VERSION}:${rcId}`)
    .digest('base64url');
}

async function rcByIcalToken(token: string): Promise<ActiveRcPerson | null> {
  if (!token || token.length > 128) return null;
  const given = Buffer.from(token);
  let found: ActiveRcPerson | null = null;
  for (const person of await getActiveRcPeople()) {
    const expected = Buffer.from(icalTokenFor(person.id));
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

async function getGamesAssignedToRc(rcName: string): Promise<CalendarFeedGame[]> {
  const key = normalizeName(rcName);
  if (!key) return [];
  await ensureAdminAuth();
  // Same shape as the other game reads: one full list, filtered in memory, so
  // PocketBase never sees a URI-length or rate-limit problem.
  const allGames = await (async () => {
    try {
      return await withCollection(collectionCandidates.games, (collection) =>
        collection.getFullList<AnyRecord>({
          sort: 'match_date',
          fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,game_result,updated',
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
    .filter((game) => normalizeName(game.assigned_rc) === key)
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
  const games = await getGamesAssignedToRc(person.fullName);
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
    const path = `/api/ical/${icalTokenFor(person.id)}.ics?lang=${lang.toLowerCase()}`;
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
  try {
    await ensureAdminAuth();
    await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.delete(String(req.params.id)),
    );
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

app.post('/api/feedback/submit', requireRcSession, async (req: Request, res: ExpressResponse) => {
  const { gameId, role, formData, pdfBase64, pdfFilename, tipsAndTricks } = req.body ?? {};

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

  // Validate PDF size (3MB decoded limit)
  const pdfBuffer = Buffer.from(String(pdfBase64), 'base64');
  if (pdfBuffer.length > 3 * 1024 * 1024) {
    res.status(400).json({ error: 'PDF exceeds 3MB size limit.' });
    return;
  }

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
    if (rcAuth) {
      const assigned = normalizeName(game.assigned_rc);
      if (assigned && assigned !== normalizeName(rcAuth.name)) {
        res.status(403).json({ error: 'Dieses Spiel ist einem anderen RC zugewiesen.' });
        return;
      }
    }

    const closedRoles: string[] = Array.isArray(game.feedback_closed_roles) ? game.feedback_closed_roles as string[] : [];
    if (closedRoles.includes(String(role))) {
      res.status(409).json({ error: `Feedback for role "${role}" has already been submitted for this game.` });
      return;
    }

    // Resolve coachee and validate email
    const refereeName = role === '1. SR' ? asText(game.first_referee) : asText(game.second_referee);
    if (!refereeName) {
      throw new Error(`No referee name found in game for role ${role}.`);
    }

    const escaped = escapeFilterValue(refereeName);
    const nameParts = refereeName.trim().split(/\s+/);
    const reversed = nameParts.length >= 2 ? nameParts.reverse().join(' ') : '';
    const escapedReversed = reversed ? escapeFilterValue(reversed) : '';
    const reverseClause = escapedReversed
      ? ` || full_name = "${escapedReversed}" || name = "${escapedReversed}" || coachee_name = "${escapedReversed}" || referee_name = "${escapedReversed}"`
      : '';
    const coacheeResult = await withCollection(collectionCandidates.coachees, async (collection) => ({
      collection,
      coachee: await collection.getFirstListItem<AnyRecord>(
        `full_name = "${escaped}" || name = "${escaped}" || coachee_name = "${escaped}" || referee_name = "${escaped}"${reverseClause}`,
      ),
    }));
    const coachee = coacheeResult.coachee;
    const coacheeCollection = coacheeResult.collection;

    const coacheeEmail = asText(coachee.email);
    if (!coacheeEmail) {
      res.status(400).json({ error: 'Coachee has no email address. Add an email in the admin panel before submitting feedback.' });
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
        role_assessed: String(role),
        feedback_json: formData,
        submitted_at: submittedAt,
      }),
    );

    const entries = Array.isArray(coachee.feedback_entries) ? coachee.feedback_entries : [];
    const nextEntries = [
      ...entries,
      {
        referee_coaches_id: created.id,
        game_id: game.id,
        submitted_at: submittedAt,
        role_assessed: role,
      },
    ];

    await coacheeCollection.update(coachee.id, {
      feedback_entries: nextEntries,
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

    await withCollection(collectionCandidates.observations, (collection) =>
      collection.create(observationPayload),
    );

    // Upload PDF to feedback record
    const pdfFormData = new FormData();
    pdfFormData.append('pdf_file', new Blob([pdfBuffer], { type: 'application/pdf' }), String(pdfFilename || 'feedback.pdf'));
    await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.update(created.id, pdfFormData),
    );

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
        rcEmail = asText(rcPerson.email);
      } catch {
        // RC person fetch failed — continue without RC email
      }

      if (!rcEmail) {
        emailWarning = 'RC has no email, sent without RC in CC';
      }

      // Format date as dd.MM.yyyy
      const matchDate = asText(game.match_date);
      let formattedDate = matchDate;
      if (matchDate) {
        const d = new Date(matchDate);
        if (!isNaN(d.getTime())) {
          formattedDate = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
        }
      }

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
      const built = buildTemplatedEmail({
        tpl: await getEmailTemplate('feedback'),
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
        surveyUrl,
        footerNote: 'Der vollständige Coaching-Feedback-Bericht ist als PDF angehängt.',
      });
      const subject = built.subject;

      const isTestMode = process.env.FEEDBACK_EMAIL_TEST === '1';
      const testRecipient = process.env.FEEDBACK_TEST_RECIPIENT || '';

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
      if (emailTestMode) {
        console.log(`[feedback-email] TEST_MODE — outbound email suppressed (would send to ${mailTo})`);
        emailSent = false;
      } else {
        await smtpTransport.sendMail({
          from: MAIL_FROM,
          replyTo: rcEmail || undefined,
          to: mailTo,
          cc: mailCc,
          bcc: mailBcc,
          subject: mailSubject,
          html: built.html,
          text: built.text,
          attachments: emailAttachments([{
            filename: String(pdfFilename || 'feedback.pdf'),
            content: pdfBuffer,
            contentType: 'application/pdf',
          }]),
        });
        emailSent = true;
      }
    } catch (emailErr) {
      emailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
      console.error('[feedback-email] Failed to send:', emailError);
    }

    // Phase 4 — Closure
    if (formData.results?.secondBesuch !== 'Y') {
      try {
        const updatedClosedRoles = [...closedRoles, String(role)];
        await withCollection(collectionCandidates.games, (collection) =>
          collection.update(game.id, { feedback_closed_roles: updatedClosedRoles }),
        );
      } catch (closeErr) {
        console.error('[feedback-closure] Failed to close game role:', closeErr);
      }
    }

    // Phase 5 — Response
    res.status(201).json({
      id: created.id,
      emailSent,
      emailError,
      emailWarning,
    });
  } catch (error) {
    res.status(500).json({ error: safeError(error) });
  }
});

// One-time migration: extract line judge names from source_payload, then clear it
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

function getTomorrowRange(): { from: string; to: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const dateStr = d.toISOString().slice(0, 10);
  return { from: `${dateStr}T00:00:00.000Z`, to: `${dateStr}T23:59:59.999Z` };
}

// Resolve a game's referee name to a coachee record (handles "First Last" vs
// "Last First"), mirroring the lookup the feedback submit uses.
async function findCoacheeByRefereeName(refereeName: string): Promise<AnyRecord | null> {
  const esc = escapeFilterValue(refereeName);
  const parts = refereeName.trim().split(/\s+/);
  const reversed = parts.length >= 2 ? [...parts].reverse().join(' ') : '';
  const escRev = reversed ? escapeFilterValue(reversed) : '';
  const revClause = escRev
    ? ` || full_name = "${escRev}" || name = "${escRev}" || coachee_name = "${escRev}" || referee_name = "${escRev}"`
    : '';
  try {
    return await withCollection(collectionCandidates.coachees, (c) =>
      c.getFirstListItem<AnyRecord>(
        `full_name = "${esc}" || name = "${esc}" || coachee_name = "${esc}" || referee_name = "${esc}"${revClause}`));
  } catch { return null; }
}

type ReminderPlan = {
  gameId: string; role: string; to: string; cc: string[];
  subject: string; text: string; html: string; coachee: string; rc: string; match: string;
};

// Build the reminders due for tomorrow. Sends nothing — so the admin UI can
// preview exactly what would go out (same contract as the demo's mail preview).
async function buildDueReminders(): Promise<ReminderPlan[]> {
  const { from, to } = getTomorrowRange();
  await ensureAdminAuth();
  const games = await withCollection(collectionCandidates.games, (c) =>
    c.getFullList<AnyRecord>({ filter: `match_date >= "${from}" && match_date <= "${to}"`, sort: 'match_date' }));
  const tpl = await getEmailTemplate('reminder');
  const people = await getActiveRcPeople().catch(() => [] as ActiveRcPerson[]);
  const plans: ReminderPlan[] = [];
  for (const game of games) {
    const rcName = asText(game.assigned_rc);
    if (!rcName) continue; // only games an RC has actually taken
    const rcEmail = people.find((p) => normalizeName(p.fullName) === normalizeName(rcName))?.email || '';
    for (const [roleLabel, refField] of [['1. SR', 'first_referee'], ['2. SR', 'second_referee']] as const) {
      const refereeName = asText(game[refField]);
      if (!refereeName) continue;
      const coachee = await findCoacheeByRefereeName(refereeName);
      const email = coachee ? asText(coachee.email) : '';
      if (!coachee || !email) continue; // not a coachee, or no address on file
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
  const stamp = getTomorrowRange().from.slice(0, 10);
  const fresh: string[] = [];
  let sent = 0, skipped = 0;
  for (const p of plans) {
    const key = `${stamp}:${p.gameId}:${p.role}`;
    if (seen.has(key)) { skipped++; continue; } // already reminded — never double-send
    try {
      await smtpTransport.sendMail({
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
      console.error('[reminder] send failed:', err instanceof Error ? err.message : err);
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
        console.error('[reminder] Daily reminder run failed:', error);
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
        console.error('[scheduler] Daily games sync failed:', error);
      }
    },
    { timezone: VM_SYNC_TIMEZONE },
  );
});
