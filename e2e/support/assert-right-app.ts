/**
 * Refuse to run the suite against somebody else's dev server.
 *
 * `reuseExistingServer` adopts whatever already listens on the port, and it does
 * not care whose app that is. On a machine running several projects it silently
 * pointed this whole suite at an unrelated application: ~120 failures, every one
 * "element(s) not found" or a click timeout, with `tsc --noEmit` clean and the
 * code perfectly fine. Twenty minutes went into hunting a regression that did
 * not exist.
 *
 * One fetch, before any test, turns that into a sentence that names the problem.
 */
export default async function assertRightApp(): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || 4374}`;
  let html: string;
  try {
    html = await (await fetch(baseURL)).text();
  } catch (error) {
    throw new Error(`E2E: nothing answered at ${baseURL} — ${error instanceof Error ? error.message : String(error)}`);
  }
  // The title and the app shell are ours; a colliding project's index is not.
  if (!/svrz|swiss\s*volley/i.test(html)) {
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || '(no title)';
    throw new Error(
      `E2E: ${baseURL} is serving a DIFFERENT app — <title> is "${title}".\n` +
      `Another project is already on that port and reuseExistingServer adopted it.\n` +
      `Free the port, or run against another one:  E2E_PORT=4399 npx playwright test`,
    );
  }
}
