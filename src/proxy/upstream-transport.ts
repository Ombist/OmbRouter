/**
 * Pluggable upstream HTTP transport: Bearer API key vs x402 pay fetch.
 */
import type { PayFetchFn } from "./chat-request-context.js";

export type UpstreamMode = "x402" | "apiKey" | "moonpay";

/**
 * Wrap fetch to send `Authorization: Bearer <apiKey>` on every request.
 * Caller builds full URL (e.g. `${apiBase}${req.url}`) the same as x402 mode.
 */
export function createApiKeyPayFetch(apiKey: string, baseFetch: typeof fetch): PayFetchFn {
  const key = apiKey.trim();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    return baseFetch(input, { ...init, headers });
  };
}
