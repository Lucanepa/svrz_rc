// The few pointer rules the notebook's pen page (InkPad) and the signature pad
// share. Only these: the two routers themselves really differ (pinch, pan and
// the palm-lead undo on the page; pen lock, purge and settle on the pad), but
// a palm is the same palm on both, and two copies of these numbers had already
// drifted apart once (24.10.2026). Dependency-free, so the signature pad can
// keep it in the main bundle.

/** A fingertip is smaller; a palm is hundreds of px. Not 40: WebKit reports a
 *  touch's width as twice UITouch.majorRadius, about 42 px for a light
 *  fingertip, so a 40 px rule took every finger for a palm. */
export const PALM_MAX_CONTACT_PX = 80;

/** On a pad, a touch stays a palm this long after the pen was last on (or
 *  over) the glass. For the buttons around it only the pen ON the glass
 *  counts: a finger tap that close to the pen's contact is the writing hand's,
 *  while a hovering Pencil must not swallow a deliberate tap of the other hand. */
export const PEN_TRAILING_MS = 500;

/** A contact wider or taller than a fingertip, when the browser reports one. */
export function isLargeContact(e: PointerEvent): boolean {
  return e.width > PALM_MAX_CONTACT_PX || e.height > PALM_MAX_CONTACT_PX;
}

/** Every sample the hardware took since the last event: a Pencil records up to
 *  240 Hz, pointermove fires at 60/120 Hz. Safari has the list since 18.2;
 *  older iPads get the event alone. */
export function coalescedOf(e: PointerEvent): PointerEvent[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

/** Capture AFTER the stroke started: setPointerCapture throws NotFoundError
 *  for a pointer that is not active — every synthetic dispatch, or a real one
 *  released before the handler ran — and unguarded it would abort the stroke
 *  and file a js.error. */
export function captureQuietly(el: Element, pointerId: number): void {
  try { el.setPointerCapture(pointerId); } catch { /* see above */ }
}
