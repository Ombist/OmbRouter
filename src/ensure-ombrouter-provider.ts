/**
 * Pure merge logic for models.providers.ombrouter during OpenClaw config injection.
 * Preserves user-supplied keys (e.g. request.tls) — only touches baseUrl, api, apiKey, models.
 */

export type OpenClawModelRef = { id: string };

export type EnsureOmbrouterProviderResult = {
  changed: boolean;
  modelListUpdated?: boolean;
};

export function ensureOmbrouterProviderFields(
  entry: Record<string, unknown>,
  expectedBaseUrl: string,
  openClawModels: readonly OpenClawModelRef[],
): EnsureOmbrouterProviderResult {
  let changed = false;
  let modelListUpdated = false;

  if (!entry.baseUrl || entry.baseUrl !== expectedBaseUrl) {
    entry.baseUrl = expectedBaseUrl;
    changed = true;
  }
  if (!entry.api) {
    entry.api = "openai-completions";
    changed = true;
  }
  if (!entry.apiKey) {
    entry.apiKey = "ombrouter-local-proxy";
    changed = true;
  }

  const currentModels = entry.models as Array<{ id?: string }> | undefined;
  const currentModelIds = new Set(
    Array.isArray(currentModels) ? currentModels.map((m) => m?.id).filter(Boolean) : [],
  );
  const expectedModelIds = openClawModels.map((m) => m.id);
  const needsModelUpdate =
    !currentModels ||
    !Array.isArray(currentModels) ||
    currentModels.length !== openClawModels.length ||
    expectedModelIds.some((id) => !currentModelIds.has(id));

  if (needsModelUpdate) {
    entry.models = openClawModels;
    changed = true;
    modelListUpdated = true;
  }

  return { changed, modelListUpdated };
}

const EXTRAS_KEY = "openclawProviderExtras";

/**
 * Optional plugin manifest fields merged into `models.providers.ombrouter` when persisting
 * openclaw.json. Only sets keys that are currently missing; never overwrites an existing
 * `request` subtree (manual request.tls etc. wins).
 */
export function applyOptionalOpenclawProviderExtras(
  entry: Record<string, unknown>,
  pluginConfig: Record<string, unknown> | undefined,
): boolean {
  const extras = pluginConfig?.[EXTRAS_KEY];
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) {
    return false;
  }

  let changed = false;
  for (const [k, v] of Object.entries(extras as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (k === "request") {
      if (entry.request !== undefined) continue;
      entry.request = v;
      changed = true;
      continue;
    }
    if (entry[k] === undefined) {
      entry[k] = v;
      changed = true;
    }
  }
  return changed;
}
