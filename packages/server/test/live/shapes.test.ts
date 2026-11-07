// Live: prompt shapes that ordinary features and preset settings produce, against each
// family's cheap model. A shape fails when the provider refuses the request (or the reply
// fails); the finding keeps the provider's error and the wire's role sequence.
import { describe } from "@effect/vitest"
import { Effect } from "effect"
import type { HttpServer } from "effect/http"
import { findings, liveEnabled, solidPng, type Exchange } from "./support/live.ts"
import { liveTest, type Profile, ref, startChat } from "./support/scenarios.ts"
import type { Turn, LiveChat, LiveChatOptions } from "./support/live.ts"

const f = findings("shapes")

const profiles: ReadonlyArray<Profile> = [
  {
    id: "anthropic haiku-4.5",
    kind: "anthropic",
    route: "anthropic",
    model: "claude-haiku-4-5",
    dialect: "anthropic",
    cacheTokens: 60
  },
  {
    id: "openai gpt-5.4-nano (chat)",
    kind: "openai-chat",
    route: "openai/v1",
    model: "gpt-5.4-nano",
    dialect: "openai",
    cacheTokens: 60,
    overrides: { settings: { samplers: { openai_max_tokens: 1500 } } }
  },
  {
    id: "openai gpt-5.4-nano (responses)",
    kind: "openai-responses",
    route: "openai/v1",
    model: "gpt-5.4-nano",
    dialect: "responses",
    cacheTokens: 60,
    overrides: { settings: { samplers: { openai_max_tokens: 1500 } } }
  },
  {
    id: "deepseek-flash",
    kind: "deepseek",
    route: "deepseek/v1",
    model: "deepseek-flash",
    dialect: "deepseek",
    cacheTokens: 60
  },
  {
    id: "OR gemini-3.5-flash-lite",
    kind: "openrouter",
    route: "openrouter/v1",
    model: "google/gemini-3.5-flash-lite",
    dialect: "openrouter",
    cacheTokens: 60
  },
  {
    id: "OR claude-haiku-4.5",
    kind: "openrouter",
    route: "openrouter/v1",
    model: "anthropic/claude-haiku-4.5",
    dialect: "openrouter",
    cacheTokens: 60
  },
  {
    id: "google gemini-3.5-flash-lite",
    kind: "google",
    route: "google/v1beta",
    model: "gemini-3.5-flash-lite",
    listed: "gemini-3.5-flash-lite",
    dialect: "google",
    cacheTokens: 60
  }
]

/** The roles of a request as sent: system parameter first when there is one. */
const roles = (e: Exchange | undefined) => {
  const body = e?.request ?? {}
  const list = (body.messages ?? body.input ?? body.contents ?? []) as Array<{
    role?: string
    type?: string
    content?: unknown
    parts?: Array<Record<string, unknown>>
  }>
  const head = body.system
    ? ["system-param"]
    : body.instructions
      ? ["instructions"]
      : body.systemInstruction
        ? ["systemInstruction"]
        : []
  return [
    ...head,
    ...list.map((m) => {
      // Gemini's parts are keyed by kind (text, inlineData, functionCall, functionResponse).
      const geminiParts = m.parts?.map((p) => Object.keys(p).find((k) => k !== "thoughtSignature") ?? "?")
      const parts = Array.isArray(m.content)
        ? (m.content as Array<{ type?: string }>).map((p) => p.type).join("+")
        : (geminiParts?.join("+") ?? "")
      return `${m.role ?? m.type}${parts && parts !== "text" && parts !== "input_text" && parts !== "output_text" ? `(${parts})` : ""}`
    })
  ]
}

const withPrompt = (st: Record<string, unknown>, prompt: Record<string, unknown>, before = "chatHistory") => {
  const order = (st.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>).at(-1)!.order
  const at = order.findIndex((o) => o.identifier === before)
  order.splice(at < 0 ? order.length : at, 0, { identifier: String(prompt.identifier), enabled: true })
  ;(st.prompts as Array<unknown>).push({ system_prompt: false, marker: false, ...prompt })
  return st
}

