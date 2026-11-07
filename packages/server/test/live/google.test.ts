// Live: Gemini on Google's native API (the Google AI Studio provider), through the app's
// provider code.
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { findings, liveEnabled, solidPng, sseEvents } from "./support/live.ts"
import {
  checkModels,
  checkTurn,
  errorCase,
  growingChat,
  liveTest,
  type Profile,
  ref,
  startChat,
  stopMidStream,
  streaming
} from "./support/scenarios.ts"

const f = findings("google")

const base = { kind: "google", route: "google/v1beta", dialect: "google" as const, ttlUnknown: true }
const lite: Profile = {
  ...base,
  id: "google gemini-3.5-flash-lite",
  model: "gemini-3.5-flash-lite",
  listed: "gemini-3.5-flash-lite",
  // Gemini's documented implicit-cache minimum: 1,024 tokens for Flash, 4,096 for Pro.
  cacheTokens: 2500
}
const argon: Profile = {
  ...base,
  id: "google gemini-4-argon",
  model: "gemini-4-argon",
  listed: "gemini-4-argon",
  cacheTokens: 5000,
  overrides: { settings: { samplers: { openai_max_tokens: 1500 } } }
}

type Api = Parameters<Parameters<typeof liveTest>[2]>[0]["api"]
const modelOf = (api: Api, chat: { connection: { id: string }; model: { id: string } }) =>
  api
    .ListModels({ connectionId: chat.connection.id as never, includeHidden: true })
    .pipe(Effect.map((m) => m.find((x) => x.id === chat.model.id) ?? null))

/** The thought parts Gemini streamed (`thought: true`). */
const thoughtParts = (body: string) =>
  sseEvents(body).flatMap((e) =>
    ((e.candidates as Array<{ content?: { parts?: Array<{ thought?: boolean }> } }> | undefined) ?? []).flatMap((c) =>
      (c.content?.parts ?? []).filter((p) => p.thought === true)
    )
  ).length

