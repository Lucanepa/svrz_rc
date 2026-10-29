// The Bluetooth protocol of DJI's Osmo Action cameras (Action 4, 5 Pro, 6 and
// the Osmo 360): what DJI's own GPS Bluetooth remote speaks. DJI documents it
// for remote makers in https://github.com/dji-sdk/Osmo-GPS-Controller-Demo
// (docs/protocol.md, docs/protocol_data_segment.md, docs/Q&A.md). This file is
// written from those documents; none of the demo's code is copied.
//
// Pure: bytes in, bytes out, no Bluetooth. The link lives in osmoLink.ts and
// the conversation with the camera in osmoCamera.ts, so the rule spec runs this
// under Node against the frames DJI publishes.
//
// A frame, little-endian throughout:
//
//   0   SOF        0xAA
//   1   Ver/Length bits 15..10 version (0), bits 9..0 the WHOLE frame's length
//   3   CmdType    bit 5: 0 a command, 1 a response; bits 4..0 whether a
//                  reply is wanted (0 no, 1 if it comes, 2 required)
//   4   ENC        0: not encrypted (the only kind sent here)
//   5   RES        3 bytes, 0
//   8   SEQ        a reply carries the SEQ of the frame it answers
//   10  CRC-16     over bytes 0..9
//   12  CmdSet, CmdId, then the payload
//   n-4 CRC-32     over bytes 0..n-5
//
// Both checksums are the reflected table CRCs (CRC-16/ARC's polynomial 0xA001,
// CRC-32's 0xEDB88320) started at 0x3AA3 and not inverted at the end.

/** The camera's GATT service, the characteristic it notifies on, and the one
 *  it is written to (docs/Q&A.md §1). */
export const OSMO_SERVICE = 0xfff0;
export const OSMO_NOTIFY = 0xfff4;
export const OSMO_WRITE = 0xfff5;
/** As 128-bit strings, for the installed app's plugin. */
export const uuid16 = (n: number): string => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

/** A supported camera advertises manufacturer data that starts AA 08 .. .. FA
 *  (Q&A §4). Bluetooth reads the first two bytes as the company identifier,
 *  little-endian; the rest is the data. */
export const DJI_COMPANY_ID = 0x08aa;
export function isOsmoAdvert(manufacturer: Record<number, ArrayLike<number>> | undefined | null): boolean {
  const data = manufacturer?.[DJI_COMPANY_ID];
  return !!data && data.length >= 3 && data[2] === 0xfa;
}

export const CMD_TYPE = {
  /** A command, no reply wanted. */
  noReply: 0x00,
  /** A command, a reply if the camera sends one. */
  replyIfAny: 0x01,
  /** A command, a reply required. */
  replyRequired: 0x02,
  /** A response, no reply wanted. */
  response: 0x20,
} as const;
export const isResponse = (cmdType: number): boolean => (cmdType & 0x20) !== 0;

/** [CmdSet, CmdId] of everything this app sends or reads. */
export const CMD = {
  connect: [0x00, 0x19],
  key: [0x00, 0x11],
  power: [0x00, 0x1a],
  status: [0x1d, 0x02],
  record: [0x1d, 0x03],
  mode: [0x1d, 0x04],
  subscribe: [0x1d, 0x05],
} as const;

/** The modes a clip can be recorded in without switching (video of some kind). */
export const MODE_VIDEO = 0x01;
const VIDEO_MODES = new Set([0x00 /* slow motion */, 0x01 /* video */, 0x28 /* SuperNight */, 0x34 /* subject tracking */]);
export const isVideoMode = (mode: number): boolean => VIDEO_MODES.has(mode);

/** camera_status in the status push. */
export const CAMERA_STATUS = { screenOff: 0x00, live: 0x01, playback: 0x02, shooting: 0x03, preRecording: 0x05 } as const;
/** power_mode in the status push. */
export const POWER_SLEEP = 3;

// ── checksums ────────────────────────────────────────────────────────────

function table(poly: number): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ poly : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const T16 = table(0xa001);
const T32 = table(0xedb88320);
const CRC_INIT = 0x3aa3;

