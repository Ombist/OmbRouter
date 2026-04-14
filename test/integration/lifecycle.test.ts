/**
 * Layer 1 — Lifecycle integration tests (mock upstream + proxy).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestProxy, stopTestProxy, getTestProxyUrl } from "./setup.js";

describe("OmbRouter proxy lifecycle", () => {
  beforeAll(async () => {
    await startTestProxy();
  });

  afterAll(async () => {
    await stopTestProxy();
  });

  it("GET /health returns 200 with status ok and upstream metadata", async () => {
    const res = await fetch(`${getTestProxyUrl()}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      upstreamFingerprint: string;
      upstreamBase: string;
      version: string;
      plugin: string;
    };
    expect(body.status).toBe("ok");
    expect(body.upstreamFingerprint).toBeTruthy();
    expect(body.upstreamBase).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(body.plugin).toBe("ombrouter");
  });

  it("GET /health?full=true includes balance info", async () => {
    const res = await fetch(`${getTestProxyUrl()}/health?full=true`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");

    const hasBalanceInfo = "balance" in body || "balanceError" in body;
    expect(hasBalanceInfo).toBe(true);
  });

  it("GET /v1/models returns model list with routing profiles", async () => {
    const res = await fetch(`${getTestProxyUrl()}/v1/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBeGreaterThan(0);

    const modelIds = body.data.map((m) => m.id);
    // Routing profile meta-models
    expect(modelIds).toContain("auto");
    expect(modelIds).toContain("eco");
    expect(modelIds).toContain("free");
    expect(modelIds).toContain("premium");
  });

  it("GET /nonexistent returns 404", async () => {
    const res = await fetch(`${getTestProxyUrl()}/nonexistent`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });

  it("GET /stats returns stats JSON", async () => {
    const res = await fetch(`${getTestProxyUrl()}/stats`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });
});
