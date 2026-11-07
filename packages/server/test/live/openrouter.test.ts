// Live: OpenRouter, through the app's provider code, pinned to each upstream by the model's
// routing setting. Real money: every request's reported cost counts against
// RP_LIVE_OPENROUTER_CAP (default $2 for the whole file).
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { findings, liveEnabled, near } from "./support/live.ts"
import {
  checkModels,
  checkTurn,
  liveTest,
  markers,
  type Profile,
  ref,
  startChat,
  totalInput
} from "./support/scenarios.ts"

const f = findings("openrouter")
const CAP = Number(process.env.RP_LIVE_OPENROUTER_CAP ?? "2")
const spent = () => Object.values(f.spend).reduce((n, s) => n + s.reported, 0)

const base = { kind: "openrouter", dialect: "openrouter" as const, route: "openrouter/v1" }
/** A model setting that pins OpenRouter to one provider (`provider.only`, no fallbacks). */
const pinned = (slug: string, samplers?: Record<string, unknown>) => ({
  settings: { routing: { only: [slug], allow_fallbacks: false }, ...(samplers ? { samplers } : {}) }
})
// OpenRouter honors the request's `provider`, so each
// upstream is reached by the model's routing setting.
const routes: ReadonlyArray<Profile & { readonly upstream: string }> = [
  {
    ...base,
    id: "OR claude via Anthropic",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Anthropic",
    overrides: pinned("anthropic")
  },
  {
    ...base,
    id: "OR claude via Vertex",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Google",
    overrides: pinned("google-vertex")
  },
  {
    ...base,
    id: "OR claude via Bedrock",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Amazon Bedrock",
    overrides: pinned("amazon-bedrock")
  },
  {
    ...base,
    id: "OR gpt-5.4-nano via OpenAI",
    model: "openai/gpt-5.4-nano",
    cacheTokens: 1500,
    upstream: "OpenAI",
    ttlUnknown: true,
    overrides: pinned("openai", { openai_max_tokens: 600, reasoning_effort: "low" })
  },
  {
    ...base,
    id: "OR gemini-3.5-flash-lite via AI Studio",
    model: "google/gemini-3.5-flash-lite",
    cacheTokens: 4400,
    upstream: "Google AI Studio",
    overrides: pinned("google-ai-studio")
  },
  // Two with the app's explicit breakpoints instead of the default (pi-ai's markers).
  {
    ...base,
    id: "OR claude via Vertex (explicit breakpoints)",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Google",
    overrides: { ...pinned("google-vertex"), cacheBreakpoints: "explicit" }
  },
  {
    ...base,
    id: "OR gemini-3.5-flash-lite via AI Studio (explicit breakpoints)",
    model: "google/gemini-3.5-flash-lite",
    cacheTokens: 4400,
    upstream: "Google AI Studio",
    overrides: { ...pinned("google-ai-studio"), cacheBreakpoints: "explicit" }
  }
]

const modelOf = (api: Parameters<Parameters<typeof liveTest>[2]>[0]["api"], connectionId: string) =>
  api
    .ListModels({ connectionId: connectionId as never, includeHidden: true })
    .pipe(Effect.map((m) => m.find((x) => x.source === "user") ?? m[0] ?? null))

