import express, { Request, Response as ExpressResponse } from 'express';
import cors from 'cors';
import PocketBase from 'pocketbase';
import dotenv from 'dotenv';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import { createHmac, randomUUID, timingSafeEqual, scryptSync } from 'node:crypto';

dotenv.config({ path: '.env.local' });
dotenv.config();

// SMTP transport for feedback emails
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.migadu.com',
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
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

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});

type AnyRecord = Record<string, unknown> & { id: string };

const app = express();
const port = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '8mb' }));

const ADMIN_SESSION_COOKIE = 'svrz_admin_session';
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.POCKETBASE_ADMIN_PASSWORD || '';

if (!ADMIN_SESSION_SECRET) {
  console.warn('[startup] Missing ADMIN_SESSION_SECRET (falling back to empty secret). Set ADMIN_SESSION_SECRET for secure admin sessions.');
}

// ── Auth gate (app-level password protection) ────────────────────────
const GATE_COOKIE = 'svrz_gate_session';
const GATE_TTL_MS = 1000 * 60 * 60 * 24; // 24 h
const GATE_PASSWORD = process.env.APP_PASSWORD || '';
const GATE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 min
const GATE_RATE_LIMIT_MAX = 5;

if (!GATE_PASSWORD) {
  console.warn('[startup] APP_PASSWORD not set — auth gate is disabled.');
}

// Precompute scrypt hash of the gate password at startup (64-byte key, 16-byte salt derived from secret)
const GATE_SALT = ADMIN_SESSION_SECRET ? ADMIN_SESSION_SECRET.slice(0, 16).padEnd(16, '0') : '0'.repeat(16);
const GATE_PASSWORD_HASH = GATE_PASSWORD
  ? scryptSync(GATE_PASSWORD, GATE_SALT, 64).toString('hex')
  : '';

// In-memory rate limiter per IP
const gateAttempts = new Map<string, { count: number; resetAt: number }>();

function checkGateRateLimit(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const entry = gateAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    gateAttempts.set(ip, { count: 1, resetAt: now + GATE_RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count >= GATE_RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

function verifyGatePassword(input: string): boolean {
  const inputHash = scryptSync(input, GATE_SALT, 64);
  const expectedBuffer = Buffer.from(GATE_PASSWORD_HASH, 'hex');
  if (inputHash.length !== expectedBuffer.length) return false;
  return timingSafeEqual(inputHash, expectedBuffer);
}

function createGateSessionToken(): string {
  const body = JSON.stringify({ sub: randomUUID(), purpose: 'gate', exp: Date.now() + GATE_TTL_MS });
  const payload = base64UrlEncode(body);
  const signature = signAdminSessionPayload(payload);
  return `${payload}.${signature}`;
}

function verifyGateSession(req: Request): boolean {
  const token = getCookieValue(req, GATE_COOKIE);
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expectedSignature = signAdminSessionPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return false;
  }
  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as { exp?: unknown };
    const exp = Number(parsed.exp);
    return Number.isFinite(exp) && exp > Date.now();
  } catch {
    return false;
  }
}

// Periodic cleanup of stale rate-limit entries (every 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of gateAttempts) {
    if (now >= entry.resetAt) gateAttempts.delete(ip);
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
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
  });
}

