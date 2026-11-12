// Live: OpenRouter models pinned to one upstream provider each (`provider.only`, which OpenRouter
// honors): DeepSeek and MiMo Pro through a few providers, an OpenAI model on
// Amazon Bedrock, and one small synthetic image per pair. Secondary checks (liveapi2): what each
// provider does with caching, reasoning, tools, prefill and images. Real money: counts against
// RP_LIVE_OPENROUTER_CAP with the rest of the OpenRouter checks.
import { describe } from "@effect/vitest"
import type { Model } from "@rp/shared/providers.ts"
import { Effect } from "effect"
import { findings, liveEnabled, solidPng } from "./support/live.ts"
import { checkTurn, liveTest, type Profile, ref, startChat, totalInput } from "./support/scenarios.ts"

const f = findings("openrouterProviders")
const CAP = Number(process.env.RP_LIVE_OPENROUTER_CAP ?? "2")
const spent = () => Object.values(f.spend).reduce((n, s) => n + s.reported, 0)

const pinned = (slug: string, samplers: Record<string, unknown> = {}) => ({
  settings: { routing: { only: [slug], allow_fallbacks: false }, samplers }
})

interface Pair {
  readonly id: string
  readonly model: string
  readonly slug: string
  readonly upstream: string
  /** The endpoint offers tools (OpenRouter's endpoint list, 2026-11-07). */
  readonly tools: boolean
  /** How the provider fails to go on from a prefill (live, 2026-11-07); the check then records what it does. */
  readonly noPrefill?: string
  /** Why the provider caches nothing at this size (live, 2026-11-07); the check then records it. */
  readonly noCache?: string
  /** The first turn that reads the cache (live, 2026-11-07); earlier turns are recorded. */
  readonly cacheFrom?: { readonly turn: number; readonly why: string }
}

const pairs: ReadonlyArray<Pair> = [
  {
    id: "OR deepseek-v4.1-flash via DeepInfra",
    model: "deepseek/deepseek-v4.1-flash",
    slug: "deepinfra",
    upstream: "DeepInfra",
    tools: true
  },
  {
    id: "OR deepseek-v4.1-flash via Together",
    model: "deepseek/deepseek-v4.1-flash",
    slug: "together",
    upstream: "Together",
    tools: true,
    noPrefill:
      "with reasoning on, the reply comes back as reasoning and the text is empty; with it off, a stray [[...]] token comes first"
  },
  {
    id: "OR deepseek-v4.1-flash via Fireworks",
    model: "deepseek/deepseek-v4.1-flash",
    slug: "fireworks",
    upstream: "Fireworks",
    tools: true
  },
  {
    id: "OR mimo-v2.6-pro via Xiaomi",
    model: "xiaomi/mimo-v2.6-pro",
    slug: "xiaomi",
    upstream: "Xiaomi",
    tools: true,
    noPrefill: "the reply goes on from it in some runs and starts over (often repeating it) in others"
  },
  {
    id: "OR mimo-v2.6-pro via DeepInfra",
    model: "xiaomi/mimo-v2.6-pro",
    slug: "deepinfra",
    upstream: "DeepInfra",
    tools: true,
    cacheFrom: { turn: 3, why: "turn 2 read 0 in both runs, and turn 3 read turn 2's prompt" }
  },
  {
    id: "OR mimo-v2.6-pro via StreamLake",
    model: "xiaomi/mimo-v2.6-pro",
    slug: "streamlake",
    upstream: "StreamLake",
    tools: true,
    noPrefill: "the reply starts over, with or without reasoning"
  },
  // AWS via OpenRouter: an approximation of direct Bedrock, never the same thing.
  {
    id: "OR gpt-oss-120b via Amazon Bedrock (via OpenRouter)",
    model: "openai/gpt-oss-120b",
    slug: "amazon-bedrock",
    upstream: "Amazon Bedrock",
    tools: false,
    noCache: "read 0 on turns 2 and 3 at ~1,800 tokens"
  }
]

const profileOf = (pair: Pair, extra: Record<string, unknown> = {}): Profile => ({
  id: pair.id,
  kind: "openrouter",
  route: "openrouter/v1",
  dialect: "openrouter",
  model: pair.model,
  listed: pair.model,
  cacheTokens: 1500,
  overrides: { ...pinned(pair.slug, { reasoning_effort: "low", openai_max_tokens: 1200 }), ...extra }
})