const record = (p: Profile, shape: string, t: Turn | null) => {
  if (!t) return
  for (const row of t.rows) f.addSpend(p.id, row, t.stored.find((s) => s.id === row.id)?.reportedCost ?? null)
  const failed = t.exchanges.find((e) => e.status >= 400)
  f.check(p.id, `shape: ${shape}`, t.version.status === "complete" && t.version.content.trim().length > 0, {
    actual: {
      status: t.version.status,
      error: t.version.error,
      http: t.exchanges.map((e) => e.status),
      providerError: failed?.body.slice(0, 500),
      roles: roles(failed ?? t.exchange),
      reply: t.version.content.slice(0, 80)
    },
    ref: ref(t)
  })
}

type Shape = {
  readonly name: string
  readonly options?: Partial<LiveChatOptions>
  readonly run: (chat: LiveChat) => Effect.Effect<Turn | null, unknown, HttpServer.HttpServer>
}

const shapes: ReadonlyArray<Shape> = [
  { name: "greeting first (assistant turn before any user turn)", run: (c) => c.say("Hello, Mira.") },
  {
    name: "greeting first, system prompt as the system parameter (use_sysprompt)",
    options: { stPreset: (st) => ({ ...st, use_sysprompt: true }) },
    run: (c) => c.say("Hello, Mira.")
  },
  { name: "no greeting", options: { greeting: null }, run: (c) => c.say("Hello, Mira.") },
  { name: "empty greeting", options: { greeting: "" }, run: (c) => c.say("Hello, Mira.") },
  {
    name: "two user messages in a row",
    run: (c) => Effect.flatMap(c.say("Hello, Mira.", { reply: false }), () => c.say("Are you there?"))
  },
  {
    name: "two character replies in a row (group)",
    options: { characters: ["Corin"] },
    run: (c) =>
      Effect.gen(function* () {
        yield* c.say("Hello, both of you.", { speaker: c.mira.entityId as never })
        return yield* c.reply({ speaker: c.others[0]! })
      })
  },
  {
    name: "user-side impersonation (the model writes the persona's turn)",
    run: (c) => Effect.flatMap(c.say("Hello, Mira."), () => c.reply({ speaker: c.tobin.entityId as never }))
  },
  {
    name: "system-role depth note mid-history (depth 1)",
    options: {
      stPreset: (st) =>
        withPrompt(st, {
          identifier: "depthNote",
          name: "Depth note",
          role: "system",
          content: "[Keep replies under 40 words.]",
          injection_position: 1,
          injection_depth: 1
        })
    },
    run: (c) => Effect.flatMap(c.say("Hello, Mira."), () => c.say("What is on the shelf?"))
  },
  {
    name: "author's-note-like user-role note at depth 2",
    options: {
      stPreset: (st) =>
        withPrompt(st, {
          identifier: "anNote",
          name: "Author's note",
          role: "user",
          content: "[Style: terse.]",
          injection_position: 1,
          injection_depth: 2
        })
    },
    run: (c) => Effect.flatMap(c.say("Hello, Mira."), () => c.say("What is on the shelf?"))
  },
  {
    name: "example messages",
    options: {
      cardFields: {
        mes_example:
          "<START>\n{{user}}: Any news?\n{{char}}: The tide came in early.\n<START>\n{{user}}: And the bell?\n{{char}}: Still silent."
      }
    },
    run: (c) => c.say("Any news tonight?")
  },
  {
    name: "odd ST role order: history first, then a system prompt, then an assistant-role prompt last",
    options: {
      stPreset: (st) => {
        const entry = (st.prompt_order as Array<{ order: Array<{ identifier: string; enabled: boolean }> }>).at(-1)!
        const rest = entry.order.filter((o) => o.identifier !== "chatHistory" && o.identifier !== "jailbreak")
        entry.order = [
          { identifier: "chatHistory", enabled: true },
          ...rest,
          { identifier: "jailbreak", enabled: true }
        ]
        for (const pr of st.prompts as Array<Record<string, unknown>>)
          if (pr.identifier === "jailbreak")
            Object.assign(pr, { role: "assistant", content: "Understood. Continuing the scene." })
        return st
      }
    },
    run: (c) => c.say("Hello, Mira.")
  },
  {
    name: "continue (the model's own capability)",
    run: (c) => Effect.flatMap(c.say("Hello, Mira."), () => c.continueLast)
  },
  {
    name: "trailing assistant prefill (prefill capability set to assistant)",
    options: { overrides: { prefill: "assistant" }, prefill: "*Mira nods.*" },
    run: (c) => c.say("Hello, Mira.")
  },
  {
    name: "image in a user turn",
    options: { overrides: { vision: true } },
    run: (c) =>
      Effect.flatMap(c.upload(solidPng([20, 160, 40])), (image) =>
        c.say("What colour is this square? One word.", { images: [image] })
      )
  },
  {
    name: "agent tool call and result",
    options: { overrides: { tools: true }, state: [{ key: "agent.enabled", value: { on: true } }] },
    run: (c) =>
      Effect.flatMap(c.say("Remember: the bell is copper.", { reply: false }), () =>
        c.say("Use the search_chat tool to find what I said about the bell, then answer in one sentence.")
      )
  }
]

