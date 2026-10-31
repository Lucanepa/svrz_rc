import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOptions, stubSignedInApp } from './support/app';

/**
 * The notebook's camera: an Osmo Action over Web Bluetooth saves the seconds
 * before a tap (its Pre-Rec), the page gets the clip's line at the caret, and
 * the card's video is matched to it afterwards and plays from the strip — on
 * this device only.
 *
 * The camera is a fake behind navigator.bluetooth that speaks the protocol of
 * src/lib/osmoProtocol.ts: it answers the connection request, asks back with
 * verify_mode 2 (allowed), pushes its status at 2 Hz once subscribed (Pre-Rec
 * armed, or not), and acknowledges record start and stop; recording, its
 * clock starts at the 10 s it buffered. It logs what it was sent.
 */

const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageBox = (page: Page) => sheet(page).locator('.rich-surface');

/** The camera is off until turned on in the options; these specs turn it on
 *  for the device first, unless they test exactly that. */
async function cameraOn(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('svrz_camera_on', '1'); } catch { /* none */ } });
}

async function fakeOsmo(page: Page, { preRec = true, on = true, battery = 78 } = {}): Promise<void> {
  if (on) await cameraOn(page);
  await page.addInitScript(({ preRec, battery }) => {
    const t16: number[] = [];
    const t32: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let a = n; let b = n;
      for (let k = 0; k < 8; k += 1) { a = a & 1 ? (a >>> 1) ^ 0xa001 : a >>> 1; b = b & 1 ? (b >>> 1) ^ 0xedb88320 : b >>> 1; }
      t16.push(a); t32.push(b >>> 0);
    }
    const crc16 = (u: Uint8Array, n: number) => { let c = 0x3aa3; for (let i = 0; i < n; i += 1) c = (t16[(c ^ u[i]) & 0xff] ^ (c >>> 8)) & 0xffff; return c; };
    const crc32 = (u: Uint8Array, n: number) => { let c = 0x3aa3; for (let i = 0; i < n; i += 1) c = (t32[(c ^ u[i]) & 0xff] ^ (c >>> 8)) >>> 0; return c >>> 0; };
    const frame = (cmdType: number, seq: number, set: number, id: number, payload: number[]) => {
      const n = 12 + 2 + payload.length + 4;
      const u = new Uint8Array(n);
      const v = new DataView(u.buffer);
      u[0] = 0xaa; v.setUint16(1, n, true); u[3] = cmdType; v.setUint16(8, seq, true);
      v.setUint16(10, crc16(u, 10), true);
      u[12] = set; u[13] = id; u.set(payload, 14);
      v.setUint32(n - 4, crc32(u, n - 4), true);
      return u;
    };
    const log: { at: number; what: string }[] = [];
    (window as unknown as { __osmoLog: typeof log }).__osmoLog = log;
    let recording = 0;
    let camSeq = 500;
    let pushing: ReturnType<typeof setInterval> | null = null;

    const notify = new EventTarget() as EventTarget & { value?: DataView; startNotifications: () => Promise<unknown> };
    notify.startNotifications = async () => notify;
    const send = (u: Uint8Array) => setTimeout(() => {
      notify.value = new DataView(u.buffer);
      notify.dispatchEvent(new Event('characteristicvaluechanged'));
    }, 20);
    const status = () => {
      const p = new Array(38).fill(0);
      p[0] = 0x01; p[1] = recording ? 0x03 : preRec ? 0x05 : 0x01;
      const t = recording ? 10 + Math.floor((Date.now() - recording) / 1000) : 0;
      p[5] = t & 0xff; p[6] = (t >> 8) & 0xff; // record_time, the pre-recording included
      p[23] = 4380 & 0xff; p[24] = (4380 >> 8) & 0xff; // remain_time
      p[37] = battery;
      return p;
    };
    const onWrite = async (buf: BufferSource) => {
      const u = new Uint8Array(buf instanceof ArrayBuffer ? buf : (buf as ArrayBufferView).buffer);
      const cmdType = u[3]; const seq = u[8] | (u[9] << 8); const set = u[12]; const id = u[13];
      if (set === 0x00 && id === 0x19 && !(cmdType & 0x20)) {
        log.push({ at: Date.now(), what: 'connect-request' });
        send(frame(0x20, seq, 0x00, 0x19, [0x44, 0xff, 0, 0, 0, 0, 0, 0, 0]));
        const ask = new Array(33).fill(0);
        ask[26] = 2; // verify_mode 2, verify_data 0: allowed
        setTimeout(() => send(frame(0x02, camSeq++, 0x00, 0x19, ask)), 80);
      } else if (set === 0x00 && id === 0x19) {
        log.push({ at: Date.now(), what: 'connect-response' });
      } else if (set === 0x1d && id === 0x05) {
        log.push({ at: Date.now(), what: 'subscribe' });
        if (!pushing) pushing = setInterval(() => send(frame(0x00, camSeq++, 0x1d, 0x02, status())), 500);
        send(frame(0x00, camSeq++, 0x1d, 0x02, status()));
      } else if (set === 0x1d && id === 0x03) {
        recording = u[14 + 4] === 0 ? Date.now() : 0;
        log.push({ at: Date.now(), what: recording ? 'record-start' : 'record-stop' });
        send(frame(0x20, seq, 0x1d, 0x03, [0]));
        send(frame(0x00, camSeq++, 0x1d, 0x02, status()));
      }
    };
    const write = { writeValueWithResponse: onWrite, writeValueWithoutResponse: onWrite, writeValue: onWrite };
    const service = { getCharacteristic: async (u: number) => (u === 0xfff4 ? notify : write) };
    const device = Object.assign(new EventTarget(), {
      id: 'fake-osmo', name: 'OsmoAction5Pro-TEST',
      gatt: { connected: false, connect: async () => device.gatt, disconnect: () => undefined, getPrimaryService: async () => service },
    });
    Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => ({ requestDevice: async () => device }) });
  }, { preRec, battery });
}

