import { writeFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, testConfig, serverLayer } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

it.live("bounds atomic rewrites on 5,000 messages with 200 branches and 20–50 swipes", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const userId = (yield* api.Whoami()).id
    const writer = yield* Writer
    const reader = yield* Reader
    const registry = yield* ExecutionRegistry
    const workshop = yield* api.CreateWorkshop({})
    const rolloutId = `scale-${workshop.id}`
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Large synthetic story",
      participants: [],
      greeting: null
    })
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, workshop.id]
      }
    ])
    const made = yield* Effect.promise(
      () =>
        new Promise<{ versions: number; messages: number; branches: number }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/workshopRewriteFixtureWorker.ts", import.meta.url), {
            workerData: {
              dbPath: databaseFile(config.dataDir),
              chatId: chat.id,
              forkId: chat.currentForkId,
              messages: 5000,
              branches: 200
            }
          })
          let result: { versions: number; messages: number; branches: number } | undefined
          worker.once("message", (value) => {
            result = value
          })
          worker.once("error", reject)
          worker.once("exit", (code) =>
            code === 0 && result ? resolve(result) : reject(new Error(`fixture exited ${code}`))
          )
        })
    )
    assert.isAbove(made.versions, 170000)
    const context: ToolContext = {
      userId,
      chatId: workshop.id,
      forkId: workshop.currentForkId,
      slotId: workshop.activeLeafSlotId!,
      versionId: "unused" as never,
      rolloutId,
      toolCallId: "rewrite",
      leafSlotId: workshop.activeLeafSlotId,
      reader,
      writer,
      cache: new Map()
    }
    const started = performance.now()
    const proof = yield* reader.AgentHistorySnapshot({ userId, chatId: chat.id, forkId: chat.currentForkId! })
    assert.isBelow(proof.stamp.length, 1500000)
    const snapshotMs = performance.now() - started
    const rewriteStarted = performance.now()
    const refused = yield* toolForKind(registry, "workshop", "rewrite_chat")!.execute(context, {
      chat: chat.id,
      title: "Large rename",
      pairs: [{ find: "Aria", replace: "Ari", in: ["messages"] }]
    } as never)
    assert.isTrue(refused.isError, refused.text)
    assert.include(refused.text, "32")
    const refusalMs = performance.now() - rewriteStarted
    const boundedStarted = performance.now()
    const result = yield* toolForKind(registry, "workshop", "rewrite_messages")!.execute(context, {
      chat: chat.id,
      title: "Bounded rename",
      messages: Array.from({ length: 32 }, (_, n) => ({ message: n + 1, text: `Ari in garden ${n}, swipe 0.` }))
    } as never)
    assert.isUndefined(result.isError, result.text)
    assert.strictEqual(JSON.parse(result.text).messages, 32)
    const rewriteMs = performance.now() - boundedStarted
    assert.isBelow(snapshotMs, 10000)
    assert.isBelow(rewriteMs, 5000)
    const [untouched] = yield* fixtureSql(
      config.dataDir,
      [{ sql: "SELECT content FROM version_records WHERE id=?", params: [`${chat.id}-s0-v1`] }],
      { readOnly: true }
    )
    assert.strictEqual(untouched![0]!.content, "Aria in garden 0, swipe 1.")
    const tail = yield* reader.GetPath({
      userId,
      chatId: chat.id,
      forkId: chat.currentForkId,
      leafSlotId: null,
      limit: 10
    })
    assert.isTrue(tail.entries.every((e) => e.version.content.startsWith("Aria ")))
    const sibling = yield* reader.GetPath({
      userId,
      chatId: chat.id,
      forkId: `${chat.id}-f1` as never,
      leafSlotId: null,
      limit: 10
    })
    assert.isTrue(sibling.entries.every((e) => e.version.content.startsWith("Aria ")))
    const effects = yield* api.ListRolloutEffects({ chatId: workshop.id })
    const undoStarted = performance.now()
    yield* api.UndoRolloutEffect(effects[0]!)
    const undoMs = performance.now() - undoStarted
    const path = yield* reader.GetPath({
      userId,
      chatId: chat.id,
      forkId: chat.currentForkId,
      leafSlotId: null,
      limit: 10
    })
    assert.isTrue(path.entries.every((e) => e.version.content.startsWith("Aria ")))
    const metrics = { messages: 5000, branches: 200, swipes: "20–50", snapshotMs, refusalMs, rewriteMs, undoMs }
    console.log(JSON.stringify(metrics))
    if (process.env.WORKSHOP_REWRITE_SCALE_OUTPUT)
      writeFileSync(process.env.WORKSHOP_REWRITE_SCALE_OUTPUT, JSON.stringify(metrics, null, 2) + "\n")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
