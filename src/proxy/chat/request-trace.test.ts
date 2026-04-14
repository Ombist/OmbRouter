import { describe, it, expect } from "vitest";
import {
  getOrCreateRequestId,
  sanitizeRequestId,
  requestTraceLogPrefix,
  DEFAULT_INCOMING_TRACE_HEADERS,
} from "./request-trace.js";
import type { IncomingMessage } from "node:http";

function mockReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("request-trace", () => {
  it("sanitizeRequestId rejects empty and control chars", () => {
    expect(sanitizeRequestId("")).toBeUndefined();
    expect(sanitizeRequestId("  ")).toBeUndefined();
    expect(sanitizeRequestId("a\nb")).toBeUndefined();
    expect(sanitizeRequestId("ok-123")).toBe("ok-123");
  });

  it("sanitizeRequestId rejects too long", () => {
    expect(sanitizeRequestId("a".repeat(129))).toBeUndefined();
  });

  it("getOrCreateRequestId prefers x-request-id", () => {
    const id = getOrCreateRequestId(
      mockReq({ "x-request-id": "client-abc", "x-correlation-id": "other" }),
    );
    expect(id).toBe("client-abc");
  });

  it("getOrCreateRequestId falls back to x-correlation-id", () => {
    const id = getOrCreateRequestId(mockReq({ "x-correlation-id": "corr-1" }));
    expect(id).toBe("corr-1");
  });

  it("getOrCreateRequestId ignores invalid and generates uuid", () => {
    const id = getOrCreateRequestId(mockReq({ "x-request-id": "bad\nid" }));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("requestTraceLogPrefix includes id", () => {
    expect(requestTraceLogPrefix("x")).toBe("[OmbRouter][req=x]");
  });

  it("DEFAULT_INCOMING_TRACE_HEADERS is ordered", () => {
    expect(DEFAULT_INCOMING_TRACE_HEADERS[0]).toBe("x-request-id");
  });

  it("getOrCreateRequestId falls back to x-ombrouter-request-id", () => {
    const id = getOrCreateRequestId(
      mockReq({ "x-ombrouter-request-id": "omb-trace-1" }),
    );
    expect(id).toBe("omb-trace-1");
  });

  it("getOrCreateRequestId ignores deprecated vendor-prefixed trace header (not in default list)", () => {
    const deprecatedHeader = "x-" + "claw" + "router" + "-request-id";
    const id = getOrCreateRequestId(mockReq({ [deprecatedHeader]: "legacy-only" }));
    expect(id).not.toBe("legacy-only");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
