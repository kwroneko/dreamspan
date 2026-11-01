// Who wrote each imported version, and how long it took (msgmeta, owner 2026-11-01): ST's
// per-message and per-swipe `extra.api`/`extra.model`, `gen_started`/`gen_finished` and
// `extra.token_count`, through the real upload, on synthetic JSONL only. The fields are as
// ST 1.19 writes them (public/script.js `saveReply`, `syncMesToSwipe`, the streaming
// processor's swipe_info, a Continue's moved `gen_started`).
import { assert, layer } from "@effect/vitest"
import type { Version } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const config = testConfig()
const iso = (minute: number, second = 0) => new Date(Date.UTC(2025, 2, 1, 9, minute, second)).toISOString()

// A swipe's record as ST keeps it in swipe_info: its dates and a copy of the message's extra.
const generated = (minute: number, seconds: number, extra: Record<string, unknown>) => ({
  send_date: iso(minute, seconds),
  gen_started: iso(minute),
  gen_finished: iso(minute, seconds),
  extra
})

const userTurn = {
  name: "Sam",
  is_user: true,
  is_system: false,
  send_date: iso(0),
  mes: "Hello there.",
  // ST counts a user's message too, with its token counter on.
  extra: { token_count: 4 }
}

// Two swipes by different models, the second shown: the message's own fields are the shown one's.
const openrouterSwipe = generated(1, 12, {
  api: "openrouter",
  model: "anthropic/claude-3.5-sonnet",
  token_count: 380,
  time_to_first_token: 900
})
const claudeSwipe = generated(2, 8, {
  api: "claude",
  model: "claude-3-opus-20240229",
  token_count: 214,
  reasoning: "Synthetic thinking.",
  reasoning_duration: 3100
})
const swiped = {
  name: "Alice",
  is_user: false,
  is_system: false,
  mes: "Second swipe.",
  send_date: claudeSwipe.send_date,
  gen_started: claudeSwipe.gen_started,
  gen_finished: claudeSwipe.gen_finished,
  extra: claudeSwipe.extra,
  swipe_id: 1,
  swipes: ["First swipe.", "Second swipe."],
  swipe_info: [openrouterSwipe, claudeSwipe]
}

// Continued with another model: ST rewrote the message's api and model, and moved
// gen_started back by the 10 s the first part took, so the span covers both parts.
const continued = {
  name: "Alice",
  is_user: false,
  is_system: false,
  mes: "Started, and continued.",
  send_date: iso(5, 30),
  gen_started: iso(4, 50),
  gen_finished: iso(5, 30),
  extra: { api: "deepseek", model: "deepseek-chat", token_count: 51 },
  swipe_id: 0,
  swipes: ["Started, and continued."],
  swipe_info: [generated(4, 10, { api: "openai", model: "gpt-4o", token_count: 20 })]
}

// Swipes generated together (n > 1): ST drops the token count from their swipe_info.
const together = {
  name: "Alice",
  is_user: false,
  is_system: false,
  mes: "One of two.",
  send_date: iso(7, 4),
  gen_started: iso(7),
  gen_finished: iso(7, 4),
  extra: { api: "makersuite", model: "gemini-2.5-pro", token_count: 33 },
  swipe_id: 0,
  swipes: ["One of two.", "Two of two."],
  swipe_info: [
    generated(7, 4, { api: "makersuite", model: "gemini-2.5-pro", token_count: 33 }),
    generated(7, 4, { api: "makersuite", model: "gemini-2.5-pro" })
  ]
}

// Garbage where ST writes figures: none of it is kept, and the text still imports.
const odd = {
  name: "Alice",
  is_user: false,
  is_system: false,
  mes: "Odd figures.",
  send_date: iso(9),
  gen_started: iso(9, 30),
  gen_finished: iso(9),
  extra: { api: "", model: 42, token_count: -3, time_to_first_token: "soon" }
}

