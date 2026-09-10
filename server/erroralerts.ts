// Mails the operator when the app breaks.
//
// The log records everything, but nobody reads a log they have no reason to
// open — the failures that matter are exactly the ones nobody reports (a cron
// that died at 05:00, a 500 on a submit somebody gave up on). This watches the
// same stream the store writes and pushes the error half out by e-mail.
//
// Everything here is about NOT becoming noise, because an alert channel that
// cries wolf is worse than none:
//   • one digest, not one mail per line — errors arrive in bursts;
//   • a per-CLASS cooldown, so a failure repeating 400 times mails once;
//   • an hourly ceiling, so a loop cannot mail the operator out of their inbox;
//   • the admin console's mute rules apply here too — muting the noise in the
//     UI silences the alert about it, which is what a reader expects;
//   • it never throws into record(), and never alerts about its own failures.

import { onEntry, type LogEntry } from './logstore.ts';
import { entryGroup, readNotes, type MuteRule } from './logquery.ts';

export type AlertMailer = (message: { to: string; subject: string; text: string; html: string }) => Promise<unknown>;

type Options = {
  send: AlertMailer;
  /** Comma-separated. Unset disables alerting entirely. */
  to: string;
  /** Where a reader should go to see the rest. */
  consoleUrl: string;
  suppressed?: boolean;
  /** The zone the mail's timestamps are written in. */
  timezone?: string;
  debounceMs?: number;
  cooldownMs?: number;
  maxPerHour?: number;
  log: (level: 'info' | 'warn' | 'error', evt: string, msg: string, data?: Record<string, unknown>) => void;
};

type Pending = {
  group: string;
  count: number;
  first: LogEntry;
  last: LogEntry;
  users: Set<string>;
  sessions: Set<string>;
};

const MAX_GROUPS_PER_MAIL = 12;
const MAX_PENDING_GROUPS = 60;

// The mail is written in English. Every other mail this app sends goes to a
// referee or a coach and is German; this one goes to whoever operates the
// server, and its content — event names, stack data, reqIds — is English
// anyway. Only the clock stays local, and it is the caller's zone (the same
// VM_SYNC_TIMEZONE the schedules and the iCal feed use) rather than the
// process's own, so a mail and the log console can never name one moment two
// different ways.
const FALLBACK_TIMEZONE = 'Europe/Zurich';

