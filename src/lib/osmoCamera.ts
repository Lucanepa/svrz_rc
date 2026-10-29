// The conversation with one Osmo Action camera over the link of osmoLink.ts:
// the handshake, the status the camera pushes twice a second, and a clip —
// the seconds the camera's Pre-Rec buffered before the tap, saved. One camera at a time, for the whole app; the notebook
// reads it through subscribeCamera()/cameraState().
//
// The handshake (docs/protocol_data_segment.md, "Connection request 0019"):
// 1. the remote sends a connection request with its id, a MAC, and a code;
// 2. the camera may answer it (a response, return code 0), and then sends a
//    connection request of its own with verify_mode 2 — verify_data 0 once the
//    coach allowed it on the camera's screen (first time only), 1 refused;
// 3. the remote answers that request with the camera's SEQ, and is connected.
// Then the status is subscribed (2 Hz and on every change).
//
// The remote's id and MAC are made up once per device and kept: the camera
// keeps its pairing under them, so the second evening needs no tap.

import {
  CMD, CMD_TYPE, FrameReader, POWER_SLEEP, buildFrame, connectRequestPayload, connectResponsePayload,
  isPreRecording, isRecording, isResponse, parseConnectRequest, parseConnectResponse, parseStatus,
  recordPayload, retCode, subscribePayload, type OsmoFrame, type OsmoStatus,
} from './osmoProtocol';
import { OsmoError, type OsmoErrorCode, type OsmoLink, type Transport } from './osmoLink';
import { clientLog } from './logger';

export type CameraPhase = 'off' | 'connecting' | 'confirm' | 'ready' | 'reconnecting';
export type CameraState = {
  phase: CameraPhase;
  /** The camera's Bluetooth name, '' when none was picked. */
  name: string;
  /** The code the camera shows on a first pairing. */
  code: number;
  status: OsmoStatus | null;
  /** A clip being saved: the moment of the tap. */
  clip: { startedAt: number; seconds: number } | null;
  /** What last went wrong, for the sentence under the button. */
  error: OsmoErrorCode | null;
  /** The camera's Pre-Rec length in seconds, 0 while not known. The protocol
   *  has no setting to read: a clip's start says it (the recording clock
   *  counts the buffered seconds), and it is kept per camera from then on. */
  preSeconds: number;
};

const ID_KEY = 'svrz_osmo_id';
const PAIRED_KEY = 'svrz_osmo_paired';
const HANDSHAKE_REPLY_MS = 3_000;
/** The coach has to find the camera and tap it on a first pairing. */
const HANDSHAKE_CONFIRM_MS = 60_000;
const COMMAND_MS = 5_000;
/** A camera drops the link while its menus are open (Pre-Rec, settings):
 *  keep trying, quickly at first, for as long as a coach would be in there. */
const RECONNECT_DELAYS = [1_500, 3_000, 5_000];
const RECONNECT_EVERY_MS = 5_000;
const RECONNECT_FOR_MS = 10 * 60_000;
const PRE_KEY = 'svrz_osmo_pre';

const OFF: CameraState = { phase: 'off', name: '', code: 0, status: null, clip: null, error: null, preSeconds: 0 };
let state: CameraState = OFF;
const listeners = new Set<() => void>();

export const cameraState = (): CameraState => state;
export function subscribeCamera(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function set(patch: Partial<CameraState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

/** A trace of every frame, for the test page and a bug report — never shipped. */
export type TraceLine = { at: number; dir: 'tx' | 'rx' | 'note'; text: string };
let trace: ((line: TraceLine) => void) | null = null;
export function setCameraTrace(fn: ((line: TraceLine) => void) | null): void { trace = fn; }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const note = (text: string) => trace?.({ at: Date.now(), dir: 'note', text });

function readJson<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage refused: a first pairing again next time */ }
}

