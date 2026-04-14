import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import { startProxy } from "./proxy.js";

describe("apiKey upstream mode", () => {
  it("starts without a wallet and proxies a chat completion with Bearer auth", async () => {
    const upstreamPort = 22000 + Math.floor(Math.random() * 5000);
    const proxyPort = 32000 + Math.floor(Math.random() * 5000);

    const upstream = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer test-secret-key") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi-from-upstream" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.listen(upstreamPort, "127.0.0.1", () => resolve());
      upstream.on("error", reject);
    });

    const apiBase = `http://127.0.0.1:${upstreamPort}`;

    const handle = await startProxy({
      upstreamMode: "apiKey",
      upstreamApiKey: "test-secret-key",
      apiBase,
      port: proxyPort,
      skipBalanceCheck: true,
    });

    try {
      const health = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      expect(health.ok).toBe(true);
      const h = (await health.json()) as {
        upstreamMode?: string;
        status?: string;
        modelsEndpoint?: { source?: string; paidBlockRunAuxRoutes?: boolean };
      };
      expect(h.status).toBe("ok");
      expect(h.upstreamMode).toBe("apiKey");
      expect(h.modelsEndpoint?.source).toBe("openclaw_router_registry");
      expect(h.modelsEndpoint?.paidBlockRunAuxRoutes).toBe(false);
      expect(h.modelsEndpoint?.auxiliaryHttpRoutesEnabled).toBe(false);
      expect(h.modelsEndpoint?.auxiliaryHttpRoutesTransport).toBeNull();

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
      expect(data.choices?.[0]?.message?.content).toBe("hi-from-upstream");
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("forwards POST /v1/images/generations with Bearer when apiKeyAllowAuxRoutes is true", async () => {
    const upstreamPort = 22000 + Math.floor(Math.random() * 5000);
    const proxyPort = 32000 + Math.floor(Math.random() * 5000);

    const upstream = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer test-secret-key") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        if (req.url === "/v1/images/generations" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              created: 1,
              data: [
                {
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.listen(upstreamPort, "127.0.0.1", () => resolve());
      upstream.on("error", reject);
    });

    const apiBase = `http://127.0.0.1:${upstreamPort}`;

    const handle = await startProxy({
      upstreamMode: "apiKey",
      upstreamApiKey: "test-secret-key",
      apiBase,
      apiKeyAllowAuxRoutes: true,
      port: proxyPort,
      skipBalanceCheck: true,
    });

    try {
      const health = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      const h = (await health.json()) as {
        modelsEndpoint?: {
          auxiliaryHttpRoutesEnabled?: boolean;
          auxiliaryHttpRoutesTransport?: string | null;
        };
      };
      expect(h.modelsEndpoint?.auxiliaryHttpRoutesEnabled).toBe(true);
      expect(h.modelsEndpoint?.auxiliaryHttpRoutesTransport).toBe("bearer");

      const imgRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "test", n: 1 }),
      });
      expect(imgRes.status).toBe(200);
      const body = (await imgRes.json()) as { data?: Array<{ url?: string }> };
      expect(body.data?.[0]?.url).toMatch(/\/images\/[\w.-]+\.png$/);
    } finally {
      await handle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