describe.skipIf(!liveEnabled)("live prompt shapes", () => {
  for (const p of profiles)
    liveTest(`${p.id}`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        for (const shape of shapes) {
          const chat = yield* startChat(api, recorder, dataDir, p, {
            ...shape.options,
            overrides: {
              ...p.overrides,
              ...shape.options?.overrides,
              settings: { ...p.overrides?.settings, ...shape.options?.overrides?.settings }
            }
          })
          const t = yield* shape.run(chat).pipe(Effect.orElseSucceed(() => null))
          if (!t) f.check(p.id, `shape: ${shape.name}`, false, { actual: "the app refused before sending" })
          record(p, shape.name, t)
        }
      })
    )

  const argons: ReadonlyArray<Profile> = [
    {
      id: "OR gemini-4-argon",
      kind: "openrouter",
      route: "openrouter/v1",
      model: "google/gemini-4-argon",
      dialect: "openrouter",
      cacheTokens: 60,
      overrides: { settings: { samplers: { openai_max_tokens: 400 } } }
    },
    {
      id: "google gemini-4-argon",
      kind: "google",
      route: "google/v1beta",
      model: "gemini-4-argon",
      listed: "gemini-4-argon",
      dialect: "google",
      cacheTokens: 60,
      overrides: { settings: { samplers: { openai_max_tokens: 1500 } } }
    }
  ]
  for (const p of argons)
    liveTest(`${p.id}: one combined shape`, f, ({ api, recorder, dataDir }) =>
      Effect.gen(function* () {
        const chat = yield* startChat(api, recorder, dataDir, p, {
          characters: ["Corin"],
          stPreset: (st) =>
            withPrompt(st, {
              identifier: "depthNote",
              name: "Depth note",
              role: "system",
              content: "[Keep replies under 40 words.]",
              injection_position: 1,
              injection_depth: 1
            }),
          cardFields: { mes_example: "<START>\n{{user}}: Any news?\n{{char}}: The tide came in early." }
        })
        yield* chat.say("Hello, both.", { reply: false })
        yield* chat.say("Are you there?", { speaker: chat.mira.entityId as never })
        record(
          p,
          "greeting first + two user turns + example messages + system depth note + two character replies in a row",
          yield* chat.reply({ speaker: chat.others[0]! })
        )
      })
    )
})
