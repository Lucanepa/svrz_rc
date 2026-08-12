import { Volleyball } from 'lucide-react';
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
// ~100×24 at h-6, and the track has to stand off it by more than the
// satellite's own half-width — which grew with the icons, so the radii grew
// with it. The satellites pass behind the mark, so a clip is not fatal; a
// track that hugs it just stops reading as an orbit.
const BOX = 186;
const CENTRE = BOX / 2;
const RX = 78;
const RY = 32;

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

// 1.5x the original 22px. Big enough that the ball's seams and the whistle's
// mouthpiece survive at a glance, which was the point of using real icons.
const SAT = 33;

/**
 * A referee's whistle, drawn on lucide's own grid — 24×24, 2px stroke, round
 * caps and joins, artwork inset from the edges — because lucide has no whistle
 * of its own (checked against the installed 0.577 and upstream `main`) and the
 * ball beside it is the genuine lucide icon. Anything drawn to a different
 * convention would read as the odd one out.
 */
function Whistle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={SAT}
      height={SAT}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Bulb and mouthpiece, and nothing else. A lanyard ring on top turned it
          into a key, and an air hole in the body into an eye — at 33px the
          silhouette is the whole of the recognition. The mouthpiece meets the
          bulb on a tangent rather than pointing at its centre, which is what
          keeps it from reading as a magnifying glass. */}
      <circle cx="14.5" cy="13.5" r="6.5" />
      <path d="M8.6 10.8 3.4 8.9a2 2 0 0 0-1.4 3.7l5.3 1.9" />
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
            <Volleyball size={SAT} strokeWidth={1.75} className="text-stone-500 drop-shadow-sm" />
          </span>
          <span className="svrz-orbit" style={{ offsetPath: `path("${REF_ORBIT}")`, animationDelay: '-1.3s' }}>
            <Whistle className="text-[#e2001a] drop-shadow-sm" />
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
