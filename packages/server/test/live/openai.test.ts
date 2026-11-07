// Live: OpenAI first party (Chat Completions and Responses), through the app's provider code.
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { findings, type LiveChat, liveEnabled, solidPng } from "./support/live.ts"
import {
  checkModels,
  checkTurn,
  errorCase,
  growingChat,
  liveTest,
  nonStreaming,
  type Profile,
  ref,
  startChat,
  stopMidStream,
  streaming
} from "./support/scenarios.ts"

const f = findings("openai")

const effort = { settings: { samplers: { openai_max_tokens: 600, reasoning_effort: "low" } } }
const noEffort = { settings: { samplers: { openai_max_tokens: 600 } } }

// gpt-5.4-nano: the cheapest current reasoning model; automatic caching from 1,024 tokens.
// Chat Completions runs with reasoning effort low; Responses without an effort, since every
// Responses request with one is refused (the effort test below records it), and function
// tools run without one on Chat Completions for the same reason.
const chatP: Profile = {
  id: "openai chat",
  kind: "openai-chat",
  route: "openai/v1",
  model: "gpt-5.4-nano",
  dialect: "openai",
  cacheTokens: 1700,
  overrides: effort
}
const respP: Profile = {
  ...chatP,
  id: "openai responses",
  kind: "openai-responses",
  dialect: "responses",
  overrides: noEffort
}

/** The chat's model as listed now (after any refresh). */
const modelOf = (api: Parameters<Parameters<typeof liveTest>[2]>[0]["api"], chat: LiveChat) =>
  api
    .ListModels({ connectionId: chat.connection.id, includeHidden: true })
    .pipe(Effect.map((m) => m.find((x) => x.id === chat.model.id) ?? null))

