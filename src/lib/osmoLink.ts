// The Bluetooth link to an Osmo Action camera: the bytes of osmoProtocol.ts go
// out on characteristic FFF5 and come back as notifications on FFF4.
//
// Two ways to get there:
// - the web app, in Chrome or Edge (laptop or Android): Web Bluetooth. Safari
//   and Firefox have none, so an iPhone or iPad cannot drive the camera.
// - the installed app: its webview has no Web Bluetooth either (WebKitGTK,
//   WebView2, Android's WebView), so it goes through the Tauri plugin
//   tauri-plugin-blec (btleplug on the desktop, its own backend on Android).
//
// A `Transport` is a camera that was picked once; `open()` connects to it and
// can be called again after the link drops, without asking the coach again.

import { DJI_COMPANY_ID, OSMO_NOTIFY, OSMO_SERVICE, OSMO_WRITE, isOsmoAdvert, uuid16 } from './osmoProtocol';

export type LinkEvents = { onData: (bytes: Uint8Array) => void; onClose: () => void };
export type OsmoLink = {
  write: (bytes: Uint8Array, withResponse: boolean) => Promise<void>;
  close: () => Promise<void>;
};
export type Transport = {
  /** The camera's Bluetooth name, e.g. "OsmoAction5Pro-1A2B". */
  name: string;
  /** Stable for this camera on this device: what a pairing is remembered under. */
  key: string;
  open: (events: LinkEvents) => Promise<OsmoLink>;
};

export type OsmoErrorCode =
  | 'unsupported' | 'cancelled' | 'not-found' | 'permission' | 'bluetooth-off'
  | 'link' | 'refused' | 'timeout' | 'busy' | 'asleep' | 'too-hot' | 'card' | 'record' | 'no-prerec';
export class OsmoError extends Error {
  constructor(public code: OsmoErrorCode, message?: string) { super(message || code); }
}

/** Where a camera can be driven from here: the web app's Web Bluetooth, the
 *  installed app's plugin, or nowhere. */
export function bluetoothSupport(native: boolean): 'web' | 'native' | null {
  if (native) return 'native';
  if (typeof navigator !== 'undefined' && (navigator as unknown as { bluetooth?: unknown }).bluetooth && typeof window !== 'undefined' && window.isSecureContext) return 'web';
  return null;
}

// ── Web Bluetooth ────────────────────────────────────────────────────────
// The few members used, typed here: TypeScript's DOM library has none.

type WbCharacteristic = EventTarget & {
  value?: DataView;
  startNotifications: () => Promise<WbCharacteristic>;
  writeValueWithResponse?: (v: BufferSource) => Promise<void>;
  writeValueWithoutResponse?: (v: BufferSource) => Promise<void>;
  writeValue: (v: BufferSource) => Promise<void>;
};
type WbService = { getCharacteristic: (u: number) => Promise<WbCharacteristic> };
type WbServer = { connected: boolean; connect: () => Promise<WbServer>; disconnect: () => void; getPrimaryService: (u: number) => Promise<WbService> };
type WbDevice = EventTarget & { id: string; name?: string; gatt?: WbServer };
type WbBluetooth = { requestDevice: (o: unknown) => Promise<WbDevice> };