/** This device as a remote: a random id and a random, locally administered MAC. */
function identity(): { deviceId: number; mac: Uint8Array } {
  const kept = readJson<{ d: number; m: number[] } | null>(ID_KEY, null);
  if (kept && Number.isInteger(kept.d) && Array.isArray(kept.m) && kept.m.length === 6) return { deviceId: kept.d >>> 0, mac: Uint8Array.from(kept.m) };
  const r = crypto.getRandomValues(new Uint8Array(10));
  const deviceId = new DataView(r.buffer).getUint32(0, true);
  const mac = r.slice(4, 10);
  mac[0] = (mac[0] & 0xfc) | 0x02; // unicast, locally administered
  writeJson(ID_KEY, { d: deviceId, m: Array.from(mac) });
  return { deviceId, mac };
}
const pairedWith = (): string[] => readJson<string[]>(PAIRED_KEY, []);
function rememberPaired(key: string): void {
  const list = pairedWith().filter((k) => k !== key);
  writeJson(PAIRED_KEY, [key, ...list].slice(0, 8));
}

type Pending = { set: number; id: number; resolve: (f: OsmoFrame | null) => void; timer: ReturnType<typeof setTimeout> };

class Session {
  private reader = new FrameReader();
  private seq = crypto.getRandomValues(new Uint16Array(1))[0] & 0x7fff;
  private pending = new Map<number, Pending>();
  private cameraConnect: ((f: OsmoFrame) => void) | null = null;
  link: OsmoLink | null = null;
  ended = false;

  constructor(public transport: Transport) {}

  onData(bytes: Uint8Array): void {
    trace?.({ at: Date.now(), dir: 'rx', text: hex(bytes) });
    for (const f of this.reader.push(bytes)) this.route(f);
  }

  private route(f: OsmoFrame): void {
    if (isResponse(f.cmdType)) {
      const p = this.pending.get(f.seq);
      if (p && p.set === f.cmdSet && p.id === f.cmdId) {
        this.pending.delete(f.seq);
        clearTimeout(p.timer);
        p.resolve(f);
      }
      return;
    }
    if (f.cmdSet === CMD.status[0] && f.cmdId === CMD.status[1]) {
      const s = parseStatus(f.payload);
      if (!s) return;
      // Into the activity log when what the camera is doing changes — counts
      // and modes only. What it reports while waiting in Pre-Rec is how the
      // buffer's length might be read before the first clip.
      const prev = state.status;
      if (!prev || prev.cameraStatus !== s.cameraStatus || prev.mode !== s.mode || prev.powerMode !== s.powerMode) {
        clientLog.info('osmo.status', 'camera status changed', { mode: s.mode, cameraStatus: s.cameraStatus, recordTime: s.recordTime, powerMode: s.powerMode, battery: s.battery, temperature: s.temperature });
      }
      // Waiting in Pre-Rec, the clock may count the buffer as it fills: its
      // highest value is then the setting. A clip's own count overrides it.
      if (isPreRecording(s) && s.recordTime > state.preSeconds && s.recordTime <= 600 && !preMeasured) set({ status: s, preSeconds: s.recordTime });
      else set({ status: s });
      return;
    }
    if (f.cmdSet === CMD.connect[0] && f.cmdId === CMD.connect[1]) this.cameraConnect?.(f);
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** Sends a command. With a reply wanted, resolves with the response, or with
   *  null when none came in `ms`. */
  async send(cmd: readonly [number, number], payload: Uint8Array, cmdType: number, ms = COMMAND_MS, seq = this.nextSeq()): Promise<OsmoFrame | null> {
    if (!this.link) throw new OsmoError('link');
    const frame = buildFrame({ cmdSet: cmd[0], cmdId: cmd[1], cmdType, seq, payload });
    const wantsReply = cmdType === CMD_TYPE.replyRequired || cmdType === CMD_TYPE.replyIfAny;
    const reply = wantsReply
      ? new Promise<OsmoFrame | null>((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(seq); resolve(null); }, ms);
        this.pending.set(seq, { set: cmd[0], id: cmd[1], resolve, timer });
      })
      : Promise.resolve(null);
    trace?.({ at: Date.now(), dir: 'tx', text: hex(frame) });
    try {
      await this.link.write(frame, wantsReply);
    } catch (e) {
      const p = this.pending.get(seq);
      if (p) { clearTimeout(p.timer); this.pending.delete(seq); }
      throw new OsmoError('link', String(e));
    }
    return reply;
  }

  async handshake(onCode: (code: number) => void): Promise<void> {
    const { deviceId, mac } = identity();
    const known = pairedWith().includes(this.transport.key);
    const code = 1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000);
    // Listening before sending: the camera's own request can come first.
    const cameraAsks = new Promise<OsmoFrame | null>((resolve) => {
      const timer = setTimeout(() => { this.cameraConnect = null; resolve(null); }, HANDSHAKE_CONFIRM_MS);
      this.cameraConnect = (f) => {
        const r = parseConnectRequest(f.payload);
        if (!r || r.verifyMode !== 2) return;
        clearTimeout(timer);
        this.cameraConnect = null;
        resolve(f);
      };
    });
    const reply = await this.send(CMD.connect, connectRequestPayload({ deviceId, mac, fwVersion: 0, verifyMode: known ? 0 : 1, verifyData: code }), CMD_TYPE.replyRequired, HANDSHAKE_REPLY_MS);
    const answer = reply ? parseConnectResponse(reply.payload) : null;
    if (answer && answer.retCode !== 0) { note(`connect refused, ret ${answer.retCode}`); throw new OsmoError('refused'); }
    // A known camera answers at once; otherwise it is waiting for a tap.
    onCode(code);
    const asked = await cameraAsks;
    if (!asked) throw new OsmoError('timeout');
    const verdict = parseConnectRequest(asked.payload);
    if (!verdict || verdict.verifyData !== 0) throw new OsmoError('refused');
    await this.send(CMD.connect, connectResponsePayload(deviceId, 0, 0), CMD_TYPE.response, 0, asked.seq);
    rememberPaired(this.transport.key);
    await this.send(CMD.subscribe, subscribePayload(), CMD_TYPE.noReply);
  }

  async close(): Promise<void> {
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    this.pending.clear();
    const link = this.link;
    this.link = null;
    await link?.close();
  }
}