export function installErrorAlerts(opts: Options): void {
  const recipients = opts.to.split(',').map((a) => a.trim()).filter(Boolean);
  if (!recipients.length) return;

  const debounceMs = opts.debounceMs ?? 120_000;
  const cooldownMs = opts.cooldownMs ?? 60 * 60 * 1000;
  const maxPerHour = opts.maxPerHour ?? 6;

  const pending = new Map<string, Pending>();
  /** group → when we last mailed about it, and how many we swallowed since. */
  const cooling = new Map<string, { until: number; swallowed: number }>();
  let sentTimestamps: number[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending = false;

  // The mute rules live in a file the admin console writes. Re-read them at
  // most every 30 s: an alert must not cost a disk read per error line, and a
  // rule added in the UI should take effect within about the time it takes to
  // switch windows.
  let rules: MuteRule[] = [];
  let rulesReadAt = 0;
  async function currentRules(): Promise<MuteRule[]> {
    if (Date.now() - rulesReadAt < 30_000) return rules;
    rulesReadAt = Date.now();
    try { rules = (await readNotes()).muteRules.filter((r) => r.enabled); } catch { /* keep the last set */ }
    return rules;
  }

  function isMuted(entry: LogEntry): boolean {
    const msg = (entry.msg || '').toLowerCase();
    return rules.some((r) => {
      if (!r.evt && !r.match && !r.level) return false;
      if (r.level && entry.lvl !== r.level) return false;
      if (r.evt && !entry.evt.toLowerCase().startsWith(r.evt.toLowerCase())) return false;
      if (r.match && !msg.includes(r.match.toLowerCase())) return false;
      return true;
    });
  }

  function describe(entry: LogEntry): string {
    let data = '';
    try {
      const json = JSON.stringify(entry.data ?? {}, null, 2);
      if (json && json !== '{}') data = json.length > 1_200 ? `${json.slice(0, 1_200)}\n…` : json;
    } catch { /* unserializable payloads are not worth an alert failing over */ }
    return data;
  }

  // Timestamps stay on the region's wall clock — an operator reading this at
  // the hall compares it against the log console, which shows the same clock.
  const zone = opts.timezone || FALLBACK_TIMEZONE;
  function stamp(t: number | string | Date): string {
    return new Date(t).toLocaleString('en-GB', { timeZone: zone, hour12: false });
  }

  /** A burst that started and ended in the same second is one moment, not a
   *  range: printing "10/09/2026, 18:33:13 → 10/09/2026, 18:33:13" made the
   *  reader parse two timestamps to learn there was only one. */
  function when(first: number | string | Date, last: number | string | Date): string {
    const [firstDay, firstTime] = stamp(first).split(', ');
    const [lastDay, lastTime] = stamp(last).split(', ');
    if (firstDay === lastDay && firstTime === lastTime) return `${firstDay} ${firstTime}`;
    if (firstDay === lastDay) return `${firstDay} ${firstTime} → ${lastTime}`;
    return `${firstDay} ${firstTime} → ${lastDay} ${lastTime}`;
  }

  // The log files a name the ingest endpoint could not tie to a session as
  // `unverified:<name>` — /api/client-logs takes no session on purpose (a
  // beacon fires after logout), so an anonymous POST must not be able to file
  // lines under a real coach's name. That marker is a property of the ingest,
  // not of the person, and reading it in an alert only ever raised the wrong
  // question: for months half of every coach's lines carried it simply because
  // the browser shipped the batch without its cookie. The entry keeps it — the
  // Protokoll can still be searched for it — the mail shows the person.
  const UNVERIFIED = 'unverified:';
  function people(users: Set<string>): string[] {
    const names = new Set<string>();
    for (const u of users) {
      const name = u.startsWith(UNVERIFIED) ? u.slice(UNVERIFIED.length) : u;
      if (name) names.add(name);
    }
    return [...names];
  }

  function esc(value: string): string {
    return value.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
  }

  // Inline styles and tables only, and every colour stated outright: a mail
  // has no stylesheet, no fonts of its own, and a client that decides to
  // invert an unstated background is how an alert arrives unreadable.
  const C = {
    page: '#f5f5f4', card: '#ffffff', line: '#e7e5e4', ink: '#1c1917',
    mute: '#78716c', app: '#4f46e5', red: '#dc2626', code: '#292524',
  };
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

  function chip(text: string, color: string, background: string): string {
    return `<span style="display:inline-block;padding:2px 7px;border-radius:6px;font:600 11px/1.6 ${MONO};color:${color};background:${background};white-space:nowrap">${esc(text)}</span>`;
  }

  function card(g: Pending): string {
    const e = g.last;
    const source = e.src === 'client' ? 'App' : 'Server';
    const meta: string[] = [esc(when(g.first.t, e.t))];
    const names = people(g.users);
    if (names.length) meta.push(esc(names.slice(0, 8).join(', ')));
    if (g.sessions.size) meta.push(`Session ${esc([...g.sessions].slice(0, 5).join(', '))}`);
    if (e.reqId) meta.push(`reqId ${esc(e.reqId)}`);
    const data = describe(e);
    return [
      `<tr><td style="padding:0 0 12px">`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${C.line};border-left:3px solid ${C.red};border-radius:10px">`,
      `<tr><td style="padding:14px 16px">`,
      `<div style="margin:0 0 8px">`,
      `${g.count > 1 ? `${chip(`${g.count}×`, '#ffffff', C.ink)}&nbsp;` : ''}`,
      `${chip(source, e.src === 'client' ? C.app : C.mute, C.page)}&nbsp;`,
      `<span style="font:600 12px/1.6 ${MONO};color:${C.mute}">${esc(e.evt)}</span>`,
      `</div>`,
      `<div style="font:500 15px/1.45 ${FONT};color:${C.ink};word-break:break-word">${esc(e.msg || '(no message)')}</div>`,
      `<div style="margin-top:8px;font:400 12px/1.7 ${FONT};color:${C.mute};word-break:break-word">${meta.join(' &nbsp;·&nbsp; ')}</div>`,
      data ? `<pre style="margin:12px 0 0;padding:10px 12px;background:${C.code};color:#e7e5e4;border-radius:8px;font:400 11px/1.6 ${MONO};white-space:pre-wrap;word-break:break-word">${esc(data)}</pre>` : '',
      `</td></tr></table></td></tr>`,
    ].join('');
  }

  function compose(groups: Pending[], swallowed: number): { subject: string; text: string; html: string } {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const head = groups[0];
    const headline = `${head.last.evt}: ${head.last.msg || '(no message)'}`.slice(0, 90);
    const subject = groups.length === 1 && total === 1
      ? `[SVRZ RC] Error — ${headline}`
      : `[SVRZ RC] ${total} errors in ${groups.length} ${groups.length === 1 ? 'kind' : 'kinds'} — ${headline}`;
    const shown = groups.slice(0, MAX_GROUPS_PER_MAIL);
    const hidden = groups.length - shown.length;
    const summary = `${total} error${total === 1 ? '' : 's'} in ${groups.length} ${groups.length === 1 ? 'kind' : 'kinds'}`
      + `${swallowed ? `, ${swallowed} more suppressed by the cooldown` : ''}`;

    // The plain-text half is not a fallback nobody reads: it is what a phone
    // notification previews, and what the terminal shows when the mail is
    // piped through anything at all. Same content, same order.
    const lines: string[] = [`${summary}, in the last few minutes.`, ''];
    for (const g of shown) {
      const e = g.last;
      lines.push(
        `── ${g.count}× ${e.src === 'client' ? 'App' : 'Server'} · ${e.evt}`,
        `   ${e.msg || '(no message)'}`,
        `   ${when(g.first.t, e.t)}`,
      );
      const names = people(g.users);
      if (names.length) lines.push(`   People: ${names.slice(0, 8).join(', ')}`);
      if (g.sessions.size) lines.push(`   Sessions: ${[...g.sessions].slice(0, 5).join(', ')}`);
      if (e.reqId) lines.push(`   reqId: ${e.reqId}`);
      const data = describe(e);
      if (data) lines.push(data.split('\n').map((l) => `   ${l}`).join('\n'));
      lines.push('');
    }
    if (hidden) lines.push(`… and ${hidden} more error kind${hidden === 1 ? '' : 's'}.`, '');
    lines.push(
      `Everything in the log: ${opts.consoleUrl}`,
      '',
      'This message comes from the server itself. If the same error repeats, it',
      'reports again in an hour at the earliest; a whole error kind can be muted',
      'in the admin console.',
    );

    const html = [
      `<div style="margin:0;padding:20px 12px;background:${C.page};color-scheme:light">`,
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto">`,
      `<tr><td style="padding:0 0 14px">`,
      `<div style="font:600 11px/1.6 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${C.mute}">SVRZ Referee Coaching</div>`,
      `<div style="font:600 20px/1.35 ${FONT};color:${C.ink};margin-top:2px">${esc(summary)}</div>`,
      `<div style="font:400 13px/1.6 ${FONT};color:${C.mute}">in the last few minutes</div>`,
      `</td></tr>`,
      shown.map(card).join(''),
      hidden ? `<tr><td style="padding:0 0 12px;font:400 13px/1.6 ${FONT};color:${C.mute}">… and ${hidden} more error kind${hidden === 1 ? '' : 's'} in the console.</td></tr>` : '',
      `<tr><td style="padding:4px 0 0">`,
      `<a href="${esc(opts.consoleUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${C.ink};color:#ffffff;font:600 13px/1 ${FONT};text-decoration:none">Open the log</a>`,
      `</td></tr>`,
      `<tr><td style="padding:14px 0 0;font:400 12px/1.7 ${FONT};color:${C.mute}">`,
      `This message comes from the server itself. If the same error repeats it reports again in an hour at the earliest, and a whole error kind can be muted in the admin console.`,
      `</td></tr></table></div>`,
    ].join('');

    return { subject, text: lines.join('\n'), html };
  }

  async function flush(): Promise<void> {
    timer = null;
    if (!pending.size || sending) return;

    // Hourly ceiling. Keep the buffer rather than dropping it: whatever is
    // still pending goes out with the next mail the budget allows.
    const hourAgo = Date.now() - 60 * 60 * 1000;
    sentTimestamps = sentTimestamps.filter((t) => t > hourAgo);
    if (sentTimestamps.length >= maxPerHour) {
      schedule(15 * 60 * 1000);
      return;
    }

    const groups = [...pending.values()].sort((a, b) => b.count - a.count);
    pending.clear();
    const swallowed = [...cooling.values()].reduce((sum, c) => sum + c.swallowed, 0);
    for (const c of cooling.values()) c.swallowed = 0;

    const { subject, text, html } = compose(groups, swallowed);
    // TEST_MODE suppresses every outbound mail in this app; an alert is no
    // exception, but it still says what it would have sent, so a test run shows
    // the alerting works without mailing anyone.
    if (opts.suppressed) {
      opts.log('warn', 'alert.suppressed', `TEST_MODE — not mailed: ${subject}`, { groups: groups.length });
      return;
    }
    sending = true;
    try {
      await opts.send({ to: recipients.join(', '), subject, text, html });
      sentTimestamps.push(Date.now());
      opts.log('info', 'alert.sent', `error alert mailed (${groups.length} group(s))`, { groups: groups.length, recipients: recipients.length });
    } catch (error) {
      // Logged under `alert.` so it cannot trigger an alert about the alert.
      opts.log('error', 'alert.send', 'could not mail the error alert', { error: String(error) });
    } finally {
      sending = false;
    }
  }

  function schedule(ms: number): void {
    if (timer) return;
    timer = setTimeout(() => { void flush(); }, ms);
    timer.unref?.();
  }

  onEntry((entry) => {
    if (entry.lvl !== 'error') return;
    // Never alert about the alerting itself, and never about a class the admin
    // console has muted.
    if (entry.evt.startsWith('alert.')) return;
    void currentRules();
    if (isMuted(entry)) return;

    const group = entryGroup(entry);

    // Already in the digest being assembled: count it there. The cooldown is
    // about not mailing the SAME thing again an hour later — inside one mail,
    // occurrences two to four hundred are the interesting part, and swallowing
    // them cost the digest the second and third person it happened to.
    const existing = pending.get(group);
    if (existing) {
      existing.count++;
      existing.last = entry;
      if (entry.user) existing.users.add(entry.user);
      if (entry.sid) existing.sessions.add(entry.sid);
      schedule(debounceMs);
      return;
    }

    const cool = cooling.get(group);
    if (cool && Date.now() < cool.until) { cool.swallowed++; return; }
    // One entry per failure class, and a long-lived process meets a lot of
    // distinct classes. Drop the expired ones once the map gets big rather than
    // holding every message shape the app has ever produced.
    if (cooling.size > 500) {
      for (const [key, value] of cooling) if (Date.now() >= value.until && !value.swallowed) cooling.delete(key);
    }
    cooling.set(group, { until: Date.now() + cooldownMs, swallowed: 0 });

    if (pending.size < MAX_PENDING_GROUPS) {
      pending.set(group, {
        group,
        count: 1,
        first: entry,
        last: entry,
        users: new Set(entry.user ? [entry.user] : []),
        sessions: new Set(entry.sid ? [entry.sid] : []),
      });
    }
    schedule(debounceMs);
  });

  // Prime the mute rules now rather than on the first error: the read is async,
  // so an error arriving before it lands would be checked against an empty set —
  // and the one class you muted precisely because it fires at startup is the
  // one that would slip through.
  void currentRules();

  opts.log('info', 'alert.installed', `error alerts to ${recipients.length} recipient(s)`, {
    debounceMs, cooldownMs, maxPerHour, suppressed: Boolean(opts.suppressed),
  });
}
