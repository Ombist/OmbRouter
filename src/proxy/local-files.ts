import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

/**
 * Read a local image file and return it as a base64 data URI.
 */
export function readImageFileAsDataUri(filePath: string): string {
  const resolved = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;

  if (!existsSync(resolved)) {
    throw new Error(`Image file not found: ${resolved}`);
  }

  const ext = resolved.split(".").pop()?.toLowerCase() ?? "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] ?? "image/png";
  const data = readFileSync(resolved);
  return `data:${mime};base64,${data.toString("base64")}`;
}
