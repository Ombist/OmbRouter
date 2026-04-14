import type { IncomingMessage, ServerResponse } from "node:http";
import { ResponseCache } from "../../response-cache.js";
import { RequestDeduplicator } from "../../dedup.js";
import {
  mergeOutgoingHeaders,
  traceResponseHeaders,
  type ResolvedRequestTrace,
} from "./request-trace.js";

export type CompletionCacheDedupResult =
  | { outcome: "responded" }
  | { outcome: "continue"; cacheKey: string; dedupKey: string };

/**
 * Long-TTL response cache short-circuit, then dedup cache / in-flight wait, then mark in-flight.
 */
export async function runCompletionCacheAndDedupPhase(input: {
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  responseCache: ResponseCache;
  deduplicator: RequestDeduplicator;
  trace: ResolvedRequestTrace;
}): Promise<CompletionCacheDedupResult> {
  const { req, res, body, responseCache, deduplicator, trace } = input;

  const cacheKey = ResponseCache.generateKey(body);
  const reqHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") reqHeaders[key] = value;
  }

  if (responseCache.shouldCache(body, reqHeaders)) {
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      trace.logger.log(`Cache HIT for ${cachedResponse.model} (saved API call)`);
      res.writeHead(
        cachedResponse.status,
        mergeOutgoingHeaders(cachedResponse.headers, traceResponseHeaders(trace)),
      );
      res.end(cachedResponse.body);
      return { outcome: "responded" };
    }
  }

  const dedupKey = RequestDeduplicator.hash(body);

  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, mergeOutgoingHeaders(cached.headers, traceResponseHeaders(trace)));
    res.end(cached.body);
    return { outcome: "responded" };
  }

  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, mergeOutgoingHeaders(result.headers, traceResponseHeaders(trace)));
    res.end(result.body);
    return { outcome: "responded" };
  }

  deduplicator.markInflight(dedupKey);
  return { outcome: "continue", cacheKey, dedupKey };
}
