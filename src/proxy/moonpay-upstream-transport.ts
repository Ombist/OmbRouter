/**
 * MoonPay Agent upstream: delegates paid HTTPS requests to `mp x402 request`.
 * Uses the local MoonPay CLI wallet (OS keychain) — no OmbRouter-held private key.
 *
 * @see https://agents.moonpay.com/skill.md — tool `x402_request`
 *
 * Limitations (MoonPay CLI contract):
 * - Target URL must be public HTTPS (not localhost / private IPs).
 * - Responses are fully buffered JSON; for chat completions with stream:true we synthesize SSE.
 */
import { spawn } from "node:child_process";
import type { PayFetchFn } from "./chat-request-context.js";

export type MoonPayChain = "solana" | "base" | "ethereum" | "arbitrum" | "polygon" | "optimism";

export type MoonPayCliPayFetchOptions = {
  /** Path to `mp` binary (default: `mp` on PATH). */
  mpPath?: string;
  /** Local wallet name registered in MoonPay CLI. */
  wallet: string;
  /** Chain to pay from (default: base for BlockRun-style APIs). */
  chain?: MoonPayChain;
  /** Max ms for each `mp` invocation (default: 180000). */
  timeoutMs?: number;
};

type X402RequestCliResult = {
  status: number;
  data: unknown;
  headers: Record<string, unknown>;
};

function parseMethod(m: string | undefined): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  const u = (m ?? "GET").toUpperCase();
  if (u === "POST" || u === "PUT" || u === "PATCH" || u === "DELETE" || u === "GET") return u;
  return "GET";
}

function runMpX402Request(
  mpPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(mpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`MoonPay CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Build OpenAI-style SSE from a non-streaming chat completion JSON body. */
function chatCompletionJsonToSse(data: Record<string, unknown>): string {
  const choice0 = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const msg = choice0?.message as Record<string, unknown> | undefined;
  const content = typeof msg?.content === "string" ? msg.content : "";
  const id = typeof data.id === "string" ? data.id : "chatcmpl-moonpay";
  const model = typeof data.model === "string" ? data.model : "";
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: data.created ?? Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const parts: string[] = [];
  if (content) {
    parts.push(`data: ${chunk({ content }, null)}\n\n`);
  } else {
    parts.push(`data: ${chunk({}, null)}\n\n`);
  }
  parts.push(`data: ${chunk({}, "stop")}\n\n`);
  parts.push("data: [DONE]\n\n");
  return parts.join("");
}

/**
 * PayFetch that runs `mp x402 request --json ...` for each call.
 */
export function createMoonPayCliPayFetch(
  options: MoonPayCliPayFetchOptions,
  _baseFetch: typeof fetch,
): PayFetchFn {
  const mpPath = options.mpPath?.trim() || "mp";
  const wallet = options.wallet.trim();
  const chain = options.chain ?? "base";
  const timeoutMs = options.timeoutMs ?? 180_000;

  if (!wallet) {
    throw new Error("MoonPay: wallet name is required");
  }

  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = parseMethod(init?.method);

    let bodyObj: Record<string, unknown> | null = null;
    let wantedStream = false;
    if (init?.body !== undefined && init.body !== null) {
      const raw =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body).toString("utf8")
            : await new Response(init.body as BodyInit).text();
      if (raw.length > 0) {
        try {
          bodyObj = JSON.parse(raw) as Record<string, unknown>;
          if (bodyObj.stream === true) {
            wantedStream = true;
            bodyObj = { ...bodyObj, stream: false };
          }
        } catch {
          bodyObj = null;
        }
      }
    }

    // Global `--json` must come before subcommands (MoonPay CLI / commander).
    const args = [
      "--json",
      "x402",
      "request",
      "--method",
      method,
      "--url",
      url,
      "--wallet",
      wallet,
      "--chain",
      chain,
    ];
    if (bodyObj !== null && (method === "POST" || method === "PUT" || method === "PATCH")) {
      args.push("--body", JSON.stringify(bodyObj));
    } else {
      args.push("--body", "null");
    }
    args.push("--params", "null");

    let result: X402RequestCliResult;
    try {
      const { stdout, stderr, code } = await runMpX402Request(mpPath, args, timeoutMs);
      if (code !== 0) {
        const msg = stderr.trim() || stdout.trim() || `mp exited with code ${code}`;
        return new Response(JSON.stringify({ error: { message: msg, type: "moonpay_cli_error" } }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        return new Response(
          JSON.stringify({ error: { message: "Empty output from mp", type: "moonpay_cli_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
      result = JSON.parse(trimmed) as X402RequestCliResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: { message: msg, type: "moonpay_cli_error" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    const status = Number.isFinite(result.status) ? result.status : 502;
    const data = result.data;

    if (wantedStream && status === 200 && data !== null && typeof data === "object") {
      const sse = chatCompletionJsonToSse(data as Record<string, unknown>);
      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const jsonStr = JSON.stringify(data ?? null);
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (result.headers && typeof result.headers === "object") {
      for (const [k, v] of Object.entries(result.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
    }
    return new Response(jsonStr, { status, headers });
  };
}
