import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { readFile, stat as fsStat } from "node:fs/promises";
import { buildProxyModelList } from "../model-list.js";
import { modelsEndpointMeta } from "../upstream-capabilities.js";
import type { AuxiliaryRouteContext } from "./context.js";

export async function tryModelsAndStaticMediaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  if (req.url === "/v1/models" && req.method === "GET") {
    const models = buildProxyModelList();
    const me = modelsEndpointMeta(ctx.upstreamMode, ctx.options.apiKeyAllowAuxRoutes);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-OmbRouter-Models-Source": me.source,
      "X-OmbRouter-Paid-BlockRun-Aux-Routes": me.paidBlockRunAuxRoutesEnabled ? "true" : "false",
      "X-OmbRouter-Aux-Http-Routes-Enabled": me.auxiliaryHttpRoutesEnabled ? "true" : "false",
    });
    res.end(JSON.stringify({ object: "list", data: models }));
    return true;
  }

  if (req.url?.startsWith("/images/") && req.method === "GET") {
    const filename = req.url
      .slice("/images/".length)
      .split("?")[0]!
      .replace(/[^a-zA-Z0-9._-]/g, "");
    if (!filename) {
      res.writeHead(400);
      res.end("Bad request");
      return true;
    }
    const filePath = join(ctx.imageDir, filename);
    try {
      const s = await fsStat(filePath);
      if (!s.isFile()) throw new Error("not a file");
      const ext = filename.split(".").pop()?.toLowerCase() ?? "png";
      const mime: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
      };
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": mime[ext] ?? "application/octet-stream",
        "Content-Length": data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Image not found" }));
    }
    return true;
  }

  if (req.url?.startsWith("/audio/") && req.method === "GET") {
    const filename = req.url
      .slice("/audio/".length)
      .split("?")[0]!
      .replace(/[^a-zA-Z0-9._-]/g, "");
    if (!filename) {
      res.writeHead(400);
      res.end("Bad request");
      return true;
    }
    const filePath = join(ctx.audioDir, filename);
    try {
      const s = await fsStat(filePath);
      if (!s.isFile()) throw new Error("not a file");
      const ext = filename.split(".").pop()?.toLowerCase() ?? "mp3";
      const mime: Record<string, string> = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        m4a: "audio/mp4",
      };
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": mime[ext] ?? "audio/mpeg",
        "Content-Length": data.length,
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Audio not found" }));
    }
    return true;
  }

  return false;
}
