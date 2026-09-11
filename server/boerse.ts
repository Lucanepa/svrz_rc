// Reading VolleyManager's SR-Börse — the exchange where a referee who cannot
// whistle a game they are convoked for offers THAT SLOT for someone else.
//
// Everything VM-facing lives here; the database writes and the schedule live in
// server/index.ts, and the reconcile DECISION below is pure so a test can reach
// it without a network or a PocketBase.
//
// Three things about this endpoint are not guesses — they were measured against
// production on 2026-09-10, and each one has already produced a wrong answer:
//
//   1. It needs the `RefAdmin:Referee` role. `RefereeDelegate`, which the nightly
//      games sync claims, gets a flat 403 here. And THREE roles answer 200 with
//      the WRONG row count — one of them zero — so a role drift reads as "the
//      börse is empty" rather than as an error. Hence assertRole below.
//   2. An unknown FILTER is ignored silently (200, wrong rows), while an invalid
//      propertyRenderConfiguration entry is fatal (500). Opposite failure modes
//      on the same request, so neither may be treated as "probably fine".
//   3. `associationId` — the SV-Nr., the only id this app stores for a referee —
//      is readable ONLY through the `refereeConvocations` ARRAY. The singular
//      `activeRefereeConvocation*HeadReferee` accessors return a fixed
//      projection that omits it however you ask.
import { CookieJar, followRedirects, VM_USER_AGENT } from './vmhttp.ts';
import { vmFetch } from './vmlock.ts';

const SEARCH_PATH = '/api/indoorvolleyball.refadmin/api%5crefereegameexchange/search';
const PAGE_PATH = '/indoorvolleyball.refadmin/refereegameexchange/index';

/** `Indoorvolleyball.RefAdmin:Referee` @ SVRZ. Overridable, because the ids are
 *  per account: if VM_USERNAME ever changes, re-read them off the dashboard's
 *  `:active-party` payload. ⚠ The role IDENTIFIER is not enough to tell this
 *  apart from a second `RefAdmin:Referee` attribute for another association
 *  that answers 200 with zero rows — only this id is. */
export const VM_ROLE_FOR_BOERSE = process.env.VM_ROLE_ATTRIBUTE_BOERSE
  || 'b87653c7-1e9e-41b7-ab44-1e50e898acc2';

/** Only the two head slots. SVRZ has never had a line-judge offer (0 of 400 rows
 *  checked), and the two endpoints disagree about the word anyway — `Linesman`
 *  here, `LineJudge` on the games search, and asking this one for a `LineJudge`
 *  property is a hard 500. */
const SLOT_BY_POSITION: Record<string, '1' | '2'> = { 'head-one': '1', 'head-two': '2' };

const CONV = 'refereeGame.refereeConvocations';
const PERSON = `${CONV}.indoorAssociationReferee.indoorReferee.person`;
const RENDER_COLUMNS = [
  'refereeGame.game.number',
  'refereeGame.game.startingDateTime',
  'status',
  'refereePosition',
  'submittingType',
  'submittedAt',
  'submittedByPerson.displayName',
  'submittedByPerson.associationId',
  'appliedAt',
  'appliedBy.indoorReferee.person.displayName',
  'appliedBy.indoorReferee.person.associationId',
  `${CONV}.refereePosition`,
  `${CONV}.refereeConvocationStatus`,
  `${PERSON}.displayName`,
  `${PERSON}.associationId`,
  `${PERSON}.__identity`,
];

const PAGE_SIZE = 200;

/** This endpoint is SLOW — a 200-row page with the convocation array on it took
 *  ~40 s against production, which is most of vmFetch's default 45 s deadline.
 *  Nothing here is user-facing, so give it room rather than aborting a page that
 *  was going to arrive. */
const SEARCH_TIMEOUT_MS = Number(process.env.VM_BOERSE_TIMEOUT_MS || 120_000);

/** How far back to bother reading. An offer on a game that has already been
 *  played cannot threaten an observation, and the whole board is 3629 rows —
 *  fetching all of it took longer than the request timeout, which is no basis
 *  for an hourly poll. */
const LOOKBACK_DAYS = Number(process.env.VM_BOERSE_LOOKBACK_DAYS || 2);

export type BoerseOfferRow = {
  vm_offer_id: string;
  match_no: string;
  game_starts_at: string;
  referee_position: string;
  slot: string;
  status: string;
  slot_person_name: string;
  slot_person_sv: string;
  slot_person_vm_id: string;
  submitted_by_name: string;
  submitted_by_sv: string;
  submitting_type: string;
  submitted_at: string;
  applied_by_name: string;
  applied_by_sv: string;
  applied_at: string;
  join_via: string;
  raw: unknown;
};