const folder = new Map([
  ["characters/Alice.png", card("Alice", "Synthetic greeting.")],
  ["chats/Alice/models.jsonl", jsonl([header({}), userTurn, swiped, continued, together, odd])]
])

const plain = (version: Version) => ({
  content: version.content,
  model: version.model,
  modelRef: version.modelRef,
  recorded: version.recorded
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("ST models and figures", (it) => {
  it.effect("imports each swipe's model, times and token count, and a re-import keeps them once", () =>
    Effect.gen(function* () {
      const { api } = yield* importStFolder(folder)
      const chat = (yield* api.ListChats({ limit: 100, before: null })).find((c) => c.title === "models")!
      const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 })
      const entries = path.entries
      assert.lengthOf(entries, 5)
      const versionsAt = (i: number) => api.ListVersions({ slotId: entries[i]!.slotId })

      // The user's turn: its time and ST's count, no model.
      assert.deepStrictEqual(plain(entries[0]!.version), {
        content: "Hello there.",
        model: null,
        modelRef: undefined,
        recorded: { tokens: 4 }
      })
      assert.strictEqual(entries[0]!.version.createdAt, Date.parse(iso(0)))

      // Each swipe has its own model and figures; the shown one is the message's.
      assert.deepStrictEqual((yield* versionsAt(1)).map(plain), [
        {
          content: "First swipe.",
          model: "OpenRouter · anthropic/claude-3.5-sonnet",
          modelRef: { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
          recorded: {
            startedAt: Date.parse(iso(1)),
            finishedAt: Date.parse(iso(1, 12)),
            tokens: 380,
            firstTokenMs: 900
          }
        },
        {
          content: "Second swipe.",
          model: "Anthropic · claude-3-opus-20240229",
          modelRef: { provider: "claude", model: "claude-3-opus-20240229" },
          recorded: {
            startedAt: Date.parse(iso(2)),
            finishedAt: Date.parse(iso(2, 8)),
            tokens: 214,
            reasoningMs: 3100
          }
        }
      ])
      assert.strictEqual(entries[1]!.version.model, "Anthropic · claude-3-opus-20240229")
      assert.strictEqual(entries[1]!.version.createdAt, Date.parse(iso(2, 8)))

      // A Continue: the model that finished it, over the whole span.
      assert.deepStrictEqual(plain(entries[2]!.version), {
        content: "Started, and continued.",
        model: "DeepSeek · deepseek-chat",
        modelRef: { provider: "deepseek", model: "deepseek-chat" },
        recorded: { startedAt: Date.parse(iso(4, 50)), finishedAt: Date.parse(iso(5, 30)), tokens: 51 }
      })

      // Swipes made together: the second has no count, as ST left it.
      assert.deepStrictEqual(
        (yield* versionsAt(3)).map((v) => v.recorded?.tokens ?? null),
        [33, null]
      )
      assert.strictEqual((yield* versionsAt(3))[1]!.model, "Google AI Studio · gemini-2.5-pro")

      // Nonsense figures are dropped: a finish before its start, an empty API, a negative count.
      assert.deepStrictEqual(plain(entries[4]!.version), {
        content: "Odd figures.",
        model: null,
        modelRef: undefined,
        recorded: undefined
      })

      // The same folder again: nothing new, and the versions read the same.
      const before = yield* Effect.forEach([0, 1, 2, 3, 4], (i) => versionsAt(i))
      const again = yield* importStFolder(folder, { partBytes: 2048 })
      assert.strictEqual(again.report.counts.chat?.unchanged, 1)
      const after = yield* Effect.forEach([0, 1, 2, 3, 4], (i) => versionsAt(i))
      assert.deepStrictEqual(
        after.map((versions) => versions.map((v) => ({ id: v.id, ...plain(v) }))),
        before.map((versions) => versions.map((v) => ({ id: v.id, ...plain(v) })))
      )
    })
  )
})
