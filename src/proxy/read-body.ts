/** Default timeout for reading model response bodies (reasoning models are slow). */
export const MODEL_BODY_READ_TIMEOUT_MS = 300_000; // 5 minutes

/** Timeout for error / partner response body reads. */
export const ERROR_BODY_READ_TIMEOUT_MS = 30_000;

export async function readBodyWithTimeout(
  body: ReadableStream<Uint8Array> | null,
  timeoutMs: number = MODEL_BODY_READ_TIMEOUT_MS,
): Promise<Uint8Array[]> {
  if (!body) return [];

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Body read timeout")), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (result.done) break;
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }

  return chunks;
}
