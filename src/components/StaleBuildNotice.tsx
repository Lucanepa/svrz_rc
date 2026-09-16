import { RotateCw, X } from 'lucide-react';

// What a lazy chunk shows in its place when the build it belongs to is gone
// and the page could not be reloaded for it (see lib/freshImport.ts): the
// reason, and the way out. As an overlay where the reader would have been,
// inline where a pad would have been.
export default function StaleBuildNotice({ message, onClose, inline }: { message: string; onClose?: () => void; inline?: boolean }) {
  const body = (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 text-center shadow-sm" data-testid="stale-build">
      <p className="text-sm font-semibold text-stone-900">App-Update</p>
      <p className="mt-1.5 text-xs text-stone-600">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
      >
        <RotateCw className="h-4 w-4" /> Neu laden
      </button>
      {onClose && (
        <button type="button" onClick={onClose} className="mt-2 inline-flex w-full items-center justify-center gap-1 text-[11px] text-stone-400 hover:text-stone-600 underline">
          <X className="h-3 w-3" /> Schliessen
        </button>
      )}
    </div>
  );
  if (inline) return <div className="grid place-items-center p-4">{body}</div>;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-stone-900/90 p-4 no-print">
      {body}
    </div>
  );
}
