import logoUrl from './assets/svrz-logo.png';

// Official Swiss Volley Region Zürich logo (extracted from an official
// SVRZ document at 200 DPI): grey volleyball swoosh, SwissVolley wordmark,
// REGION ZÜRICH subtitle.
export default function SvrzLogo({ className = 'h-16' }: { className?: string }) {
  return (
    <img
      src={logoUrl}
      alt="Swiss Volley Region Zürich"
      className={`${className} w-auto`}
      draggable={false}
    />
  );
}
