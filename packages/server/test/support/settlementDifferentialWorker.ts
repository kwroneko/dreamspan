import type { AppendResult } from "../../src/db/ops.ts"
// Exercise the actual transaction settlement against the frozen scanning statement.
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { isDeepStrictEqual } from "node:util"
import { Cause, Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { NewVersion } from "@rp/shared/chat.ts"
import { defaultBinLimits } from "@rp/shared/bin.ts"
import { readerConnection, writerConnection } from "../../src/db/connection.ts"
import { migrations } from "../../src/db/migrations.ts"
import { trackSummaryTouches, summaryValidSql } from "../../src/db/summaryValidity.ts"
import { installStorageKindValidation } from "../../src/db/storageKinds.ts"
import { makeWriteHandlers } from "../../src/db/writes.ts"
import { makeLibraryWriteHandlers } from "../../src/db/libraryWrites.ts"
import { makeMergeReadHandlers, makeMergeWriteHandlers } from "../../src/db/merges.ts"
import { cardDoc } from "./docs.ts"
import { makeAccountWriteHandlers } from "../../src/db/accounts.ts"
import { makeBin } from "../../src/db/bin.ts"
import { makeBinWriteHandlers } from "../../src/db/binWrites.ts"
import { makeShellReadHandlers } from "../../src/db/shellReads.ts"
import { makeShellWriteHandlers } from "../../src/db/shellWrites.ts"
import { scanningSettlement } from "./scanningSettlement.ts"
import { transaction } from "../../src/db/tx.ts"

const { file, seed, steps } = workerData as { file: string; seed: number; steps: number }
let draws = seed
const random = () => {
  draws = (Math.imul(draws, 1664525) + 1013904223) >>> 0
  return draws / 4294967296
}
const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(random() * items.length)]!
let reference: readonly [string, ReadonlyArray<unknown>]
let comparisons = 0
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query) {
  const statement = prepare.call(this, query)
  if (query.includes("kept(chat_id, stamp) AS MATERIALIZED")) {
    statement.all = new Proxy(statement.all, {
      apply: (target, self, args) => {
        const snapshot = () => ({
          stamps: prepare.call(this, "SELECT * FROM fork_shell_stamps ORDER BY fork_id").all(),
          stored: prepare.call(this, "SELECT * FROM fork_summaries ORDER BY fork_id").all(),
          valid: prepare
            .call(
              this,
              `SELECT fs.fork_id, ${summaryValidSql("fs", "c", "coalesce((SELECT stamp FROM shell_user_stamps WHERE user_id=c.owner_user_id),0)")} AS valid
            FROM fork_summaries fs JOIN chats c ON c.id=fs.chat_id ORDER BY fs.fork_id`
            )
            .all()
        })
        this.exec("SAVEPOINT scanning_reference")
        prepare.call(this, reference[0]).all(...(reference[1] as Array<string | number | null>))
        const expected = snapshot()
        this.exec("ROLLBACK TO scanning_reference; RELEASE scanning_reference")
        const result = Reflect.apply(target, self, args)
        const actual = snapshot()
        if (!isDeepStrictEqual(actual, expected))
          throw new Error(
            `settlement differs at seed ${seed}, comparison ${comparisons}: ${JSON.stringify({ expected, actual })}`
          )
        comparisons++
        return result
      }
    })
  }
  return statement
}

