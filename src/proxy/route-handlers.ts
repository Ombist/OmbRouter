import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuxiliaryRouteContext } from "./routes/context.js";
import { tryHealthCacheStatsRoutes } from "./routes/health-cache-stats.js";
import { tryModelsAndStaticMediaRoutes } from "./routes/models-static.js";
import { tryImagePostRoutes } from "./routes/image-posts.js";
import { tryAudioPostRoute } from "./routes/audio-post.js";
import { tryPartnerAndNotV1Routes } from "./routes/partner-not-found.js";

export type { AuxiliaryRouteContext, ProviderErrorCounts } from "./routes/context.js";

/**
 * Handle /health, /cache, /stats, /v1/models, static assets, image/audio POST, partner paths.
 * Returns true if the request was fully handled.
 */
export async function tryHandleAuxiliaryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuxiliaryRouteContext,
): Promise<boolean> {
  if (await tryHealthCacheStatsRoutes(req, res, ctx)) return true;
  if (await tryModelsAndStaticMediaRoutes(req, res, ctx)) return true;
  if (await tryImagePostRoutes(req, res, ctx)) return true;
  if (await tryAudioPostRoute(req, res, ctx)) return true;
  if (await tryPartnerAndNotV1Routes(req, res, ctx)) return true;
  return false;
}