describe.skipIf(!liveEnabled)("live Google (Gemini API)", () => {
  liveTest("flash-lite: models, caching, streaming, stop, errors", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const chat = yield* startChat(api, recorder, dataDir, lite)
      const model = yield* checkModels(f, lite, api, chat, { listed: "gemini-3.5-flash-lite" })
      yield* growingChat(f, lite, chat, model)
      const small = yield* startChat(api, recorder, dataDir, lite, { cardTokens: 200 })
      const t = (yield* small.say("Hello, Mira. Two sentences about the harbor, please."))!
      checkTurn(f, lite, "basic reply", t, model)
      streaming(f, lite, t, small.events)
      yield* stopMidStream(f, lite, small)
      const bad = yield* startChat(
        api,
        recorder,
        dataDir,
        { ...base, id: lite.id, model: "gemini-no-such-model", cacheTokens: 50 },
        { cardTokens: 50 }
      )
      errorCase(f, lite, "unknown model", (yield* bad.say("Hello."))!, ["bad_request", "not_found"])
      const badKey = yield* startChat(api, recorder, dataDir, lite, { cardTokens: 50, apiKey: "invalid-live-check" })
      errorCase(f, lite, "bad key", (yield* badKey.say("Hello."))!, ["auth"])
    })
  )

  liveTest("flash-lite: thinking, agent tools with thinking, prefill and continue, vision", f, (ctx) =>
    Effect.gen(function* () {
      const { api, recorder, dataDir } = ctx
      const p = { ...lite, id: "google flash-lite (thinking)" }
      const thinking = { settings: { samplers: { reasoning_effort: "low", openai_max_tokens: 1500 } } }
      const chat = yield* startChat(api, recorder, dataDir, p, { cardTokens: 200, overrides: thinking })
      const model = yield* modelOf(api, chat)
      const t = (yield* chat.say("Think it over, then answer briefly: which entry mentions a bell?"))!
      checkTurn(f, p, "thinking reply", t, model)
      const config = (t.exchange?.request?.generationConfig ?? {}) as Record<string, unknown>
      f.check(p.id, "thinking requested on the wire", !!config.thinkingConfig, {
        actual: config.thinkingConfig ?? null
      })
      f.check(p.id, "thoughts shown and stored", (t.version.reasoning ?? "").length > 0, {
        actual: {
          reasoning: (t.version.reasoning ?? "").slice(0, 80),
          wireThoughtParts: thoughtParts(t.exchange?.body ?? "")
        }
      })
      f.check(p.id, "thought tokens counted", (t.row?.counts.reasoning ?? 0) > 0, { actual: t.row?.counts })

      const agent = yield* startChat(api, recorder, dataDir, p, {
        cardTokens: 200,
        overrides: { ...thinking, tools: true },
        state: [{ key: "agent.enabled", value: { on: true } }]
      })
      yield* agent.say("Remember this: the copper bell hangs in the chapel.", { reply: false })
      const a = (yield* agent.say(
        "Use the search_chat tool to find what I said about the copper bell, then answer in one sentence."
      ))!
      for (const row of a.rows) f.addSpend(p.id, row, null)
      f.check(
        p.id,
        "agent with thinking: tool round trip completes",
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
      f.check(
        p.id,
        "agent: the function call goes back with its thought signature",
        second.includes("thoughtSignature"),
        {
          actual: second.slice(0, 300)
        }
      )

      const pre = yield* startChat(
        api,
        recorder,
        dataDir,
        { ...lite, id: "google flash-lite (prefill)" },
        {
          cardTokens: 200,
          overrides: { prefill: "assistant", vision: true },
          prefill: "*Mira sets down her pen and says,*"
        }
      )
      const pm = yield* modelOf(api, pre)
      const r = (yield* pre.say("Tell me about the fog."))!
      checkTurn(f, lite, "prefilled reply", r, pm)
      const contents = (r.exchange?.request?.contents ?? []) as Array<{ role: string; parts?: unknown }>
      f.check(
        lite.id,
        "prefill: last wire content is the model's prefill",
        contents.at(-1)?.role === "model" && JSON.stringify(contents.at(-1)?.parts).includes("Mira sets down her pen"),
        { actual: { role: contents.at(-1)?.role, parts: JSON.stringify(contents.at(-1)?.parts ?? "").slice(0, 120) } }
      )
      f.check(
        lite.id,
        "prefill: saved text leaves the prefill out",
        !r.version.content.includes("sets down her pen and says"),
        {
          actual: r.version.content.slice(0, 120)
        }
      )
      const c = yield* pre.continueLast
      checkTurn(f, lite, "continue", c, pm)
      f.check(
        lite.id,
        "continue: text extends the original",
        c.version.content.startsWith(r.version.content.trimEnd()) &&
          c.version.content.length > r.version.content.length,
        { actual: { before: r.version.content.length, after: c.version.content.length, error: c.version.error } }
      )
      const image = yield* pre.upload(solidPng([220, 20, 20]))
      const v = (yield* pre.say("What colour is the square in this image? Answer with one word.", { images: [image] }))!
      checkTurn(f, lite, "vision", v, pm)
      f.check(lite.id, "vision: the model sees the synthetic image", /red/i.test(v.version.content), {
        actual: { text: v.version.content.slice(0, 120), error: v.version.error },
        ref: ref(v)
      })
    })
  )

  liveTest("gemini-4-argon: listed, reasoning, caching over 3 turns, reasoning off", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const chat = yield* startChat(api, recorder, dataDir, argon)
      const model = yield* checkModels(f, argon, api, chat, { listed: "gemini-4-argon" })
      const lines = [
        "Good evening, Mira. Is the copper bell entry still in the ledger?",
        "Then read me the amber lantern entry.",
        "Who guards the white compass?"
      ]
      let prev: ReturnType<typeof checkTurn> = null
      for (const [i, line] of lines.entries()) {
        const t = (yield* chat.say(line))!
        const w = checkTurn(f, argon, `turn ${i + 1}`, t, model)
        if (i === 0)
          f.check(argon.id, "turn 1: reasons by default (thought tokens)", (w?.reasoning ?? 0) > 0, { actual: w })
        if (prev && w) {
          const prevTotal = (prev.uncached ?? 0) + (prev.read ?? 0)
          f.check(
            argon.id,
            `turn ${i + 1}: implicit cache reads most of the previous prompt`,
            (w.read ?? 0) >= 0.7 * prevTotal,
            {
              expected: { readAtLeast: Math.round(0.7 * prevTotal) },
              actual: w,
              ref: ref(t)
            }
          )
        }
        prev = w
      }
      // The model can't turn reasoning off; the app must not send a request it refuses.
      const off = yield* startChat(
        api,
        recorder,
        dataDir,
        { ...argon, id: "google gemini-4-argon (reasoning off)" },
        {
          cardTokens: 100,
          overrides: { settings: { samplers: { reasoning_effort: "none", openai_max_tokens: 1500 } } }
        }
      )
      const o = (yield* off.say("Hello, Mira. One sentence about the harbor."))!
      checkTurn(f, argon, "reasoning off requested", o, model)
    })
  )
})