const exit = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    yield* installStorageKindValidation
    yield* trackSummaryTouches(sql)
    reference = scanningSettlement(sql).compile()
    const bin = makeBin(sql, defaultBinLimits)
    const graph = yield* makeWriteHandlers(bin)
    const accounts = yield* makeAccountWriteHandlers
    const library = yield* makeLibraryWriteHandlers(bin)
    const mergeReads = yield* makeMergeReadHandlers
    const merges = yield* makeMergeWriteHandlers(bin)
    const deleted = yield* makeBinWriteHandlers(bin, defaultBinLimits)
    const readShell = (payload: Parameters<Effect.Success<typeof makeShellReadHandlers>["ShellLibrary"]>[0]) =>
      Effect.flatMap(makeShellReadHandlers, (reads) => reads.ShellLibrary(payload)).pipe(
        Effect.provide(readerConnection(file))
      )
    const stores = yield* makeShellWriteHandlers
    const userId = (yield* accounts.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })).id
    const cards = []
    for (const label of ["Aria", "Wren"])
      cards.push(
        (yield* library.CreateEntity({
          userId,
          kind: "card",
          label,
          subtitle: "",
          doc: cardDoc(label),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })).entityId
      )
    const chats = []
    for (let c = 0; c < 3; c++) {
      const chat = yield* graph.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: `Synthetic ${c}`,
        participants: cards,
        greeting: null
      })
      chats.push(chat)
      let parent = null
      for (let n = 0; n < 12; n++) {
        const made: AppendResult = yield* graph.AppendMessage({
          userId,
          chatId: chat.id,
          forkId: chat.currentForkId!,
          parentSlotId: parent,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            speakerEntityId: pick(cards),
            writer: "human",
            content: `Synthetic ${c}:${n}`,
            status: "complete",
            macroMode: "verbatim",
            origin: "user_written"
          })
        })
        parent = made.slotId
      }
    }
    for (let n = 0; n < steps; n++) {
      const chat = pick(chats)
      const forks = yield* sql<{
        id: string
        tip_slot_id: string
      }>`SELECT id, tip_slot_id FROM forks WHERE chat_id=${chat.id} AND deleted_at IS NULL`
      const fork = pick(forks)
      const slots = yield* sql<{
        id: string
        selected_version_id: string
      }>`WITH RECURSIVE path(id) AS (SELECT ${fork.tip_slot_id} UNION ALL SELECT s.parent_slot_id FROM path p JOIN slots s ON s.id=p.id WHERE s.parent_slot_id IS NOT NULL) SELECT s.id,s.selected_version_id FROM path p JOIN slots s ON s.id=p.id WHERE s.purged_at IS NULL`
      const slot = pick(slots)
      switch (n % 8) {
        case 0:
          yield* graph.CreateFork({
            userId,
            chatId: chat.id,
            fromForkId: fork.id as never,
            atSlotId: fork.tip_slot_id as never
          })
          break
        case 1:
          yield* graph.AddVersion({
            userId,
            slotId: slot.id as never,
            forkId: fork.id as never,
            select: random() < 0.5,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: pick(cards),
              writer: "human",
              content: `Swipe ${n}`,
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
          break
        case 2: // A bulk text rewrite touching shared ancestors, preserving stale rows between writes.
          yield* transaction(
            sql,
            "SyntheticRewrite"
          )(
            sql`UPDATE version_texts SET content=content || ${` rewrite ${n}`} WHERE version_seq IN (SELECT v.seq FROM versions v JOIN slots s ON s.id=v.slot_id WHERE s.chat_id=${chat.id})`
          )
          break
        case 3: // Multiple deletions in one transaction must never use a previously stale summary as proof.
          yield* transaction(
            sql,
            "SyntheticMultiDelete"
          )(
            sql`UPDATE versions SET purged_at=${n + 1} WHERE id IN (SELECT v.id FROM versions v JOIN slots s ON s.id=v.slot_id WHERE s.chat_id=${chat.id} AND v.id<>s.selected_version_id AND v.purged_at IS NULL LIMIT 3)`
          )
          break
        case 4:
          if (forks.length > 1 && fork.id !== chat.currentForkId)
            yield* deleted.DeleteFork({ userId, forkId: fork.id as never })
          break
        case 5:
          yield* graph.AppendMessage({
            userId,
            chatId: chat.id,
            forkId: fork.id as never,
            parentSlotId: fork.tip_slot_id as never,
            branch: false,
            commitDraft: null,
            version: new NewVersion({
              speakerEntityId: pick(cards),
              writer: "human",
              content: `Append ${n}`,
              status: "complete",
              macroMode: "verbatim",
              origin: "user_written"
            })
          })
          break
        case 6:
          yield* transaction(sql, "SyntheticTipMove")(sql`UPDATE forks SET tip_slot_id=${slot.id} WHERE id=${fork.id}`)
          break
        case 7: {
          const source = pick(chats.filter((other) => other.id !== chat.id))
          const request = {
            userId,
            chatId: chat.id,
            forkId: fork.id as never,
            at: null,
            source: { chatId: source.id, forkId: source.currentForkId! },
            includeLeftOut: true
          }
          // An already merged random source is a typed no-op. Other failures still fail the model.
          yield* Effect.gen(function* () {
            const preview = yield* mergeReads.PreviewChatMerge(request)
            yield* merges.MergeChat({ ...request, title: `Merge ${n}`, framing: null, digest: preview.digest })
          }).pipe(
            Effect.catchTag("MergeRefused", (error) =>
              error.message.startsWith("Nothing new in") ? Effect.void : Effect.fail(error)
            )
          )
          break
        }
      }
      const cached = yield* readShell({ userId })
      const fresh = yield* readShell({ userId, recompute: true })
      const { fresh: _cached, ...stored } = cached
      const { fresh: _fresh, ...scratch } = fresh
      if (!isDeepStrictEqual(stored, scratch)) throw new Error(`stored summary differs at seed ${seed} step ${n}`)
      if (n % 3 === 0) yield* stores.StoreForkSummaries({ userId, chats: cached.fresh })
    }
  }).pipe(Effect.provide(writerConnection(file)), Effect.scoped, Effect.exit)
)
if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
parentPort!.postMessage({ seed, steps, comparisons })