let session: Session | null = null;
/** The Pre-Rec length came from a clip on this connection: the standby clock no longer overrides it. */
let preMeasured = false;
/** A clip that was started and could not be stopped (the link dropped): it is
 *  stopped as soon as the camera is back. */
let stopOwed = false;

async function openSession(s: Session, first: boolean): Promise<void> {
  s.link = await s.transport.open({
    onData: (b) => s.onData(b),
    onClose: () => { if (session === s && !s.ended) void lost(s); },
  });
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  await s.handshake((code) => {
    // Only say "confirm on the camera" when it is visibly waiting for that.
    confirmTimer = setTimeout(() => { if (session === s) set({ phase: 'confirm', code }); }, first ? 600 : 3_000);
  }).finally(() => { if (confirmTimer) clearTimeout(confirmTimer); });
  set({ phase: 'ready', error: null, code: 0, preSeconds: state.preSeconds || keptPre(s.transport.key) });
  if (stopOwed) {
    stopOwed = false;
    await s.send(CMD.record, recordPayload(false), CMD_TYPE.replyIfAny).catch(() => undefined);
  }
}

/** Connects to a camera picked with pickWebCamera() or findNativeCamera(). */
export async function connectCamera(transport: Transport): Promise<void> {
  await disconnectCamera();
  preMeasured = false;
  const s = new Session(transport);
  session = s;
  set({ ...OFF, phase: 'connecting', name: transport.name });
  const t0 = Date.now();
  try {
    await openSession(s, true);
    clientLog.info('osmo.connected', 'camera connected', { ms: Date.now() - t0, known: pairedWith().includes(transport.key) });
  } catch (e) {
    const code = e instanceof OsmoError ? e.code : 'link';
    clientLog.warn('osmo.connect.fail', `camera connect failed: ${code}`, { code, ms: Date.now() - t0 });
    if (session === s) { session = null; await s.close().catch(() => undefined); set({ ...OFF, error: code }); }
    throw e;
  }
}

function keptPre(key: string): number {
  const all = readJson<Record<string, number>>(PRE_KEY, {});
  return Number.isFinite(all[key]) ? all[key] : 0;
}
function keepPre(key: string, seconds: number): void {
  const all = readJson<Record<string, number>>(PRE_KEY, {});
  all[key] = seconds;
  writeJson(PRE_KEY, all);
}

