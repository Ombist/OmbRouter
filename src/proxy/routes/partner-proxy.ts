import type { IncomingMessage, ServerResponse } from "node:http";
import { logUsage } from "../../logger.js";
import { USER_AGENT } from "../../version.js";
import { readBodyWithTimeout, ERROR_BODY_READ_TIMEOUT_MS } from "../read-body.js";
import { safeWrite } from "../response-write.js";

/**
 * Proxy a partner API request through x402 payment flow.
 */
export async function proxyPartnerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiBase: string,
  payFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  getActualPaymentUsd: () => number,
): Promise<void> {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;

  const bodyChunks: Buffer[] = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(bodyChunks);

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key === "host" ||
      key === "connection" ||
      key === "transfer-encoding" ||
      key === "content-length"
    )
      continue;
    if (key.startsWith("x-stainless-") || key.startsWith("anthropic-")) continue;
    if (typeof value === "string") headers[key] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  headers["user-agent"] = USER_AGENT;

  console.log(`[OmbRouter] Partner request: ${req.method} ${req.url}`);

  const upstream = await payFetch(upstreamUrl, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
    responseHeaders[key] = value;
  });

  res.writeHead(upstream.status, responseHeaders);

  if (upstream.body) {
    const chunks = await readBodyWithTimeout(upstream.body, ERROR_BODY_READ_TIMEOUT_MS);
    for (const chunk of chunks) {
      safeWrite(res, Buffer.from(chunk));
    }
  }

  res.end();

  const latencyMs = Date.now() - startTime;
  console.log(`[OmbRouter] Partner response: ${upstream.status} (${latencyMs}ms)`);

  const partnerCost = getActualPaymentUsd();
  logUsage({
    timestamp: new Date().toISOString(),
    model: "partner",
    tier: "PARTNER",
    cost: partnerCost,
    baselineCost: partnerCost,
    savings: 0,
    latencyMs,
    partnerId:
      (req.url?.split("?")[0] ?? "").replace(/^\/v1\//, "").replace(/\//g, "_") || "unknown",
    service: "partner",
  }).catch(() => {});
}
