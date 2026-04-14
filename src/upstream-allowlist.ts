import { normalizeUpstreamBaseUrl } from "./upstream-fetch.js";

/**
 * When OMBROUTER_UPSTREAM_ALLOWLIST is set (comma-separated hostnames or URL prefixes),
 * reject baseUrl values that do not match any entry. Default: unset = allow any.
 */
export function assertUpstreamAllowlist(apiBase: string): void {
  const raw = process.env.OMBROUTER_UPSTREAM_ALLOWLIST?.trim();
  if (!raw) return;

  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const norm = normalizeUpstreamBaseUrl(apiBase);
  let url: URL;
  try {
    url = new URL(norm.includes("://") ? norm : `https://${norm}`);
  } catch {
    throw new Error(`OmbRouter: cannot parse baseUrl for allowlist check: ${apiBase}`);
  }

  const ok = items.some((item) => {
    if (item.includes("://")) {
      const prefix = item.replace(/\/+$/, "");
      const n = norm.replace(/\/+$/, "");
      return n.startsWith(prefix) || n === prefix;
    }
    return url.hostname === item || url.hostname.endsWith(`.${item}`);
  });

  if (!ok) {
    throw new Error(
      "OmbRouter: baseUrl is not allowed by OMBROUTER_UPSTREAM_ALLOWLIST (comma-separated hostnames or https:// origin prefixes).",
    );
  }
}