export function crc16(bytes: ArrayLike<number>, length = bytes.length): number {
  let c = CRC_INIT;
  for (let i = 0; i < length; i += 1) c = (T16[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) & 0xffff;
  return c;
}

export function crc32(bytes: ArrayLike<number>, length = bytes.length): number {
  let c = CRC_INIT;
  for (let i = 0; i < length; i += 1) c = (T32[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return c >>> 0;
}

// ── frames ───────────────────────────────────────────────────────────────

export type OsmoFrame = { cmdType: number; seq: number; cmdSet: number; cmdId: number; payload: Uint8Array };

const HEAD = 12;      // SOF .. CRC-16
const MIN_FRAME = 16; // a frame with no DATA at all
const MAX_FRAME = 0x3ff;

export function buildFrame(f: OsmoFrame): Uint8Array {
  const length = HEAD + 2 + f.payload.length + 4;
  if (length > MAX_FRAME) throw new Error('osmo frame too long');
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  out[0] = 0xaa;
  view.setUint16(1, length & MAX_FRAME, true);
  out[3] = f.cmdType;
  // 4 ENC and 5..7 RES stay 0.
  view.setUint16(8, f.seq & 0xffff, true);
  view.setUint16(10, crc16(out, 10), true);
  out[12] = f.cmdSet;
  out[13] = f.cmdId;
  out.set(f.payload, 14);
  view.setUint32(length - 4, crc32(out, length - 4), true);
  return out;
}

/** One whole frame, or null when it is not one (length, either checksum). */
export function parseFrame(bytes: Uint8Array): OsmoFrame | null {
  if (bytes.length < MIN_FRAME || bytes[0] !== 0xaa) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint16(1, true) & MAX_FRAME;
  if (length !== bytes.length) return null;
  if (view.getUint16(10, true) !== crc16(bytes, 10)) return null;
  if (view.getUint32(length - 4, true) !== crc32(bytes, length - 4)) return null;
  if (length < HEAD + 2 + 4) return null; // no CmdSet/CmdId: nothing this app reads
  return {
    cmdType: bytes[3],
    seq: view.getUint16(8, true),
    cmdSet: bytes[12],
    cmdId: bytes[13],
    payload: bytes.slice(14, length - 4),
  };
}

/**
 * Turns the notifications into frames. A frame may come in pieces when the
 * link's MTU is small, and the Action 5 Pro also notifies frames that start
 * with 0x55, which are not for remotes (Q&A §13). So: bytes are buffered, a
 * frame starts at an 0xAA whose header checksum holds, and anything else is
 * dropped a byte at a time until the next 0xAA.
 */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: ArrayLike<number>): OsmoFrame[] {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.length);
    let buf = next;
    const out: OsmoFrame[] = [];
    for (;;) {
      const start = buf.indexOf(0xaa);
      if (start < 0) { buf = new Uint8Array(0); break; }
      if (start > 0) buf = buf.slice(start);
      if (buf.length < HEAD) break;
      const length = (buf[1] | (buf[2] << 8)) & MAX_FRAME;
      const headOk = length >= MIN_FRAME && (buf[10] | (buf[11] << 8)) === crc16(buf, 10);
      if (!headOk) { buf = buf.slice(1); continue; }
      if (buf.length < length) break;
      const frame = parseFrame(buf.slice(0, length));
      if (frame) { out.push(frame); buf = buf.slice(length); } else buf = buf.slice(1);
    }
    // A link that only ever sends noise must not grow the buffer for ever.
    this.buf = buf.length > 4 * MAX_FRAME ? new Uint8Array(0) : buf;
    return out;
  }

  reset(): void { this.buf = new Uint8Array(0); }
}

// ── payloads ─────────────────────────────────────────────────────────────

/** The connection request (00 19), both ways: the remote sends it first, the
 *  camera answers it with one of its own whose verify_mode is 2. */
export type ConnectRequest = {
  /** The remote's own id. */
  deviceId: number;
  /** The remote's MAC, 6 bytes. The camera keeps its pairing under it. */
  mac: Uint8Array;
  /** 0: the camera does not offer the remote a firmware update. */
  fwVersion: number;
  /** 0 a remote the camera knows (it asks only if it lost the pairing),
   *  1 a first pairing (the camera shows the code to confirm),
   *  2 the camera's answer. */
  verifyMode: number;
  /** The code the camera shows (modes 0/1); in the camera's answer 0 means
   *  allowed and 1 refused. */
  verifyData: number;
};

