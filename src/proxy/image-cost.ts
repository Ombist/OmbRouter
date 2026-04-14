// Image pricing table (must match server's IMAGE_MODELS in blockrun/src/lib/models.ts)
const IMAGE_PRICING: Record<string, { default: number; sizes?: Record<string, number> }> = {
  "openai/dall-e-3": {
    default: 0.04,
    sizes: { "1024x1024": 0.04, "1792x1024": 0.08, "1024x1792": 0.08 },
  },
  "openai/gpt-image-1": {
    default: 0.02,
    sizes: { "1024x1024": 0.02, "1536x1024": 0.04, "1024x1536": 0.04 },
  },
  "black-forest/flux-1.1-pro": { default: 0.04 },
  "google/nano-banana": { default: 0.05 },
  "google/nano-banana-pro": {
    default: 0.1,
    sizes: { "1024x1024": 0.1, "2048x2048": 0.1, "4096x4096": 0.15 },
  },
};

/**
 * Estimate the cost of an image generation/editing request.
 */
export function estimateImageCost(model: string, size?: string, n: number = 1): number {
  const pricing = IMAGE_PRICING[model];
  if (!pricing) return 0.04 * n * 1.05;
  const sizePrice = size && pricing.sizes ? pricing.sizes[size] : undefined;
  const pricePerImage = sizePrice ?? pricing.default;
  return pricePerImage * n * 1.05;
}
