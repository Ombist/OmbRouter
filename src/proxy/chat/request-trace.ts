import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

const MAX_REQUEST_ID_LEN = 128;

/** Headers checked in order (lowercase keys). */
export const DEFAULT_INCOMING_TRACE_HEADERS = [
  "x-request-id",
  "x-correlation-id",
  "x-ombrouter-request-id",
] as const;

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._:@/+-]+$/;

function singleHeader(
  headers: IncomingMessage["headers"],
  name: string,
): string | undefined {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

/**
 * Trim and cap length; reject values with control chars or unsafe characters.
 */
export function sanitizeRequestId(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_REQUEST_ID_LEN) return undefined;
  if (/[\x00-\x1f\x7f]/.test(t)) return undefined;
  if (!SAFE_ID_PATTERN.test(t)) return undefined;
  return t;
}

/**
 * Use client-provided trace id from common headers, or generate a new UUID.
 */
export function getOrCreateRequestId(
  req: IncomingMessage,
  headerNames: readonly string[] = DEFAULT_INCOMING_TRACE_HEADERS,
): string {
  for (const name of headerNames) {
    const raw = singleHeader(req.headers, name);
    if (raw) {
      const s = sanitizeRequestId(raw);
      if (s) return s;
    }
  }
  return randomUUID();
}

export function requestTraceLogPrefix(requestId: string): string {
  return `[OmbRouter][req=${requestId}]`;
}

export type RequestTraceLogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createRequestLogger(requestId: string): RequestTraceLogger {
  const p = requestTraceLogPrefix(requestId);
  return {
    log: (...args: unknown[]) => console.log(p, ...args),
    warn: (...args: unknown[]) => console.warn(p, ...args),
    error: (...args: unknown[]) => console.error(p, ...args),
  };
}

/**
 * Merge outgoing response headers; later keys win. Keys normalized to lowercase for Node.
 */
export function mergeOutgoingHeaders(
  base: Record<string, string | number | string[]>,
  extra: Record<string, string>,
): Record<string, string | number | string[]> {
  return { ...base, ...extra };
}

/** Add `request_id` on the nested `error` object when present, else top-level. */
export function attachRequestIdToErrorPayload(
  payload: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> {
  const err = payload["error"];
  if (err && typeof err === "object" && err !== null && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    if (e["request_id"] === undefined) {
      return {
        ...payload,
        error: { ...e, request_id: requestId },
      };
    }
    return payload;
  }
  if (payload["request_id"] === undefined) {
    return { ...payload, request_id: requestId };
  }
  return payload;
}

export function attachRequestIdToErrorJsonString(
  jsonStr: string,
  requestId: string,
): string {
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    return JSON.stringify(attachRequestIdToErrorPayload(o, requestId));
  } catch {
    return jsonStr;
  }
}

export type ResolvedRequestTrace = {
  requestId: string;
  /** Echo on HTTP responses (SSE first line, JSON errors, cache replay). */
  echoResponseHeader: boolean;
  responseHeaderName: string;
  includeRequestIdInErrorBody: boolean;
  logger: RequestTraceLogger;
};

export function resolveRequestTrace(
  req: IncomingMessage,
  options: {
    requestTrace?: {
      enabled?: boolean;
      responseHeader?: string;
      includeInErrorBody?: boolean;
    };
  },
): ResolvedRequestTrace {
  const rt = options.requestTrace;
  const enabled = rt?.enabled !== false;
  const responseHeaderName = (rt?.responseHeader ?? "x-request-id").toLowerCase();
  const includeRequestIdInErrorBody = rt?.includeInErrorBody !== false;
  const requestId = getOrCreateRequestId(req);
  return {
    requestId,
    echoResponseHeader: enabled,
    responseHeaderName,
    includeRequestIdInErrorBody,
    logger: createRequestLogger(requestId),
  };
}

export function traceResponseHeaders(
  trace: ResolvedRequestTrace,
): Record<string, string> {
  if (!trace.echoResponseHeader) return {};
  return { [trace.responseHeaderName]: trace.requestId };
}