async function lost(s: Session): Promise<void> {
  note('link lost');
  clientLog.info('osmo.lost', 'camera link lost', { recording: !!state.clip });
  if (state.clip) stopOwed = true;
  s.link = null;
  set({ phase: 'reconnecting', status: null, clip: null });
  const until = Date.now() + RECONNECT_FOR_MS;
  for (let attempt = 0; Date.now() < until; attempt += 1) {
    await new Promise((r) => setTimeout(r, RECONNECT_DELAYS[attempt] ?? RECONNECT_EVERY_MS));
    if (session !== s || s.ended) return;
    try {
      await openSession(s, false);
      clientLog.info('osmo.reconnected', 'camera back', { attempt: attempt + 1 });
      return;
    } catch { await s.link?.close().catch(() => undefined); s.link = null; }
  }
  clientLog.warn('osmo.reconnect.fail', 'camera did not come back', {});
  if (session === s) { session = null; set({ ...OFF, error: 'link' }); }
}

export async function disconnectCamera(): Promise<void> {
  const s = session;
  session = null;
  if (s) await s.close().catch(() => undefined);
  set(OFF);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (test()) return true; await sleep(100); }
  return test();
}

/** After the camera says it is recording, this much more before the stop:
 *  the clip is what came BEFORE the tap, and a stop sent at once could reach
 *  a camera still busy starting. */
const TAIL_MS = 1_000;
/** What a clip holds when the camera does not say (its Pre-Rec setting). */
export const DEFAULT_PRE_SECONDS = 10;

/**
 * Saves the last seconds: the camera has to be in Pre-Rec (camera_status 5,
 * set on the camera — the protocol has no command for it), so a record start
 * keeps what it buffered before the tap; it is stopped a moment later and
 * goes back to Pre-Rec by itself. `onSaved` runs as soon as the camera has
 * started, with the moment of the tap — the notebook writes its line then.
 * Resolves when the camera has stopped, with the seconds it kept before the
 * tap (its recording time includes the pre-recording, so it says).
 */
export async function saveClip(onSaved?: (tappedAt: number, preSeconds: number) => void): Promise<{ tappedAt: number; preSeconds: number; stoppedAt: number }> {
  const s = session;
  if (!s || state.phase !== 'ready') throw new OsmoError('link');
  if (state.clip) throw new OsmoError('busy');
  const tappedAt = Date.now();
  // The first push can be a moment behind the handshake.
  if (!state.status) await waitFor(() => !!state.status, 1_000);
  const st = state.status;
  if (st) {
    if (st.powerMode === POWER_SLEEP) throw new OsmoError('asleep');
    if (st.temperature >= 2) throw new OsmoError('too-hot');
    if (isRecording(st)) throw new OsmoError('busy');
    if (!isPreRecording(st)) throw new OsmoError('no-prerec');
    if (st.remainSeconds > 0 && st.remainSeconds < 30) throw new OsmoError('card');
  }
  set({ clip: { startedAt: tappedAt, seconds: 0 } });
  try {
    const started = await s.send(CMD.record, recordPayload(true), CMD_TYPE.replyIfAny);
    if (started && retCode(started.payload) !== 0) throw new OsmoError('record', `ret ${retCode(started.payload)}`);
    const running = await waitFor(() => isRecording(state.status), started ? 1_500 : 2_000);
    if (!started && !running) throw new OsmoError('record', 'no reply');
    // Seconds on the clock the moment it runs: the pre-recording it kept.
    const t = running && state.status ? state.status.recordTime : 0;
    const measured = t >= 1 && t <= 600 ? t : 0;
    const preSeconds = measured || state.preSeconds || DEFAULT_PRE_SECONDS;
    if (measured) { preMeasured = true; keepPre(s.transport.key, measured); set({ preSeconds: measured }); }
    clientLog.info('osmo.clip', 'clip saved', { recordTime: t, reply: !!started, ms: Date.now() - tappedAt });
    onSaved?.(tappedAt, preSeconds);
    await sleep(TAIL_MS);
    if (session !== s || !s.link) { stopOwed = true; throw new OsmoError('link'); }
    await s.send(CMD.record, recordPayload(false), CMD_TYPE.replyIfAny);
    return { tappedAt, preSeconds, stoppedAt: Date.now() };
  } catch (e) {
    clientLog.warn('osmo.clip.fail', `clip failed: ${e instanceof OsmoError ? e.code : 'link'}`, { code: e instanceof OsmoError ? e.code : 'link' });
    throw e;
  } finally {
    if (session === s) set({ clip: null });
  }
}
