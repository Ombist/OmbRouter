import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { logUsage } from "../../logger.js";
import { USER_AGENT } from "../../version.js";
import { paymentStore } from "../payment-context.js";
import { estimateImageCost } from "../image-cost.js";
import { readImageFileAsDataUri } from "../local-files.js";
import type { AuxiliaryRouteContext } from "./context.js";
import { auxiliaryHttpRoutesEnabled } from "../upstream-capabilities.js";

export async function tryImagePostRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  const blockImageAudio = !auxiliaryHttpRoutesEnabled(
    ctx.options.upstreamMode ?? "x402",
    ctx.options.apiKeyAllowAuxRoutes,
  );
  if (
    blockImageAudio &&
    (req.url === "/v1/images/generations" || req.url === "/v1/images/image2image") &&
    req.method === "POST"
  ) {
    for await (const _chunk of req) {
      /* drain body */
    }
    res.writeHead(501, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "Image routes are disabled in apiKey upstream mode. Use upstreamMode x402 or moonpay with a BlockRun-compatible HTTPS apiBase, or see https://agents.moonpay.com/skill.md for MoonPay tooling.",
          type: "not_supported",
          code: "upstream_mode_api_key",
        },
      }),
    );
    return true;
  }

  if (req.url === "/v1/images/generations" && req.method === "POST") {
    const imgStartTime = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const reqBody = Buffer.concat(chunks);
    let imgModel = "unknown";
    let imgCost = 0;
    try {
      const parsed = JSON.parse(reqBody.toString());
      imgModel = parsed.model || "openai/dall-e-3";
      const n = parsed.n || 1;
      imgCost = estimateImageCost(imgModel, parsed.size, n);
    } catch {
      /* use defaults */
    }
    try {
      const upstream = await ctx.payFetch(`${ctx.apiBase}/v1/images/generations`, {
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
      let result: { created?: number; data?: Array<{ url?: string; revised_prompt?: string }> };
      try {
        result = JSON.parse(text);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(text);
        return true;
      }
      if (result.data?.length) {
        await mkdir(ctx.imageDir, { recursive: true });
        const port = ctx.getListenPort();
        for (const img of result.data) {
          const dataUriMatch = img.url?.match(/^data:(image\/\w+);base64,(.+)$/);
          if (dataUriMatch) {
            const [, mimeType, b64] = dataUriMatch;
            const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType!.split("/")[1] ?? "png");
            const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
            await writeFile(join(ctx.imageDir, filename), Buffer.from(b64!, "base64"));
            img.url = `http://localhost:${port}/images/${filename}`;
            console.log(`[OmbRouter] Image saved → ${img.url}`);
          } else if (img.url?.startsWith("https://") || img.url?.startsWith("http://")) {
            try {
              const imgResp = await fetch(img.url);
              if (imgResp.ok) {
                const contentType = imgResp.headers.get("content-type") ?? "image/png";
                const ext =
                  contentType.includes("jpeg") || contentType.includes("jpg")
                    ? "jpg"
                    : contentType.includes("webp")
                      ? "webp"
                      : "png";
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                const buf = Buffer.from(await imgResp.arrayBuffer());
                await writeFile(join(ctx.imageDir, filename), buf);
                img.url = `http://localhost:${port}/images/${filename}`;
                console.log(`[OmbRouter] Image downloaded & saved → ${img.url}`);
              }
            } catch (downloadErr) {
              console.warn(
                `[OmbRouter] Failed to download image, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
              );
            }
          }
        }
      }
      const imgActualCost = paymentStore.getStore()?.amountUsd ?? imgCost;
      logUsage({
        timestamp: new Date().toISOString(),
        model: imgModel,
        tier: "IMAGE",
        cost: imgActualCost,
        baselineCost: imgActualCost,
        savings: 0,
        latencyMs: Date.now() - imgStartTime,
      }).catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OmbRouter] Image generation error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Image generation failed", details: msg }));
      }
    }
    return true;
  }

  if (req.url === "/v1/images/image2image" && req.method === "POST") {
    const img2imgStartTime = Date.now();
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks);

    let reqBody: string;
    let img2imgModel = "openai/gpt-image-1";
    let img2imgCost = 0;
    try {
      const parsed = JSON.parse(rawBody.toString());
      for (const field of ["image", "mask"] as const) {
        const val = parsed[field];
        if (typeof val !== "string" || !val) continue;
        if (val.startsWith("data:")) {
          // pass through
        } else if (val.startsWith("https://") || val.startsWith("http://")) {
          const imgResp = await fetch(val);
          if (!imgResp.ok)
            throw new Error(`Failed to download ${field} from ${val}: HTTP ${imgResp.status}`);
          const contentType = imgResp.headers.get("content-type") ?? "image/png";
          const buf = Buffer.from(await imgResp.arrayBuffer());
          parsed[field] = `data:${contentType};base64,${buf.toString("base64")}`;
          console.log(
            `[OmbRouter] img2img: downloaded ${field} URL → data URI (${buf.length} bytes)`,
          );
        } else {
          parsed[field] = readImageFileAsDataUri(val);
          console.log(`[OmbRouter] img2img: read ${field} file → data URI`);
        }
      }
      if (!parsed.model) parsed.model = "openai/gpt-image-1";
      img2imgModel = parsed.model;
      img2imgCost = estimateImageCost(img2imgModel, parsed.size, parsed.n || 1);
      reqBody = JSON.stringify(parsed);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request", details: msg }));
      return true;
    }

    try {
      const upstream = await ctx.payFetch(`${ctx.apiBase}/v1/images/image2image`, {
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
      let result: { created?: number; data?: Array<{ url?: string; revised_prompt?: string }> };
      try {
        result = JSON.parse(text);
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(text);
        return true;
      }
      if (result.data?.length) {
        await mkdir(ctx.imageDir, { recursive: true });
        const port = ctx.getListenPort();
        for (const img of result.data) {
          const dataUriMatch = img.url?.match(/^data:(image\/\w+);base64,(.+)$/);
          if (dataUriMatch) {
            const [, mimeType, b64] = dataUriMatch;
            const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType!.split("/")[1] ?? "png");
            const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
            await writeFile(join(ctx.imageDir, filename), Buffer.from(b64!, "base64"));
            img.url = `http://localhost:${port}/images/${filename}`;
            console.log(`[OmbRouter] Image saved → ${img.url}`);
          } else if (img.url?.startsWith("https://") || img.url?.startsWith("http://")) {
            try {
              const imgResp = await fetch(img.url);
              if (imgResp.ok) {
                const contentType = imgResp.headers.get("content-type") ?? "image/png";
                const ext =
                  contentType.includes("jpeg") || contentType.includes("jpg")
                    ? "jpg"
                    : contentType.includes("webp")
                      ? "webp"
                      : "png";
                const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
                const buf = Buffer.from(await imgResp.arrayBuffer());
                await writeFile(join(ctx.imageDir, filename), buf);
                img.url = `http://localhost:${port}/images/${filename}`;
                console.log(`[OmbRouter] Image downloaded & saved → ${img.url}`);
              }
            } catch (downloadErr) {
              console.warn(
                `[OmbRouter] Failed to download image, using original URL: ${downloadErr instanceof Error ? downloadErr.message : String(downloadErr)}`,
              );
            }
          }
        }
      }
      const img2imgActualCost = paymentStore.getStore()?.amountUsd ?? img2imgCost;
      logUsage({
        timestamp: new Date().toISOString(),
        model: img2imgModel,
        tier: "IMAGE",
        cost: img2imgActualCost,
        baselineCost: img2imgActualCost,
        savings: 0,
        latencyMs: Date.now() - img2imgStartTime,
      }).catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[OmbRouter] Image editing error: ${msg}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Image editing failed", details: msg }));
      }
    }
    return true;
  }

  return false;
}
