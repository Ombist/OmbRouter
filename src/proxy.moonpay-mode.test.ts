import { describe, expect, it } from "vitest";
import { startProxy } from "./proxy.js";
import type { PayFetchFn } from "./proxy/chat-request-context.js";

describe("moonpay upstream mode", () => {
  it("starts without a local BlockRun wallet key and forwards chat completion via payFetch override", async () => {
    const proxyPort = 33000 + Math.floor(Math.random() * 5000);

    const fakePayFetch: PayFetchFn = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("chat/completions")) {
        return new Response(JSON.stringify({ error: "unexpected url" }), { status: 500 });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mp-test",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "moonpay-upstream-ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const handle = await startProxy({
      upstreamMode: "moonpay",
      moonpayWallet: "test-wallet",
      _payFetchOverride: fakePayFetch,
      port: proxyPort,
      skipBalanceCheck: true,
    });

    try {
      const health = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      expect(health.ok).toBe(true);
      const h = (await health.json()) as {
        upstreamMode?: string;
        moonpayWallet?: string;
        modelsEndpoint?: { source?: string; paidBlockRunAuxRoutes?: boolean };
      };
      expect(h.upstreamMode).toBe("moonpay");
      expect(h.moonpayWallet).toBe("test-wallet");
      expect(h.modelsEndpoint?.source).toBe("openclaw_router_registry");
      expect(h.modelsEndpoint?.paidBlockRunAuxRoutes).toBe(true);

      const modelsRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
      expect(modelsRes.ok).toBe(true);
      expect(modelsRes.headers.get("X-OmbRouter-Models-Source")).toBe("openclaw_router_registry");
      expect(modelsRes.headers.get("X-OmbRouter-Paid-BlockRun-Aux-Routes")).toBe("true");

      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.ok).toBe(true);
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      expect(data.choices?.[0]?.message?.content).toBe("moonpay-upstream-ok");
    } finally {
      await handle.close();
    }
  });
});
