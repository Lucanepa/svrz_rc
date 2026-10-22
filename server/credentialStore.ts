// The read side of the stored login credentials (server/index.ts, "Stored
// credentials") — the cache and the fallback, kept here so a spec can drive a
// store that fails without a database behind it (e2e/credential-store.spec.ts).
// index.ts keeps the I/O: the settings row, the lock, the write.
//
// 22.10.2026 (log audit, R3): the read used to swallow an error and cache an
// EMPTY map for 60 s. Empty means "never set in the console", and a slot never
// set falls back to its env variable — so for a minute after one unreadable
// row, the bootstrap passwords from the container's environment opened the
// app and the console, and the passwords set in the console were refused. It
// was armed on 10.10 at 14:13Z with nobody signing in. A team login made in
// such a window would carry a token that survives the next rotation.
//
// Now an error is never an answer. The last map that WAS read stands in for
// the store while it cannot be reached; with none, the read throws and the
// login answers 503. A missing row is still a successful read — that is a
// fresh deployment, and the env bootstrap is exactly what it is for.

/** The store could not be read, and there is no earlier copy to answer with. */
export class CredentialsUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`stored credentials unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CredentialsUnavailableError';
    (this as { cause?: unknown }).cause = cause;
  }
}

export type CredentialReader<T> = {
  /** The stored map: cached, freshly read, or — when the store fails — the
   *  last one read. Throws CredentialsUnavailableError when there is none. */
  read(): Promise<T>;
  /** Drop the cached copy; the next read goes to the store. */
  invalidate(): void;
  /** What a write just stored. It is the store's content from this moment,
   *  so it — not the map from before the write — is what a failed read falls
   *  back to: otherwise an outage right after a rotation would bring the
   *  rotated-away password back. Also drops the cached copy. */
  remember(value: T): void;
};

export function createCredentialReader<T>(opts: {
  /** One read of the store. Resolves the empty map for a missing row; throws
   *  for anything it could not read or parse. */
  load: () => Promise<T>;
  ttlMs: number;
  now?: () => number;
  /** Told about each failed read, and whether a last good copy answered it. */
  onError?: (error: unknown, servedLastGood: boolean) => void;
}): CredentialReader<T> {
  const now = opts.now ?? Date.now;
  let cache: { data: T; expiresAt: number } | null = null;
  let lastGood: { data: T } | null = null;
  // Bumped by every invalidate/remember. A read that was already in flight
  // when the store changed must not put its older answer back in the cache or
  // in lastGood after the write's.
  let generation = 0;

  return {
    async read() {
      if (cache && cache.expiresAt > now()) return cache.data;
      const startedIn = generation;
      try {
        const data = await opts.load();
        if (startedIn === generation) {
          cache = { data, expiresAt: now() + opts.ttlMs };
          lastGood = { data };
        }
        return data;
      } catch (error) {
        // Never cached: the next request asks the store again, so the moment
        // it is back the logins are judged on what it holds.
        opts.onError?.(error, Boolean(lastGood));
        if (lastGood) return lastGood.data;
        throw new CredentialsUnavailableError(error);
      }
    },
    invalidate() {
      generation += 1;
      cache = null;
    },
    remember(value) {
      generation += 1;
      cache = null;
      lastGood = { data: value };
    },
  };
}

/** Whether two login names are the same name as a person types it: trimmed,
 *  any case. A phone capitalises the first letter of a username field, and
 *  "Admin" is the admin. Not for secrets — a name, compared in the clear. */
export function sameLoginName(typed: string, stored: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase();
  return norm(stored) !== '' && norm(typed) === norm(stored);
}
