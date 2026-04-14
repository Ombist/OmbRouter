import { describe, it, expect } from "vitest";
import { maybeCompressChatCompletionBody } from "./completions-compression.js";

const noopLog = { log: () => {}, warn: () => {}, error: () => {} };

describe("maybeCompressChatCompletionBody", () => {
  it("returns same buffer when below threshold", async () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "x" }] }));
    const out = await maybeCompressChatCompletionBody({
      body,
      autoCompress: true,
      compressionThresholdKB: 1_000_000,
      log: noopLog,
    });
    expect(out.equals(body)).toBe(true);
  });

  it("returns same buffer when autoCompress is false", async () => {
    const body = Buffer.from("not-json");
    const out = await maybeCompressChatCompletionBody({
      body,
      autoCompress: false,
      compressionThresholdKB: 0,
      log: noopLog,
    });
    expect(out.equals(body)).toBe(true);
  });
});
