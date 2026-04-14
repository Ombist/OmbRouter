import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { logUsage } from "../../logger.js";
import { USER_AGENT } from "../../version.js";
import { paymentStore } from "../payment-context.js";
import type { AuxiliaryRouteContext } from "./context.js";
import { auxiliaryHttpRoutesEnabled } from "../upstream-capabilities.js";

export async function tryAudioPostRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  if (req.url !== "/v1/audio/generations" || req.method !== "POST") {
    return false;
  }

  if (
    !auxiliaryHttpRoutesEnabled(ctx.options.upstreamMode ?? "x402", ctx.options.apiKeyAllowAuxRoutes)
  ) {
    for await (const _chunk of req) {
      /* drain body */
    }
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "Audio generation is disabled in apiKey upstream mode. Use upstreamMode x402 or moonpay with a BlockRun-compatible HTTPS apiBase, or see https://agents.moonpay.com/skill.md for MoonPay tooling.",
          type: "not_supported",
          code: "upstream_mode_api_key",
        },
      }),
    );
    return true;
  }

  const audioStartTime = Date.now();
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const reqBody = Buffer.concat(chunks);
  let audioModel = "minimax/music-2.5+";
  try {
    const parsed = JSON.parse(reqBody.toString());
    audioModel = parsed.model || audioModel;
  } catch {
    /* use defaults */
  }
  try {
    const upstream = await ctx.payFetch(`${ctx.apiBase}/v1/audio/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: reqBody,
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(text);
      return true;
    }
    let result: {
      created?: number;
      model?: string;
      data?: Array<{ url?: string; duration_seconds?: number; lyrics?: string }>;
    };
    try {
      result = JSON.parse(text);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(text);
      return true;
    }
    if (result.data?.length) {
      await mkdir(ctx.audioDir, { recursive: true });
      const port = ctx.getListenPort();
      for (const track of result.data) {
        if (track.url?.startsWith("https://") || track.url?.startsWith("http://")) {
          try {
            const audioResp = await fetch(track.url);
            if (audioResp.ok) {
              const contentType = audioResp.headers.get("content-type") ?? "audio/mpeg";
              const ext = contentType.includes("wav") ? "wav" : "mp3";
              const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
              const buf = Buffer.from(await audioResp.arrayBuffer());
              await writeFile(join(ctx.audioDir, filename), buf);
              track.url = `http://localhost:${port}/audio/${filename}`;
              console.log(`[OmbRouter] Audio saved → ${track.url}`);
            }
          } catch (downloadErr) {
            console.warn(
              `[OmbRouter] Failed to download audio, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
            );
          }
        }
      }
    }
    const audioActualCost = paymentStore.getStore()?.amountUsd ?? 0.15;
    logUsage({
      timestamp: new Date().toISOString(),
      model: audioModel,
      tier: "AUDIO",
      cost: audioActualCost,
      baselineCost: audioActualCost,
      savings: 0,
      latencyMs: Date.now() - audioStartTime,
    }).catch(() => {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[OmbRouter] Audio generation error: ${msg}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Audio generation failed", details: msg }));
    }
  }
  return true;
}