const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Whose slot is on offer.
 *
 * For an OPEN offer this is the person who would be replaced — regardless of who
 * filed it. The association files on referees' behalf constantly (23 of 400 rows
 * measured), so `submittedByPerson` is NOT the answer and never was.
 *
 * For an APPLIED offer the same convocation already names whoever TOOK the slot,
 * not who left it — which is why callers must read `status` before treating this
 * as "the owner". Getting that backwards would paint the new referee's name red.
 */
function slotHolder(item: Record<string, any>): { name: string; sv: string; vmId: string } | null {
  const position = txt(item.refereePosition);
  const convocations: any[] = item?.refereeGame?.refereeConvocations ?? [];
  const match = convocations.find((c) => txt(c?.refereePosition) === position);
  const person = match?.indoorAssociationReferee?.indoorReferee?.person;
  if (!person) return null;
  return { name: txt(person.displayName), sv: txt(person.associationId), vmId: txt(person.__identity) };
}

/** One VM row → one stored row. Returns null for anything we deliberately ignore. */
export function toOfferRow(item: Record<string, any>): BoerseOfferRow | null {
  const position = txt(item.refereePosition);
  const slot = SLOT_BY_POSITION[position];
  if (!slot) return null; // linesman / standby — out of scope, see SLOT_BY_POSITION

  const holder = slotHolder(item);
  const game = item?.refereeGame?.game ?? {};
  const applied = item?.appliedBy?.indoorReferee?.person ?? {};
  const submitter = item?.submittedByPerson ?? {};

  // An OPEN offer with no convocation at all is the association advertising an
  // UNSTAFFED game, not somebody dumping one — 6 of 37 open rows. It cannot
  // threaten an observation, because nobody is on it to observe.
  const joinVia = !holder ? (txt(item.status) === 'open' ? 'unstaffed' : 'unresolved')
    : holder.sv ? 'position+sv'
      : holder.name ? 'position+name'
        : 'position';

  return {
    vm_offer_id: txt(item.__identity),
    match_no: txt(game.number),
    game_starts_at: txt(game.startingDateTime),
    referee_position: position,
    slot,
    status: txt(item.status),
    slot_person_name: holder?.name ?? '',
    slot_person_sv: holder?.sv ?? '',
    slot_person_vm_id: holder?.vmId ?? '',
    submitted_by_name: txt(submitter.displayName),
    submitted_by_sv: txt(submitter.associationId),
    submitting_type: txt(item.submittingType),
    submitted_at: txt(item.submittedAt),
    applied_by_name: txt(applied.displayName),
    applied_by_sv: txt(applied.associationId),
    applied_at: txt(item.appliedAt),
    join_via: joinVia,
    // Trimmed evidence, not the whole VM row: games.source_payload is dead
    // because storing 2 MB of upstream JSON per record was the wrong idea once.
    raw: { position, status: txt(item.status), holder, number: txt(game.number) },
  };
}

// FLAT, not a discriminated union. This tsconfig has no `strict`, so TypeScript
// does not narrow on a boolean literal tag — `if (r.ok)` leaves `r.error`
// unreachable to the checker. A flat shape with empty defaults is the idiom this
// repo settled on for exactly that reason.
export type FetchResult = {
  ok: boolean;
  offers: BoerseOfferRow[];
  total: number;
  ignored: number;
  error: string;
  httpStatus?: number;
};

const failed = (error: string, httpStatus?: number): FetchResult =>
  ({ ok: false, offers: [], total: 0, ignored: 0, error, httpStatus });

/** The dashboard's active role, so a poll can put it back the way it found it. */
async function readActiveRole(base: string, jar: CookieJar): Promise<{ csrf: string; attr: string }> {
  const { body } = await followRedirects(base, `${base}/`, jar);
  const csrf = body.match(/data-csrf-token="([^"]+)"/)?.[1] ?? '';
  // Parse it, do not pattern-match it. `activeAttributeValue` contains nested
  // objects, so a `[^}]*` regex walks straight past its own closing brace and
  // returns the first id it trips over — which is the ASSOCIATION's
  // (`286bd004…`, "Swiss Volley Region Zürich"), not the role's. That read as a
  // failed role claim on the first live run.
  //
  // The attribute's value is HTML-escaped and wrapped in a call:
  //   :active-party="$convertFromBackendToFrontend({ … })"
  const raw = (body.match(/:active-party="([^"]+)"/)?.[1] ?? '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'");
  let attr = '';
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open >= 0 && close > open) {
    try {
      const party = JSON.parse(raw.slice(open + 1, close)) as
        { activeAttributeValue?: { persistenceObjectIdentifier?: string } };
      attr = txt(party.activeAttributeValue?.persistenceObjectIdentifier);
    } catch { attr = ''; }
  }
  return { csrf, attr };
}

