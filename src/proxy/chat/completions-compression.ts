import { compressContext, shouldCompress, type NormalizedMessage } from "../../compression/index.js";
import type { RequestTraceLogger } from "./request-trace.js";

/**
 * Optionally compress large chat completion JSON bodies in place (LLM-safe layers).
 */
export async function maybeCompressChatCompletionBody(input: {
  body: Buffer;
  autoCompress: boolean;
  compressionThresholdKB: number;
  log: RequestTraceLogger;
}): Promise<Buffer> {
  const { body, autoCompress, compressionThresholdKB, log } = input;
  const requestSizeKB = Math.ceil(body.length / 1024);

  if (!autoCompress || requestSizeKB <= compressionThresholdKB) {
    return body;
  }

  try {
    log.log(
      `Request size ${requestSizeKB}KB exceeds threshold ${compressionThresholdKB}KB, applying compression...`,
    );

    const parsed = JSON.parse(body.toString()) as {
      messages?: NormalizedMessage[];
      [key: string]: unknown;
    };

    if (parsed.messages && parsed.messages.length > 0 && shouldCompress(parsed.messages)) {
      const compressionResult = await compressContext(parsed.messages, {
        enabled: true,
        preserveRaw: false,
        layers: {
          deduplication: true,
          whitespace: true,
          dictionary: false,
          paths: false,
          jsonCompact: true,
          observation: false,
          dynamicCodebook: false,
        },
        dictionary: {
          maxEntries: 50,
          minPhraseLength: 15,
          includeCodebookHeader: false,
        },
      });

      const compressedSizeKB = Math.ceil(compressionResult.compressedChars / 1024);
      const savings = (((requestSizeKB - compressedSizeKB) / requestSizeKB) * 100).toFixed(1);

      log.log(`Compressed ${requestSizeKB}KB → ${compressedSizeKB}KB (${savings}% reduction)`);

      parsed.messages = compressionResult.messages;
      return Buffer.from(JSON.stringify(parsed));
    }
  } catch (err) {
    log.warn(`Compression failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return body;
}
