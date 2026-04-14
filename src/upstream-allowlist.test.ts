import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { assertUpstreamAllowlist } from "./upstream-allowlist.js";

describe("assertUpstreamAllowlist", () => {
  const prev = process.env.OMBROUTER_UPSTREAM_ALLOWLIST;

  beforeEach(() => {
    delete process.env.OMBROUTER_UPSTREAM_ALLOWLIST;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.OMBROUTER_UPSTREAM_ALLOWLIST;
    else process.env.OMBROUTER_UPSTREAM_ALLOWLIST = prev;
  });

  it("no-ops when env unset", () => {
    expect(() => assertUpstreamAllowlist("https://evil.internal/metadata")).not.toThrow();
  });

  it("allows hostname match", () => {
    process.env.OMBROUTER_UPSTREAM_ALLOWLIST = "api.openai.com";
    expect(() => assertUpstreamAllowlist("https://api.openai.com/v1")).not.toThrow();
  });

  it("allows URL prefix match", () => {
    process.env.OMBROUTER_UPSTREAM_ALLOWLIST = "https://api.openai.com";
    expect(() => assertUpstreamAllowlist("https://api.openai.com/v1")).not.toThrow();
  });

  it("rejects non-listed host", () => {
    process.env.OMBROUTER_UPSTREAM_ALLOWLIST = "api.openai.com";
    expect(() => assertUpstreamAllowlist("https://evil.example/v1")).toThrow(/not allowed/);
  });
});
