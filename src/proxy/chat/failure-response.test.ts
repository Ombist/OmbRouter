import { describe, it, expect, vi, beforeEach } from "vitest";

const safeWriteMock = vi.fn();
vi.mock("../response-write.js", () => ({
  safeWrite: (...args: unknown[]) => safeWriteMock(...args),
}));

vi.mock("../payment-context.js", () => ({
  paymentStore: { getStore: () => undefined },
}));

vi.mock("../../logger.js", () => ({
  logUsage: vi.fn().mockResolvedValue(undefined),
}));

import { respondToAllUpstreamModelsFailed } from "./failure-response.js";
import type { RequestDeduplicator } from "../../dedup.js";

const traceLog = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("respondToAllUpstreamModelsFailed", () => {
  beforeEach(() => {
    safeWriteMock.mockClear();
  });

  it("emits SSE data lines with OpenAI-shaped error for plain text body", () => {
    const end = vi.fn();
    const res = { end } as unknown as import("node:http").ServerResponse;
    const complete = vi.fn();
    const deduplicator = { complete } as unknown as RequestDeduplicator;

    respondToAllUpstreamModelsFailed({
      res,
      headersSentEarly: true,
      failedAttempts: [{ model: "m", reason: "x", status: 500 }],
      lastError: { body: "plain text error", status: 502 },
      originalContextSizeKB: 1,
      contextLimitKb: 256,
      deduplicator,
      dedupKey: "k",
      routingDecision: undefined,
      modelId: "openai/x",
      startTime: Date.now(),
      log: traceLog,
      requestId: "test-req-id",
      includeRequestIdInErrorBody: true,
      extraResponseHeaders: {},
    });

    const dataCalls = safeWriteMock.mock.calls.map((c) => String(c[1]));
    const dataLine = dataCalls.find((s) => s.startsWith("data: ") && !s.includes("[DONE]"));
    expect(dataLine).toBeDefined();
    const jsonStr = dataLine!.replace(/^data: /, "").trim();
    const parsed = JSON.parse(jsonStr) as {
      error?: { type?: string; message?: string; request_id?: string };
    };
    expect(parsed.error?.type).toBe("provider_error");
    expect(parsed.error?.message).toContain("plain text");
    expect(parsed.error?.request_id).toBe("test-req-id");
    expect(end).toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      "k",
      expect.objectContaining({ status: 200 }),
    );
  });
});