const CONNECT_REQUEST_LENGTH = 33; // u32 id, u8 len, 16 mac, u32 fw, u8 conidx, u8 mode, u16 data, 4 reserved

export function connectRequestPayload(r: ConnectRequest): Uint8Array {
  const out = new Uint8Array(CONNECT_REQUEST_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint32(0, r.deviceId >>> 0, true);
  const mac = r.mac.slice(0, 16);
  out[4] = mac.length;
  out.set(mac, 5);
  view.setUint32(21, r.fwVersion >>> 0, true);
  // 25 conidx stays 0.
  out[26] = r.verifyMode;
  view.setUint16(27, r.verifyData & 0xffff, true);
  return out;
}

export function parseConnectRequest(p: Uint8Array): ConnectRequest | null {
  if (p.length < CONNECT_REQUEST_LENGTH) return null;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const len = Math.min(p[4], 16);
  return {
    deviceId: view.getUint32(0, true),
    mac: p.slice(5, 5 + len),
    fwVersion: view.getUint32(21, true),
    verifyMode: p[26],
    verifyData: view.getUint16(27, true),
  };
}

/** The response to a connection request: u32 device id, u8 return code, 4
 *  reserved bytes of which the first is the camera's index (0: one camera). */
export function connectResponsePayload(deviceId: number, retCode = 0, cameraIndex = 0): Uint8Array {
  const out = new Uint8Array(9);
  new DataView(out.buffer).setUint32(0, deviceId >>> 0, true);
  out[4] = retCode;
  out[5] = cameraIndex;
  return out;
}

export function parseConnectResponse(p: Uint8Array): { deviceId: number; retCode: number; cameraIndex: number } | null {
  if (p.length < 5) return null;
  return { deviceId: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true), retCode: p[4], cameraIndex: p[5] ?? 0 };
}

/** The device ids DJI's demo puts into the record and mode commands. */
const RECORD_DEVICE_ID = 0x33ff0000;
const MODE_DEVICE_ID = 0xff330000;

/** Record control (1D 03): start or stop. */
export function recordPayload(start: boolean): Uint8Array {
  const out = new Uint8Array(9);
  new DataView(out.buffer).setUint32(0, RECORD_DEVICE_ID, true);
  out[4] = start ? 0 : 1;
  return out;
}

/** Mode switch (1D 04). */
export function modePayload(mode: number): Uint8Array {
  const out = new Uint8Array(9);
  new DataView(out.buffer).setUint32(0, MODE_DEVICE_ID, true);
  out[4] = mode;
  return out;
}

/** Status subscription (1D 05): 3 = periodic and on every change; 20 = 2 Hz,
 *  the only rate the camera takes. */
export function subscribePayload(pushMode = 3, freq = 20): Uint8Array {
  return Uint8Array.of(pushMode, freq, 0, 0, 0, 0);
}

/** The first byte of most responses: 0 is success. */
export const retCode = (p: Uint8Array): number => (p.length ? p[0] : -1);

/** The camera status push (1D 02), the fields this app shows or acts on. */
export type OsmoStatus = {
  mode: number;
  cameraStatus: number;
  /** Seconds, pre-recording included. */
  recordTime: number;
  /** MB left on the card. */
  remainMb: number;
  /** Seconds of video left on the card. */
  remainSeconds: number;
  powerMode: number;
  /** 0 normal, 1 warm, 2 too hot to record, 3 shutting down. */
  temperature: number;
  /** 0..100, or -1 when the push is too short to carry it. */
  battery: number;
};

export function parseStatus(p: Uint8Array): OsmoStatus | null {
  if (p.length < 31) return null;
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    mode: p[0],
    cameraStatus: p[1],
    recordTime: view.getUint16(5, true),
    remainMb: view.getUint32(15, true),
    remainSeconds: view.getUint32(23, true),
    powerMode: p[28],
    temperature: p[30],
    battery: p.length >= 38 ? p[37] : -1,
  };
}

export const isRecording = (s: OsmoStatus | null): boolean => !!s && s.cameraStatus === CAMERA_STATUS.shooting;
/** Pre-Rec armed: the camera buffers, and a record start keeps the seconds before it. */
export const isPreRecording = (s: OsmoStatus | null): boolean => !!s && s.cameraStatus === CAMERA_STATUS.preRecording;
