// Live: OpenRouter routes, through the app's provider code. Real money: every request's
// reported cost counts against RP_LIVE_OPENROUTER_CAP (default $2 for the whole file).
import { describe } from "@effect/vitest"
import type { Connection } from "@rp/shared/providers.ts"
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

const base = { kind: "openrouter", dialect: "openrouter" as const }
// Each upstream is reached through its own route (a request's `provider` is
// overridden), so each upstream is reached through the route that serves it.
const routes: ReadonlyArray<Profile & { readonly upstream: string }> = [
  {
    ...base,
    id: "OR claude via Bedrock",
    route: "openrouter/v1",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Amazon Bedrock"
  },
  {
    ...base,
    id: "OR claude via Vertex",
    route: "openrouter-nozdr/v1",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Google"
  },
  {
    ...base,
    id: "OR gpt-5.4-nano via Azure",
    route: "openrouter/v1",
    model: "openai/gpt-5.4-nano",
    cacheTokens: 1500,
    upstream: "Azure",
    ttlUnknown: true,
    overrides: { settings: { samplers: { openai_max_tokens: 600, reasoning_effort: "low" } } }
  },
  {
    ...base,
    id: "OR gemini-3.5-flash-lite via AI Studio",
    route: "openrouter/v1",
    model: "google/gemini-3.5-flash-lite",
    cacheTokens: 4400,
    upstream: "Google AI Studio"
  },
  // The same two with the app's explicit breakpoints instead of the default (pi-ai's markers).
  {
    ...base,
    id: "OR claude via Bedrock (explicit breakpoints)",
    route: "openrouter/v1",
    model: "anthropic/claude-haiku-4.5",
    cacheTokens: 4400,
    upstream: "Amazon Bedrock",
    overrides: { cacheBreakpoints: "explicit" }
  },
  {
    ...base,
    id: "OR gemini-3.5-flash-lite via AI Studio (explicit breakpoints)",
    route: "openrouter/v1",
    model: "google/gemini-3.5-flash-lite",
    cacheTokens: 4400,
    upstream: "Google AI Studio",
    overrides: { cacheBreakpoints: "explicit" }
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
          if (prev && w) {
            const prevTotal = totalInput(prev)
            f.check(r.id, `turn ${i + 1}: reads most of the previous prompt`, (w.read ?? 0) >= 0.7 * prevTotal, {
              expected: { readAtLeast: Math.round(0.7 * prevTotal) },
              actual: { ...w, cost: t.row?.cost?.amount },
              ref: ref(t)
            })
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
                `turn ${i + 1}: estimated cached prefix ≈ provider's cached tokens (±40%)`,
                near(est.prefixTokens, w.read ?? 0, 1.4),
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

  liveTest("route pinning, a route switch mid-chat, and one Gemini 4 Argon call", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      if (spent() > CAP) return void f.check("openrouter", "routing", null, { actual: `cap $${CAP} reached` })
      const r = {
        ...routes[0]!,
        id: "OR routing",
        overrides: { settings: { routing: { only: ["anthropic"], allow_fallbacks: false } } }
      }
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
        actual: { upstream: t1.row?.upstream, note: "routing is set by the route" }
      })
      const t2 = (yield* chat.say("Then read me the amber lantern entry."))!
      checkTurn(f, r, "pinned turn 2", t2, model)
      // Switch the same connection to the route that serves Claude from Vertex.
      const connection = (yield* api.ListConnections()).find((c: Connection) => c.id === chat.connection.id)!
      yield* api.UpdateConnection({
        connectionId: connection.id,
        settings: {
          name: connection.name,
          baseUrl: connection.baseUrl!.replace("/openrouter/v1", "/openrouter-nozdr/v1"),
          compat: connection.compat,
          cacheTtlS: connection.cacheTtlS,
          maxConcurrent: connection.maxConcurrent,
          presetOverrideRefId: connection.presetOverrideRefId
        },
        expectedRowVersion: connection.rowVersion
      })
      yield* Effect.sleep("1 second")
      const t3 = (yield* chat.say("Who guards the white compass?"))!
      const w3 = checkTurn(f, r, "after the route switch", t3, model)
      f.check(r.id, "route switch: the provider's cache is cold on the new upstream", (w3?.read ?? 0) === 0, {
        actual: { upstream: t3.row?.upstream, ...w3 },
        ref: ref(t3)
      })
      f.check(r.id, "route switch: estimate says the prefix changed", !!t3.before?.warmth?.changed, {
        actual: t3.before?.warmth ?? null
      })

      if (spent() > CAP) return
      const argon: Profile = {
        ...base,
        id: "OR gemini-4-argon",
        route: "openrouter/v1",
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
