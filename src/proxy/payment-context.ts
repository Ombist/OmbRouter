import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request x402 payment amount (USD) for usage logging. */
export const paymentStore = new AsyncLocalStorage<{ amountUsd: number }>();