describe.skipIf(!liveEnabled)("live OpenAI", () => {
  for (const p of [chatP, respP])
    liveTest(`${p.id}: basics`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        const chat = yield* startChat(api, recorder, dataDir, p, { cardTokens: 300 })
        const model = yield* checkModels(f, p, api, chat, {
          listed: "acme.gpt-5.4-nano",
          vision: true,
          reasoning: true
        })
        const used = yield* modelOf(api, chat)
        f.check(p.id, "model added by id gets catalog facts and price", used?.upstream.price !== undefined, {
          actual: { price: used?.upstream.price, context: used?.upstream.context, catalog: used?.upstream.catalog }
        })
        const t = (yield* chat.say("Hello, Mira. Tell me one thing about the harbor in two sentences."))!
        checkTurn(f, p, "basic reply", t, used ?? model)
        streaming(f, p, t, chat.events)
        // Reasoning effort: on this chat for Chat Completions, on a chat of its own for Responses.
        const thinker =
          p.overrides === effort
            ? chat
            : yield* startChat(api, recorder, dataDir, { ...p, overrides: effort }, { cardTokens: 300 })
        const r =
          p.overrides === effort
            ? t
            : (yield* thinker.say("Hello, Mira. Tell me one thing about the harbor in two sentences."))!
        if (r !== t) checkTurn(f, p, "reply with reasoning effort low", r, used ?? model)
        f.check(
          p.id,
          "reasoning effort sent as configured",
          JSON.stringify(r.exchange?.request ?? {}).includes('"low"'),
          {
            actual: {
              reasoning_effort: r.exchange?.request?.reasoning_effort,
              reasoning: r.exchange?.request?.reasoning
            }
          }
        )
        f.check(p.id, "reasoning tokens reported and counted", (r.row?.counts.reasoning ?? 0) > 0, {
          actual: r.row?.counts,
          ref: ref(r)
        })
        f.check(p.id, "reasoning text shown on the version", (r.version.reasoning ?? "").length > 0, {
          actual: {
            reasoning: (r.version.reasoning ?? "").slice(0, 80),
            requestReasoning: r.exchange?.request?.reasoning ?? r.exchange?.request?.reasoning_effort
          }
        })
        f.check(
          p.id,
          "prompt_cache_key sent (session routing)",
          typeof t.exchange?.request?.prompt_cache_key === "string",
          {
            actual: { prompt_cache_key: t.exchange?.request?.prompt_cache_key ?? null }
          }
        )
        yield* stopMidStream(f, p, chat)
        const buffered = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 100,
          overrides: { settings: { ...p.overrides?.settings, stream: false } }
        })
        yield* nonStreaming(f, p, buffered)
        const bad = yield* startChat(api, recorder, dataDir, { ...p, model: "gpt-no-such-model-9" }, { cardTokens: 50 })
        errorCase(f, p, "unknown model", (yield* bad.say("Hello."))!, ["bad_request"])
        const badKey = yield* startChat(api, recorder, dataDir, p, { cardTokens: 50, apiKey: "sk-invalid-live-check" })
        errorCase(f, p, "bad key", (yield* badKey.say("Hello."))!, ["auth"])
      })
    )

  for (const p of [chatP, respP])
    liveTest(`${p.id}: caching`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        const chat = yield* startChat(api, recorder, dataDir, p)
        yield* growingChat(f, p, chat, yield* modelOf(api, chat))
      })
    )

  for (const p of [chatP, respP])
    liveTest(`${p.id}: schema prefill, continue, agent tools, vision`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        const chat = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 200,
          overrides: { ...noEffort, prefill: "tool_schema", vision: true },
          prefill: "*Mira sets down her pen and says,*"
        })
        const model = yield* modelOf(api, chat)
        const t = (yield* chat.say("Tell me about the fog."))!
        checkTurn(f, p, "schema-prefilled reply", t, model)
        const tools = JSON.stringify(t.exchange?.request?.tools ?? null)
        f.check(p.id, "schema prefill: forced reply tool on the wire", tools.includes("continue_reply"), {
          actual: tools.slice(0, 200)
        })
        f.check(
          p.id,
          "schema prefill: saved reply leaves the prefix out and has text",
          t.version.content.length > 0 && !t.version.content.includes("sets down her pen and says"),
          {
            actual: t.version.content.slice(0, 120),
            ref: ref(t)
          }
        )
        const continued = yield* Effect.result(chat.continueLast)
        if (continued._tag === "Failure")
          f.check(p.id, "continue: the app accepts the reply to continue", false, {
            actual: { refused: String(continued.failure), replyLength: t.version.content.length }
          })
        else {
          const c = continued.success
          checkTurn(f, p, "continue", c, model)
          f.check(
            p.id,
            "continue: text extends the original",
            c.version.content.startsWith(t.version.content.trimEnd()) &&
              c.version.content.length > t.version.content.length,
            {
              actual: { before: t.version.content.length, after: c.version.content.length, error: c.version.error }
            }
          )
        }
        // Vision on a chat of its own: on the prefilled one every reply goes through the schema.
        const vis = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 100,
          overrides: { ...noEffort, vision: true }
        })
        const image = yield* vis.upload(solidPng([220, 20, 20]))
        const v = (yield* vis.say("What colour is the square in this image? Answer with one word.", {
          images: [image]
        }))!
        checkTurn(f, p, "vision", v, model)
        f.check(p.id, "vision: the model sees the synthetic image", /red/i.test(v.version.content), {
          actual: v.version.content.slice(0, 120),
          ref: ref(v)
        })

        const agent = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 200,
          overrides: { ...noEffort, tools: true },
          state: [{ key: "agent.enabled", value: { on: true } }]
        })
        yield* agent.say("Remember this: the copper bell hangs in the chapel.", { reply: false })
        const a = (yield* agent.say(
          "Use the search_chat tool to find what I said about the copper bell, then answer in one sentence."
        ))!
        for (const row of a.rows) f.addSpend(p.id, row, null)
        f.check(
          p.id,
          "agent: tool call, result sent back, final reply",
          a.version.status === "complete" && a.exchanges.length >= 2,
          {
            actual: {
              status: a.version.status,
              error: a.version.error,
              requests: a.exchanges.length,
              http: a.exchanges.map((e) => e.status),
              body: a.exchanges.find((e) => e.status >= 400)?.body.slice(0, 300)
            },
            ref: ref(a)
          }
        )

        // Agent tools with a reasoning effort set: a user's normal combination.
        const both = yield* startChat(api, recorder, dataDir, p, {
          cardTokens: 200,
          overrides: { ...effort, tools: true },
          state: [{ key: "agent.enabled", value: { on: true } }]
        })
        const b = (yield* both.say("Use the search_chat tool to look for the word bell, then answer in one sentence."))!
        for (const row of b.rows) f.addSpend(p.id, row, null)
        f.check(
          p.id,
          "agent tools with reasoning effort low: request accepted, final reply",
          b.version.status === "complete",
          {
            actual: {
              status: b.version.status,
              error: b.version.error,
              http: b.exchanges.map((e) => e.status),
              body: b.exchanges.find((e) => e.status >= 400)?.body.slice(0, 300)
            },
            ref: ref(b)
          }
        )
      })
    )
})
