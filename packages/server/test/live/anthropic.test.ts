// Live: Anthropic Messages, native, through the app's own provider code.
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { findings, LIVE, liveEnabled, solidPng, sseEvents } from "./support/live.ts"
import {
  checkModels,
  checkTurn,
  errorCase,
  growingChat,
  liveTest,
  markers,
  nonStreaming,
  type Profile,
  ref,
  startChat,
  stopMidStream,
  streaming,
  wireCounts
} from "./support/scenarios.ts"
import { wireUsage } from "./support/live.ts"

const f = findings("anthropic")

// Haiku 4.5, added by id (no price: AddUserModel takes only the context window from the catalog).
const haikuById: Profile = {
  id: "anthropic",
  kind: "anthropic",
  route: "anthropic",
  model: "claude-haiku-4-5",
  dialect: "anthropic",
  cacheTokens: 5200,
  documented: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWriteLong: 2 }
}

// As listed by the provider: priced and flagged for reasoning by pi-ai's catalog. Its cache
// minimum is 4,096 tokens.
const haiku: Profile = { ...haikuById, listed: "claude-haiku-4-5-20251001" }

describe.skipIf(!liveEnabled)("live Anthropic", () => {
  liveTest("basics: models, streaming, stop, errors, display-only buffering", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const chat = yield* startChat(api, recorder, dataDir, haiku, { cardTokens: 300 })
      const model = yield* checkModels(f, haiku, api, chat, {
        listed: "claude-haiku-4-5-20251001",
        context: 200000,
        vision: true,
        reasoning: true
      })
      // A model added by its id (no request is sent).
      const byId = yield* startChat(api, recorder, dataDir, haikuById, { cardTokens: 50 })
      f.check(
        haiku.id,
        "model added by id gets the catalog's price and reasoning flag",
        byId.model.upstream.price !== undefined && byId.model.upstream.reasoning === true,
        {
          expected: { price: "present", reasoning: true },
          actual: { upstream: byId.model.upstream }
        }
      )
      const t = (yield* chat.say("Hello, Mira. Tell me one thing about the harbor in two sentences."))!
      checkTurn(f, haiku, "basic reply", t, model)
      streaming(f, haiku, t, chat.events)
      yield* stopMidStream(f, haiku, chat)

      const buffered = yield* startChat(api, recorder, dataDir, haiku, {
        cardTokens: 100,
        overrides: { settings: { stream: false } }
      })
      yield* nonStreaming(f, haiku, buffered)

      const badModel = yield* startChat(
        api,
        recorder,
        dataDir,
        { ...haikuById, model: "claude-no-such-model-9" },
        { cardTokens: 50 }
      )
      errorCase(f, haiku, "unknown model", (yield* badModel.say("Hello."))!, ["bad_request"])
      const badKey = yield* startChat(api, recorder, dataDir, haiku, {
        cardTokens: 50,
        apiKey: "sk-ant-invalid-live-check"
      })
      errorCase(f, haiku, "bad key", (yield* badKey.say("Hello."))!, ["auth"])
    })
  )

  liveTest("caching with default model settings (pi-ai's own markers)", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const p = { ...haiku, id: "anthropic (default markers)" }
      const chat = yield* startChat(api, recorder, dataDir, p)
      const model =
        (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
          (m) => m.id === chat.model.id
        ) ?? null
      const run = yield* growingChat(f, p, chat, model)
      const first = run.turns[0]!.t
      f.check(
        p.id,
        "default: markers sent (system + last message), 5-minute TTL",
        markers(first.exchange).length >= 1,
        {
          actual: markers(first.exchange)
        }
      )
    })
  )

  liveTest("caching with explicit breakpoints", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const p = { ...haiku, id: "anthropic (explicit)", overrides: { cacheBreakpoints: "explicit" as const } }
      const chat = yield* startChat(api, recorder, dataDir, p)
      const model =
        (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
          (m) => m.id === chat.model.id
        ) ?? null
      const run = yield* growingChat(f, p, chat, model)
      for (const [i, { t }] of run.turns.entries()) {
        const m = markers(t.exchange)
        const planned = t.run?.messages.filter((x) => x.breakpoint !== null).map((x) => x.breakpoint) ?? []
        f.check(
          p.id,
          `turn ${i + 1}: 1–4 markers on the wire, matching the planned breakpoints`,
          m.length >= 1 && m.length <= 4,
          {
            actual: { wire: m, planned }
          }
        )
      }
    })
  )

  liveTest("1-hour TTL, and the 5-minute expiry", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const p = {
        ...haiku,
        id: "anthropic (1h)",
        overrides: { cacheBreakpoints: "explicit" as const, settings: { cacheRetention: "long" as const } }
      }
      const hour = yield* startChat(api, recorder, dataDir, p)
      const model =
        (yield* api.ListModels({ connectionId: hour.connection.id, includeHidden: true })).find(
          (m) => m.id === hour.model.id
        ) ?? null
      const t1 = (yield* hour.say("Good evening. Read me the first entry."))!
      const w1 = checkTurn(f, p, "1h turn 1", t1, model)
      const m = markers(t1.exchange)
      f.check(p.id, "1h: every marker asks for ttl 1h", m.length > 0 && m.every((x) => x.ttl === "1h"), { actual: m })
      f.check(
        p.id,
        "1h: provider reports the write as 1-hour, ledger long write = it",
        !!w1 && (w1.writeLong ?? 0) > 0 && w1.writeLong === w1.write && t1.row?.counts.cacheWriteLong === w1.writeLong,
        {
          actual: { wire: w1, ledger: t1.row?.counts },
          ref: ref(t1)
        }
      )
      const t2 = (yield* hour.say("And the second entry."))!
      checkTurn(f, p, "1h turn 2", t2, model)
      f.check(p.id, "1h: estimate's TTL is 3600 s", t2.before?.warmth?.ttlS === 3600, {
        actual: t2.before?.warmth ?? null
      })

      const q = { ...haiku, id: "anthropic (5m)" }
      const five = yield* startChat(api, recorder, dataDir, q)
      const s1 = (yield* five.say("Good evening. Read me the first entry."))!
      checkTurn(f, q, "5m turn 1", s1, model)
      if (!LIVE.waitTtl) {
        f.check(q.id, "expiry after 5 minutes (RP_LIVE_WAIT_TTL=1)", null, { actual: "not waited" })
        return
      }
      yield* Effect.sleep("330 seconds")
      const s2 = (yield* five.say("And the second entry."))!
      const sw = checkTurn(f, q, "5m after 330 s", s2, model)
      f.check(q.id, "5m: after 330 s the cache has expired (no read)", (sw?.read ?? 0) === 0, {
        actual: sw,
        ref: ref(s2)
      })
      const w = s2.before?.warmth
      f.check(
        q.id,
        "5m: estimate says expired before that request",
        !!w && w.expiresAt !== null && w.expiresAt < Date.now(),
        {
          actual: w ?? null
        }
      )
      const t3 = (yield* hour.say("And the third entry."))!
      const hw = checkTurn(f, p, "1h after 330 s", t3, model)
      f.check(p.id, "1h: after 330 s the cache still reads", (hw?.read ?? 0) > 0, { actual: hw, ref: ref(t3) })
    })
  )

  liveTest("minimum cacheable size", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      // Haiku 4.5's minimum is 4,096 tokens: about 2,000 isn't cached.
      const p = { ...haiku, id: "anthropic (below minimum)" }
      const small = yield* startChat(api, recorder, dataDir, p, { cardTokens: 1800 })
      const model =
        (yield* api.ListModels({ connectionId: small.connection.id, includeHidden: true })).find(
          (m) => m.id === small.model.id
        ) ?? null
      const a = checkTurn(f, p, "small turn 1", (yield* small.say("Good evening."))!, model)
      f.check(p.id, "below 4,096: nothing written", (a?.write ?? 0) === 0, { actual: a })
      const t2 = (yield* small.say("Read me an entry."))!
      const b = checkTurn(f, p, "small turn 2", t2, model)
      f.check(p.id, "below 4,096: nothing read", (b?.read ?? 0) === 0, { actual: b })
      const w = t2.before?.warmth
      f.check(
        p.id,
        "below minimum: estimate doesn't claim a warm cache",
        !w || w.changed !== null || w.ttlS === null || !(w.prefixTokens > 0 && !w.verified),
        {
          expected: "no warm claim for a prefix the provider never cached",
          actual: w ?? null
        }
      )
      // Haiku 5.5's minimum is 512 tokens, and it isn't in pi-ai's catalog.
      const h55: Profile = {
        ...haikuById,
        id: "anthropic haiku-5.5",
        model: "claude-haiku-5-5",
        documented: undefined as never
      }
      const tiny = yield* startChat(api, recorder, dataDir, h55, { cardTokens: 700 })
      const m55 =
        (yield* api.ListModels({ connectionId: tiny.connection.id, includeHidden: true })).find(
          (m) => m.id === tiny.model.id
        ) ?? null
      const c = (yield* tiny.say("Good evening."))!
      const cw = checkTurn(f, h55, "700-token prompt", c, m55)
      f.check(h55.id, "above 512: cache written", (cw?.write ?? 0) > 0, { actual: cw })
      f.check(h55.id, "a model missing from the catalog still gets a cost", c.row?.cost !== null, {
        actual: { cost: c.row?.cost, price: m55?.upstream.price ?? null }
      })
    })
  )

  liveTest("thinking, and thinking across agent tool calls", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const p = { ...haiku, id: "anthropic (thinking)" }
      const chat = yield* startChat(api, recorder, dataDir, p, {
        cardTokens: 200,
        overrides: { settings: { samplers: { reasoning_effort: "low", openai_max_tokens: 2500 } } }
      })
      const model =
        (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
          (m) => m.id === chat.model.id
        ) ?? null
      const t1 = (yield* chat.say("Think briefly, then answer: which entry mentions a bell?"))!
      checkTurn(f, p, "thinking turn 1", t1, model)
      f.check(p.id, "thinking requested on the wire", !!t1.exchange?.request?.thinking, {
        actual: t1.exchange?.request?.thinking
      })
      f.check(p.id, "thinking shown and stored on the version", (t1.version.reasoning ?? "").length > 0, {
        actual: {
          reasoning: (t1.version.reasoning ?? "").slice(0, 80),
          wireThinking: sseEvents(t1.exchange?.body ?? "").some(
            (e) => (e.delta as { type?: string } | undefined)?.type === "thinking_delta"
          )
        }
      })
      const t2 = (yield* chat.say("And which mentions a lantern?"))!
      checkTurn(f, p, "thinking turn 2 (earlier thinking not replayed)", t2, model)

      const agent = yield* startChat(api, recorder, dataDir, p, {
        cardTokens: 200,
        overrides: { tools: true, settings: { samplers: { reasoning_effort: "low", openai_max_tokens: 2500 } } },
        state: [{ key: "agent.enabled", value: { on: true } }]
      })
      yield* agent.say("Remember this: the copper bell hangs in the chapel.", { reply: false })
      const t = (yield* agent.say(
        "Use the search_chat tool to find what I said about the copper bell, then answer in one sentence."
      ))!
      f.check(
        p.id,
        "agent: tool call, then a final reply",
        t.version.status === "complete" && t.exchanges.length >= 2,
        {
          actual: {
            status: t.version.status,
            error: t.version.error,
            requests: t.exchanges.length,
            http: t.exchanges.map((e) => e.status)
          },
          ref: ref(t)
        }
      )
      for (const row of t.rows) f.addSpend(p.id, row, null)
      const second = t.exchanges[1]?.request as { messages?: Array<{ role: string; content: unknown }> } | undefined
      const assistant = second?.messages?.filter((m) => m.role === "assistant").at(-1)
      const blocks = Array.isArray(assistant?.content) ? (assistant!.content as Array<Record<string, unknown>>) : []
      f.check(
        p.id,
        "agent: the signed thinking block goes back before the tool_use",
        blocks.some((b) => b.type === "thinking" && typeof b.signature === "string" && b.signature.length > 0) &&
          blocks.some((b) => b.type === "tool_use"),
        {
          actual: blocks.map((b) => ({ type: b.type, signed: typeof b.signature === "string" }))
        }
      )
    })
  )

  liveTest("prefill, continue and vision", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const p = { ...haiku, id: "anthropic (prefill)" }
      const chat = yield* startChat(api, recorder, dataDir, p, {
        cardTokens: 200,
        overrides: { prefill: "assistant", vision: true },
        prefill: "*Mira sets down her pen and says,*"
      })
      const model =
        (yield* api.ListModels({ connectionId: chat.connection.id, includeHidden: true })).find(
          (m) => m.id === chat.model.id
        ) ?? null
      const t = (yield* chat.say("Tell me about the fog."))!
      checkTurn(f, p, "prefilled reply", t, model)
      const msgs = (t.exchange?.request?.messages ?? []) as Array<{ role: string; content: unknown }>
      const lastText = JSON.stringify(msgs.at(-1)?.content ?? "")
      f.check(
        p.id,
        "prefill: last wire message is the assistant prefill",
        msgs.at(-1)?.role === "assistant" && lastText.includes("Mira sets down her pen"),
        {
          actual: { role: msgs.at(-1)?.role, content: lastText.slice(0, 120) }
        }
      )
      f.check(
        p.id,
        "prefill: saved text leaves the prefill out",
        !t.version.content.includes("sets down her pen and says"),
        {
          actual: t.version.content.slice(0, 120)
        }
      )
      const c = yield* chat.continueLast
      checkTurn(f, p, "continue", c, model)
      f.check(
        p.id,
        "continue: text extends the original",
        c.version.content.startsWith(t.version.content.trimEnd()) &&
          c.version.content.length > t.version.content.length,
        {
          actual: {
            before: t.version.content.length,
            after: c.version.content.length,
            start: c.version.content.slice(0, 60)
          }
        }
      )
      const image = yield* chat.upload(solidPng([220, 20, 20]))
      const v = (yield* chat.say("What colour is the square in this image? Answer with one word.", {
        images: [image]
      }))!
      checkTurn(f, p, "vision", v, model)
      f.check(p.id, "vision: the model sees the synthetic image", /red/i.test(v.version.content), {
        actual: v.version.content.slice(0, 120),
        ref: ref(v)
      })
      const est = v.run?.messages.flatMap((m) => m.images ?? []) ?? []
      const wire = wireCounts("anthropic", wireUsage(v.exchange?.body ?? ""))
      f.check(p.id, "vision: image token estimate (64×64 → ⌈64/28⌉² = 9)", est.length === 1, {
        actual: { estimates: est, wire }
      })
    })
  )
})