describe.skipIf(!liveEnabled)("live OpenRouter", () => {
  for (const r of routes)
    liveTest(`${r.id}: 3 turns of caching`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        if (spent() > CAP) return void f.check(r.id, "caching", null, { actual: `cap $${CAP} reached` })
        const chat = yield* startChat(api, recorder, dataDir, r)
        // The model as the list reports it (prices, cache write premium), then used by key.
        yield* api.RefreshModels({ connectionId: chat.connection.id })
        const model =
          (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
            (m) => m.id === chat.model.id
          ) ?? null
        const lines = [
          "Good evening, Mira. Is the copper bell entry still in the ledger?",
          "Then read me the amber lantern entry.",
          "Who guards the white compass?"
        ]
        let prev: ReturnType<typeof checkTurn> = null
        for (const [i, line] of lines.entries()) {
          const t = (yield* chat.say(line))!
          const w = checkTurn(f, r, `turn ${i + 1}`, t, model)
          f.check(r.id, `turn ${i + 1}: served by ${r.upstream}`, t.row?.upstream === r.upstream, {
            actual: t.row?.upstream
          })
          // Claude caches only at markers; the others cache on their own.
          if (i === 0)
            f.check(
              r.id,
              "turn 1: cache markers on the wire",
              r.model.startsWith("anthropic/") || r.overrides?.cacheBreakpoints === "explicit"
                ? markers(t.exchange).length > 0
                : null,
              { actual: markers(t.exchange) }
            )
          // OpenAI's cache is best effort (livefix): what it reads is recorded, not required. Live
          // (liveapi2): a 1,700-token chat read nothing on turns 2 and 3, a 3,200-token prompt sent
          // three times read 2,816 from the second, with or without prompt_cache_key.
          const bestEffort = r.model.startsWith("openai/")
          if (prev && w) {
            const prevTotal = totalInput(prev)
            f.check(
              r.id,
              `turn ${i + 1}: reads most of the previous prompt`,
              bestEffort ? null : (w.read ?? 0) >= 0.7 * prevTotal,
              {
                expected: { readAtLeast: Math.round(0.7 * prevTotal) },
                actual: { ...w, cost: t.row?.cost?.amount },
                ref: ref(t)
              }
            )
            const est = t.before?.warmth
            f.check(
              r.id,
              `turn ${i + 1}: estimate says warm`,
              !est && r.ttlUnknown ? null : !!est && est.changed === null && est.ttlS !== null,
              { actual: est ?? null }
            )
            if (est)
              f.check(
                r.id,
                bestEffort
                  ? `turn ${i + 1}: estimated cached prefix claims no more than the provider read`
                  : `turn ${i + 1}: estimated cached prefix ≈ provider's cached tokens (±40%)`,
                bestEffort ? est.prefixTokens <= (w.read ?? 0) * 1.4 : near(est.prefixTokens, w.read ?? 0, 1.4),
                {
                  expected: { providerRead: w.read },
                  actual: { estimatePrefixTokens: est.prefixTokens, verified: est.verified, ttlS: est.ttlS },
                  ref: ref(t)
                }
              )
          }
          prev = w
          if (spent() > CAP) break
        }
      })
    )

  liveTest("route pinning, a provider switch mid-chat, and one Gemini 4 Argon call", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      if (spent() > CAP) return void f.check("openrouter", "routing", null, { actual: `cap $${CAP} reached` })
      const r = { ...routes[0]!, id: "OR routing" }
      const chat = yield* startChat(api, recorder, dataDir, r)
      const model = yield* modelOf(api, chat.connection.id)
      const t1 = (yield* chat.say("Good evening, Mira. Is the copper bell entry still in the ledger?"))!
      checkTurn(f, r, "pinned turn 1", t1, model)
      f.check(
        r.id,
        "the model's routing setting goes out as `provider`",
        JSON.stringify(t1.exchange?.request?.provider ?? null) ===
          JSON.stringify({ only: ["anthropic"], allow_fallbacks: false }),
        {
          actual: t1.exchange?.request?.provider ?? null
        }
      )
      f.check(r.id, "pinned to anthropic: served by Anthropic", t1.row?.upstream === "Anthropic", {
        actual: { upstream: t1.row?.upstream }
      })
      const t2 = (yield* chat.say("Then read me the amber lantern entry."))!
      checkTurn(f, r, "pinned turn 2", t2, model)
      // Pin the same model to Vertex: another provider's cache.
      const current = (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
        (m) => m.id === chat.model.id
      )!
      yield* api.EditModel({
        modelId: current.id,
        overrides: pinned("google-vertex"),
        expectedRowVersion: current.rowVersion
      })
      yield* Effect.sleep("1 second")
      const t3 = (yield* chat.say("Who guards the white compass?"))!
      const w3 = checkTurn(f, r, "after the provider switch", t3, model)
      f.check(r.id, "provider switch: served by Vertex", t3.row?.upstream === "Google", {
        actual: { upstream: t3.row?.upstream }
      })
      f.check(r.id, "provider switch: the provider's cache is cold on the new upstream", (w3?.read ?? 0) === 0, {
        actual: { upstream: t3.row?.upstream, ...w3 },
        ref: ref(t3)
      })
      f.check(r.id, "provider switch: estimate says the prefix changed", !!t3.before?.warmth?.changed, {
        actual: t3.before?.warmth ?? null
      })

      if (spent() > CAP) return
      const argon: Profile = {
        ...base,
        id: "OR gemini-4-argon",
        model: "google/gemini-4-argon",
        cacheTokens: 100
      }
      const a = yield* startChat(api, recorder, dataDir, argon)
      yield* checkModels(f, argon, api, a, { listed: "google/gemini-4-argon" })
      const am =
        (yield* api.ListModels({ connectionId: a.connection.id, includeHidden: true })).find(
          (m) => m.key === argon.model && m.source === "fetched"
        ) ?? null
      const t = (yield* a.say("Hello, Mira. One sentence about the harbor."))!
      checkTurn(f, argon, "one reply", t, am)
    })
  )
})
