import './support/build-globals';
import { test, expect } from '@playwright/test';
import {
  CMD, CMD_TYPE, FrameReader, buildFrame, connectRequestPayload, crc16, crc32, isOsmoAdvert, parseConnectRequest, parseFrame,
  parseStatus, recordPayload,
} from '../src/lib/osmoProtocol';
import { HEAVY_MBIT, clipMbit, clipNumbersIn, doomedClips, fallsBehind, fileEnd, matchClipFiles, newClip, nextClipNumber, type PickedFile } from '../src/lib/clips';

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
  const clip = (id: string, t: number) => ({ clipId: id, at: t, seconds: 10 });

  test('a file ends at its card time; a copied file at its name plus a clip', () => {
    expect(fileEnd(dji(at(19, 42, 10), 3))).toMatchObject({ at: at(19, 42, 20), proxy: false });
    // Copied off the card later: the card time is the copy's; the name's guess stands beside it.
    expect(fileEnd({ ...dji(at(19, 42, 10), 3), lastModified: at(23, 0, 0) })).toMatchObject({ at: at(23, 0, 0), alt: at(19, 42, 10) + 11_500 });
    // A card time before the name is no recording's end: the name alone.
    expect(fileEnd({ ...dji(at(19, 42, 10), 3), lastModified: at(19, 0, 0) })).toMatchObject({ at: at(19, 42, 10) + 11_500, alt: null });
    expect(fileEnd({ name: 'GX010123.MP4', lastModified: at(19, 0, 10), size: 1 }).at).toBe(at(19, 0, 10));
  });

  test('the first evening\'s card: three clips, the camera 14 s ahead, the third with a short buffer', () => {
    // 29.10.2026, as tapped on the laptop and as the SD card listed the files.
    const ms = (h: number, m: number, s: number, frac = 0) => at(h, m, s) + frac;
    const clips = [
      { clipId: 'c1', at: ms(22, 5, 30), stoppedAt: ms(22, 5, 31, 600) },
      { clipId: 'c2', at: ms(22, 5, 42), stoppedAt: ms(22, 5, 43, 600) },
      { clipId: 'c3', at: ms(22, 5, 49), stoppedAt: ms(22, 5, 50, 600) },
    ];
    const card: PickedFile[] = [
      { name: 'DJI_20261029220534_0018_D.LRF', lastModified: ms(22, 5, 46, 150), size: 9_508_489 },
      { name: 'DJI_20261029220534_0018_D.MP4', lastModified: ms(22, 5, 46, 280), size: 92_324_728 },
      { name: 'DJI_20261029220546_0019_D.MP4', lastModified: ms(22, 5, 57, 650), size: 103_662_760 },
      { name: 'DJI_20261029220546_0019_D.LRF', lastModified: ms(22, 5, 57, 780), size: 10_421_369 },
      { name: 'DJI_20261029220558_0020_D.MP4', lastModified: ms(22, 6, 4, 440), size: 53_973_726 },
      { name: 'DJI_20261029220558_0020_D.LRF', lastModified: ms(22, 6, 4, 560), size: 5_208_478 },
    ];
    expect(Object.fromEntries(matchClipFiles(clips, card))).toEqual({ c1: 1, c2: 2, c3: 4 });
  });

  test('clips are numbered across the pages; a page\'s text names the ones it mentions', () => {
    const a = newClip('rc', 'page-1', 1, at(19, 0, 0), 10, 'Osmo');
    const b = newClip('rc', 'page-2', 2, at(19, 5, 0), 10, 'Osmo');
    expect(nextClipNumber([a, b])).toBe(3);
    expect(nextClipNumber([])).toBe(1);
    expect(clipNumbersIn('Satz 2 [Clip 2 · 19:05:00] und [Clip 11 · 19:20:31] wie [Clip x]')).toEqual([2, 11]);
  });

  test('31.10.2026: Pre-Rec names a file from the stop before, minutes earlier; every clip finds its own', () => {
    // As tapped and stopped on the laptop, and as the SD card listed the files.
    // The camera 18 s ahead. DJI_..._0001 is named 18:46:55 and ends 19:01:01:
    // Pre-Rec had been buffering since the camera was set up. A rule taking a
    // card time 5 minutes past the name for a copy's left c34, c36, c38 and
    // c44 without a video.
    const on31 = (h: number, m: number, s: number, ms = 0) => new Date(2026, 9, 31, h, m, s).getTime() + ms;
    const clips = [
      { clipId: 'c34', at: on31(19, 0, 41, 919), stoppedAt: on31(19, 0, 43, 881) },
      { clipId: 'c35', at: on31(19, 1, 6, 862), stoppedAt: on31(19, 1, 8, 785) },
      { clipId: 'c36', at: on31(19, 13, 20, 846), stoppedAt: on31(19, 13, 22, 725) },
      { clipId: 'c37', at: on31(19, 14, 34, 2), stoppedAt: on31(19, 14, 36, 6) },
      { clipId: 'c38', at: on31(19, 21, 1, 881), stoppedAt: on31(19, 21, 3, 788) },
      { clipId: 'c39', at: on31(19, 21, 7, 935), stoppedAt: on31(19, 21, 9, 929) },
      { clipId: 'c40', at: on31(19, 22, 0, 83), stoppedAt: on31(19, 22, 1, 987) },
      { clipId: 'c41', at: on31(19, 25, 39, 166), stoppedAt: on31(19, 25, 41, 111) },
      { clipId: 'c42', at: on31(19, 29, 48, 268), stoppedAt: on31(19, 29, 50, 189) },
      { clipId: 'c43', at: on31(19, 32, 19, 662), stoppedAt: on31(19, 32, 21, 550) },
      { clipId: 'c44', at: on31(19, 39, 28, 389), stoppedAt: on31(19, 39, 30, 331) },
    ];
    const card: PickedFile[] = [
      { name: 'DJI_20261031184655_0001_D.MP4', lastModified: on31(19, 1, 1, 190), size: 415824619 },
      { name: 'DJI_20261031184655_0001_D.LRF', lastModified: on31(19, 1, 1, 320), size: 40203104 },
      { name: 'DJI_20261031190101_0002_D.MP4', lastModified: on31(19, 1, 26, 150), size: 212729209 },
      { name: 'DJI_20261031190101_0002_D.LRF', lastModified: on31(19, 1, 26, 300), size: 22534021 },
      { name: 'DJI_20261031190126_0003_D.MP4', lastModified: on31(19, 13, 40, 110), size: 217458432 },
      { name: 'DJI_20261031190126_0003_D.LRF', lastModified: on31(19, 13, 40, 240), size: 39752917 },
      { name: 'DJI_20261031191340_0004_D.MP4', lastModified: on31(19, 14, 53, 280), size: 218316370 },
      { name: 'DJI_20261031191340_0004_D.LRF', lastModified: on31(19, 14, 53, 410), size: 36108240 },
      { name: 'DJI_20261031191453_0005_D.LRF', lastModified: on31(19, 21, 21, 180), size: 40607840 },
      { name: 'DJI_20261031191453_0005_D.MP4', lastModified: on31(19, 21, 21, 320), size: 411553462 },
      { name: 'DJI_20261031192121_0006_D.MP4', lastModified: on31(19, 21, 27, 200), size: 47478624 },
      { name: 'DJI_20261031192121_0006_D.LRF', lastModified: on31(19, 21, 27, 350), size: 4728093 },
      { name: 'DJI_20261031192127_0007_D.MP4', lastModified: on31(19, 22, 19, 360), size: 214238142 },
      { name: 'DJI_20261031192127_0007_D.LRF', lastModified: on31(19, 22, 19, 500), size: 27266736 },
      { name: 'DJI_20261031192219_0008_D.MP4', lastModified: on31(19, 25, 58, 470), size: 215870455 },
      { name: 'DJI_20261031192219_0008_D.LRF', lastModified: on31(19, 25, 58, 610), size: 39634269 },
      { name: 'DJI_20261031192559_0009_D.MP4', lastModified: on31(19, 30, 7, 590), size: 216031699 },
      { name: 'DJI_20261031192559_0009_D.LRF', lastModified: on31(19, 30, 7, 760), size: 39762235 },
      { name: 'DJI_20261031193008_0010_D.MP4', lastModified: on31(19, 32, 38, 970), size: 217664110 },
      { name: 'DJI_20261031193008_0010_D.LRF', lastModified: on31(19, 32, 39, 120), size: 39817871 },
      { name: 'DJI_20261031193239_0011_D.MP4', lastModified: on31(19, 39, 47, 730), size: 412888836 },
      { name: 'DJI_20261031193239_0011_D.LRF', lastModified: on31(19, 39, 47, 850), size: 39692972 },
    ];
    expect(Object.fromEntries(matchClipFiles(clips, card))).toEqual({
      c34: 0, c35: 2, c36: 4, c37: 6, c38: 9, c39: 10, c40: 12, c41: 14, c42: 16, c43: 18, c44: 20,
    });
  });

  test('copied off the card, the files still find their clips by their names', () => {
    // Every card time is the copy's, a minute apart from nothing; the names carry the starts.
    const clips = [clip('a', at(19, 42, 10)), clip('b', at(19, 44, 10)), clip('c', at(19, 50, 0))];
    const copied = [dji(at(19, 41, 59), 1), dji(at(19, 43, 59), 2), dji(at(19, 49, 49), 3)].map((f, k) => ({ ...f, lastModified: at(23, 0, k) }));
    expect(Object.fromEntries(matchClipFiles(clips, copied))).toEqual({ a: 0, b: 1, c: 2 });
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

  // 31.10.2026: 4K at 120 fps, 614 MB for a 15 s Pre-Rec clip — less than half
  // speed on the laptop. The 2.7K/60 card of the day before (75 Mbit/s) played.
  test('a 4K/120 original is too heavy to start on; a 2.7K/60 one is not', () => {
    expect(clipMbit({ size: 614_270_983 }, 15)).toBeGreaterThan(HEAVY_MBIT);
    expect(clipMbit({ size: 150_000_000 }, 15)).toBeLessThan(HEAVY_MBIT);
    expect(clipMbit(null, 15)).toBe(0);
    expect(clipMbit({ size: 0 }, 15)).toBe(0);
  });

  test('falling behind is under 60 % of real time, judged after four seconds, at the chosen speed', () => {
    // The laptop's log: 1.5 s of video in 7 s.
    expect(fallsBehind(7, 1.5)).toBe(true);
    expect(fallsBehind(4, 3.9)).toBe(false);
    // Too early to say.
    expect(fallsBehind(3, 0.2)).toBe(false);
    // Slow motion set in the player is not falling behind.
    expect(fallsBehind(8, 2, 0.25)).toBe(false);
    expect(fallsBehind(8, 0.8, 0.25)).toBe(true);
  });
});
