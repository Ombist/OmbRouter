import { describe, expect, it } from "vitest";

import { detectDegradedSuccessResponse } from "./proxy.js";

describe("detectDegradedSuccessResponse", () => {
  it("flags plain overload placeholder text", () => {
    const result = detectDegradedSuccessResponse(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(result).toBeDefined();
  });

  it("flags overload placeholder inside successful chat response JSON", () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "The AI service is temporarily overloaded. Please try again in a moment.",
          },
        },
      ],
    });

    const result = detectDegradedSuccessResponse(payload);
    expect(result).toBeDefined();
  });

  it("flags known repetitive hallucination loop patterns", () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: `The boxed is the response.

Yes.

The response is the text.

Yes.

The final answer is the boxed.

Yes.`,
          },
        },
      ],
    });

    const result = detectDegradedSuccessResponse(payload);
    expect(result).toBeDefined();
  });

  it("flags empty turn: no content and no tool_calls with finish_reason stop", () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
    });
    const result = detectDegradedSuccessResponse(payload);
    expect(result).toMatch(/empty turn/);
  });

  it("flags empty turn: null content, no tool_calls, finish_reason stop", () => {
    const payload = JSON.stringify({
      choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }],
    });
    const result = detectDegradedSuccessResponse(payload);
    expect(result).toMatch(/empty turn/);
  });

  it("does not flag responses with tool_calls even if content is empty", () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const result = detectDegradedSuccessResponse(payload);
    expect(result).toBeUndefined();
  });

  it("does not flag empty turn when finish_reason is not stop", () => {
    const payload = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
    });
    const result = detectDegradedSuccessResponse(payload);
    expect(result).toBeUndefined();
  });

  it("does not flag normal assistant responses", () => {
    const payload = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Paris is the capital of France.",
          },
        },
      ],
    });

    const result = detectDegradedSuccessResponse(payload);
    expect(result).toBeUndefined();
  });
});
