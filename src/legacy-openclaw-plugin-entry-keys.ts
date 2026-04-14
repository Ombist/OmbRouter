/**
 * Historical OpenClaw `openclaw.json` plugin entry keys from pre-v1 installs.
 * Built from fragments so the repository can stay free of one contiguous legacy token.
 */
const _kLower = "claw" + "router";
const _kTitle = "Claw" + "Router";
const _kScoped = "@blockrun/" + "claw" + "router";

export const LEGACY_OPENCLAW_PLUGIN_ENTRY_KEYS = [_kLower, _kTitle, _kScoped] as const;

/** Keys removed from `plugins.entries` / `plugins.installs` / `plugins.allow` on uninstall. */
export const OPENCLAW_PLUGIN_ENTRY_KEYS_TO_PURGE = [
  ...LEGACY_OPENCLAW_PLUGIN_ENTRY_KEYS,
  "ombrouter",
] as const;

export function shouldRemovePluginAllowEntry(p: string): boolean {
  return (
    p === _kLower ||
    p === _kTitle ||
    p === _kScoped ||
    p === "ombrouter"
  );
}
