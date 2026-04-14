import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";

const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { createMoonPayCliPayFetch } from "./moonpay-upstream-transport.js";

function fakeMpChild(stdout: string, stderr: string, code: number): ChildProcess {
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    stdoutEmitter.emit("data", Buffer.from(stdout));
    stderrEmitter.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

describe("createMoonPayCliPayFetch", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invokes mp with --json x402 request and forwards JSON body on POST", async () => {
    const cliOut = JSON.stringify({
      status: 200,
      data: { ok: true, model: "m" },
      headers: { "Content-Type": "application/json" },
    });
    mockSpawn.mockImplementation(() => fakeMpChild(cliOut, "", 0));

    const payFetch = createMoonPayCliPayFetch(
      { wallet: "my-wallet", chain: "base", mpPath: "/bin/mp" },
      fetch,
    );

    const res = await payFetch("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [mpPath, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(mpPath).toBe("/bin/mp");
    expect(args[0]).toBe("--json");
    expect(args.slice(1, 3)).toEqual(["x402", "request"]);
    expect(args).toContain("--wallet");
    expect(args).toContain("my-wallet");
    expect(args).toContain("--chain");
    expect(args).toContain("base");
    expect(args).toContain("https://api.example.com/v1/chat/completions");

    expect(res.ok).toBe(true);
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBe(true);
  });

  it("sets stream:false in body sent to mp when client asked for stream:true and returns synthetic SSE", async () => {
    const completion = {
      id: "id1",
      object: "chat.completion",
      created: 1,
      model: "gpt-test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
    };
    const cliOut = JSON.stringify({
      status: 200,
      data: completion,
      headers: {},
    });
    mockSpawn.mockImplementation(() => fakeMpChild(cliOut, "", 0));

    const payFetch = createMoonPayCliPayFetch({ wallet: "w" }, fetch);
    const res = await payFetch("https://api.example.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [], stream: true }),
    });

    const bodyIdx = (mockSpawn.mock.calls[0][1] as string[]).indexOf("--body");
    const bodyArg = (mockSpawn.mock.calls[0][1] as string[])[bodyIdx + 1];
    const parsed = JSON.parse(bodyArg) as { stream?: boolean };
    expect(parsed.stream).toBe(false);

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("hello");
    expect(text).toContain("[DONE]");
  });

  it("returns 502 JSON when mp exits non-zero", async () => {
    mockSpawn.mockImplementation(() => fakeMpChild("", "not logged in", 1));

    const payFetch = createMoonPayCliPayFetch({ wallet: "w" }, fetch);
    const res = await payFetch("https://api.example.com/x", { method: "GET" });
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error?: { type?: string } };
    expect(j.error?.type).toBe("moonpay_cli_error");
  });
});
