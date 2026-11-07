// Providers (providerDefinitions.ts): which one a connection uses, what it stores, and how the
// provider's settings sit between a model's own edits and what its list reports.
import { describe, expect, it } from "vitest"
import {
  awsRegionOf,
  builtinProviders,
  defaultProviderId,
  findProvider,
  providerChanges,
  resolveProviderSettings
} from "../src/providerDefinitions.ts"
import { resolveModel } from "../src/providers.ts"

const bedrock = builtinProviders.find((p) => p.id === "anthropic-bedrock")!

describe("findProvider", () => {
  it("uses the connection's own provider", () => {
    expect(findProvider(builtinProviders, "openai", "openai-chat", "http://localhost:8080/v1")?.id).toBe("openai")
  })
  it("gives a connection made by API type alone the provider that type implies", () => {
    expect(defaultProviderId("anthropic", null)).toBe("anthropic")
    expect(defaultProviderId("openai-responses", null)).toBe("openai")
    expect(defaultProviderId("openai-chat", null)).toBe("openai")
    expect(defaultProviderId("openai-chat", "http://localhost:8080/v1")).toBe("openai-compatible")
    expect(defaultProviderId("anthropic-bedrock", null)).toBe("anthropic-bedrock")
  })
  it("falls back from a provider no longer registered", () => {
    expect(findProvider(builtinProviders, "gone-plugin", "openrouter")?.id).toBe("openrouter")
  })
  it("lists every API type a provider offers once, each a different kind", () => {
    for (const provider of builtinProviders)
      expect(new Set(provider.apis.map((a) => a.id)).size, provider.id).toBe(provider.apis.length)
  })
})

describe("provider settings", () => {
  it("stores only what differs from the provider's defaults", () => {
    expect(providerChanges(bedrock, { auth: "api-key", lookback: false, region: "eu-west-1" })).toEqual({
      region: "eu-west-1"
    })
    expect(providerChanges(bedrock, { lookback: true })).toEqual({ lookback: true })
  })
  it("puts the user's changes over the defaults", () => {
    expect(resolveProviderSettings(bedrock, { auth: "aws-sigv4" })).toEqual({
      auth: "aws-sigv4",
      cacheBreakpoints: "explicit",
      lookback: false,
      maxMarkers: 4
    })
  })
  it("reads the region an AWS address names", () => {
    expect(awsRegionOf("https://bedrock-runtime.eu-west-3.amazonaws.com")).toBe("eu-west-3")
    expect(awsRegionOf("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com/")).toBe("us-gov-west-1")
    expect(awsRegionOf("https://bedrock-runtime.us-east-1.amazonaws.com.evil.test")).toBeNull()
    expect(awsRegionOf("not a url")).toBeNull()
  })
})

describe("resolveModel with a provider", () => {
  const settings = resolveProviderSettings(bedrock, {})
  it("takes the provider's layout over the model list's, marked as the provider's", () => {
    const model = resolveModel("m", { cacheLayout: { minTokens: 2048 } }, {}, {}, settings)
    expect(model.cacheBreakpoints).toEqual({ value: "explicit", source: "provider" })
    expect(model.cacheLayout).toEqual({
      value: { minTokens: 2048, lookback: false, maxMarkers: 4 },
      source: "provider"
    })
  })
  it("keeps the model's own edits over the provider's", () => {
    const model = resolveModel("m", {}, { cacheBreakpoints: "auto", cacheLayout: { lookback: true } }, {}, settings)
    expect(model.cacheBreakpoints).toEqual({ value: "auto", source: "user" })
    expect(model.cacheLayout).toEqual({ value: { lookback: true }, source: "user" })
  })
  it("changes nothing for a provider with no cache settings", () => {
    const model = resolveModel("m", {}, {}, {}, {})
    expect(model.cacheBreakpoints.source).toBe("unknown")
    expect(model.cacheLayout.source).toBe("unknown")
  })
})
