/**
 * Upload a base64 data URI to catbox.moe and return a public URL.
 * Google image models (nano-banana) return data URIs instead of hosted URLs,
 * which breaks Telegram and other clients that can't render raw base64.
 */
export async function uploadDataUriToHost(dataUri: string): Promise<string> {
  const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) throw new Error("Invalid data URI format");
  const [, mimeType, b64Data] = match;
  const ext = mimeType === "image/jpeg" ? "jpg" : (mimeType.split("/")[1] ?? "png");

  const buffer = Buffer.from(b64Data, "base64");
  const blob = new Blob([buffer], { type: mimeType });

  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", blob, `image.${ext}`);

  const uploadController = new AbortController();
  const uploadTimeout = setTimeout(() => uploadController.abort(), 30_000);
  try {
    const resp = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      body: form,
      signal: uploadController.signal,
    });

    if (!resp.ok) throw new Error(`catbox.moe upload failed: HTTP ${resp.status}`);
    const result = await resp.text();
    if (result.startsWith("https://")) {
      return result.trim();
    }
    throw new Error(`catbox.moe upload failed: ${result}`);
  } finally {
    clearTimeout(uploadTimeout);
  }
}
