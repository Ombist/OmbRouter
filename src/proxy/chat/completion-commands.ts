import type { ServerResponse } from "node:http";
import { paymentStore } from "../payment-context.js";
import { logUsage } from "../../logger.js";
import { estimateImageCost } from "../image-cost.js";
import { readImageFileAsDataUri } from "../local-files.js";
import { uploadDataUriToHost } from "../chat-upload.js";
import { USER_AGENT } from "../../version.js";
import { route, DEFAULT_ROUTING_CONFIG, type RouterOptions } from "../../router/index.js";
import { classifyByRules } from "../../router/rules.js";
import type { SessionStore } from "../../session.js";
import type { PayFetchFn } from "../chat-request-context.js";

type CommandsCtx = {
  apiBase: string;
  payFetch: PayFetchFn;
  routerOpts: RouterOptions;
  sessionStore: SessionStore;
};

/**
 * Handles /debug, /imagegen, and /img2img when the last user message matches.
 * @returns true if the response was fully written and the caller should return.
 */
export async function tryHandleCompletionSlashCommands(input: {
  res: ServerResponse;
  ctx: CommandsCtx;
  parsed: Record<string, unknown>;
  lastContent: string;
  isStreaming: boolean;
  maxTokens: number;
  sessionId: string | undefined;
}): Promise<boolean> {
  const { res, ctx, parsed, lastContent, isStreaming, maxTokens, sessionId } = input;
  const { apiBase, payFetch, routerOpts, sessionStore } = ctx;

  if (lastContent.startsWith("/debug")) {
    const debugPrompt = lastContent.slice("/debug".length).trim() || "hello";
    const messages = parsed.messages as Array<{ role: string; content: unknown }>;
    const systemMsg = messages?.find((m) => m.role === "system");
    const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : undefined;
    const fullText = `${systemPrompt ?? ""} ${debugPrompt}`;
    const estimatedTokens = Math.ceil(fullText.length / 4);

    const normalizedModel =
      typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
    const profileName = normalizedModel.replace("blockrun/", "");
    const debugProfile = (
      ["eco", "auto", "premium"].includes(profileName) ? profileName : "auto"
    ) as "eco" | "auto" | "premium";

    const scoring = classifyByRules(
      debugPrompt,
      systemPrompt,
      estimatedTokens,
      DEFAULT_ROUTING_CONFIG.scoring,
    );

    const debugRouting = route(debugPrompt, systemPrompt, maxTokens, {
      ...routerOpts,
      routingProfile: debugProfile,
    });

    const dimLines = (scoring.dimensions ?? [])
      .map((d) => {
        const nameStr = (d.name + ":").padEnd(24);
        const scoreStr = d.score.toFixed(2).padStart(6);
        const sigStr = d.signal ? `  [${d.signal}]` : "";
        return `  ${nameStr}${scoreStr}${sigStr}`;
      })
      .join("\n");

    const sess = sessionId ? sessionStore.getSession(sessionId) : undefined;
    const sessLine = sess
      ? `Session: ${sessionId!.slice(0, 8)}... → pinned: ${sess.model} (${sess.requestCount} requests)`
      : sessionId
        ? `Session: ${sessionId.slice(0, 8)}... → no pinned model`
        : "Session: none";

    const { simpleMedium, mediumComplex, complexReasoning } =
      DEFAULT_ROUTING_CONFIG.scoring.tierBoundaries;

    const debugText = [
      "OmbRouter Debug",
      "",
      `Profile: ${debugProfile} | Tier: ${debugRouting.tier} | Model: ${debugRouting.model}`,
      `Confidence: ${debugRouting.confidence.toFixed(2)} | Cost: $${debugRouting.costEstimate.toFixed(4)} | Savings: ${(debugRouting.savings * 100).toFixed(0)}%`,
      `Reasoning: ${debugRouting.reasoning}`,
      "",
      `Scoring (weighted: ${scoring.score.toFixed(3)})`,
      dimLines,
      "",
      `Tier Boundaries: SIMPLE <${simpleMedium.toFixed(2)} | MEDIUM <${mediumComplex.toFixed(2)} | COMPLEX <${complexReasoning.toFixed(2)} | REASONING >=${complexReasoning.toFixed(2)}`,
      "",
      sessLine,
    ].join("\n");

    const completionId = `chatcmpl-debug-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const syntheticResponse = {
      id: completionId,
      object: "chat.completion",
      created: timestamp,
      model: "ombrouter/debug",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: debugText },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const sseChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: "ombrouter/debug",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: debugText },
            finish_reason: null,
          },
        ],
      };
      const sseDone = {
        id: completionId,
        object: "chat.completion.chunk",
        created: timestamp,
        model: "ombrouter/debug",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
      res.write(`data: ${JSON.stringify(sseDone)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(syntheticResponse));
    }
    console.log(`[OmbRouter] /debug command → ${debugRouting.tier} | ${debugRouting.model}`);
    return true;
  }

  if (lastContent.startsWith("/imagegen")) {
    const imageArgs = lastContent.slice("/imagegen".length).trim();

    let imageModel = "google/nano-banana";
    let imageSize = "1024x1024";
    let imagePrompt = imageArgs;

    const modelMatch = imageArgs.match(/--model\s+(\S+)/);
    if (modelMatch) {
      const raw = modelMatch[1];
      const IMAGE_MODEL_ALIASES: Record<string, string> = {
        "dall-e-3": "openai/dall-e-3",
        dalle3: "openai/dall-e-3",
        dalle: "openai/dall-e-3",
        "gpt-image": "openai/gpt-image-1",
        "gpt-image-1": "openai/gpt-image-1",
        flux: "black-forest/flux-1.1-pro",
        "flux-pro": "black-forest/flux-1.1-pro",
        banana: "google/nano-banana",
        "nano-banana": "google/nano-banana",
        "banana-pro": "google/nano-banana-pro",
        "nano-banana-pro": "google/nano-banana-pro",
      };
      imageModel = IMAGE_MODEL_ALIASES[raw] ?? raw;
      imagePrompt = imagePrompt.replace(/--model\s+\S+/, "").trim();
    }

    const sizeMatch = imageArgs.match(/--size\s+(\d+x\d+)/);
    if (sizeMatch) {
      imageSize = sizeMatch[1];
      imagePrompt = imagePrompt.replace(/--size\s+\d+x\d+/, "").trim();
    }

    if (!imagePrompt) {
      const errorText = [
        "Usage: /imagegen <prompt>",
        "",
        "Options:",
        "  --model <model>  Model to use (default: nano-banana)",
        "  --size <WxH>     Image size (default: 1024x1024)",
        "",
        "Models:",
        "  nano-banana       Google Gemini Flash — $0.05/image",
        "  banana-pro        Google Gemini Pro — $0.10/image (up to 4K)",
        "  dall-e-3          OpenAI DALL-E 3 — $0.04/image",
        "  gpt-image         OpenAI GPT Image 1 — $0.02/image",
        "  flux              Black Forest Flux 1.1 Pro — $0.04/image",
        "",
        "Examples:",
        "  /imagegen a cat wearing sunglasses",
        "  /imagegen --model dall-e-3 a futuristic city at sunset",
        "  /imagegen --model banana-pro --size 2048x2048 mountain landscape",
      ].join("\n");

      const completionId = `chatcmpl-image-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/image", choices: [{ index: 0, delta: { role: "assistant", content: errorText }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/image", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created: timestamp,
            model: "ombrouter/image",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: errorText },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      }
      console.log(`[OmbRouter] /imagegen command → showing usage help`);
      return true;
    }

    console.log(
      `[OmbRouter] /imagegen command → ${imageModel} (${imageSize}): ${imagePrompt.slice(0, 80)}...`,
    );
    try {
      const imageUpstreamUrl = `${apiBase}/v1/images/generations`;
      const imageBody = JSON.stringify({
        model: imageModel,
        prompt: imagePrompt,
        size: imageSize,
        n: 1,
      });
      const imageResponse = await payFetch(imageUpstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: imageBody,
      });

      const imageResult = (await imageResponse.json()) as {
        created?: number;
        data?: Array<{ url?: string; revised_prompt?: string }>;
        error?: string | { message?: string };
      };

      let responseText: string;
      if (!imageResponse.ok || imageResult.error) {
        const errMsg =
          typeof imageResult.error === "string"
            ? imageResult.error
            : ((imageResult.error as { message?: string })?.message ??
              `HTTP ${imageResponse.status}`);
        responseText = `Image generation failed: ${errMsg}`;
        console.log(`[OmbRouter] /imagegen error: ${errMsg}`);
      } else {
        const images = imageResult.data ?? [];
        if (images.length === 0) {
          responseText = "Image generation returned no results.";
        } else {
          const lines: string[] = [];
          for (const img of images) {
            if (img.url) {
              if (img.url.startsWith("data:")) {
                try {
                  const hostedUrl = await uploadDataUriToHost(img.url);
                  lines.push(hostedUrl);
                } catch (uploadErr) {
                  console.error(
                    `[OmbRouter] /imagegen: failed to upload data URI: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                  );
                  lines.push(
                    "Image generated but upload failed. Try again or use --model dall-e-3.",
                  );
                }
              } else {
                lines.push(img.url);
              }
            }
            if (img.revised_prompt) lines.push(`Revised prompt: ${img.revised_prompt}`);
          }
          lines.push("", `Model: ${imageModel} | Size: ${imageSize}`);
          responseText = lines.join("\n");
        }
        console.log(`[OmbRouter] /imagegen success: ${images.length} image(s) generated`);
        const imagegenActualCost =
          paymentStore.getStore()?.amountUsd ?? estimateImageCost(imageModel, imageSize, 1);
        logUsage({
          timestamp: new Date().toISOString(),
          model: imageModel,
          tier: "IMAGE",
          cost: imagegenActualCost,
          baselineCost: imagegenActualCost,
          savings: 0,
          latencyMs: 0,
        }).catch(() => {});
      }

      const completionId = `chatcmpl-image-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/image", choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/image", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created: timestamp,
            model: "ombrouter/image",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: responseText },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[OmbRouter] /imagegen error: ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Image generation failed: ${errMsg}`, type: "image_error" },
          }),
        );
      }
    }
    return true;
  }

  if (lastContent.startsWith("/img2img")) {
    const imgArgs = lastContent.slice("/img2img".length).trim();

    let img2imgModel = "openai/gpt-image-1";
    let img2imgSize = "1024x1024";
    let imagePath: string | null = null;
    let maskPath: string | null = null;
    let img2imgPrompt = imgArgs;

    const imageMatch = imgArgs.match(/--image\s+(\S+)/);
    if (imageMatch) {
      imagePath = imageMatch[1];
      img2imgPrompt = img2imgPrompt.replace(/--image\s+\S+/, "").trim();
    }

    const maskMatch = imgArgs.match(/--mask\s+(\S+)/);
    if (maskMatch) {
      maskPath = maskMatch[1];
      img2imgPrompt = img2imgPrompt.replace(/--mask\s+\S+/, "").trim();
    }

    const img2imgSizeMatch = imgArgs.match(/--size\s+(\d+x\d+)/);
    if (img2imgSizeMatch) {
      img2imgSize = img2imgSizeMatch[1];
      img2imgPrompt = img2imgPrompt.replace(/--size\s+\d+x\d+/, "").trim();
    }

    const img2imgModelMatch = imgArgs.match(/--model\s+(\S+)/);
    if (img2imgModelMatch) {
      const raw = img2imgModelMatch[1];
      const IMG2IMG_ALIASES: Record<string, string> = {
        "gpt-image": "openai/gpt-image-1",
        "gpt-image-1": "openai/gpt-image-1",
      };
      img2imgModel = IMG2IMG_ALIASES[raw] ?? raw;
      img2imgPrompt = img2imgPrompt.replace(/--model\s+\S+/, "").trim();
    }

    const usageText = [
      "Usage: /img2img --image <path> <prompt>",
      "",
      "Options:",
      "  --image <path>   Source image path (required)",
      "  --mask <path>    Mask image path (optional, white = area to edit)",
      "  --model <model>  Model (default: gpt-image-1)",
      "  --size <WxH>     Output size (default: 1024x1024)",
      "",
      "Models:",
      "  gpt-image-1      OpenAI GPT Image 1 — $0.02/image",
      "",
      "Examples:",
      "  /img2img --image ~/photo.png change background to starry sky",
      "  /img2img --image ./cat.jpg --mask ./mask.png remove the background",
      "  /img2img --image /tmp/portrait.png --size 1536x1024 add a hat",
    ].join("\n");

    const sendImg2ImgText = (text: string) => {
      const completionId = `chatcmpl-img2img-${Date.now()}`;
      const timestamp = Math.floor(Date.now() / 1000);
      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/img2img", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created: timestamp, model: "ombrouter/img2img", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: completionId,
            object: "chat.completion",
            created: timestamp,
            model: "ombrouter/img2img",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      }
    };

    if (!imagePath || !img2imgPrompt) {
      sendImg2ImgText(usageText);
      return true;
    }

    let imageDataUri: string;
    let maskDataUri: string | undefined;
    try {
      imageDataUri = readImageFileAsDataUri(imagePath);
      if (maskPath) maskDataUri = readImageFileAsDataUri(maskPath);
    } catch (fileErr) {
      const fileErrMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
      sendImg2ImgText(`Failed to read image file: ${fileErrMsg}`);
      return true;
    }

    console.log(
      `[OmbRouter] /img2img → ${img2imgModel} (${img2imgSize}): ${img2imgPrompt.slice(0, 80)}`,
    );

    try {
      const img2imgBody = JSON.stringify({
        model: img2imgModel,
        prompt: img2imgPrompt,
        image: imageDataUri,
        ...(maskDataUri ? { mask: maskDataUri } : {}),
        size: img2imgSize,
        n: 1,
      });

      const img2imgResponse = await payFetch(`${apiBase}/v1/images/image2image`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: img2imgBody,
      });

      const img2imgResult = (await img2imgResponse.json()) as {
        created?: number;
        data?: Array<{ url?: string; revised_prompt?: string }>;
        error?: string | { message?: string };
      };

      let responseText: string;
      if (!img2imgResponse.ok || img2imgResult.error) {
        const errMsg =
          typeof img2imgResult.error === "string"
            ? img2imgResult.error
            : ((img2imgResult.error as { message?: string })?.message ??
              `HTTP ${img2imgResponse.status}`);
        responseText = `Image editing failed: ${errMsg}`;
        console.log(`[OmbRouter] /img2img error: ${errMsg}`);
      } else {
        const images = img2imgResult.data ?? [];
        if (images.length === 0) {
          responseText = "Image editing returned no results.";
        } else {
          const lines: string[] = [];
          for (const img of images) {
            if (img.url) {
              if (img.url.startsWith("data:")) {
                try {
                  const hostedUrl = await uploadDataUriToHost(img.url);
                  lines.push(hostedUrl);
                } catch (uploadErr) {
                  console.error(
                    `[OmbRouter] /img2img: failed to upload data URI: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                  );
                  lines.push("Image edited but upload failed. Try again.");
                }
              } else {
                lines.push(img.url);
              }
            }
            if (img.revised_prompt) lines.push(`Revised prompt: ${img.revised_prompt}`);
          }
          lines.push("", `Model: ${img2imgModel} | Size: ${img2imgSize}`);
          responseText = lines.join("\n");
        }
        console.log(`[OmbRouter] /img2img success: ${images.length} image(s)`);
        const img2imgActualCost2 =
          paymentStore.getStore()?.amountUsd ?? estimateImageCost(img2imgModel, img2imgSize, 1);
        logUsage({
          timestamp: new Date().toISOString(),
          model: img2imgModel,
          tier: "IMAGE",
          cost: img2imgActualCost2,
          baselineCost: img2imgActualCost2,
          savings: 0,
          latencyMs: 0,
        }).catch(() => {});
      }

      sendImg2ImgText(responseText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[OmbRouter] /img2img error: ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Image editing failed: ${errMsg}`, type: "img2img_error" },
          }),
        );
      }
    }
    return true;
  }

  return false;
}
