// Providers (providerDefinitions.ts): which one a connection uses, what it stores, and how the
// provider's settings sit between a model's own edits and what its list reports.
import { describe, expect, it } from "vitest"
import {
  awsRegionOf,
  builtinProviders,
  defaultProviderId,
  findProvider,
  providerChanges,
  providerBaseUrl,
  resolveProviderSettings
} from "../src/providerDefinitions.ts"
import { ASSUMED_CONTEXT, ASSUMED_MAX_OUTPUT, DEFAULT_RESPONSE, withModelSettings } from "../src/modelSettings.ts"
import type { LegacyPresetDoc } from "../src/docs/preset.ts"
import { ProviderSettings, resolveModel } from "../src/providers.ts"
import { Schema } from "effect"

const bedrock = builtinProviders.find((p) => p.id === "anthropic-bedrock")!

describe("silent-provider limit", () => {
  it("accepts omitted or positive whole seconds and refuses invalid connection settings", () => {
    expect(Schema.is(ProviderSettings)({})).toBe(true)
    expect(Schema.is(ProviderSettings)({ idleTimeoutS: 300 })).toBe(true)
    for (const idleTimeoutS of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "300"])
      expect(Schema.is(ProviderSettings)({ idleTimeoutS })).toBe(false)
  })
})

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
  it("uses a provider's default region until the connection overrides it", () => {
    const regional = { ...bedrock, defaults: { ...bedrock.defaults, region: "eu-west-3" } }
    expect(providerBaseUrl(regional, {})).toBe("https://bedrock-runtime.eu-west-3.amazonaws.com")
    expect(providerBaseUrl(regional, { region: "us-west-2" })).toBe("https://bedrock-runtime.us-west-2.amazonaws.com")
  })
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
    expect(model.cacheLayout).toEqual({ value: { lookback: true, maxMarkers: 4 }, source: "user" })
  })
  it("keeps the Bedrock layout when a model overrides only the minimum", () => {
    const listed = { cacheLayout: { lookback: true, summarySplit: true, maxMarkers: 8, minTokens: 2048 } }
    const model = resolveModel("m", listed, { cacheLayout: { minTokens: 4096 } }, {}, settings)
    expect(model.cacheLayout).toEqual({
      value: { lookback: false, summarySplit: true, maxMarkers: 4, minTokens: 4096 },
      source: "user"
    })
  })
  it("changes nothing for a provider with no cache settings", () => {
    const model = resolveModel("m", {}, {}, {}, {})
    expect(model.cacheBreakpoints.source).toBe("unknown")
    expect(model.cacheLayout.source).toBe("unknown")
  })
})

describe("provider capability defaults", () => {
  it("uses the prefill dialect supported by the provider and model generation", () => {
    const messages = { kind: "anthropic", api: "anthropic-messages" }
    const chat = { kind: "openai-chat", api: "openai-completions", provider: "openai" }
    const prefill = (key: string, connection: typeof messages, upstream = {}) =>
      resolveModel(key, upstream, {}, {}, {}, connection).prefill
    expect(prefill("claude-haiku-4-5-20251001", messages)).toEqual({ value: "assistant", source: "provider" })
    for (const key of ["claude-sonnet-4-6", "claude-fable-5-2"]) expect(prefill(key, messages).value, key).toBe("none")
    expect(prefill("upstream.gpt-5.6-sol", chat).value).toBe("tool_schema")
    expect(prefill("gpt-5.4-mini", chat, { prefill: "none" }).value).toBe("none")
    expect(prefill("gpt-5.4-mini", { kind: "openai-chat", api: "openai-completions" }).value).toBe("tool_schema")
  })

  it("uses a recognized vision family only when model metadata is absent", () => {
    const connection = { kind: "deepseek", api: "openai-completions" }
    const resolve = (key: string, upstream = {}, overrides = {}) =>
      resolveModel(key, upstream, overrides, {}, {}, connection).vision
    expect(resolve("upstream.deepseek-v4-flash")).toEqual({ value: true, source: "provider" })
    // Unknown vision stays on (owner, 2026-11-25): no family match leaves it unknown, not off.
    expect(resolve("opaque-alias")).toEqual({ value: true, source: "unknown" })
    expect(resolve("deepseek-flash", { vision: false }).value).toBe(false)
    expect(resolve("deepseek-flash", {}, { vision: false }).source).toBe("user")
  })

  it("assumes a 64K output limit within the window when no source reports one, keeping RP defaults at 4,096", () => {
    expect(resolveModel("unknown-1m", { context: 1_048_576 }, {}).maxOutput).toEqual({
      value: ASSUMED_MAX_OUTPUT,
      source: "unknown"
    })
    expect(resolveModel("unknown-default", {}, {}).maxOutput).toEqual({
      value: ASSUMED_MAX_OUTPUT,
      source: "unknown"
    })
    expect(resolveModel("small-window", { context: 8192 }, {}).maxOutput).toEqual({
      value: 8192,
      source: "unknown"
    })
    expect(resolveModel("explicit-upstream", { context: 1_048_576, maxOutput: 4096 }, {}).maxOutput).toEqual({
      value: 4096,
      source: "upstream"
    })
    expect(resolveModel("explicit-user", { context: 1_048_576 }, { maxOutput: 16_384 }).maxOutput).toEqual({
      value: 16_384,
      source: "user"
    })
    const basePreset = {} as LegacyPresetDoc
    expect(withModelSettings(basePreset, {}, ASSUMED_CONTEXT, null).samplers.openai_max_tokens).toBe(DEFAULT_RESPONSE)
    expect(withModelSettings(basePreset, {}, 1_048_576, ASSUMED_MAX_OUTPUT).samplers.openai_max_tokens).toBe(
      DEFAULT_RESPONSE
    )
    expect(
      withModelSettings(basePreset, { samplers: { openai_max_tokens: 32_768 } }, 1_048_576, null).samplers
        .openai_max_tokens
    ).toBe(32_768)
  })
})
