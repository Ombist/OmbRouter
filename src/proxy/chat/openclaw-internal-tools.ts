/**
 * OpenClaw agent-framework tools that upstream BlockRun models must not receive.
 */
export const OPENCLAW_INTERNAL_TOOLS = new Set([
  "update_plan",
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "web_search",
  "web_fetch",
  "browser",
  "memory_search",
]);

/**
 * Removes internal tools from `parsed.tools` in place.
 * @returns number of tools removed (0 if none)
 */
export function filterOpenClawInternalTools(parsed: Record<string, unknown>): number {
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return 0;
  const originalCount = parsed.tools.length;
  parsed.tools = (
    parsed.tools as Array<{ function?: { name?: string } }>
  ).filter((t) => !OPENCLAW_INTERNAL_TOOLS.has(t?.function?.name ?? ""));
  const removed = originalCount - (parsed.tools as unknown[]).length;
  if (removed > 0) {
    console.log(
      `[OmbRouter] Filtered ${removed} internal OpenClaw tool${removed > 1 ? "s" : ""} (update_plan, etc.)`,
    );
  }
  return removed;
}
