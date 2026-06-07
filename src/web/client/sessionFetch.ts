const sessionHeader = 'x-imagex-session';

let tokenPromise: Promise<string> | null = null;

export function installImagexSessionFetch(): void {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!shouldAttachSession(input, init)) return nativeFetch(input, init);
    const token = await getSessionToken(nativeFetch);
    const headers = new Headers(headersFrom(input, init));
    headers.set(sessionHeader, token);
    return nativeFetch(input, { ...init, headers });
  };
}

function shouldAttachSession(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  const url = requestUrl(input);
  return url.origin === window.location.origin && url.pathname.startsWith('/api/');
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.toString(), window.location.origin);
  if (input instanceof Request) return new URL(input.url, window.location.origin);
  return new URL(String(input), window.location.origin);
}

function headersFrom(input: RequestInfo | URL, init?: RequestInit): HeadersInit | undefined {
  if (init?.headers) return init.headers;
  if (input instanceof Request) return input.headers;
  return undefined;
}

async function getSessionToken(fetchImpl: typeof window.fetch): Promise<string> {
  tokenPromise ??= fetchImpl('/api/session', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('Unable to start ImageX API session.');
      const data = (await response.json()) as { token?: string };
      if (!data.token) throw new Error('ImageX API session response did not include a token.');
      return data.token;
    });
  return tokenPromise;
}