type Api = Parameters<Parameters<typeof liveTest>[2]>[0]["api"]
const modelOf = (api: Api, chat: { connection: { id: string }; model: { id: string } }) =>
  api
    .ListModels({ connectionId: chat.connection.id as never, includeHidden: true })
    .pipe(Effect.map((m) => m.find((x) => x.id === chat.model.id) ?? null))

describe.skipIf(!liveEnabled)("live OpenRouter, pinned providers", () => {
  for (const pair of pairs)
    liveTest(`${pair.id}: caching, reasoning, tools, prefill`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        if (spent() > CAP) return void f.check(pair.id, "pair", null, { actual: `cap $${CAP} reached` })
        const p = profileOf(pair)
        const chat = yield* startChat(api, recorder, dataDir, p)
        const model = yield* modelOf(api, chat)
        const lines = [
          "Good evening, Mira. Is the copper bell entry still in the ledger?",
          "Then read me the amber lantern entry.",
          "Who guards the white compass?"
        ]
        let prev: ReturnType<typeof checkTurn> = null
        for (const [i, line] of lines.entries()) {
          const t = (yield* chat.say(line))!
          const w = checkTurn(f, p, `turn ${i + 1}`, t, model)
          f.check(p.id, `turn ${i + 1}: served by ${pair.upstream}`, t.row?.upstream === pair.upstream, {
            actual: t.row?.upstream
          })
          if (i === 0)
            f.check(p.id, "reasoning content shown and stored", (t.version.reasoning ?? "").length > 0, {
              actual: { reasoning: (t.version.reasoning ?? "").slice(0, 80), tokens: w?.reasoning }
            })
          if (prev && w) {
            const prevTotal = totalInput(prev)
            f.check(
              p.id,
              `turn ${i + 1}: automatic cache reads most of the previous prompt`,
              pair.noCache || i + 1 < (pair.cacheFrom?.turn ?? 0) ? null : (w.read ?? 0) >= 0.7 * prevTotal,
              {
                expected: { readAtLeast: Math.round(0.7 * prevTotal) },
                actual: { ...w, cost: t.row?.cost?.amount, known: pair.noCache ?? pair.cacheFrom?.why },
                ref: ref(t)
              }
            )
            // The app documents no cache lifetime for these, so it claims nothing warm.
            const est = t.before?.warmth
            f.check(
              p.id,
              `turn ${i + 1}: estimate claims nothing it can't know`,
              !est || est.prefixTokens <= (w.read ?? 0) * 1.4,
              {
                actual: est ?? null
              }
            )
          }
          prev = w
        }
        if (pair.tools) {
          const agent = yield* startChat(api, recorder, dataDir, p, {
            cardTokens: 200,
            overrides: { ...p.overrides, tools: true },
            state: [{ key: "agent.enabled", value: { on: true } }]
          })
          yield* agent.say("Remember this: the copper bell hangs in the chapel.", { reply: false })
          const a = (yield* agent.say(
            "Use the search_chat tool to find what I said about the copper bell, then answer in one sentence."
          ))!
          for (const row of a.rows) f.addSpend(p.id, row, a.stored.find((s) => s.id === row.id)?.reportedCost ?? null)
          f.check(
            p.id,
            "agent with reasoning: tool round trip completes",
            a.version.status === "complete" && a.exchanges.length >= 2,
            {
              actual: {
                status: a.version.status,
                error: a.version.error,
                http: a.exchanges.map((e) => e.status),
                body: a.exchanges.find((e) => e.status >= 400)?.body.slice(0, 300)
              },
              ref: ref(a)
            }
          )
          const second = JSON.stringify(a.exchanges[1]?.request ?? {})
          f.check(p.id, "agent: reasoning goes back with the tool call", /reasoning/.test(second), {
            actual: second.slice(0, 200)
          })
        } else f.check(p.id, "agent tools", null, { actual: "the endpoint offers no tools" })

        const pre = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 200,
          overrides: { ...p.overrides, prefill: "assistant" },
          prefill: "*Mira sets down her pen and says,*"
        })
        const pm = yield* modelOf(api, pre)
        const r = (yield* pre.say("Tell me about the fog."))!
        const msgs = (r.exchange?.request?.messages ?? []) as Array<{ role: string }>
        const continued =
          msgs.at(-1)?.role === "assistant" &&
          r.version.status === "complete" &&
          !/sets down her pen and says/.test(r.version.content)
        if (pair.noPrefill && r.row) f.addSpend(p.id, r.row, r.stored.at(-1)?.reportedCost ?? null)
        else checkTurn(f, p, "prefilled reply", r, pm)
        f.check(
          p.id,
          "prefill: sent as the last message, and the reply goes on from it",
          pair.noPrefill ? null : continued,
          {
            ...(pair.noPrefill ? { expected: `known: ${pair.noPrefill}` } : {}),
            actual: {
              last: msgs.at(-1)?.role,
              continued,
              reply: r.version.content.slice(0, 120),
              error: r.version.error
            }
          }
        )
      })
    )

  // One small synthetic image per pair: accepted, counted, and whether the cache survives it.
  const imagePairs: ReadonlyArray<Profile & { readonly upstream: string }> = [
    ...["anthropic", "google-vertex", "amazon-bedrock"].map((slug) => ({
      id: `OR claude via ${slug} (image)`,
      kind: "openrouter",
      route: "openrouter/v1",
      dialect: "openrouter" as const,
      model: "anthropic/claude-haiku-4.5",
      cacheTokens: 4400,
      upstream: { anthropic: "Anthropic", "google-vertex": "Google", "amazon-bedrock": "Amazon Bedrock" }[slug]!,
      overrides: { ...pinned(slug), vision: true }
    })),
    {
      id: "OR gpt-5.4-nano via openai (image)",
      kind: "openrouter",
      route: "openrouter/v1",
      dialect: "openrouter",
      model: "openai/gpt-5.4-nano",
      cacheTokens: 1500,
      upstream: "OpenAI",
      overrides: { ...pinned("openai", { reasoning_effort: "low", openai_max_tokens: 600 }), vision: true }
    },
    ...(["xiaomi", "deepinfra"] as const).map((slug) => ({
      id: `OR mimo-v2.6-pro via ${slug} (image)`,
      kind: "openrouter",
      route: "openrouter/v1",
      dialect: "openrouter" as const,
      model: "xiaomi/mimo-v2.6-pro",
      listed: "xiaomi/mimo-v2.6-pro",
      cacheTokens: 1500,
      upstream: { xiaomi: "Xiaomi", deepinfra: "DeepInfra" }[slug]!,
      overrides: { ...pinned(slug, { reasoning_effort: "low", openai_max_tokens: 1200 }), vision: true }
    }))
  ]

  liveTest("one image per pair: accepted, counted, cache after it", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      for (const p of imagePairs) {
        if (spent() > CAP) return void f.check(p.id, "image", null, { actual: `cap $${CAP} reached` })
        const chat = yield* startChat(api, recorder, dataDir, p)
        const model: Model | null = yield* modelOf(api, chat)
        if (p.listed && model && model.upstream.vision === false) {
          f.check(p.id, "image", null, { actual: "the provider's list says the model takes no images" })
          continue
        }
        const image = yield* chat.upload(solidPng([220, 20, 20]))
        const v = (yield* chat.say("What colour is the square in this image? Answer with one word.", {
          images: [image]
        }))!
        const w1 = checkTurn(f, p, "image turn", v, model)
        f.check(p.id, `image: served by ${p.upstream}`, v.row?.upstream === p.upstream, { actual: v.row?.upstream })
        f.check(p.id, "image: accepted, and the model sees it", /red/i.test(v.version.content), {
          actual: { text: v.version.content.slice(0, 120), error: v.version.error },
          ref: ref(v)
        })
        const estimated = v.run?.messages.flatMap((m) => m.images ?? []) ?? []
        f.check(p.id, "image: the app estimated its tokens", estimated.length === 1, {
          actual: { estimated, wire: w1 }
        })
        const t = (yield* chat.say("Thank you. And the copper bell entry?"))!
        const w2 = checkTurn(f, p, "turn after the image", t, model)
        if (w1 && w2)
          f.check(
            p.id,
            "image: the next turn reads the prefix with the image from cache",
            p.model.startsWith("openai/") ? null : (w2.read ?? 0) >= 0.7 * totalInput(w1),
            {
              expected: { readAtLeast: Math.round(0.7 * totalInput(w1)) },
              actual: { imageTurn: w1, next: w2 },
              ref: ref(t)
            }
          )
      }
    })
  )
})
