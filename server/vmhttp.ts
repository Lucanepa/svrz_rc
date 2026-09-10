// The HTTP pieces every VolleyManager caller needs: a cookie jar that survives
// the login redirect chain, and a redirect follower that keeps it fed.
//
// They were private to server/index.ts until the SR-Börse poller needed them
// too — and it cannot import that file, which starts an Express server on
// import. Copying them would have been worse: two cookie jars drift, and this
// one already carries a fix (the non-standard `getSetCookie` fallback) that a
// copy would quietly lack.
import { vmFetch } from './vmlock.ts';

export type VmTraceEntry = {
  step: string;
  requestUrl: string;
  status: number;
  redirected: boolean;
  location: string;
  pageTitle: string;
  bodySnippet: string;
};

export class CookieJar {
  private cookies: Record<string, string> = {};

  update(response: Response) {
    const typedHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    for (const cookieHeader of typedHeaders.getSetCookie?.() ?? []) {
      const match = cookieHeader.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.cookies[match[1]] = match[2];
      }
    }

    const fallback = response.headers.get('set-cookie');
    if (fallback) {
      for (const part of fallback.split(/,(?=\s*\w+=)/)) {
        const match = part.trim().match(/^([^=]+)=([^;]*)/);
        if (match) {
          this.cookies[match[1]] = match[2];
        }
      }
    }
  }

  set(name: string, value: string) {
    this.cookies[name] = value;
  }

  header(): string {
    return Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }
}



/** The <title> of an error page, for a trace entry that has to explain itself. */
function extractPageTitle(html: string): string {
  return (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** A little readable prose from a response, for the same reason. */
function snippetFromHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export const VM_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function followRedirects(
  baseUrl: string,
  url: string,
  jar: CookieJar,
  init: RequestInit = {},
  maxRedirects = 10,
  trace?: VmTraceEntry[],
  step = 'request',
): Promise<{ response: Response; body: string }> {
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
  let currentUrl = url;
  let currentInit = init;

  for (let i = 0; i < maxRedirects; i += 1) {
    const response = await vmFetch(currentUrl, {
      ...currentInit,
      headers: {
        'User-Agent': userAgent,
        Cookie: jar.header(),
        ...(currentInit.headers ?? {}),
      },
      redirect: 'manual',
    });
    jar.update(response);
    const body = await response.text();
    const location = response.headers.get('location') || '';
    trace?.push({
      step,
      requestUrl: currentUrl,
      status: response.status,
      redirected: response.status >= 300 && response.status < 400,
      location,
      pageTitle: extractPageTitle(body),
      bodySnippet: snippetFromHtml(body),
    });

    if (response.status >= 300 && response.status < 400) {
      if (!location) {
        break;
      }
      currentUrl = location.startsWith('http') ? location : `${baseUrl}${location}`;
      currentInit = {};
      continue;
    }

    return { response, body };
  }

  throw new Error(`Too many redirects while requesting ${url}`);
}