async function switchRole(base: string, jar: CookieJar, csrf: string, attributeValueId: string): Promise<boolean> {
  if (!attributeValueId || !csrf) return false;
  const body = new URLSearchParams();
  body.set('attributeValueAsArray[0]', attributeValueId);
  body.set('__csrfToken', csrf);
  const res = await vmFetch(`${base}/api/sportmanager.security/api%5cparty/switchRoleAndAttribute`, {
    method: 'PUT',
    headers: {
      'User-Agent': VM_USER_AGENT, Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest', Origin: base, Referer: `${base}/`,
    },
    body: body.toString(),
  });
  jar.update(res);
  await res.text();
  return res.ok;
}

/**
 * Read the whole börse.
 *
 * Deliberately UNFILTERED. Filtering to `status=open` — which is what the börse
 * UI itself defaults to — would make a TAKEN offer indistinguishable from a
 * WITHDRAWN one, because both simply stop appearing. The app would then show
 * "all clear" at the exact moment an observation is certainly lost. Taken offers
 * stay in the API with `status: applied` and a populated `appliedBy` (362 of 362
 * measured), so reading everything is what makes withdrawal detectable at all.
 *
 * The role is claimed before reading and RESTORED after: the account is shared
 * with the wiedisync project on another host, which cannot be locked against, so
 * the least this poll can do is not leave the account somewhere it did not find
 * it. See infrastructure.md → "The shared VolleyManager account".
 */
export async function fetchBoerseOffers(opts: {
  base: string; username: string; password: string;
  log?: (msg: string, data?: unknown) => void;
}): Promise<FetchResult> {
  const { base, username, password } = opts;
  const say = opts.log ?? (() => {});
  const jar = new CookieJar();
  jar.set('language', 'de');
  let restoreTo = '';

  try {
    const { body: loginHtml } = await followRedirects(base, `${base}/login`, jar);
    const hidden: Record<string, string> = {};
    for (const m of loginHtml.matchAll(/name="([^"]+)"[^>]*value="([^"]*?)"/g)) hidden[m[1]] = m[2];
    const prefix = '__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword]';
    hidden[`${prefix}[username]`] = username;
    hidden[`${prefix}[password]`] = password;
    await followRedirects(base, `${base}/sportmanager.security/authentication/authenticate`, jar, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(hidden).toString(),
    });

    const before = await readActiveRole(base, jar);
    restoreTo = before.attr;
    if (before.attr !== VM_ROLE_FOR_BOERSE) {
      // Worth saying out loud: the account is shared, and "somebody else moved
      // it" is the single likeliest cause of a future wrong answer here. On
      // 2026-09-11 it was found on wiedisync's ClubAdministrator, which answers
      // this endpoint 200 with five rows — invisible without this line.
      say(`[boerse] account was on ${before.attr || '(none)'} — claiming ${VM_ROLE_FOR_BOERSE}, will restore`);
      await switchRole(base, jar, before.csrf, VM_ROLE_FOR_BOERSE);
    }

    // Assert the ATTRIBUTE VALUE ID, not the role name. Two different attributes
    // are both `Indoorvolleyball.RefAdmin:Referee`, and the other one answers
    // this endpoint 200 with zero rows — the single most dangerous outcome here,
    // because it looks exactly like "nothing is in the börse".
    const after = await readActiveRole(base, jar);
    if (after.attr !== VM_ROLE_FOR_BOERSE) {
      return failed(`VM_ROLE_NOT_CLAIMED: wanted ${VM_ROLE_FOR_BOERSE}, session is on ${after.attr || '(none)'}`);
    }

    const page = await followRedirects(base, `${base}${PAGE_PATH}`, jar, { headers: { Referer: `${base}/` } });
    if (page.response.status !== 200) {
      return failed(`börse page ${page.response.status}`, page.response.status);
    }
    const csrf = page.body.match(/data-csrf-token="([^"]+)"/)?.[1] ?? '';
    if (!csrf) return failed('no CSRF token on the börse page');

    const offers: BoerseOfferRow[] = [];
    let ignored = 0;
    let offset = 0;
    let total = 0;

    // Newest game first, and stop once a page has walked past the cutoff.
    //
    // A dateRange filter would be the obvious way to bound this, and it is the
    // one thing this endpoint will not do — any dateRange on
    // `refereeGame.game.startingDateTime` is a hard 500, in every format. So the
    // window is enforced by ORDERING and stopping, which VM does support.
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
    let reachedCutoff = false;

    for (;;) {
      const params = new URLSearchParams();
      params.set('searchConfiguration[propertyOrderings][0][propertyName]', 'refereeGame.game.startingDateTime');
      params.set('searchConfiguration[propertyOrderings][0][descending]', 'true');
      params.set('searchConfiguration[propertyOrderings][0][isSetByUser]', 'true');
      params.set('searchConfiguration[offset]', String(offset));
      params.set('searchConfiguration[limit]', String(PAGE_SIZE));
      params.set('searchConfiguration[textSearchOperator]', 'AND');
      RENDER_COLUMNS.forEach((c, i) => params.set(`propertyRenderConfiguration[${i}]`, c));
      params.set('__csrfToken', csrf);

      const res = await vmFetch(`${base}${SEARCH_PATH}`, {
        method: 'POST',
        headers: {
          'User-Agent': VM_USER_AGENT, Cookie: jar.header(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest', Origin: base, Referer: `${base}${PAGE_PATH}`,
        },
        body: params.toString(),
      }, SEARCH_TIMEOUT_MS);
      jar.update(res);
      const text = await res.text();
      if (res.status !== 200) {
        return failed(`search ${res.status} at offset ${offset}`, res.status);
      }
      let parsed: { items?: any[]; totalItemsCount?: number };
      try { parsed = JSON.parse(text); } catch { return failed('search returned non-JSON'); }

      const items = parsed.items ?? [];
      total = parsed.totalItemsCount ?? 0;
      for (const item of items) {
        const row = toOfferRow(item);
        if (!row || !row.vm_offer_id) { ignored += 1; continue; }
        if (row.game_starts_at && row.game_starts_at < cutoff) { reachedCutoff = true; continue; }
        offers.push(row);
      }
      say(`[boerse] page at ${offset}: ${items.length} of ${total}, kept ${offers.length}`);

      offset += PAGE_SIZE;
      if (items.length === 0 || reachedCutoff || offset >= total || offset > 20000) break;
    }

    // "Complete" means complete FOR THE WINDOW, and the only proof of that is
    // having read past its edge. A run that stopped because the pages ran out —
    // a short page, a hiccup, an ignored offset — has not shown it saw
    // everything current, and must not be allowed to withdraw anything: that is
    // how a mass false all-clear happens.
    if (!reachedCutoff && offset < total) {
      return failed(`incomplete: stopped at ${offset} of ${total} without reaching the cutoff`);
    }

    return { ok: true, offers, total, ignored, error: '' };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    // Put the account back, always — including after a throw.
    try {
      if (restoreTo && restoreTo !== VM_ROLE_FOR_BOERSE) {
        const now = await readActiveRole(opts.base, jar);
        await switchRole(opts.base, jar, now.csrf, restoreTo);
      }
    } catch { /* best effort: the next job claims what it needs anyway */ }
  }
}

