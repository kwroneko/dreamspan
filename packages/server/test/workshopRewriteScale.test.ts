import { writeFileSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { composerKey } from "@rp/shared/drafts.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { shownInSql } from "../src/db/forkState.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, testConfig, serverLayer } from "./support/config.ts"
import { fixtureSql, summaryJob } from "./support/lcmFixtures.ts"

it.live("atomically rewrites and renames 5,000 messages and summaries without stalling drafts", () => {
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
    const forkId = chat.currentForkId!
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, workshop.id]
      }
    ])
    const made = yield* Effect.promise(
      () =>
        new Promise<{ versions: number }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/workshopRewriteFixtureWorker.ts", import.meta.url), {
            workerData: { dbPath: databaseFile(config.dataDir), chatId: chat.id, forkId, messages: 5000, branches: 200 }
          })
          let result: { versions: number } | undefined
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
    const summaries: Summary[] = []
    for (let block = 0; block < 100; block++) {
      const inputs = Array.from({ length: 50 }, (_, i) => ({
        slotId: `${chat.id}-s${block * 50 + i}` as never,
        versionId: `${chat.id}-s${block * 50 + i}-v0` as never,
        amendCount: 0
      }))
      const job = yield* summaryJob(config.dataDir, chat.id, inputs[0]!.slotId, inputs.at(-1)!.slotId)
      summaries.push(
        yield* writer.CompleteSummary({
          userId,
          ...job,
          content: `Aria remembers block ${block}.`,
          status: "complete",
          inputs,
          children: []
        })
      )
    }
    const samples: Array<{ operation: string; publicationMs: number; draftMs: number }> = []
    const chunks: number[] = []
    const observe = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const other = yield* writer
          .CreateChat({
            userId,
            kind: "rp",
            status: "active",
            title: "Concurrent draft",
            participants: [],
            greeting: null
          })
          .pipe(Effect.orDie)
        const start = performance.now()
        let finished = start
        const pending = yield* Effect.forkScoped(
          effect.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                finished = performance.now()
              })
            )
          )
        )
        yield* Effect.sleep(5)
        const draftStart = performance.now()
        const draft = yield* writer
          .SaveDraft({
            userId,
            key: composerKey(other.id, other.currentForkId),
            draftId: null,
            content: "Typed while the story changed",
            expectedRowVersion: null,
            expectedSession: null,
            baseRevision: null
          })
          .pipe(Effect.orDie)
        const draftMs = performance.now() - draftStart
        const result = yield* Fiber.join(pending)
        const publicationMs = finished - start
        assert.strictEqual(draft.content, "Typed while the story changed")
        assert.isBelow(publicationMs, 1500, `${operation} publication holds the writer too long`)
        assert.isBelow(draftMs, 1500, `${operation} delayed another chat's draft`)
        samples.push({ operation, publicationMs, draftMs })
        return result
      }).pipe(Effect.scoped)
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
      writer: {
        ...writer,
        PrepareHistoryEdits: (input, options) =>
          Effect.suspend(() => {
            const start = performance.now()
            return writer.PrepareHistoryEdits(input, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  chunks.push(performance.now() - start)
                })
              )
            )
          }),
        ApplyAgentChangeset: (input, options) =>
          observe("ApplyAgentChangeset", writer.ApplyAgentChangeset(input, options))
      },
      cache: new Map()
    }
    const counts = (fork = forkId) =>
      Effect.gen(function* () {
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: `SELECT sum(v.content GLOB 'Aria *') AS original,sum(v.content GLOB 'Ari *') AS edited
        FROM forks f JOIN slots s ON s.chat_id=f.chat_id JOIN version_records v ON v.id=${shownInSql("f.id", "s")} WHERE f.id=?`,
              params: [fork]
            }
          ],
          { readOnly: true }
        )
        return rows![0]!
      })
    const assertOriginal = () =>
      Effect.gen(function* () {
        assert.strictEqual((yield* counts()).original, 5000)
        assert.strictEqual((yield* counts(`${chat.id}-f1` as never)).original, 5000)
        for (const summary of summaries)
          assert.isTrue((yield* reader.GetSummary({ userId, forkId, summaryId: summary.id })).fresh)
      })
    const undo = () =>
      Effect.gen(function* () {
        const effect = (yield* api.ListRolloutEffects({ chatId: workshop.id }))[0]!
        yield* observe(
          "UndoRolloutEffect",
          writer.UndoRolloutEffect({
            userId,
            rolloutId: effect.rolloutId,
            toolCallId: effect.toolCallId,
            seq: effect.seq
          })
        )
        yield* assertOriginal()
      })
    const start = performance.now()
    const rewritten = yield* toolForKind(registry, "workshop", "rewrite_messages")!.execute(context, {
      chat: chat.id,
      title: "Rewrite the whole story",
      messages: Array.from({ length: 5000 }, (_, n) => ({ message: n + 1, text: `Ari in garden ${n}, swipe 0.` }))
    } as never)
    const rewriteMs = performance.now() - start
    assert.isUndefined(rewritten.isError, rewritten.text)
    assert.strictEqual(JSON.parse(rewritten.text).messages, 5000)
    assert.strictEqual((yield* counts()).edited, 5000)
    assert.strictEqual((yield* counts(`${chat.id}-f1` as never)).original, 5000)
    assert.isFalse((yield* reader.GetSummary({ userId, forkId, summaryId: summaries[0]!.id })).fresh)
    yield* undo()
    // Off during preparation must still refuse the final publication, with no story rows.
    let revoked = false
    const refused = yield* toolForKind(registry, "workshop", "rewrite_chat")!.execute(
      {
        ...context,
        toolCallId: "revoked",
        cache: new Map(),
        writer: {
          ...writer,
          PrepareHistoryEdits: (input, options) =>
            writer.PrepareHistoryEdits(input, options).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (!revoked) {
                    revoked = true
                    yield* writer
                      .SetWorkshopGrant({ userId, chatId: workshop.id, capability: "chats.rewrite", mode: "off" })
                      .pipe(Effect.orDie)
                  }
                })
              )
            )
        }
      },
      { chat: chat.id, title: "Must not apply", pairs: [{ find: "Aria", replace: "Ari", in: ["messages"] }] } as never
    )
    assert.isTrue(refused.isError, refused.text)
    assert.include(refused.text, "turned off")
    yield* assertOriginal()
    yield* writer.SetWorkshopGrant({ userId, chatId: workshop.id, capability: "chats.rewrite", mode: "allow" })
    const renameStart = performance.now()
    const renamed = yield* toolForKind(registry, "workshop", "rewrite_chat")!.execute(
      { ...context, toolCallId: "rename", cache: new Map() },
      {
        chat: chat.id,
        title: "Rename across the story and summaries",
        pairs: [{ find: "Aria", replace: "Ari", in: ["messages", "summaries"] }]
      } as never
    )
    const renameMs = performance.now() - renameStart
    assert.isUndefined(renamed.isError, renamed.text)
    assert.strictEqual(JSON.parse(renamed.text).messages, 5000)
    assert.strictEqual(JSON.parse(renamed.text).summaries, 100)
    assert.strictEqual((yield* counts()).edited, 5000)
    const freshnessStart = performance.now()
    for (const summary of summaries) {
      const current = yield* reader.GetSummary({ userId, forkId, summaryId: summary.id })
      assert.isTrue(current.fresh)
      assert.include(current.content!, "Ari remembers")
    }
    const freshnessMs = performance.now() - freshnessStart
    const [swipe] = yield* fixtureSql(
      config.dataDir,
      [{ sql: "SELECT content FROM version_records WHERE id=?", params: [`${chat.id}-s0-v1`] }],
      { readOnly: true }
    )
    assert.strictEqual(swipe![0]!.content, "Aria in garden 0, swipe 1.")
    yield* undo()
    assert.isTrue(chunks.length >= 20)
    assert.isBelow(Math.max(...chunks), 1500)
    const metrics = {
      messages: 5000,
      branches: 200,
      swipes: "20–50",
      summaries: 100,
      rewriteMs,
      renameMs,
      freshnessMs,
      maxPreparationMs: Math.max(...chunks),
      samples
    }
    if (process.env.WORKSHOP_REWRITE_SCALE_OUTPUT)
      writeFileSync(process.env.WORKSHOP_REWRITE_SCALE_OUTPUT, JSON.stringify(metrics, null, 2) + "\n")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
