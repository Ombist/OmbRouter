/**
 * Integration test setup — mock upstream + OmbRouter proxy on a worker port.
 */

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startProxy } from "../../src/proxy.js";
import type { ProxyHandle } from "../../src/proxy.js";

const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 5_000;

let mockServer: Server | undefined;
let proxyHandle: ProxyHandle | undefined;

function getTestPort(): number {
  const workerRaw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? "1";
  const workerId = Number.parseInt(workerRaw, 10);
  if (Number.isInteger(workerId) && workerId >= 1) {
    return 8401 + workerId;
  }
  return 8402;
}

function startMockUpstream(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (req.method === "GET" && url.split("?")[0] === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [{ id: "mock/upstream-model", object: "model" }],
            }),
          );
          return;
        }
        if (req.method === "POST" && url.includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: `chatcmpl-mock-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "mock/upstream-model",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "mock upstream ok" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("mock upstream: no address"));
        return;
      }
      mockServer = server;
      resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
    server.on("error", reject);
  });
}

export async function startTestProxy(): Promise<ProxyHandle> {
  if (proxyHandle) return proxyHandle;

  const baseUrl = await startMockUpstream();
  const testPort = getTestPort();

  proxyHandle = await startProxy({
    baseUrl,
    port: testPort,
    skipBalanceCheck: true,
  });

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${proxyHandle.baseUrl}/health`);
      if (res.ok) return proxyHandle;
    } catch {
      // proxy not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }

  throw new Error(`Test proxy did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

export async function stopTestProxy(): Promise<void> {
  if (proxyHandle) {
    await proxyHandle.close();
    proxyHandle = undefined;
  }
  if (mockServer) {
    await new Promise<void>((r) => mockServer!.close(() => r()));
    mockServer = undefined;
  }
}

export function getTestProxyUrl(): string {
  if (!proxyHandle) throw new Error("Test proxy not started — call startTestProxy() first");
  return proxyHandle.baseUrl;
}
