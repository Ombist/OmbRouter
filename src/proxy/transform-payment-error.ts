/**
 * Transform upstream payment errors into user-friendly messages.
 * Parses the raw x402 error and formats it nicely.
 */
export function transformPaymentError(errorBody: string): string {
  try {
    const parsed = JSON.parse(errorBody) as {
      error?: string;
      details?: string;
      code?: string;
      debug?: string;
      payer?: string;
    };

    if (parsed.error === "Payment verification failed" && parsed.details) {
      const match = parsed.details.match(/Verification failed:\s*(\{.*\})/s);
      if (match) {
        const innerJson = JSON.parse(match[1]) as {
          invalidMessage?: string;
          invalidReason?: string;
          payer?: string;
        };

        if (innerJson.invalidReason === "insufficient_funds" && innerJson.invalidMessage) {
          const balanceMatch = innerJson.invalidMessage.match(
            /insufficient balance:\s*(\d+)\s*<\s*(\d+)/i,
          );
          if (balanceMatch) {
            const currentMicros = parseInt(balanceMatch[1], 10);
            const requiredMicros = parseInt(balanceMatch[2], 10);
            const currentUSD = (currentMicros / 1_000_000).toFixed(6);
            const requiredUSD = (requiredMicros / 1_000_000).toFixed(6);
            const wallet = innerJson.payer || "unknown";
            const shortWallet =
              wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;

            return JSON.stringify({
              error: {
                message: `Insufficient USDC balance. Current: $${currentUSD}, Required: ~$${requiredUSD}`,
                type: "insufficient_funds",
                wallet: wallet,
                current_balance_usd: currentUSD,
                required_usd: requiredUSD,
                help: `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`,
              },
            });
          }
        }

        if (innerJson.invalidReason === "invalid_payload") {
          return JSON.stringify({
            error: {
              message: "Payment signature invalid. This may be a temporary issue.",
              type: "invalid_payload",
              help: "Try again. If this persists, rebuild from your OmbRouter checkout and restart the proxy.",
            },
          });
        }

        if (innerJson.invalidReason === "transaction_simulation_failed") {
          console.error(
            `[OmbRouter] Solana transaction simulation failed: ${innerJson.invalidMessage || "unknown"}`,
          );
          return JSON.stringify({
            error: {
              message: "Solana payment simulation failed. Retrying with a different model.",
              type: "transaction_simulation_failed",
              help: "This is usually temporary. If it persists, check your Solana USDC balance or try: /model free",
            },
          });
        }
      }
    }

    if (
      parsed.error === "Payment verification failed" &&
      parsed.code === "PAYMENT_INVALID" &&
      parsed.debug
    ) {
      const debugLower = parsed.debug.toLowerCase();
      const wallet = parsed.payer || "unknown";
      const shortWallet =
        wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
      const chain = wallet.startsWith("0x") ? "Base" : "Solana";

      if (debugLower.includes("insufficient")) {
        return JSON.stringify({
          error: {
            message: `Insufficient ${chain} USDC balance.`,
            type: "insufficient_funds",
            wallet,
            help:
              chain === "Solana"
                ? `Fund wallet ${shortWallet} with USDC on Solana, or switch to Base: /wallet base`
                : `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`,
          },
        });
      }

      if (
        debugLower.includes("transaction_simulation_failed") ||
        debugLower.includes("simulation")
      ) {
        console.error(`[OmbRouter] ${chain} transaction simulation failed: ${parsed.debug}`);
        return JSON.stringify({
          error: {
            message: `${chain} payment simulation failed. Retrying with a different model.`,
            type: "transaction_simulation_failed",
            help: "This is usually temporary. If it persists, try: /model free",
          },
        });
      }

      if (debugLower.includes("invalid signature") || debugLower.includes("invalid_signature")) {
        return JSON.stringify({
          error: {
            message: `${chain} payment signature invalid.`,
            type: "invalid_payload",
            help: "Try again. If this persists, rebuild from your OmbRouter checkout and restart the proxy.",
          },
        });
      }

      if (debugLower.includes("expired")) {
        return JSON.stringify({
          error: {
            message: `${chain} payment expired. Retrying.`,
            type: "expired",
            help: "This is usually temporary.",
          },
        });
      }

      console.error(
        `[OmbRouter] ${chain} payment verification failed: ${parsed.debug} payer=${wallet}`,
      );
      return JSON.stringify({
        error: {
          message: `${chain} payment verification failed: ${parsed.debug}`,
          type: "payment_invalid",
          wallet,
          help:
            chain === "Solana"
              ? "Try again or switch to Base: /wallet base"
              : "Try again. If this persists, try: /model free",
        },
      });
    }

    if (
      parsed.error === "Settlement failed" ||
      parsed.error === "Payment settlement failed" ||
      parsed.details?.includes("Settlement failed") ||
      parsed.details?.includes("transaction_simulation_failed")
    ) {
      const details = parsed.details || "";
      const gasError = details.includes("unable to estimate gas");

      return JSON.stringify({
        error: {
          message: gasError
            ? "Payment failed: network congestion or gas issue. Try again."
            : "Payment settlement failed. Try again in a moment.",
          type: "settlement_failed",
          help: "This is usually temporary. If it persists, try: /model free",
        },
      });
    }
  } catch {
    /* return original */
  }
  return errorBody;
}
