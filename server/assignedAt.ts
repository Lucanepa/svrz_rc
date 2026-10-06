// When a held game was taken, recovered from the request log.
//
// `games.assigned_at` only exists since 06.10.2026. Every booking older than
// that has a holder and no moment — and on a double booking the moment is the
// question ("how could this happen": was one taken before the one-booking
// guard of 30.09.2026?). The request log answers it for the last
// LOG_RETENTION_DAYS: each PUT /api/games/<id>/assign-rc left a `req.in` line
// with the body and a `req.out` line with the status, under one reqId.
//
// The log cannot say which door a take came through — the console and a coach
// send the same body, and the referer is only the origin — so a backfilled row
// gets the time and an empty `assigned_via`. Pure, so it can be tested without
// a log directory (e2e/assigned-at.spec.ts); index.ts does the reading and the
// writing.

export type LogLine = {
  t: string;
  evt: string;
  reqId?: string;
  data?: Record<string, unknown>;
};

const ASSIGN_PATH = /^\/api\/games\/([^/]+)\/assign-rc\/?$/;

/** The latest successful take per game id, as an ISO instant. A game whose
 *  latest successful call was a give-back is left out: whatever holds it now
 *  did not come through that route, and its time is not in the log. */
export function latestTakes(lines: LogLine[]): Map<string, string> {
  const bodies = new Map<string, Record<string, unknown>>();
  for (const l of lines) {
    if (l.evt !== 'req.in' || !l.reqId) continue;
    if (String(l.data?.method ?? '').toUpperCase() !== 'PUT') continue;
    if (!ASSIGN_PATH.test(String(l.data?.path ?? ''))) continue;
    const body = l.data?.body;
    if (body && typeof body === 'object') bodies.set(l.reqId, body as Record<string, unknown>);
  }
  const last = new Map<string, { t: string; take: boolean }>();
  for (const l of lines) {
    if (l.evt !== 'req.out' || !l.reqId) continue;
    if (String(l.data?.method ?? '').toUpperCase() !== 'PUT') continue;
    if (Number(l.data?.status) !== 200) continue;
    const m = ASSIGN_PATH.exec(String(l.data?.path ?? ''));
    if (!m) continue;
    const body = bodies.get(l.reqId);
    // No body line (budget, a lost file): not knowable whether it was a take.
    if (!body) continue;
    const take = String(body.assignedRc ?? '').trim() !== '' || String(body.assignedRcId ?? '').trim() !== '';
    const prev = last.get(m[1]);
    if (!prev || l.t > prev.t) last.set(m[1], { t: l.t, take });
  }
  const out = new Map<string, string>();
  for (const [id, v] of last) if (v.take) out.set(id, v.t);
  return out;
}