function setAdminSessionCookie(res: ExpressResponse, token: string) {
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
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
    const parsed = JSON.parse(base64UrlDecode(payload)) as { email?: unknown; exp?: unknown };
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

function requireAdminSession(req: Request, res: ExpressResponse, next: () => void) {
  const session = verifyAdminSession(req);
  if (!session.ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
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

function buildFeedbackEmailHtml(params: {
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  role: string;
  rcName: string;
  tipsAndTricks: string;
  surveyUrl: string;
}): string {
  const e = (s: string) => escapeHtml(s);
  const tipsSection = params.tipsAndTricks.trim()
    ? `
    <div style="margin: 24px 0; padding: 16px 20px; border-left: 4px solid #059669; background: #ecfdf5; border-radius: 0 8px 8px 0;">
      <h2 style="margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #059669;">Tips &amp; Tricks</h2>
      <p style="margin: 0; font-size: 14px; color: #1e293b; white-space: pre-wrap; line-height: 1.6;">${e(params.tipsAndTricks)}</p>
    </div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f5f5f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 32px; margin-bottom: 16px;">
      <h1 style="margin: 0 0 24px; font-size: 20px; font-weight: 700; color: #1c1917;">SR-Coaching Feedback</h1>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #44403c;">
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Spiel Nr.</td><td style="padding: 6px 0;">${e(params.matchNo)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Liga</td><td style="padding: 6px 0;">${e(params.league)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Datum</td><td style="padding: 6px 0;">${e(params.date)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Ort</td><td style="padding: 6px 0;">${e(params.location)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Mannschaften</td><td style="padding: 6px 0;">${e(params.homeTeam)} vs ${e(params.awayTeam)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Beurteilte Rolle</td><td style="padding: 6px 0;">${e(params.role)}</td></tr>
        <tr><td style="padding: 6px 12px 6px 0; font-weight: 600; white-space: nowrap; vertical-align: top;">Schiedsrichter-Coach</td><td style="padding: 6px 0;">${e(params.rcName)}</td></tr>
      </table>
      ${tipsSection}
      <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #e7e5e4;">
        <p style="margin: 0 0 12px; font-size: 14px; color: #44403c;">Wir freuen uns über Ihr Feedback zum Coaching-Erlebnis:</p>
        <a href="${e(params.surveyUrl)}" style="display: inline-block; padding: 10px 24px; background: #059669; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">Feedback geben</a>
      </div>
    </div>
    <div style="text-align: center; padding: 8px 0;">
      <p style="margin: 0 0 4px; font-size: 13px; color: #78716c;">Der vollständige Coaching-Feedback-Bericht ist als PDF angehängt.</p>
      <p style="margin: 0; font-size: 11px; color: #a8a29e;">Diese E-Mail wurde automatisch vom SR-Coaching-System versendet.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildFeedbackEmailText(params: {
  matchNo: string;
  league: string;
  date: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  role: string;
  rcName: string;
  tipsAndTricks: string;
  surveyUrl: string;
}): string {
  let text = `SR-Coaching Feedback\n\n`;
  text += `Spiel Nr.: ${params.matchNo}\n`;
  text += `Liga: ${params.league}\n`;
  text += `Datum: ${params.date}\n`;
  text += `Ort: ${params.location}\n`;
  text += `Mannschaften: ${params.homeTeam} vs ${params.awayTeam}\n`;
  text += `Beurteilte Rolle: ${params.role}\n`;
  text += `Schiedsrichter-Coach: ${params.rcName}\n`;
  if (params.tipsAndTricks.trim()) {
    text += `\n--- Tipps & Tricks ---\n${params.tipsAndTricks}\n`;
  }
  text += `\nWir freuen uns über Ihr Feedback zum Coaching-Erlebnis:\n${params.surveyUrl}\n`;
  text += `\nDer vollständige Coaching-Feedback-Bericht ist als PDF angehängt.\n`;
  text += `Diese E-Mail wurde automatisch vom SR-Coaching-System versendet.\n`;
  return text;
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
  try {
    await pb.admins.authWithPassword(email, password);
    return;
  } catch {
    // PocketBase versions may use _superusers instead of admins.
  }

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
    maps_url: asText(raw.maps_url),
    game_result: asText(raw.game_result),
  };
}

async function upsertGame(gameData: ReturnType<typeof mapIncomingGame>) {
  await ensureAdminAuth();
  return withCollection(collectionCandidates.games, async (games) => {
    const externalId = gameData.external_id;
    let existing: AnyRecord | null = null;
    if (externalId) {
      const filter = `external_id = "${escapeFilterValue(externalId)}"`;
      try {
        existing = await games.getFirstListItem<AnyRecord>(filter);
      } catch {
        existing = null;
      }
    } else if (gameData.match_no && gameData.match_date) {
      const filter = `match_no = "${escapeFilterValue(gameData.match_no)}" && match_date = "${escapeFilterValue(gameData.match_date)}"`;
      try {
        existing = await games.getFirstListItem<AnyRecord>(filter);
      } catch {
        existing = null;
      }
    }

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

  const rawTokens = rcName.trim().split(/\s+/);
  const fallbackFirstName = rawTokens.slice(0, -1).join(' ') || rawTokens[0] || rcName;
  const fallbackLastName = rawTokens.length > 1 ? rawTokens[rawTokens.length - 1] : rcName;
  const created = await withCollection<AnyRecord>(collectionCandidates.refereeCoachPeople, (collection) =>
    collection.create({
      first_name: fallbackFirstName,
      last_name: fallbackLastName,
      active: true,
    }),
  );
  return created.id;
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
          fields: 'id,match_no,league,match_date,location,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles,is_rd_game,is_ld_game',
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
  for (const row of allObservations) {
    const coacheeId = asText(row.coachee);
    if (!coacheeId) continue;
    const existing = stats.get(coacheeId);
    const isSecond = asBoolean(row.second_observation, false);
    const createdAt = asText(row.created ?? row.updated);
    if (existing) {
      existing.count += 1;
      if (isSecond) existing.hasFurther = true;
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
      res.status(500).json({
        ok: false,
        error: {
          stage: 'connectivity',
          pocketbaseUrl: pbUrl,
          message: reachabilityError || 'PocketBase is not reachable from API process.',
        },
      });
      return;
    }

    await ensureAdminAuth();
    res.json({ ok: true });
  } catch (error) {
    const details = error && typeof error === 'object'
      ? {
          name: (error as { name?: string }).name,
          message: (error as { message?: string }).message,
          status: (error as { status?: number }).status,
          response: (error as { response?: unknown }).response,
          data: (error as { data?: unknown }).data,
        }
      : { message: String(error) };
    res.status(500).json({ ok: false, error: details });
  }
});

app.get('/api/admin/auth/status', (req: Request, res: ExpressResponse) => {
  const session = verifyAdminSession(req);
  res.json({
    authenticated: session.ok,
    email: session.email || '',
  });
});

app.post('/api/admin/auth/login', async (req: Request, res: ExpressResponse) => {
  const email = asText((req.body ?? {}).email);
  const password = asText((req.body ?? {}).password);
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required.' });
    return;
  }
  try {
    await verifyAdminCredentials(email, password);
    const token = createAdminSessionToken(email);
    setAdminSessionCookie(res, token);
    res.json({ ok: true, email });
  } catch (error) {
    clearAdminSessionCookie(res);
    if (error instanceof Error && error.message === 'INVALID_ADMIN_CREDENTIALS') {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }
    res.status(503).json({ error: 'PocketBase auth unavailable. Please try again.' });
  }
});

app.post('/api/admin/auth/logout', (_req: Request, res: ExpressResponse) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

// ── Auth gate endpoints ──────────────────────────────────────────────
app.get('/api/auth/gate/status', (req: Request, res: ExpressResponse) => {
  if (!GATE_PASSWORD) {
    res.json({ authenticated: true }); // gate disabled
    return;
  }
  res.json({ authenticated: verifyGateSession(req) });
});

app.post('/api/auth/gate', (req: Request, res: ExpressResponse) => {
  if (!GATE_PASSWORD) {
    res.json({ ok: true }); // gate disabled
    return;
  }
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const { allowed, retryAfterMs } = checkGateRateLimit(ip);
  if (!allowed) {
    res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfterMs });
    return;
  }
  const password = asText((req.body ?? {}).password);
  if (!password) {
    res.status(400).json({ error: 'Password is required.' });
    return;
  }
  if (!verifyGatePassword(password)) {
    res.status(401).json({ error: 'Wrong password.' });
    return;
  }
  const token = createGateSessionToken();
  res.cookie(GATE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: GATE_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.get('/api/eligible-games', async (_req: Request, res: ExpressResponse) => {
  try {
    const games = await getEligibleGames();
    res.json(games);
  } catch (error) {
    const details = error && typeof error === 'object'
      ? {
          name: (error as { name?: string }).name,
          message: (error as { message?: string }).message,
          status: (error as { status?: number }).status,
          response: (error as { response?: unknown }).response,
          data: (error as { data?: unknown }).data,
        }
      : { message: String(error) };
    res.status(500).json({ error: details });
  }
});

let rcPeopleCache: { data: unknown[]; expiresAt: number } | null = null;

app.get('/api/referee-coach-people', async (_req: Request, res: ExpressResponse) => {
  try {
    if (rcPeopleCache && Date.now() < rcPeopleCache.expiresAt) {
      return res.json(rcPeopleCache.data);
    }
    await ensureAdminAuth();
    const people = await withCollection(collectionCandidates.refereeCoachPeople, (collection) =>
      collection.getFullList<AnyRecord>({ sort: 'last_name', filter: 'active = true' }),
    );
    const mapped = people.map((p) => ({
      id: p.id,
      fullName: `${asText(p.first_name)} ${asText(p.last_name)}`.trim(),
    }));
    rcPeopleCache = { data: mapped, expiresAt: Date.now() + 10 * 60 * 1000 };
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.put('/api/games/:id/assign-rc', async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const gameId = String(req.params.id);
    const rcName = asText((req.body ?? {}).assignedRc);
    const updated = await withCollection(collectionCandidates.games, (collection) =>
      collection.update(gameId, { assigned_rc: rcName }),
    );
    res.json({ ok: true, id: (updated as AnyRecord).id, assignedRc: asText((updated as AnyRecord).assigned_rc) });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ── RC Overview ──────────────────────────────────────────────────────
app.get('/api/rc-overview', async (_req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
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
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/rc-overview/:rcName/coachees', async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const rcName = decodeURIComponent(String(req.params.rcName));
    const rcKey = normalizeName(rcName);

    // Fetch all games assigned to this RC
    const allGames = await withCollection(collectionCandidates.games, (collection) =>
      collection.getFullList<AnyRecord>({
        sort: '-match_date',
        fields: 'id,match_no,league,match_date,home_team,away_team,first_referee,second_referee,assigned_rc,feedback_closed_roles,is_rd_game,is_ld_game',
      }),
    );
    const rcGames = allGames.filter((g) => normalizeName(g.assigned_rc) === rcKey);

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
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/games/sync', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSync(req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/games/sync/debug', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    const result = await runGamesSyncDebug(req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
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
      error: String(error),
      ...(debug && trace ? { trace } : {}),
    });
  }
});

app.get('/api/coachees', async (_req: Request, res: ExpressResponse) => {
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
    res.status(500).json({ error: String(error) });
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
        feedback_entries: Array.isArray(data.feedback_entries) ? data.feedback_entries : [],
      }),
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: String(error) });
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
    if ('feedback_entries' in raw) payload.feedback_entries = raw.feedback_entries;
    const updated = await withCollection(collectionCandidates.coachees, (collection) =>
      collection.update(String(req.params.id), payload),
    );
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: String(error) });
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
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/coachees/:id/games', async (req: Request, res: ExpressResponse) => {
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
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/coachees/:id/feedbacks', async (req: Request, res: ExpressResponse) => {
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
    res.status(500).json({ error: String(error) });
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
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/observations', async (req: Request, res: ExpressResponse) => {
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
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/observations/summary', async (req: Request, res: ExpressResponse) => {
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
    res.status(500).json({ error: String(error) });
  }
});

app.get('/api/games/calendar-status', async (_req: Request, res: ExpressResponse) => {
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
    const details = error && typeof error === 'object'
      ? {
          name: (error as { name?: string }).name,
          message: (error as { message?: string }).message,
          status: (error as { status?: number }).status,
          response: (error as { response?: unknown }).response,
          data: (error as { data?: unknown }).data,
        }
      : { message: String(error) };
    res.status(500).json({ error: details });
  }
});

app.post('/api/referee-coaches', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const created = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.create(req.body ?? {}),
    );
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.put('/api/referee-coaches/:id', requireAdminSession, async (req: Request, res: ExpressResponse) => {
  try {
    await ensureAdminAuth();
    const updated = await withCollection(collectionCandidates.refereeCoaches, (collection) =>
      collection.update(String(req.params.id), req.body ?? {}),
    );
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: String(error) });
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
    res.status(500).json({ error: String(error) });
  }
});

app.post('/api/feedback/submit', async (req: Request, res: ExpressResponse) => {
  const { gameId, role, formData, pdfBase64, pdfFilename, tipsAndTricks } = req.body ?? {};

  // Phase 1 — Validation
  if (!gameId || !role || !formData || !pdfBase64) {
    res.status(400).json({ error: 'gameId, role, formData and pdfBase64 are required.' });
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

    // Fetch game and check closure
    const game = await withCollection(collectionCandidates.games, (collection) =>
      collection.getOne<AnyRecord>(String(gameId)),
    );

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
    const refereeCoachPersonId = await resolveRefereeCoachPersonId(asText(formData.meta?.rc));

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
      const subject = `SR-Coaching Feedback – Spiel ${matchNo} (${formattedDate})`;

      const surveyUrl = process.env.FEEDBACK_SURVEY_URL || '';
      const emailParams = {
        matchNo,
        league: asText(game.league),
        date: formattedDate,
        location: asText(game.location),
        homeTeam: asText(game.home_team),
        awayTeam: asText(game.away_team),
        role: String(role),
        rcName: asText(formData.meta?.rc),
        tipsAndTricks: String(tipsAndTricks || ''),
        surveyUrl,
      };

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
        // Coaching address (FEEDBACK_CC) in BCC
        const bccList = [process.env.FEEDBACK_CC].filter(Boolean) as string[];
        mailBcc = bccList.length > 0 ? bccList : undefined;
        mailSubject = subject;
      }

      await smtpTransport.sendMail({
        from: process.env.SMTP_FROM || 'coaching-feedback@svrz.ch',
        replyTo: rcEmail || undefined,
        to: mailTo,
        cc: mailCc,
        bcc: mailBcc,
        subject: mailSubject,
        html: buildFeedbackEmailHtml(emailParams),
        text: buildFeedbackEmailText(emailParams),
        attachments: [{
          filename: String(pdfFilename || 'feedback.pdf'),
          content: pdfBuffer,
          contentType: 'application/pdf',
        }],
      });

      emailSent = true;
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
    res.status(500).json({ error: String(error) });
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
    res.status(500).json({ error: String(error) });
  }
});

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
  console.log(`[scheduler] games sync cron: "${VM_SYNC_CRON}" (${VM_SYNC_TIMEZONE})`);

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