// ── Reconcile ────────────────────────────────────────────────────────

export type StoredOffer = { id: string; vm_offer_id: string; status: string; withdrawn_at: string };

export type ReconcilePlan = {
  creates: BoerseOfferRow[];
  updates: Array<{ id: string; row: BoerseOfferRow }>;
  withdraws: string[];
  blocked: string;
};

/**
 * What to write, given what VM just said and what we already hold.
 *
 * Pure on purpose: this is the half that can turn every warning off at once, so
 * it is the half that has to be testable without a network.
 *
 * Two guards, both earned. A single 200-with-zero-rows is the known silent-role
 * failure and must never clear the board on its own — `emptyStreak` is how the
 * caller says it has now seen that twice. And a reconcile that would withdraw
 * most of what we hold is refused outright: a mass all-clear should be a human
 * decision, not a quiet consequence of one odd response.
 */
export function planReconcile(opts: {
  fetched: BoerseOfferRow[];
  stored: StoredOffer[];
  emptyStreak: number;
  maxWithdrawRatio?: number;
}): ReconcilePlan {
  const { fetched, stored } = opts;
  const empty = { creates: [], updates: [], withdraws: [], blocked: '' };

  if (fetched.length === 0 && opts.emptyStreak < 2 && stored.some((s) => !s.withdrawn_at)) {
    return { ...empty, blocked: 'zero rows once — not clearing the board until a second run agrees' };
  }

  const byVmId = new Map(stored.map((s) => [s.vm_offer_id, s]));
  const seen = new Set<string>();
  const creates: BoerseOfferRow[] = [];
  const updates: Array<{ id: string; row: BoerseOfferRow }> = [];

  for (const row of fetched) {
    seen.add(row.vm_offer_id);
    const existing = byVmId.get(row.vm_offer_id);
    if (existing) updates.push({ id: existing.id, row });
    else creates.push(row);
  }

  const live = stored.filter((s) => !s.withdrawn_at);
  const withdraws = live.filter((s) => !seen.has(s.vm_offer_id)).map((s) => s.id);

  const ratio = opts.maxWithdrawRatio ?? 0.3;
  if (live.length >= 10 && withdraws.length > Math.ceil(live.length * ratio)) {
    return {
      creates, updates, withdraws: [],
      blocked: `would withdraw ${withdraws.length} of ${live.length} live offers — refusing a mass all-clear`,
    };
  }

  return { creates, updates, withdraws, blocked: '' };
}