/** The page's clips sit in the strip's "Clips (n)" menu: opens it, once. */
async function clipMenu(page: Page) {
  const list = sheet(page).getByTestId('clips-list');
  if (!(await list.isVisible())) await sheet(page).getByTestId('clips-menu').click();
  await expect(list).toBeVisible();
  return list;
}

const osmoLog = (page: Page) => page.evaluate(() => (window as unknown as { __osmoLog: { at: number; what: string }[] }).__osmoLog.map((l) => ({ ...l })));

test.describe('The notebook films with an Osmo', () => {
  test('a clip of the seconds before the tap is saved, written at the caret, matched to its video and played', async ({ page }) => {
    test.setTimeout(60_000);
    await fakeOsmo(page);
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await expect(sheet(page)).toBeVisible();

    await sheet(page).getByTestId('cam-connect').click();
    // Folded: the camera's name. The chevron unfolds its battery and card.
    await expect(sheet(page).getByTestId('cam-state')).toContainText('OsmoAction5Pro-TEST');
    await expect(sheet(page).getByTestId('cam-power')).toHaveCount(0);
    await expect(sheet(page).getByRole('button', { name: /^(Trennen|Disconnect)$/ })).toHaveCount(0);
    await sheet(page).getByTestId('cam-details').click();
    await expect(sheet(page).getByTestId('cam-power')).toHaveText(/^(Akku|battery) 78 % · 1 h 13 min/);
    await expect(sheet(page).getByRole('button', { name: /^(Trennen|Disconnect)$/ })).toBeVisible();
    expect((await osmoLog(page)).map((l) => l.what)).toEqual(['connect-request', 'connect-response', 'subscribe']);

    await pageBox(page).click();
    await page.keyboard.type('2. SR ');
    await sheet(page).getByTestId('cam-clip').click();
    // At the caret, on the line being typed, the moment the camera starts.
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^2\. SR \[Clip 1 · \d\d:\d\d:\d\d\] \s*$/);
    await page.keyboard.type('Pfiff zu spät');
    // The clip is what came before: the camera is stopped a moment later, not ten seconds on.
    await expect(sheet(page).getByTestId('cam-clip')).toHaveText(/^Clip$/, { timeout: 5_000 });
    const log = await osmoLog(page);
    const start = log.find((l) => l.what === 'record-start')!;
    const stop = log.find((l) => l.what === 'record-stop')!;
    expect(stop.at - start.at).toBeGreaterThanOrEqual(900);
    expect(stop.at - start.at).toBeLessThan(3_500);
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^2\. SR \[Clip 1 · \d\d:\d\d:\d\d\] Pfiff zu spät\s*$/);
    // The camera's clock at the start said how much it kept.
    await expect(sheet(page).getByTestId('cam-prerec')).toHaveText('· Pre-Rec 10 s');
    // The line is one piece in the editor: a chip, the same text underneath.
    await expect(pageBox(page).locator('[data-atom]')).toHaveText(/^\[Clip 1 · \d\d:\d\d:\d\d\]$/);
    await expect(pageBox(page).locator('[data-atom]')).toHaveAttribute('contenteditable', 'false');
    // Grey while its video is not here yet.
    await expect(pageBox(page).locator('[data-atom]')).toHaveClass(/bg-stone-100/);

    // No video yet: the chip says so, and the card's file is matched by its name.
    await expect(sheet(page).getByTestId('clips-menu')).toHaveText('Clips (1)');
    const item = (await clipMenu(page)).getByTestId('clip-item');
    await expect(item).toContainText(/Clip 1 · \d\d:\d\d:\d\d/);
    await expect(item).toContainText(/Video fehlt|Video missing/);
    // Escape folds the menu and leaves the notebook open.
    await page.keyboard.press('Escape');
    await expect(sheet(page).getByTestId('clips-list')).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    const name = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const open = indexedDB.open('svrz-clips', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const req = open.result.transaction('clips', 'readonly').objectStore('clips').getAll();
        req.onsuccess = () => {
          const c = req.result[0] as { at: number; seconds: number };
          if (c.seconds !== 10) { reject(new Error(`kept ${c.seconds} s`)); return; }
          const d = new Date(c.at - 10_000 + 1_000); // named after the buffered start, the camera's clock a second on
          const p = (x: number, w = 2) => String(x).padStart(w, '0');
          resolve(`DJI_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_0042_D.MP4`);
        };
      };
    }));
    await sheet(page).getByTestId('clips-file').setInputFiles([
      { name, mimeType: 'video/mp4', buffer: Buffer.from('not really a video') },
      { name: 'DJI_20200101120000_0001_D.MP4', mimeType: 'video/mp4', buffer: Buffer.from('another evening') },
    ]);
    await expect(page.getByText(/^(1 von 1 Clips zugeordnet|1 of 1 clips matched)$/)).toBeVisible();
    await clipMenu(page);
    await expect(sheet(page).getByTestId('clips-attach')).toHaveCount(0);
    // Blue now that it is.
    await expect(pageBox(page).locator('[data-atom]')).toHaveClass(/bg-sky-100/);

    await (await clipMenu(page)).getByRole('menuitem', { name: /^(Clip 1 abspielen|Play clip 1)$/ }).click();
    const player = page.getByTestId('clip-player');
    await expect(player).toBeVisible();
    await expect(player.locator('video')).toHaveAttribute('src', /^blob:/);
    // A name of its own: on the chip, and in the name it is saved under.
    await player.getByTestId('clip-name').fill('Pfiff zu spät');
    await player.getByTestId('clip-name').press('Enter');
    await expect(player.getByTestId('clip-download')).toHaveAttribute('download', /^Clip 1 \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d - Pfiff zu spät\.mp4$/);
    // Escape closes the video and leaves the notebook open.
    await page.keyboard.press('Escape');
    await expect(player).toHaveCount(0);
    await expect(sheet(page)).toBeVisible();
    await expect((await clipMenu(page)).getByTestId('clip-item')).toHaveText('Clip 1 · Pfiff zu spät');
    await page.keyboard.press('Escape');
    // A tap on the line in the page opens the same clip.
    await pageBox(page).locator('[data-atom]').click();
    await expect(player).toBeVisible();
    await page.keyboard.press('Escape');

    // The video is this device's: nothing about it went to the server.
    const stored = await page.evaluate(() => new Promise<{ name: string; size: number }>((resolve) => {
      const open = indexedDB.open('svrz-clips', 1);
      open.onsuccess = () => {
        const req = open.result.transaction('clips', 'readonly').objectStore('clips').getAll();
        req.onsuccess = () => resolve((req.result[0] as { file: { name: string; size: number } }).file);
      };
    }));
    expect(stored).toMatchObject({ name, size: 'not really a video'.length });

    // Deleted: gone from the device, the line stays on the page.
    await (await clipMenu(page)).getByTestId('clip-item').click();
    await player.getByTestId('clip-delete').click();
    await page.getByRole('button', { name: /^(Löschen|Delete)$/ }).last().click();
    await expect(player).toHaveCount(0);
    await expect(sheet(page).getByTestId('clips-menu')).toHaveCount(0);
    await expect(pageBox(page).locator('[data-atom]')).toHaveCount(1);

    // Typing cannot break the line: Backspace takes the words, then the whole clip.
    await pageBox(page).click();
    await page.keyboard.press('End');
    for (let i = 0; i < 'Pfiff zu spät'.length + 1; i += 1) await page.keyboard.press('Backspace');
    await expect(pageBox(page).locator('[data-atom]')).toHaveCount(1);
    await page.keyboard.press('Backspace');
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^2\. SR\s*$/);
  });

  test('"@" offers the clips, newest first, and puts the picked one in as its chip', async ({ page }) => {
    await page.addInitScript(() => {
      const now = Date.now();
      const clip = (n: number, ago: number, title = '') => ({
        id: `rc1|clip-${n}`, ownerId: 'rc1', clipId: `clip-${n}`, pageId: 'page-elsewhere', n, at: now - ago, seconds: 10,
        stoppedAt: now - ago + 1_500, camera: 'Osmo', file: null, createdAt: now - 5_000, title,
      });
      const open = indexedDB.open('svrz-clips', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onsuccess = () => {
        const tx = open.result.transaction('clips', 'readwrite');
        tx.objectStore('clips').put(clip(1, 600_000));
        tx.objectStore('clips').put(clip(2, 60_000, 'Netzfehler'));
        tx.oncomplete = () => open.result.close();
      };
    });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await pageBox(page).click();
    await page.keyboard.type('Siehe @');
    const menu = sheet(page).getByTestId('pad-mention');
    await expect(menu.getByRole('menuitem')).toHaveCount(2);
    await expect(menu.getByRole('menuitem').first()).toContainText('Clip 2 · Netzfehler');
    await menu.getByRole('menuitem').first().click();
    await expect(menu).toHaveCount(0);
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^Siehe \[Clip 2 · \d\d:\d\d:\d\d\] \s*$/);
    await expect(pageBox(page).locator('[data-atom]')).toHaveCount(1);
    // Mentioned here, filmed elsewhere: its chip is on this page's strip too.
    const items = (await clipMenu(page)).getByTestId('clip-item');
    await expect(items).toHaveCount(1);
    await expect(items).toContainText('Clip 2 · Netzfehler');
    await page.keyboard.press('Escape');
    // Typing on after an "@" is an "@".
    await page.keyboard.type('mail@x');
    await expect(menu).toHaveCount(0);
    await expect.poll(() => pageBox(page).evaluate((el) => (el as HTMLElement).innerText)).toMatch(/mail@x\s*$/);
  });

  test('a clip that opens on a still picture starts where it moves, and can be watched from the start', async ({ page }) => {
    // e2e/fixtures/still-start.webm: two seconds of one frame, then three of motion.
    const video = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'still-start.webm'));
    const at = await page.evaluate(() => Date.now());
    await page.addInitScript((at) => {
      const open = indexedDB.open('svrz-clips', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onsuccess = () => {
        const tx = open.result.transaction('clips', 'readwrite');
        tx.objectStore('clips').put({ id: 'rc1|clip-still', ownerId: 'rc1', clipId: 'clip-still', pageId: 'page-x', n: 1, at, seconds: 10, stoppedAt: at + 1_500, camera: 'Osmo', file: null, createdAt: Date.now() - 5_000 });
        tx.oncomplete = () => open.result.close();
      };
    }, at || Date.now());
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await pageBox(page).click();
    await page.keyboard.type('@');
    await sheet(page).getByTestId('pad-mention').getByRole('menuitem').first().click();
    const d = new Date(Date.now() - 12_000);
    const p = (x: number, w = 2) => String(x).padStart(w, '0');
    const name = `DJI_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_0007_D.MP4`;
    await sheet(page).getByTestId('clips-file').setInputFiles([{ name, mimeType: 'video/mp4', buffer: video }]);
    await expect(page.getByText(/^(1 von 1 Clips zugeordnet|1 of 1 clips matched)$/)).toBeVisible();
    await (await clipMenu(page)).getByRole('menuitem', { name: /^(Clip 1 abspielen|Play clip 1)$/ }).click();
    const player = page.getByTestId('clip-player');
    const fromStart = player.getByTestId('clip-from-start');
    await expect(fromStart).toHaveText(/^(Standbild am Anfang übersprungen|Still picture at the start skipped) \(1\.[4-8] s\)/, { timeout: 15_000 });
    await expect.poll(() => player.getByTestId('clip-video').evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(1.3);
    await fromStart.click();
    await expect.poll(() => player.getByTestId('clip-video').evaluate((v) => (v as HTMLVideoElement).currentTime)).toBeLessThan(1.3);
    await expect(fromStart).toHaveText(/^(Standbild am Anfang überspringen|Skip the still picture at the start)/);
  });

  test('the camera is off until the options turn it on', async ({ page }) => {
    await fakeOsmo(page, { on: false });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await expect(sheet(page).getByRole('button', { name: /^(Zeit|Time)$/ })).toBeVisible();
    await expect(sheet(page).getByTestId('cam-connect')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openOptions(page);
    const option = page.getByTestId('option-camera');
    await expect(option).toHaveAttribute('aria-pressed', 'false');
    await option.click();
    await expect(option).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await expect(sheet(page).getByTestId('cam-connect')).toBeVisible();
  });

  test('with Pre-Rec off on the camera, the strip says so and nothing is recorded', async ({ page }) => {
    await fakeOsmo(page, { preRec: false });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await sheet(page).getByTestId('cam-connect').click();
    await expect(sheet(page).getByTestId('cam-state')).toContainText(/^(Pre-Rec ist aus|Pre-Rec is off)/);
    await sheet(page).getByTestId('cam-clip').click();
    await expect(page.getByText(/^(Pre-Rec ist an der Kamera aus|Pre-Rec is off on the camera)/)).toBeVisible();
    expect((await osmoLog(page)).map((l) => l.what)).not.toContain('record-start');
    await expect(pageBox(page)).toHaveText('');
  });

  test('the page\'s clips sit in one menu, the newest first', async ({ page }) => {
    await page.addInitScript(() => {
      const now = Date.now();
      const clip = (n: number, ago: number, title = '') => ({
        id: `rc1|clip-${n}`, ownerId: 'rc1', clipId: `clip-${n}`, pageId: 'page-elsewhere', n, at: now - ago, seconds: 10,
        stoppedAt: now - ago + 1_500, camera: 'Osmo', file: null, createdAt: now - 5_000, title,
      });
      const open = indexedDB.open('svrz-clips', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('clips', { keyPath: 'id' });
      open.onsuccess = () => {
        const tx = open.result.transaction('clips', 'readwrite');
        tx.objectStore('clips').put(clip(1, 600_000));
        tx.objectStore('clips').put(clip(2, 60_000, 'Netzfehler'));
        tx.objectStore('clips').put(clip(3, 300_000));
        tx.oncomplete = () => open.result.close();
      };
    });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await pageBox(page).click();
    // Mentioned on this page: all three are its clips. The "@" menu is newest first too.
    for (const i of [0, 1, 2]) {
      await page.keyboard.type(' @');
      await sheet(page).getByTestId('pad-mention').getByRole('menuitem').nth(i).click();
    }
    await expect(pageBox(page).locator('[data-atom]')).toHaveCount(3);

    // One button on the strip, not a chip per clip.
    await expect(sheet(page).getByTestId('clips-menu')).toHaveText('Clips (3)');
    await expect(sheet(page).getByTestId('clip-item')).toHaveCount(0);
    const items = (await clipMenu(page)).getByTestId('clip-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Clip 2 · Netzfehler');
    await expect(items.nth(1)).toContainText(/^Clip 3 · /);
    await expect(items.nth(2)).toContainText(/^Clip 1 · /);
    // Still waiting for their videos: the menu offers to add them.
    await expect(sheet(page).getByTestId('clips-attach')).toBeVisible();

    // A tap beside the menu folds it, and the page keeps what was written.
    await sheet(page).getByRole('button', { name: /^(Abbrechen|Cancel)$/ }).first().click({ position: { x: 5, y: 5 } });
    await expect(sheet(page).getByTestId('clips-list')).toHaveCount(0);
    await expect(pageBox(page).locator('[data-atom]')).toHaveCount(3);

    // Picking one folds the menu and opens that clip.
    await (await clipMenu(page)).getByTestId('clip-item').nth(0).click();
    await expect(sheet(page).getByTestId('clips-list')).toHaveCount(0);
    await expect(page.getByTestId('clip-player')).toContainText(/Clip 2/);
  });

  test('a low battery shows on the folded camera line; unfolded, the details are remembered', async ({ page }) => {
    await fakeOsmo(page, { battery: 15 });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await sheet(page).getByTestId('cam-connect').click();
    await expect(sheet(page).getByTestId('cam-state')).toContainText('OsmoAction5Pro-TEST');
    await expect(sheet(page).getByTestId('cam-battery-low')).toHaveText(/^· (Akku|battery) 15 %$/);
    await sheet(page).getByTestId('cam-details').click();
    await expect(sheet(page).getByTestId('cam-details')).toHaveAttribute('aria-expanded', 'true');
    // Unfolded, the battery is in the details and not twice.
    await expect(sheet(page).getByTestId('cam-battery-low')).toHaveCount(0);
    await expect(sheet(page).getByTestId('cam-power')).toHaveText(/^(Akku|battery) 15 % · 1 h 13 min/);
    expect(await page.evaluate(() => localStorage.getItem('svrz_cam_details'))).toBe('1');
  });

  test('without Bluetooth (Safari, Firefox) there is no camera button', async ({ page }) => {
    await cameraOn(page);
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => undefined }); });
    await stubSignedInApp(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
    await expect(sheet(page).getByRole('button', { name: /^(Zeit|Time)$/ })).toBeVisible();
    await expect(sheet(page).getByTestId('cam-connect')).toHaveCount(0);
  });
});
