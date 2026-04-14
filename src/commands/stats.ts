/**
 * /stats command — show OmbRouter usage statistics and cost savings.
 * Extracted from index.ts for modularity.
 */
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "../types.js";
import { getStats, formatStatsAscii, clearStats } from "../stats.js";

export function createStatsCommand(): OpenClawPluginCommandDefinition {
  return {
    name: "stats",
    description: "Show OmbRouter usage statistics and cost savings",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const arg = ctx.args?.trim().toLowerCase() || "7";

      if (arg === "clear" || arg === "reset") {
        try {
          const { deletedFiles } = await clearStats();
          return {
            text: `Stats cleared — ${deletedFiles} log file(s) deleted. Fresh start!`,
          };
        } catch (err) {
          return {
            text: `Failed to clear stats: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      const days = parseInt(arg, 10) || 7;

      try {
        const stats = await getStats(Math.min(days, 30)); // Cap at 30 days
        const ascii = formatStatsAscii(stats);

        return {
          text: ["```", ascii, "```"].join("\n"),
        };
      } catch (err) {
        return {
          text: `Failed to load stats: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
