/**
 * Upstream OpenAI-compatible API URL resolution and fetch wrapper.
 * Adds optional Bearer API key and default headers to all requests.
 */

/**
 * Trim trailing slashes from base URL.
 */
export function normalizeUpstreamBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Join configured API base with incoming request path (e.g. /v1/chat/completions).
 * Uses WHATWG URL so /v1/... paths resolve correctly against .../v1 base.
 */
export function resolveUpstreamUrl(apiBase: string, reqPath: string | undefined): string {
  const base = normalizeUpstreamBaseUrl(apiBase);
  const path = reqPath?.startsWith("/") ? reqPath : `/${reqPath ?? ""}`;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).href;
}

export type UpstreamFetchInit = {
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
};

/**
 * Returns a fetch-like function that merges Authorization and default headers.
 */
export function createUpstreamFetch(
  init: UpstreamFetchInit,
): (input: RequestInfo | URL, requestInit?: RequestInit) => Promise<Response> {
  const { apiKey, defaultHeaders = {} } = init;

  return (input: RequestInfo | URL, requestInit?: RequestInit) => {
    const headers = new Headers(requestInit?.headers);
    for (const [k, v] of Object.entries(defaultHeaders)) {
      if (!headers.has(k)) headers.set(k, v);
    }
    if (apiKey && !headers.has("authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return fetch(input, { ...requestInit, headers });
  };
}
