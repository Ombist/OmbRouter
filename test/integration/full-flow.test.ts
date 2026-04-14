/**
 * Live upstream integration tests (optional).
 *
 * Set OMBROUTER_INTEGRATION_LIVE=1 and OMBROUTER_INTEGRATION_BASE_URL to a real
 * OpenAI-compatible API base (e.g. https://api.openai.com/v1). Optionally set
 * OMBROUTER_INTEGRATION_API_KEY.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startProxy } from "../../src/proxy.js";
import type { ProxyHandle } from "../../src/proxy.js";

const live = process.env.OMBROUTER_INTEGRATION_LIVE === "1";
const integrationBase = process.env.OMBROUTER_INTEGRATION_BASE_URL?.trim();
const integrationKey = process.env.OMBROUTER_INTEGRATION_API_KEY?.trim();

describe.skipIf(!live || !integrationBase)("OmbRouter full-flow (live upstream)", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = await startProxy({
      baseUrl: integrationBase!,
      apiKey: integrationKey,
      port: 0,
      skipBalanceCheck: true,
    });
  }, 60_000);

  afterAll(async () => {
    if (proxy) await proxy.close();
  });

  it("chat completion with ombrouter/free returns valid response", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ombrouter/free",
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 50,
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBeTruthy();
  }, 60_000);

  it("chat completion with ombrouter/auto resolves to a model", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ombrouter/auto",
        messages: [{ role: "user", content: "What is 2+2?" }],
        max_tokens: 50,
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.model).toBeTruthy();
    expect(body.choices.length).toBeGreaterThan(0);
  }, 60_000);

  it("streaming chat completion returns SSE with data and [DONE]", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ombrouter/free",
        messages: [{ role: "user", content: "Say hi." }],
        max_tokens: 50,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);

    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  }, 60_000);
});
