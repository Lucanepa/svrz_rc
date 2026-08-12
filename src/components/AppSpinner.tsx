import SvrzLogo from '../SvrzLogo';

/**
 * The loading spinner: the SVRZ mark held still in the middle while a ball and
 * a referee run two crossed elliptical orbits around it.
 *
 * The orbits are real ellipses tilted ±45°, not circles under a rotated parent —
 * a circle looks identical however you tilt it, and squashing a spinning parent
 * shears whatever rides on it, so the ball would wobble. Each satellite instead
 * follows a `path()` via `offset-path`, which is CSS rather than SMIL and so
 * can be switched off for people who ask for less motion.
 *
 * The path coordinates are pixels in a fixed box, so the whole thing scales
 * from one transform on the wrapper rather than from re-derived geometry.
 */

// The box is sized around the wordmark, not the other way round. The mark is
// ~100×24 at h-6, and both radii have to clear it by more than the satellite's
// own half-width (11px) or the ball crops the logo's corners as it passes:
// 70 > 50 + 11 across, 26 > 12 + 11 down.
const BOX = 170;
const CENTRE = BOX / 2;
const RX = 70;
const RY = 26;

// An ellipse tilted by `deg`, drawn as two arcs between the ends of its major
// axis. Those ends are the centre plus/minus the major axis rotated by `deg`.
function tiltedEllipsePath(deg: number): string {
  const rad = (deg * Math.PI) / 180;
  const dx = RX * Math.cos(rad);
  const dy = RX * Math.sin(rad);
  const ax = (CENTRE - dx).toFixed(2);
  const ay = (CENTRE - dy).toFixed(2);
  const bx = (CENTRE + dx).toFixed(2);
  const by = (CENTRE + dy).toFixed(2);
  return `M ${ax},${ay} A ${RX},${RY} ${deg} 1 0 ${bx},${by} A ${RX},${RY} ${deg} 1 0 ${ax},${ay}`;
}

const BALL_ORBIT = tiltedEllipsePath(45);
const REF_ORBIT = tiltedEllipsePath(-45);

/** A volleyball: the three seams are what make it one at this size. */
function Volleyball() {
  return (
    <svg viewBox="-12 -12 24 24" className="h-[22px] w-[22px] drop-shadow-sm" aria-hidden="true">
      <circle r="10" fill="#ffffff" stroke="#a8a29e" strokeWidth="1.1" />
      <g fill="none" stroke="#a8a29e" strokeWidth="1.1" strokeLinecap="round">
        <path d="M -10,-2 C -4,-4 4,-3 9.4,3.4" />
        <path d="M -3.5,-9.4 C -1,-3 0.5,3 -2.6,9.6" />
        <path d="M 6.5,-7.6 C 3.5,-3.5 -2,0.5 -9.8,1.5" />
      </g>
    </svg>
  );
}

/** A referee mid-signal: one arm up is the shape that reads as "referee". */
function Referee() {
  return (
    <svg viewBox="-12 -12 24 24" className="h-[22px] w-[22px] drop-shadow-sm" aria-hidden="true">
      <g stroke="#44403c" strokeWidth="1.8" strokeLinecap="round" fill="none">
        {/* Legs first, so the shirt overlaps them at the waist. */}
        <path d="M -1.5,2.6 L -2.4,8.4" />
        <path d="M 1.5,2.6 L 2.4,8.4" />
        {/* The signalling arm, and the one at rest. */}
        <path d="M 3.4,-2.6 L 7.4,-7.8" />
        <path d="M -3.4,-2.4 L -6.2,1.6" />
      </g>
      <circle cx="0" cy="-6.6" r="2.8" fill="#44403c" />
      {/* Shirt: narrow waist, so it reads as a torso and not a bell. */}
      <path d="M -3.6,-3 Q 0,-4 3.6,-3 L 3,3.2 Q 0,4 -3,3.2 Z" fill="#e2001a" />
    </svg>
  );
}

export default function AppSpinner({
  size = BOX,
  label,
  className = '',
}: {
  /** Rendered width/height in px. The geometry is scaled, never recomputed. */
  size?: number;
  /** Announced to screen readers and shown under the mark when present. */
  label?: string;
  className?: string;
}) {
  const scale = size / BOX;
  return (
    <div className={`flex flex-col items-center gap-3 ${className}`} role="status" aria-busy="true">
      <div
        style={{ width: size, height: size }}
        className="relative shrink-0"
        aria-hidden="true"
      >
        <div
          style={{ width: BOX, height: BOX, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          className="absolute left-0 top-0"
        >
          {/* The tracks. Faint on purpose: they explain the motion without
              competing with the mark they surround. */}
          <svg viewBox={`0 0 ${BOX} ${BOX}`} className="absolute inset-0 h-full w-full">
            <g fill="none" stroke="#e7e5e4" strokeWidth="1.25">
              <path d={BALL_ORBIT} />
              <path d={REF_ORBIT} />
            </g>
          </svg>

          {/* Offset by half a lap so the two are never on top of each other. */}
          <span className="svrz-orbit" style={{ offsetPath: `path("${BALL_ORBIT}")` }}>
            <Volleyball />
          </span>
          <span className="svrz-orbit" style={{ offsetPath: `path("${REF_ORBIT}")`, animationDelay: '-1.3s' }}>
            <Referee />
          </span>

          {/* Last, so it is painted OVER the satellites. An ellipse comes closer
              to the centre than the corners of the wordmark's box do, so
              whatever is passing would otherwise clip "REGION ZÜRICH" twice a
              lap. Ducking behind the mark also reads more like an orbit than
              sliding across the front of it does. */}
          <SvrzLogo className="absolute left-1/2 top-1/2 h-6 -translate-x-1/2 -translate-y-1/2" />
        </div>
      </div>
      {label && <p className="text-xs font-medium text-stone-500">{label}</p>}
      <span className="sr-only">{label || 'Wird geladen…'}</span>
    </div>
  );
}
