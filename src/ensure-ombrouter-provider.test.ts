import { describe, expect, it } from "vitest";
import {
  applyOptionalOpenclawProviderExtras,
  ensureOmbrouterProviderFields,
} from "./ensure-ombrouter-provider.js";

describe("ensureOmbrouterProviderFields", () => {
  const baseUrl = "http://127.0.0.1:8402/v1";
  const models = [{ id: "auto" }, { id: "eco" }];

  it("preserves request.tls and other user keys while fixing baseUrl/api/apiKey/models", () => {
    const entry: Record<string, unknown> = {
      baseUrl: "http://wrong:1/v1",
      request: {
        tls: {
          cert: "/path/client.pem",
          key: "/path/client.key",
          serverName: "local.proxy",
        },
      },
      models: [{ id: "auto" }],
    };

    const result = ensureOmbrouterProviderFields(entry, baseUrl, models);

    expect(result.changed).toBe(true);
    expect(entry.request).toEqual({
      tls: {
        cert: "/path/client.pem",
        key: "/path/client.key",
        serverName: "local.proxy",
      },
    });
    expect(entry.baseUrl).toBe(baseUrl);
    expect(entry.api).toBe("openai-completions");
    expect(entry.apiKey).toBe("ombrouter-local-proxy");
    expect(entry.models).toEqual(models);
  });

  it("returns changed false when already in sync", () => {
    const entry: Record<string, unknown> = {
      baseUrl,
      api: "openai-completions",
      apiKey: "ombrouter-local-proxy",
      models: [...models],
    };

    const result = ensureOmbrouterProviderFields(entry, baseUrl, models);
    expect(result.changed).toBe(false);
  });
});

describe("applyOptionalOpenclawProviderExtras", () => {
  it("fills missing request from plugin extras only when entry has no request", () => {
    const entry: Record<string, unknown> = { baseUrl: "http://127.0.0.1:1/v1" };
    const pluginConfig = {
      openclawProviderExtras: {
        request: { tls: { serverName: "proxy.local" } },
      },
    };
    expect(applyOptionalOpenclawProviderExtras(entry, pluginConfig)).toBe(true);
    expect(entry.request).toEqual({ tls: { serverName: "proxy.local" } });
  });

  it("does not overwrite existing request", () => {
    const entry: Record<string, unknown> = {
      request: { tls: { cert: "/a.pem" } },
    };
    const pluginConfig = {
      openclawProviderExtras: {
        request: { tls: { cert: "/b.pem" } },
      },
    };
    expect(applyOptionalOpenclawProviderExtras(entry, pluginConfig)).toBe(false);
    expect(entry.request).toEqual({ tls: { cert: "/a.pem" } });
  });

  it("fills other missing top-level keys only", () => {
    const entry: Record<string, unknown> = { baseUrl: "http://x/v1" };
    const pluginConfig = {
      openclawProviderExtras: { foo: "bar" },
    };
    expect(applyOptionalOpenclawProviderExtras(entry, pluginConfig)).toBe(true);
    expect(entry.foo).toBe("bar");
  });
});
