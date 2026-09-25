// Placeholders for data that is still in flight. They keep a page's real
// layout on screen during the first load, so a list that is merely loading
// never looks like a list that is empty.
//
// Used wherever a list, a dashboard or a form is waiting for its data — in the
// coach app from the very first load, and in the admin console. The branded
// spinner (components/AppSpinner.tsx) is kept for the moments there is no
// shape to hold yet: the session check before the app knows who you are, a
// signature waiting on the server, a lazily loaded tool.

export function Skeleton({ className = '' }: { className?: string; key?: string | number }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-stone-200/80 ${className}`} />;
}

export function SkeletonRows({ rows = 6, pill = true }: { rows?: number; pill?: boolean }) {
  return (
    <div className="divide-y divide-stone-100" role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          {pill && <Skeleton className="h-5 w-16 rounded-full" />}
        </div>
      ))}
    </div>
  );
}

export default Skeleton;
