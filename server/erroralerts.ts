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

export type AlertMailer = (message: { to: string; subject: string; text: string }) => Promise<unknown>;

type Options = {
  send: AlertMailer;
  /** Comma-separated. Unset disables alerting entirely. */
  to: string;
  /** Where a reader should go to see the rest. */
  consoleUrl: string;
  suppressed?: boolean;
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
// anyway. Only the clock stays local.
const ALERT_TIMEZONE = process.env.TZ || 'Europe/Zurich';

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
  function stamp(t: number | string | Date): string {
    return new Date(t).toLocaleString('en-GB', { timeZone: ALERT_TIMEZONE, hour12: false });
  }

  function compose(groups: Pending[], swallowed: number): { subject: string; text: string } {
    const total = groups.reduce((sum, g) => sum + g.count, 0);
    const head = groups[0];
    const headline = `${head.last.evt}: ${head.last.msg || '(no message)'}`.slice(0, 90);
    const subject = groups.length === 1 && total === 1
      ? `[SVRZ RC] Error — ${headline}`
      : `[SVRZ RC] ${total} errors in ${groups.length} ${groups.length === 1 ? 'kind' : 'kinds'} — ${headline}`;

    const lines: string[] = [
      `${total} error${total === 1 ? '' : 's'}${swallowed ? ` (+${swallowed} more suppressed, see cooldown)` : ''} in the last few minutes.`,
      '',
    ];
    for (const g of groups.slice(0, MAX_GROUPS_PER_MAIL)) {
      const e = g.last;
      lines.push(
        `── ${g.count}× ${e.src === 'client' ? 'App' : 'Server'} · ${e.evt}`,
        `   ${e.msg || '(no message)'}`,
        `   first ${stamp(g.first.t)} · last ${stamp(e.t)}`,
      );
      if (g.users.size) lines.push(`   People: ${[...g.users].slice(0, 8).join(', ')}`);
      if (g.sessions.size) lines.push(`   Sessions: ${[...g.sessions].slice(0, 5).join(', ')}`);
      if (e.reqId) lines.push(`   reqId: ${e.reqId}`);
      const data = describe(e);
      if (data) lines.push(data.split('\n').map((l) => `   ${l}`).join('\n'));
      lines.push('');
    }
    if (groups.length > MAX_GROUPS_PER_MAIL) {
      lines.push(`… and ${groups.length - MAX_GROUPS_PER_MAIL} more error kinds.`, '');
    }
    lines.push(
      `Everything in the log: ${opts.consoleUrl}`,
      '',
      'This message comes from the server itself. If the same error repeats, it',
      'reports again in an hour at the earliest; a whole error kind can be muted',
      'in the admin console.',
    );
    return { subject, text: lines.join('\n') };
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

    const { subject, text } = compose(groups, swallowed);
    // TEST_MODE suppresses every outbound mail in this app; an alert is no
    // exception, but it still says what it would have sent, so a test run shows
    // the alerting works without mailing anyone.
    if (opts.suppressed) {
      opts.log('warn', 'alert.suppressed', `TEST_MODE — not mailed: ${subject}`, { groups: groups.length });
      return;
    }
    sending = true;
    try {
      await opts.send({ to: recipients.join(', '), subject, text });
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
