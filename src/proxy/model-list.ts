import { OPENCLAW_MODELS } from "../models.js";

type ModelListEntry = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

/**
 * Build `/v1/models` response entries from the local OpenClaw routing registry (`OPENCLAW_MODELS`).
 * This is not fetched from MoonPay or the live upstream; see `modelsEndpointMeta` and `/health` `modelsEndpoint`.
 */
export function buildProxyModelList(createdAt: number = Math.floor(Date.now() / 1000)): ModelListEntry[] {
  const seen = new Set<string>();
  return OPENCLAW_MODELS.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).map((model) => ({
    id: model.id,
    object: "model" as const,
    created: createdAt,
    owned_by: model.id.includes("/") ? (model.id.split("/")[0] ?? "blockrun") : "blockrun",
  }));
}
