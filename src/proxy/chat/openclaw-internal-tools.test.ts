import { describe, it, expect } from "vitest";
import { filterOpenClawInternalTools, OPENCLAW_INTERNAL_TOOLS } from "./openclaw-internal-tools.js";

describe("openclaw-internal-tools", () => {
  it("filterOpenClawInternalTools removes known internal names", () => {
    const parsed: Record<string, unknown> = {
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "custom_api" } },
      ],
    };
    const removed = filterOpenClawInternalTools(parsed);
    expect(removed).toBe(1);
    const tools = parsed.tools as Array<{ function?: { name?: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].function?.name).toBe("custom_api");
  });

  it("OPENCLAW_INTERNAL_TOOLS includes update_plan", () => {
    expect(OPENCLAW_INTERNAL_TOOLS.has("update_plan")).toBe(true);
  });
});
