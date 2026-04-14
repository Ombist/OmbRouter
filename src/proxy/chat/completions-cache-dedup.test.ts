import { describe, it, expect, vi } from "vitest";
import { runCompletionCacheAndDedupPhase } from "./completions-cache-dedup.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResponseCache } from "../../response-cache.js";
import type { RequestDeduplicator } from "../../dedup.js";
import type { ResolvedRequestTrace } from "./request-trace.js";

describe("runCompletionCacheAndDedupPhase", () => {
  it("returns responded and writes headers when long cache hits", async () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const res = { writeHead, end } as unknown as ServerResponse;
    const req = { headers: {} } as IncomingMessage;

    const trace: ResolvedRequestTrace = {
      requestId: "rid",
      echoResponseHeader: true,
      responseHeaderName: "x-request-id",
      includeRequestIdInErrorBody: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const body = Buffer.from('{"model":"m","messages":[]}');

    const responseCache = {
      shouldCache: () => true,
      get: () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
        model: "test-model",
      }),
    } as unknown as ResponseCache;

    const markInflight = vi.fn();
    const deduplicator = {
      getCached: () => undefined,
      getInflight: () => undefined,
      markInflight,
    } as unknown as RequestDeduplicator;

    const r = await runCompletionCacheAndDedupPhase({
      req,
      res,
      body,
      responseCache,
      deduplicator,
      trace,
    });

    expect(r).toEqual({ outcome: "responded" });
    expect(writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "content-type": "application/json",
        "x-request-id": "rid",
      }),
    );
    expect(end).toHaveBeenCalled();
    expect(markInflight).not.toHaveBeenCalled();
  });

  it("returns continue and marks inflight when no short-circuit", async () => {
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    const req = { headers: {} } as IncomingMessage;
    const trace: ResolvedRequestTrace = {
      requestId: "r2",
      echoResponseHeader: false,
      responseHeaderName: "x-request-id",
      includeRequestIdInErrorBody: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    const body = Buffer.from("{}");

    const responseCache = {
      shouldCache: () => false,
      get: vi.fn(),
    } as unknown as ResponseCache;

    const markInflight = vi.fn();
    const deduplicator = {
      getCached: () => undefined,
      getInflight: () => undefined,
      markInflight,
    } as unknown as RequestDeduplicator;

    const r = await runCompletionCacheAndDedupPhase({
      req,
      res,
      body,
      responseCache,
      deduplicator,
      trace,
    });

    expect(r.outcome).toBe("continue");
    if (r.outcome === "continue") {
      expect(r.cacheKey).toBeDefined();
      expect(r.dedupKey).toBeDefined();
      expect(markInflight).toHaveBeenCalledWith(r.dedupKey);
    }
  });
});
