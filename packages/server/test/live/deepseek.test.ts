// Live: DeepSeek, through the app's provider code.
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import { findings, type LiveChat, liveEnabled, solidPng } from "./support/live.ts"
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

const f = findings("deepseek")

const p: Profile = {
  id: "deepseek",
  kind: "deepseek",
  route: "deepseek/v1",
  model: "deepseek-flash",
  dialect: "deepseek",
  cacheTokens: 1500,
  ttlUnknown: true,
  documented: { input: 0.3, output: 1.2, cacheRead: 0.006 }
}

/** The chat's model as listed now (after any refresh). */
const modelOf = (api: Parameters<Parameters<typeof liveTest>[2]>[0]["api"], chat: LiveChat) =>
  api
    .ListModels({ connectionId: chat.connection.id, includeHidden: true })
    .pipe(Effect.map((m) => m.find((x) => x.id === chat.model.id) ?? null))

describe.skipIf(!liveEnabled)("live DeepSeek", () => {
  liveTest("basics, caching", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const chat = yield* startChat(api, recorder, dataDir, p)
      yield* checkModels(f, p, api, chat, { listed: "acme.deepseek-flash" })
      const model = yield* modelOf(api, chat)
      yield* growingChat(f, p, chat, model)
      const small = yield* startChat(api, recorder, dataDir, p, { cardTokens: 200 })
      const t = (yield* small.say("Hello, Mira. Two sentences about the harbor, please."))!
      checkTurn(f, p, "basic reply", t, model)
      streaming(f, p, t, small.events)
      yield* stopMidStream(f, p, small)
      const bad = yield* startChat(
        api,
        recorder,
        dataDir,
        { ...p, model: "deepseek-no-such-model" },
        { cardTokens: 50 }
      )
      errorCase(f, p, "unknown model", (yield* bad.say("Hello."))!, ["bad_request"])
      const badKey = yield* startChat(api, recorder, dataDir, p, { cardTokens: 50, apiKey: "sk-invalid-live-check" })
      errorCase(f, p, "bad key", (yield* badKey.say("Hello."))!, ["auth"])
    })
  )

  liveTest("reasoning_content, agent tools with reasoning, continue, vision", f, ({ api, recorder, dataDir }) =>
    Effect.gen(function* () {
      const thinking = { settings: { samplers: { reasoning_effort: "high", openai_max_tokens: 1500 } } }
      const chat = yield* startChat(api, recorder, dataDir, p, { cardTokens: 200, overrides: thinking })
      const model = yield* modelOf(api, chat)
      const t = (yield* chat.say("Think it over, then answer briefly: which entry mentions a bell?"))!
      checkTurn(f, p, "thinking reply", t, model)
      f.check(
        p.id,
        "thinking requested on the wire",
        JSON.stringify(t.exchange?.request ?? {}).match(/thinking|reasoning_effort/) !== null,
        {
          actual: { thinking: t.exchange?.request?.thinking, reasoning_effort: t.exchange?.request?.reasoning_effort }
        }
      )
      f.check(p.id, "reasoning_content shown and stored", (t.version.reasoning ?? "").length > 0, {
        actual: {
          reasoning: (t.version.reasoning ?? "").slice(0, 80),
          wire: t.exchange?.body.includes('"reasoning_content":"')
        }
      })
      f.check(p.id, "reasoning tokens counted", (t.row?.counts.reasoning ?? 0) > 0, { actual: t.row?.counts })
      const t2 = (yield* chat.say("And a lantern?"))!
      checkTurn(f, p, "thinking turn 2", t2, model)
      const c = yield* chat.continueLast
      checkTurn(f, p, "continue (nudge: no /beta prefix route)", c, model)
      f.check(
        p.id,
        "continue: text extends the original",
        c.version.content.startsWith(t2.version.content.trimEnd()) &&
          c.version.content.length > t2.version.content.length,
        {
          actual: { before: t2.version.content.length, after: c.version.content.length, error: c.version.error }
        }
      )
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
      const second = JSON.stringify(a.exchanges[1]?.request ?? {})
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
      f.check(
        p.id,
        "agent with thinking: reasoning_content sent back with the tool call",
        second.includes("reasoning_content"),
        {
          actual: second.slice(0, 200)
        }
      )
      const vis = yield* startChat(api, recorder, dataDir, p, { cardTokens: 100, overrides: { vision: true } })
      const image = yield* vis.upload(solidPng([220, 20, 20]))
      const v = (yield* vis.say("What colour is the square in this image? Answer with one word.", { images: [image] }))!
      checkTurn(f, p, "vision", v, model)
      f.check(p.id, "vision: the model sees the synthetic image", /red/i.test(v.version.content), {
        actual: { text: v.version.content.slice(0, 120), error: v.version.error },
        ref: ref(v)
      })
    })
  )

  liveTest("prefill (needs a /beta route)", f, () =>
    Effect.sync(() => {
      f.check(p.id, "assistant prefill through /beta", null, {
        actual: "blocked: no /deepseek/beta route (404)"
      })
    })
  )
})
