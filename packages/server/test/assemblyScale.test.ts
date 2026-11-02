import { countTokens, type LocalEncoding } from "../src/importer/tokenizer.ts"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
// Context assembly on long chats (ARCHITECTURE.md §15): the next request over 1,000 and then
// 4,000 more synthetic messages, all within the model's context, so every one of them is
// read, scripted, composed and sent. Linear work grows about fourfold; a step that is
// quadratic in the history (as building the images' lookup once per request message was)
// grows sixteenfold. Opt-in (`ASSEMBLY_SCALE=1`), as timing on the shared host is noisy:
// it prints the medians and the ratio.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import type { ChatId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Reader } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const config = testConfig({ dbReaders: 2 })

const median = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

/** Appends `n` messages after the fork's tip, alternating sides, and moves the tip to the last. */
const append = (chatId: string, forkId: string, tip: string, from: number, n: number) =>
  fixtureSql(config.dataDir, [
    {
      sql: `WITH RECURSIVE n(x) AS (SELECT ${from} UNION ALL SELECT x+1 FROM n WHERE x < ${from + n - 1})
        INSERT INTO versions(id,slot_id,ordinal,status,speaker_entity_id,writer,content,macro_mode,origin,created_at,updated_at)
        SELECT ?||'-v'||x, ?||'-s'||x, 0, 'complete', NULL, CASE WHEN x % 2 = 0 THEN 'human' ELSE 'model' END,
          'Aria walks the garden path, line '||x||'.', 'verbatim', CASE WHEN x % 2 = 0 THEN 'user_written' ELSE 'generated' END, 1, 1 FROM n`,
      params: [chatId, chatId]
    },
    {
      sql: `WITH RECURSIVE n(x) AS (SELECT ${from} UNION ALL SELECT x+1 FROM n WHERE x < ${from + n - 1})
        INSERT INTO slots(id,chat_id,lane_id,parent_slot_id,depth,selected_version_id,created_at,fork_id)
        SELECT ?||'-s'||x, ?, (SELECT lane_id FROM slots WHERE id = ?),
          CASE WHEN x = ${from} THEN ? ELSE ?||'-s'||(x-1) END,
          (SELECT depth FROM slots WHERE id = ?) + 1 + x - ${from}, ?||'-v'||x, 1, ? FROM n`,
      params: [chatId, chatId, tip, tip, chatId, tip, chatId, forkId]
    },
    { sql: "UPDATE forks SET tip_slot_id=? WHERE id=?", params: [`${chatId}-s${from + n - 1}`, forkId] }
  ])

const measure = Effect.gen(function* () {
  const api = yield* client()
  const reader = yield* Reader
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() => startMockProvider((_request, res) => sse(res, completionChunks(["Seen."], {})))),
    (m) => Effect.promise(() => m.close())
  )
  const generated = yield* generateReply(api, {
    connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
    model: { context: 1_000_000 },
    preset: { openai_max_context: 1_000_000 }
  })
  const chatId = generated.chat.id as ChatId
  const forkId = generated.chat.currentForkId!
  const userId = (yield* api.Whoami()).id as UserId
  // Summarization off: every message is sent as written, as on a long imported chat.
  yield* api.SetLcmEnabled({ chatId, forkId, enabled: false })
  const tip = generated.events.findLast((e) => e._tag === "Slot")
  assert.isDefined(tip)
  const leaf = tip._tag === "Slot" ? tip.entry.slotId : ""
  const time = Effect.gen(function* () {
    const runs: Array<number> = []
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      const next = yield* reader.CacheWarmth({ userId, chatId })
      runs.push(performance.now() - start)
      assert.isNull(next.assemblyError ?? null)
    }
    return median(runs)
  })
  yield* append(chatId, forkId, leaf, 0, 1000)
  const small = yield* time
  yield* append(chatId, forkId, `${chatId}-s999`, 1000, 4000)
  const large = yield* time
  // Every message is in the request: nothing was cut by the budget.
  const next = yield* reader.CacheWarmth({ userId, chatId })
  assert.isAtMost(next.historyStart?.depth ?? 0, 1)
  process.stdout.write(
    `next context display: 1,000 messages ${small.toFixed(0)} ms, 5,000 messages ${large.toFixed(0)} ms, ratio ${(large / small).toFixed(1)}\n`
  )
  // Measure the unchanged budget assembly itself, then the minimum extra work of replacing
  // its character estimate with tokenization. Budgeting fragments repeatedly would cost more.
  const rawTimes: Array<number> = []
  let texts: ReadonlyArray<string> = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    const result = yield* reader.AssembleContext({
      userId,
      chatId,
      slotId: `${chatId}-s4999` as SlotId,
      versionId: `${chatId}-v4999` as VersionId,
      now: Date.now(),
      timeZone: "UTC",
      frozen: null
    })
    rawTimes.push(performance.now() - start)
    texts = (
      JSON.parse(result.snapshot) as { request: { messages: Array<{ content: string; name?: string }> } }
    ).request.messages.map((m) => m.content + (m.name ?? ""))
  }
  const raw = median(rawTimes)
  process.stdout.write(`budget assembly: 5,000 messages ${raw.toFixed(0)} ms\n`)
  for (const encoding of [
    "o200k_base",
    "llama3",
    "mistral-v3",
    "qwen2",
    "qwen3",
    "deepseek-v3",
    "deepseek-v4",
    "gemma2"
  ] satisfies Array<LocalEncoding>) {
    yield* Effect.promise(() => countTokens(encoding, ["warm"]))
    const times: Array<number> = []
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      yield* Effect.promise(() => countTokens(encoding, texts))
      times.push(performance.now() - start)
    }
    const overhead = median(times)
    process.stdout.write(
      `${encoding}: extra ${overhead.toFixed(0)} ms, minimum budget overhead ${((100 * overhead) / raw).toFixed(1)}%\n`
    )
  }
  assert.isBelow(large / small, 10)
}).pipe(Effect.scoped, Effect.provide(serverLayer(config)))

if (process.env.ASSEMBLY_SCALE === "1")
  it.live("the next request over 1,000 and 5,000 messages", () => measure, 30 * 60_000)
else it.skip("the next request over 1,000 and 5,000 messages (ASSEMBLY_SCALE=1)", () => {})
