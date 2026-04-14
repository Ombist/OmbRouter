import { describe, it, expect } from "vitest";
import { transformPaymentError } from "../src/proxy.js";

describe("transformPaymentError", () => {
  // ---------- Base (EVM) format: error + details ----------

  it("handles Base insufficient_funds with balance info", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      details:
        'Verification failed: {"invalidMessage":"insufficient balance: 251 < 11463","invalidReason":"insufficient_funds","isValid":false,"payer":"0xABC123"}',
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("insufficient_funds");
    expect(result.error.message).toContain("Insufficient USDC");
  });

  it("handles Base invalid_payload", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      details:
        'Verification failed: {"invalidMessage":"contract call failed","invalidReason":"invalid_payload","isValid":false,"payer":"0xABC123"}',
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("invalid_payload");
  });

  // ---------- code=PAYMENT_INVALID + debug format ----------

  it("detects EVM payer in PAYMENT_INVALID format and says Base not Solana", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug:
        'Verification failed: {"invalidMessage":"contract call failed: unable to call contract: execution reverted","invalidReason":"invalid_payload","isValid":false,"payer":"0x6B386D954052D4d5dCB7F066624DAF11d6Ed191a"}',
      payer: "0x6B386D954052D4d5dCB7F066624DAF11d6Ed191a",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("payment_invalid");
    // Must NOT say Solana for an EVM payer
    expect(result.error.message).toContain("Base");
    expect(result.error.message).not.toContain("Solana");
  });

  it("says Solana for non-0x payer in PAYMENT_INVALID format", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "transaction_simulation_failed: some error",
      payer: "39qMXPYgDxY4QsMS34MQYwH8NUwK94sBpfDQJVhahuQN",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("transaction_simulation_failed");
    expect(result.error.message).toContain("Solana");
    expect(result.error.message).not.toContain("Base");
  });

  it("handles Solana insufficient in PAYMENT_INVALID format", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "insufficient balance for transfer",
      payer: "39qMXPYgDxY4QsMS34MQYwH8NUwK94sBpfDQJVhahuQN",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("insufficient_funds");
    expect(result.error.message).toContain("Solana");
  });

  it("handles EVM insufficient in PAYMENT_INVALID format", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "insufficient balance for transfer",
      payer: "0xABC123",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("insufficient_funds");
    expect(result.error.message).toContain("Base");
  });

  it("handles expired payment", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "payment authorization expired",
      payer: "39qMXPYgDxY4QsMS34MQYwH8NUwK94sBpfDQJVhahuQN",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("expired");
    expect(result.error.message).toContain("Solana");
  });

  it("handles invalid signature", () => {
    const body = JSON.stringify({
      error: "Payment verification failed",
      code: "PAYMENT_INVALID",
      debug: "invalid_signature: bad sig",
      payer: "0xDEAD",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("invalid_payload");
    expect(result.error.message).toContain("Base");
  });

  // ---------- Settlement errors ----------

  it("handles settlement gas error", () => {
    const body = JSON.stringify({
      error: "Settlement failed",
      details: "unable to estimate gas",
    });
    const result = JSON.parse(transformPaymentError(body));
    expect(result.error.type).toBe("settlement_failed");
    expect(result.error.message).toContain("gas");
  });

  // ---------- Pass-through ----------

  it("returns raw body for non-payment errors", () => {
    const body = "some random error";
    expect(transformPaymentError(body)).toBe(body);
  });

  it("returns raw body for unparseable JSON", () => {
    const body = "{broken json";
    expect(transformPaymentError(body)).toBe(body);
  });
});