/** The browser's camera chooser. Must run inside a tap: Chrome refuses it otherwise. */
export async function pickWebCamera(): Promise<Transport> {
  const bt = (navigator as unknown as { bluetooth?: WbBluetooth }).bluetooth;
  if (!bt) throw new OsmoError('unsupported');
  let device: WbDevice;
  try {
    device = await bt.requestDevice({
      // Either: the advert DJI documents, or the service (some firmware
      // advertises it). The chooser lists what matches one of them.
      filters: [{ manufacturerData: [{ companyIdentifier: DJI_COMPANY_ID }] }, { services: [OSMO_SERVICE] }],
      optionalServices: [OSMO_SERVICE],
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'NotFoundError') throw new OsmoError('cancelled');
    if (name === 'SecurityError' || name === 'NotAllowedError') throw new OsmoError('permission');
    throw new OsmoError('unsupported', String(e));
  }
  return {
    name: device.name || 'Osmo',
    key: `web:${device.id}`,
    open: (events) => openWebLink(device, events),
  };
}

async function openWebLink(device: WbDevice, events: LinkEvents): Promise<OsmoLink> {
  const gatt = device.gatt;
  if (!gatt) throw new OsmoError('link');
  let closedByUs = false;
  const onGone = () => { device.removeEventListener('gattserverdisconnected', onGone); if (!closedByUs) events.onClose(); };
  try {
    const server = await gatt.connect();
    device.addEventListener('gattserverdisconnected', onGone);
    const service = await server.getPrimaryService(OSMO_SERVICE);
    const notify = await service.getCharacteristic(OSMO_NOTIFY);
    const write = await service.getCharacteristic(OSMO_WRITE);
    notify.addEventListener('characteristicvaluechanged', () => {
      const v = notify.value;
      if (v) events.onData(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    });
    await notify.startNotifications();
    return {
      write: async (bytes, withResponse) => {
        const buf = bytes.slice().buffer;
        if (withResponse && write.writeValueWithResponse) await write.writeValueWithResponse(buf);
        else if (!withResponse && write.writeValueWithoutResponse) await write.writeValueWithoutResponse(buf);
        else await write.writeValue(buf);
      },
      close: async () => { closedByUs = true; device.removeEventListener('gattserverdisconnected', onGone); try { gatt.disconnect(); } catch { /* gone already */ } },
    };
  } catch (e) {
    device.removeEventListener('gattserverdisconnected', onGone);
    try { gatt.disconnect(); } catch { /* not connected */ }
    if (e instanceof OsmoError) throw e;
    throw new OsmoError('link', String(e));
  }
}

// ── the installed app ────────────────────────────────────────────────────

type Blec = typeof import('@mnlphlp/plugin-blec');
const SCAN_MS = 8_000;

type Found = { address: string; name: string };

/** One scan: the camera used last when it is there (by address, else by name),
 *  else the nearest one; null when none answered within SCAN_MS. */
async function scanOnce(blec: Blec, lastKey?: string, lastName?: string): Promise<Found | null> {
  return new Promise<Found | null>((resolve) => {
    let done = false;
    const finish = (d: { address: string; name: string } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void blec.stopScan().catch(() => undefined);
      resolve(d);
    };
    const timer = setTimeout(() => finish(null), SCAN_MS + 500);
    void blec.startScan((devices) => {
      const cams = devices.filter((d) => isOsmoAdvert(d.manufacturerData) || d.services?.some((s) => s.toLowerCase() === uuid16(OSMO_SERVICE)));
      if (!cams.length) return;
      const last = cams.find((d) => `native:${d.address}` === lastKey) || (lastName ? cams.find((d) => d.name === lastName) : undefined);
      // Asked for one camera (a reconnect): wait for it, do not take another.
      if (lastName && !last) return;
      const pick = last || cams.slice().sort((a, b) => b.rssi - a.rssi)[0];
      finish({ address: pick.address, name: pick.name || 'Osmo' });
    }, SCAN_MS).catch(() => finish(null));
  });
}

/** Scans for a camera and takes the first one found: a coach has one camera.
 *  The one used last is taken when it is among them. */
export async function findNativeCamera(lastKey?: string): Promise<Transport> {
  const blec: Blec = await import('@mnlphlp/plugin-blec');
  const state = await blec.getAdapterState().catch(() => 'Unknown');
  if (state === 'Off') throw new OsmoError('bluetooth-off');
  if (!(await blec.checkPermissions(true))) throw new OsmoError('permission');
  const found = await scanOnce(blec, lastKey);
  if (!found) throw new OsmoError('not-found');
  let address = found.address;
  const transport: Transport = {
    name: found.name,
    key: `native:${found.address}`,
    open: async (events) => {
      try {
        return await openNativeLink(blec, address, events);
      } catch (e) {
        // Back from its menus, a camera can advertise under another address:
        // look for it again by name before giving up on this try.
        const again = await scanOnce(blec, undefined, found.name);
        if (!again) throw e;
        address = again.address;
        return openNativeLink(blec, address, events);
      }
    },
  };
  return transport;
}

async function openNativeLink(blec: Blec, address: string, events: LinkEvents): Promise<OsmoLink> {
  let closedByUs = false;
  const service = uuid16(OSMO_SERVICE);
  try {
    const conn = await blec.connect(address, () => { if (!closedByUs) events.onClose(); });
    await conn.subscribe(uuid16(OSMO_NOTIFY), service, (data) => events.onData(Uint8Array.from(data)));
    return {
      write: (bytes, withResponse) => conn.send(uuid16(OSMO_WRITE), Array.from(bytes), withResponse ? 'withResponse' : 'withoutResponse', service),
      close: async () => { closedByUs = true; await conn.disconnect().catch(() => undefined); },
    };
  } catch (e) {
    throw new OsmoError('link', String(e));
  }
}
