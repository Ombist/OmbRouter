import type { ServerResponse } from "node:http";

/**
 * Check if response socket is writable (prevents write-after-close errors).
 */
export function canWrite(res: ServerResponse): boolean {
  return (
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket.destroyed &&
    res.socket.writable
  );
}

/**
 * Safe write with backpressure handling.
 */
export function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    console.warn(`[OmbRouter] safeWrite: socket not writable, dropping ${bytes} bytes`);
    return false;
  }
  return res.write(data);
}
