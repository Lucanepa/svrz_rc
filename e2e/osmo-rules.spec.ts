import './support/build-globals';
import { test, expect } from '@playwright/test';
import {
  CMD, CMD_TYPE, FrameReader, buildFrame, connectRequestPayload, crc16, crc32, isOsmoAdvert, parseConnectRequest, parseFrame,
  parseStatus, recordPayload,
} from '../src/lib/osmoProtocol';
import { doomedClips, fileStart, matchClipFiles, newClip, type PickedFile } from '../src/lib/clips';

/**
 * The Osmo Action's Bluetooth protocol (src/lib/osmoProtocol.ts) against the
 * frames DJI publishes with its remote demo (dji-sdk/Osmo-GPS-Controller-Demo:
 * test/connect_cmd_frame_builder/connect_cmd_frame.txt, test/test_gps.c), and
 * the matching of a card's files to the notebook's clip lines (src/lib/clips.ts).
 * Pure functions under Node: no browser, no camera.
 */

const hex = (s: string) => Uint8Array.from(s.replace(/\s+/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

// DJI's example connection request: device id 0x12345678, MAC 38:34:56:78:9A:BC,
// firmware 0, verify mode 0, code 0x1FFE, SEQ 1, a reply required.
const DJI_CONNECT = 'AA330002000000000100982F00197856341206383456789ABC00000000000000000000000000000000FE1F00000000796C667C';
// DJI's first GPS push frame (test_gps.c, ble_test_packets[0]).
const DJI_GPS = 'AA42000000000000 0300D2DD00174F00 35018AA50200BCB2 E943A34F750DB96D 0000DE5824418D9A C54100000000E803 0000E80300000A00 00000E00000063B5 D131';

test.describe('Frames as DJI writes them', () => {
  test('both checksums match DJI\'s frames', () => {
    for (const s of [DJI_CONNECT, DJI_GPS]) {
      const f = hex(s);
      const n = f.length;
      expect(crc16(f, 10)).toBe(f[10] | (f[11] << 8));
      expect(crc32(f, n - 4)).toBe((f[n - 4] | (f[n - 3] << 8) | (f[n - 2] << 16) | (f[n - 1] << 24)) >>> 0);
    }
  });

  test('the connection request is built byte for byte as DJI\'s example', () => {
    const payload = connectRequestPayload({ deviceId: 0x12345678, mac: hex('383456789ABC'), fwVersion: 0, verifyMode: 0, verifyData: 0x1ffe });
    const frame = buildFrame({ cmdSet: CMD.connect[0], cmdId: CMD.connect[1], cmdType: CMD_TYPE.replyRequired, seq: 1, payload });
    expect(toHex(frame)).toBe(DJI_CONNECT);
  });

  test('a frame reads back; a wrong byte anywhere is no frame', () => {
    const f = parseFrame(hex(DJI_CONNECT));
    expect(f).toMatchObject({ cmdType: 0x02, seq: 1, cmdSet: 0x00, cmdId: 0x19 });
    const req = parseConnectRequest(f!.payload);
    expect(req).toMatchObject({ deviceId: 0x12345678, fwVersion: 0, verifyMode: 0, verifyData: 0x1ffe });
    expect(toHex(req!.mac)).toBe('383456789ABC');
    for (const at of [3, 12, 30]) {
      const bad = hex(DJI_CONNECT);
      bad[at] ^= 0x01;
      expect(parseFrame(bad)).toBeNull();
    }
  });

  test('the reader joins pieces, skips the 0x55 frames and resyncs after noise', () => {
    const r = new FrameReader();
    const good = hex(DJI_CONNECT);
    const gps = hex(DJI_GPS);
    const broken = gps.slice();
    broken[20] ^= 0xff; // the payload: the header still holds, CRC-32 does not
    expect(r.push(Uint8Array.of(0x55, 0x0d, 0x04, 0x33, 0xaa, 0x01))).toEqual([]);
    expect(r.push(good.slice(0, 7))).toEqual([]);
    expect(r.push(good.slice(7, 30))).toEqual([]);
    const one = r.push(good.slice(30));
    expect(one).toHaveLength(1);
    expect(one[0].cmdId).toBe(0x19);
    const two = r.push(Uint8Array.from([...broken, ...gps]));
    expect(two.map((f) => f.cmdId)).toEqual([0x17]);
    expect(r.push(good).map((f) => f.seq)).toEqual([1]);
  });

  test('record start and stop are the demo\'s payloads', () => {
    expect(toHex(recordPayload(true))).toBe('0000FF330000000000');
    expect(toHex(recordPayload(false))).toBe('0000FF330100000000');
  });

  test('the status push gives mode, state, card and battery', () => {
    const p = new Uint8Array(38);
    const v = new DataView(p.buffer);
    p[0] = 0x01; // video
    p[1] = 0x03; // recording
    v.setUint16(5, 7, true);
    v.setUint32(15, 51_200, true);
    v.setUint32(23, 4_380, true);
    p[28] = 0;
    p[30] = 1;
    p[37] = 78;
    expect(parseStatus(p)).toEqual({ mode: 1, cameraStatus: 3, recordTime: 7, remainMb: 51_200, remainSeconds: 4_380, powerMode: 0, temperature: 1, battery: 78 });
    expect(parseStatus(p.slice(0, 31))!.battery).toBe(-1);
    expect(parseStatus(p.slice(0, 20))).toBeNull();
  });

  test('a camera is told by its advert', () => {
    expect(isOsmoAdvert({ 0x08aa: [0x12, 0x34, 0xfa, 0x00] })).toBe(true);
    expect(isOsmoAdvert({ 0x08aa: [0x12, 0x34, 0x00] })).toBe(false);
    expect(isOsmoAdvert({ 0x004c: [0x12, 0x34, 0xfa] })).toBe(false);
    expect(isOsmoAdvert(undefined)).toBe(false);
  });
});

test.describe('Matching the card to the clips', () => {
  const at = (h: number, m: number, s: number) => new Date(2026, 9, 29, h, m, s).getTime();
  const dji = (t: number, n: number, ext = 'MP4'): PickedFile => {
    const d = new Date(t);
    const p = (x: number, w = 2) => String(x).padStart(w, '0');
    return { name: `DJI_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(n, 4)}_D.${ext}`, lastModified: t + 10_000, size: 1 };
  };
  const clip = (id: string, t: number) => ({ clipId: id, startedAt: t, seconds: 10 });

  test('the name of a DJI file is when it started', () => {
    expect(fileStart(dji(at(19, 42, 10), 3), 10)).toMatchObject({ at: at(19, 42, 10), proxy: false });
    expect(fileStart({ name: 'GX010123.MP4', lastModified: at(19, 0, 10), size: 1 }, 10).at).toBe(at(19, 0, 0));
  });

  test('every clip finds its file, with the camera\'s clock right', () => {
    const clips = [clip('a', at(19, 42, 10)), clip('b', at(19, 55, 3)), clip('c', at(20, 31, 47))];
    const files = [dji(at(20, 31, 48), 7), dji(at(19, 42, 11), 5), dji(at(19, 30, 0), 4), dji(at(19, 55, 3), 6)];
    const m = matchClipFiles(clips, files);
    expect(Object.fromEntries(m)).toEqual({ a: 1, b: 3, c: 0 });
  });

  test('a camera clock 37 minutes off still matches, by the offset the clips share', () => {
    const off = 37 * 60_000 + 2_000;
    const clips = [clip('a', at(19, 42, 10)), clip('b', at(19, 55, 3)), clip('c', at(20, 31, 47))];
    const files = [dji(at(19, 42, 10) + off, 1), dji(at(19, 55, 3) + off, 2), dji(at(20, 31, 47) + off, 3), dji(at(19, 50, 0), 4)];
    expect(Object.fromEntries(matchClipFiles(clips, files))).toEqual({ a: 0, b: 1, c: 2 });
  });

  test('of an MP4 and its LRF proxy, the MP4 is taken; a lone LRF is taken', () => {
    const clips = [clip('a', at(19, 42, 10)), clip('b', at(19, 55, 3))];
    const files = [dji(at(19, 42, 10), 1, 'LRF'), dji(at(19, 42, 10), 1, 'MP4'), dji(at(19, 55, 3), 2, 'LRF')];
    expect(Object.fromEntries(matchClipFiles(clips, files))).toEqual({ a: 1, b: 2 });
  });

  test('a file nowhere near a clip is left alone', () => {
    expect(matchClipFiles([clip('a', at(19, 42, 10)), clip('b', at(19, 44, 10))], [dji(at(19, 43, 10), 1)]).size).toBe(1);
    expect(matchClipFiles([clip('a', at(19, 42, 10))], []).size).toBe(0);
  });

  test('a clip goes with its page, and after a week anyway', () => {
    const now = at(20, 0, 0);
    const kept = newClip('rc', 'page-1', 1, now - 5 * 60_000, 10, 'Osmo');
    const pageGone = newClip('rc', 'page-2', 1, now - 5 * 60_000, 10, 'Osmo');
    const justNow = newClip('rc', 'page-3', 1, now - 5_000, 10, 'Osmo');
    const old = newClip('rc', 'page-1', 2, now - 8 * 24 * 3_600_000, 10, 'Osmo');
    const doomed = doomedClips([kept, pageGone, justNow, old], new Set(['page-1']), now).map((c) => c.pageId + c.n);
    expect(doomed).toEqual(['page-21', 'page-12']);
  });
});
