// LCM over inserted messages (spec/MESSAGE-INSERT.md §3.4, unit 7), through the real writer and
// the reader's code on a read-only connection. An insertion inside a summary's range makes it
// stale in the fork that shows it and nowhere else, and the next reply's plan writes it again
// over the display range, the inserted message included. At a seam the earlier summary covers
// the gap, stale, so the layer keeps the later ones; directly after the cursor an insertion is
// raw. A job claimed before an insertion completes with its inputs. A summary that includes an
// inserted message is ignored in a fork that doesn't show it. A random oracle checks validity,
// freshness, positions and the layer's continuity in every fork against first principles.
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathPieces } from "../src/db/displayPath.ts"
import { inFork } from "../src/db/forkState.ts"
import { pathView } from "../src/db/lcmDisplay.ts"
import { lineageValidator, selectSummaryLayer } from "../src/db/lcmLayer.ts"
import { maintain } from "../src/db/lcmMaintain.ts"
import { readSummary } from "../src/db/lcmReads.ts"
import { defaultMaintenancePlanner } from "../src/lcm/planning.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const said = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "model",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "generated"
  })

const setup = (dataDir: string) =>
  Effect.gen(function* () {
    const writer = yield* Database.Writer
    const reader = yield* Database.Reader
    const userId = (yield* writer.EnsureUser({ handle: "ana", displayName: "Ana" })).id as UserId
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [],
      greeting: null
    })
    const chatId = chat.id as ChatId
    const main = chat.currentForkId! as ForkId
    const tip = (forkId: ForkId) =>
      Effect.map(
        fixtureSql(dataDir, [{ sql: "SELECT tip_slot_id AS tip FROM forks WHERE id = ?", params: [forkId] }], {
          readOnly: true
        }),
        ([rows]) => (rows![0] as { tip: SlotId | null }).tip
      )
    const append = (forkId: ForkId, content: string) =>
      Effect.gen(function* () {
        const parent = yield* tip(forkId)
        return (yield* writer.AppendMessage({
          userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch: false,
          version: said(content),
          commitDraft: null
        })).slotId
      })
    const insert = (forkId: ForkId, anchor: SlotId | null, content: string) =>
      Effect.gen(function* () {
        const expected =
          anchor === null ? 0 : (yield* reader.GetSlot({ userId, slotId: anchor, forkId })).entry.rowVersion
        return (yield* writer.InsertMessage({
          userId,
          chatId,
          forkId,
          anchorSlotId: anchor,
          expectedRowVersion: expected,
          body: { _tag: "Write", speaker: null, content }
        })).slotId
      })
    const fork = (from: ForkId, at: SlotId | null) =>
      Effect.map(writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }), (made) => made.fork.id)

    /** A read on its own read-only connection, in fork `forkId` (ForkView). */
    const read = <A, E>(forkId: ForkId, run: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, never>) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* run(sql).pipe(inFork(sql, chatId, forkId, null))
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
    /** The slots `forkId` shows, in order, and those of them it splices in (its inserted pieces). */
    const pieces = (forkId: ForkId) =>
      Effect.gen(function* () {
        const at = yield* tip(forkId)
        return yield* read(forkId, (sql) =>
          Effect.gen(function* () {
            const ids: Array<SlotId> = []
            const spliced = new Set<SlotId>()
            for (const piece of yield* pathPieces(sql, chatId, forkId, at))
              if (piece.kind === "inserted") {
                ids.push(piece.slotId as SlotId)
                spliced.add(piece.slotId as SlotId)
              } else
                ids.push(
                  ...(yield* sql<{ id: SlotId }>`SELECT id FROM slots WHERE chain_id = ${piece.chainId}
                    AND depth BETWEEN ${piece.lo} AND ${piece.hi} ORDER BY depth`).map((r) => r.id)
                )
            return { ids, spliced }
          })
        )
      })
    const display = (forkId: ForkId) => Effect.map(pieces(forkId), (shown) => shown.ids)

    /** A processing job and running rollout in `forkId`, as a claim leaves them. */
    const job = (forkId: ForkId, first: SlotId, last: SlotId, children: ReadonlyArray<Summary> = []) =>
      Effect.gen(function* () {
        const jobId = uuidv7(),
          rolloutId = uuidv7()
        const level = children.length ? Math.max(...children.map((s) => s.level)) + 1 : 1
        yield* fixtureSql(dataDir, [
          {
            sql: "INSERT INTO summarization_jobs(id,chat_id,fork_id,level,first_slot_id,last_slot_id,status,target_token_count,input_child_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,'processing',600,?,1,1)",
            params: [
              jobId,
              chatId,
              forkId,
              level,
              first,
              last,
              children.length ? JSON.stringify(children.map((s) => s.id)) : null
            ]
          },
          {
            sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES(?,?,?,'running','summarizer','background',1,1)",
            params: [rolloutId, chatId, level === 1 ? "summarize" : "condense"]
          }
        ])
        return { jobId, rolloutId }
      })
    const inputsOf = (forkId: ForkId, slots: ReadonlyArray<SlotId>) =>
      Effect.forEach(slots, (slotId) =>
        Effect.map(reader.GetSlot({ userId, slotId, forkId }), ({ entry }) => ({
          slotId,
          versionId: entry.version.id,
          amendCount: 0
        }))
      )
    const complete = (
      claimed: { jobId: string; rolloutId: string },
      inputs: Summary["inputs"],
      children: ReadonlyArray<Summary> = []
    ) =>
      writer.CompleteSummary({
        userId,
        ...claimed,
        content: `summary of ${children.length ? children.map((c) => c.id).join(",") : inputs.map((i) => i.slotId).join(",")}`,
        status: "complete",
        inputs,
        children: children.map((s) => ({ summaryId: s.id, revisionId: s.revisionId }))
      })
    /** An L1 over `slots` as `forkId` shows them, made in that fork. */
    const summarize = (forkId: ForkId, slots: ReadonlyArray<SlotId>) =>
      Effect.gen(function* () {
        const inputs = yield* inputsOf(forkId, slots)
        return yield* complete(yield* job(forkId, slots[0]!, slots.at(-1)!), inputs)
      })
    const condense = (forkId: ForkId, children: ReadonlyArray<Summary>) =>
      Effect.gen(function* () {
        return yield* complete(
          yield* job(forkId, children[0]!.firstSlotId, children.at(-1)!.lastSlotId, children),
          [],
          children
        )
      })

    const summaryIn = (forkId: ForkId, id: string) => read(forkId, (sql) => readSummary(sql, userId, id))
    const validIn = (forkId: ForkId, id: string) =>
      Effect.gen(function* () {
        const leaf = yield* tip(forkId)
        return yield* read(forkId, (sql) =>
          Effect.gen(function* () {
            const view = yield* pathView(sql, chatId, leaf)
            return yield* lineageValidator(sql, userId, view ?? undefined)(id)
          })
        )
      })
    const layerIn = (forkId: ForkId) =>
      Effect.gen(function* () {
        const leaf = yield* tip(forkId)
        return yield* read(forkId, (sql) => selectSummaryLayer(sql, userId, chatId, leaf))
      })
    /** What a reply's planning pass would start for the summaries, as the reader's planner says. */
    const planIn = (forkId: ForkId) =>
      Effect.gen(function* () {
        const leaf = (yield* tip(forkId))!
        return yield* read(forkId, (sql) =>
          Effect.gen(function* () {
            const layer = yield* selectSummaryLayer(sql, userId, chatId, leaf)
            return yield* maintain(sql, userId, chatId, leaf, layer, {
              planner: defaultMaintenancePlanner,
              reason: "reply",
              leafTarget: 600,
              clipTokens: 6000,
              budget: { target: Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }
            })
          })
        )
      })

    return {
      dataDir,
      writer,
      reader,
      userId,
      chatId,
      main,
      tip,
      append,
      insert,
      fork,
      display,
      pieces,
      job,
      inputsOf,
      complete,
      summarize,
      condense,
      summaryIn,
      validIn,
      layerIn,
      planIn,
      read
    }
  })

type Harness = Effect.Success<ReturnType<typeof setup>>

const run = <A, E>(body: (h: Harness) => Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const dataDir = tempDir("lcm-insert")
    return yield* Effect.flatMap(setup(dataDir), body).pipe(
      Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers }))
    )
  })

/** A chat of `count` messages in its main fork. */
const messages = (h: Harness, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, n) => n),
    (n) => h.append(h.main, `m${n}`),
    { concurrency: 1 }
  )

describe("an insertion inside a summarized range", () => {
  it.effect(
    "is stale in the fork that shows it, fresh in one made before, and rewritten including the insertion",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2, m3] = yield* messages(h, 4)
          const s = yield* h.summarize(h.main, [m0!, m1!, m2!])
          const g = yield* h.fork(h.main, m3!)
          const x = yield* h.insert(h.main, m1!, "x")

          const inF = yield* h.summaryIn(h.main, s.id)
          assert.isFalse(inF.fresh)
          assert.deepStrictEqual([inF.from, inF.to], [1, 4])
          const inG = yield* h.summaryIn(g, s.id)
          assert.isTrue(inG.fresh)
          assert.deepStrictEqual([inG.from, inG.to], [1, 3])

          // The summary stays in use, stale, until it's replaced, as after an edit inside it.
          const layer = yield* h.layerIn(h.main)
          assert.deepStrictEqual(
            layer.summaries.map((t) => [t.id, t.fresh]),
            [[s.id, false]]
          )
          assert.strictEqual(layer.cursor, m2)
          assert.strictEqual(layer.cursorDepth, 3)

          // The reply's pass writes it again over F's display range, the insertion included.
          const plan = yield* h.planIn(h.main)
          assert.deepStrictEqual(
            plan.refresh.map((chunk) => [chunk.sourceSummaryId, chunk.inputs.map((i) => i.slotId)]),
            [[s.id, [m0!, m1!, x, m2!]]]
          )
          assert.deepStrictEqual((yield* h.planIn(g)).refresh, [])

          // Enqueued and completed in F, it replaces the stale one there only.
          const [queued] = yield* h.writer.EnqueueSummaries({
            userId: h.userId,
            chatId: h.chatId,
            leafSlotId: (yield* h.tip(h.main))!,
            forkId: h.main,
            chunks: plan.refresh,
            requestClass: "interactive"
          })
          assert.deepStrictEqual([queued!.firstSlotId, queued!.lastSlotId], [m0, m2])
          // A second plan of the same range overlaps the live job by position, so nothing more is queued.
          assert.deepStrictEqual(
            yield* h.writer.EnqueueSummaries({
              userId: h.userId,
              chatId: h.chatId,
              leafSlotId: (yield* h.tip(h.main))!,
              forkId: h.main,
              chunks: [{ ...plan.refresh[0]!, refresh: false }],
              requestClass: "interactive"
            }),
            []
          )
          const rewritten = yield* claimAndComplete(h, queued!.id, plan.refresh[0]!.inputs)
          assert.strictEqual(rewritten.slotCount, 4)
          assert.isTrue((yield* h.summaryIn(h.main, rewritten.id)).fresh)
          assert.deepStrictEqual(
            (yield* h.layerIn(h.main)).summaries.map((t) => [t.id, t.fresh]),
            [[rewritten.id, true]]
          )
          // In G the rewritten summary includes a message G doesn't show: ignored there.
          assert.isFalse(yield* h.validIn(g, rewritten.id))
          assert.deepStrictEqual(
            (yield* h.layerIn(g)).summaries.map((t) => [t.id, t.fresh]),
            [[s.id, true]]
          )
        })
      ),
    60_000
  )
})

describe("an insertion at a seam", () => {
  it.effect(
    "keeps the later summary and rewrites the earlier one over the gap",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2, m3, m4] = yield* messages(h, 5)
          const s1 = yield* h.summarize(h.main, [m0!, m1!])
          const s2 = yield* h.summarize(h.main, [m2!, m3!])
          const x = yield* h.insert(h.main, m1!, "x")
          // Neither is stale by itself: the insertion sits after S1's last input, before S2's first.
          assert.isTrue((yield* h.summaryIn(h.main, s1.id)).fresh)
          assert.isTrue((yield* h.summaryIn(h.main, s2.id)).fresh)

          const layer = yield* h.layerIn(h.main)
          assert.deepStrictEqual(
            layer.summaries.map((t) => [t.id, t.from, t.to, t.fresh]),
            [
              [s1.id, 1, 3, false],
              [s2.id, 4, 5, true]
            ]
          )
          assert.strictEqual(layer.cursor, m3)
          assert.strictEqual(layer.cursorDepth, 4)

          const plan = yield* h.planIn(h.main)
          assert.deepStrictEqual(
            plan.refresh.map((chunk) => [chunk.sourceSummaryId, chunk.inputs.map((i) => i.slotId)]),
            [[s1.id, [m0!, m1!, x]]]
          )
          const s1x = yield* h.summarize(h.main, [m0!, m1!, x])
          assert.deepStrictEqual(
            (yield* h.layerIn(h.main)).summaries.map((t) => [t.id, t.fresh]),
            [
              [s1x.id, true],
              [s2.id, true]
            ]
          )
          assert.deepStrictEqual((yield* h.planIn(h.main)).refresh, [])
          assert.strictEqual(m4 !== undefined, true)
        })
      ),
    60_000
  )

  it.effect(
    "inside a condensation, rewrites the part before the gap, then the condensation over it",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2, m3] = yield* messages(h, 5)
          const s1 = yield* h.summarize(h.main, [m0!, m1!])
          const s2 = yield* h.summarize(h.main, [m2!, m3!])
          const top = yield* h.condense(h.main, [s1, s2])
          const x = yield* h.insert(h.main, m1!, "x")
          assert.isFalse((yield* h.summaryIn(h.main, top.id)).fresh)

          const first = yield* h.planIn(h.main)
          assert.deepStrictEqual(
            first.refresh.map((chunk) => [chunk.sourceSummaryId, chunk.inputs.map((i) => i.slotId)]),
            [[s1.id, [m0!, m1!, x]]]
          )
          assert.deepStrictEqual(first.condensations, [])
          const s1x = yield* h.summarize(h.main, [m0!, m1!, x])

          const second = yield* h.planIn(h.main)
          assert.deepStrictEqual(second.refresh, [])
          assert.deepStrictEqual(
            second.condensations.map((c) => [c.level, c.children, c.sourceSummaryId]),
            [[2, [s1x.id, s2.id], top.id]]
          )
          const [queued] = yield* h.writer.EnqueueCondensations({
            userId: h.userId,
            chatId: h.chatId,
            leafSlotId: (yield* h.tip(h.main))!,
            forkId: h.main,
            jobs: second.condensations,
            requestClass: "interactive"
          })
          const parts = [yield* h.summaryIn(h.main, s1x.id), yield* h.summaryIn(h.main, s2.id)]
          const remade = yield* claimAndComplete(h, queued!.id, [], parts)
          assert.deepStrictEqual(
            (yield* h.layerIn(h.main)).summaries.map((t) => [t.id, t.from, t.to, t.fresh]),
            [[remade.id, 1, 5, true]]
          )
        })
      ),
    60_000
  )

  it.effect(
    "before the first summary, when only inserted messages precede it, rewrites it from the first message",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2] = yield* messages(h, 3)
          const s = yield* h.summarize(h.main, [m0!, m1!])
          const x = yield* h.insert(h.main, null, "x")
          const layer = yield* h.layerIn(h.main)
          assert.deepStrictEqual(
            layer.summaries.map((t) => [t.id, t.from, t.to, t.fresh]),
            [[s.id, 1, 3, false]]
          )
          assert.strictEqual(layer.cursor, m1)
          assert.deepStrictEqual(
            (yield* h.planIn(h.main)).refresh.map((chunk) => chunk.inputs.map((i) => i.slotId)),
            [[x, m0, m1]]
          )
          assert.isDefined(m2)
        })
      ),
    60_000
  )
})

describe("an insertion directly after the cursor", () => {
  it.effect(
    "is raw history, and asks for no rewrite",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1] = yield* messages(h, 4)
          const s = yield* h.summarize(h.main, [m0!, m1!])
          yield* h.insert(h.main, m1!, "x")
          const layer = yield* h.layerIn(h.main)
          assert.deepStrictEqual(
            layer.summaries.map((t) => [t.id, t.from, t.to, t.fresh]),
            [[s.id, 1, 2, true]]
          )
          assert.strictEqual(layer.cursor, m1)
          assert.strictEqual(layer.cursorDepth, 1)
          const plan = yield* h.planIn(h.main)
          assert.deepStrictEqual(plan.refresh, [])
          assert.deepStrictEqual(plan.condensations, [])
        })
      ),
    60_000
  )
})

describe("a job claimed before an insertion", () => {
  it.effect(
    "completes with its inputs, and its summary is stale at once in the fork that shows the insertion",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2, m3] = yield* messages(h, 4)
          const g = yield* h.fork(h.main, m3!)
          const claimed = yield* h.job(h.main, m1!, m2!)
          const inputs = yield* h.inputsOf(h.main, [m1!, m2!])
          yield* h.insert(h.main, m1!, "x")
          const done = yield* h.complete(claimed, inputs)
          assert.strictEqual(done.slotCount, 2)
          const inF = yield* h.summaryIn(h.main, done.id)
          assert.deepStrictEqual([inF.from, inF.to, inF.fresh], [2, 4, false])
          assert.isTrue((yield* h.summaryIn(g, done.id)).fresh)

          // A condensation claimed before an insertion between its parts completes too, stale.
          const a = yield* h.summarize(g, [m0!])
          const b = yield* h.summarize(g, [m1!, m2!])
          const condensing = yield* h.job(h.main, m0!, m2!, [a, b])
          yield* h.insert(h.main, m0!, "y")
          const top = yield* h.complete(condensing, [], [a, b])
          assert.isFalse((yield* h.summaryIn(h.main, top.id)).fresh)
          assert.isTrue((yield* h.summaryIn(g, top.id)).fresh)
        })
      ),
    60_000
  )

  it.effect(
    "is refused when its inputs skip a message that wasn't inserted",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2] = yield* messages(h, 3)
          yield* h.insert(h.main, m0!, "x")
          const exit = yield* Effect.exit(
            h.complete(yield* h.job(h.main, m0!, m2!), yield* h.inputsOf(h.main, [m0!, m2!]))
          )
          assert.isTrue(Exit.isFailure(exit))
          assert.include(String(exit), "L1 inputs must be exactly the job's chain")
          assert.isDefined(m1)
        })
      ),
    60_000
  )
})

const rawSummary = (h: Harness, slots: ReadonlyArray<SlotId>, status: "complete" | "failed" = "complete") => {
  const id = uuidv7(),
    revision = uuidv7()
  return Effect.exit(
    fixtureSql(h.dataDir, [
      {
        sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'s',1,'generated',1)",
        params: [revision, id]
      },
      {
        sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,1,?,?,?,?,?,1)",
        params: [id, h.chatId, revision, slots[0]!, slots.at(-1)!, slots.length, status]
      },
      ...slots.map((slot, ordinal) => ({
        sql: "INSERT INTO summary_inputs(summary_id,ordinal,slot_id,version_id,amend_count) VALUES(?,?,?,NULL,0)",
        params: [id, ordinal, slot]
      })),
      { sql: "UPDATE summaries SET sealed = 1 WHERE id = ?", params: [id] }
    ])
  )
}

describe("the summary triggers", () => {
  it.effect(
    "take a range with inserted messages in display order and refuse one that skips a message that wasn't inserted",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2] = yield* messages(h, 3)
          const x = yield* h.insert(h.main, m1!, "x")
          const y = yield* h.insert(h.main, x, "y")
          // m0, m1, x, y, m2 is the main fork's display order: x below m1, y below x.
          assert.isTrue(Exit.isSuccess(yield* rawSummary(h, [m0!, m1!, x, y, m2!])))
          assert.isTrue(Exit.isSuccess(yield* rawSummary(h, [y, m2!])))
          assert.isTrue(Exit.isSuccess(yield* rawSummary(h, [m1!, m2!])))
          const skipped = yield* rawSummary(h, [m0!, m2!])
          assert.isTrue(Exit.isFailure(skipped))
          assert.match(String(skipped), /summary (inputs must follow their declared chain|endpoints must form)/)
          assert.isTrue(Exit.isFailure(yield* rawSummary(h, [m2!, x])))
        })
      ),
    60_000
  )
})

describe("display lineage regressions", () => {
  it.effect(
    "refuses reverse inserted siblings and an ordinary branch that returns to the old path",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [a, b] = yield* messages(h, 2)
          const x = yield* h.insert(h.main, a!, "older")
          const y = yield* h.insert(h.main, a!, "newer")
          assert.isTrue(Exit.isSuccess(yield* rawSummary(h, [a!, y, x, b!])))
          assert.isTrue(Exit.isFailure(yield* rawSummary(h, [a!, x, y, b!])), "siblings must be newest first")
          const atX = yield* h.fork(h.main, x)
          const reply = yield* h.append(atX, "ordinary reply below x")
          assert.isTrue(
            Exit.isFailure(yield* rawSummary(h, [a!, y, x, reply, b!])),
            "cannot return from an ordinary branch"
          )
          const merged = yield* h.insert(h.main, a!, "merged insertion")
          yield* fixtureSql(h.dataDir, [
            {
              sql: "INSERT INTO slot_parents(slot_id,parent_slot_id,ordinal) VALUES(?,?,0)",
              params: [merged, b!]
            }
          ])
          assert.isTrue(Exit.isFailure(yield* rawSummary(h, [a!, merged, b!])), "merged inputs remain forbidden")
        })
      ),
    60_000
  )

  it.effect(
    "refuses reversed condensation children and reversed header endpoints",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [a, b] = yield* messages(h, 2)
          const x = yield* h.insert(h.main, a!, "older")
          const y = yield* h.insert(h.main, a!, "newer")
          const parts = yield* Effect.forEach([a!, x, y, b!], (slot) => h.summarize(h.main, [slot]))
          const id = uuidv7(),
            revision = uuidv7()
          const result = yield* Effect.exit(
            fixtureSql(h.dataDir, [
              {
                sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'s',1,'generated',1)",
                params: [revision, id]
              },
              {
                sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,2,?,?,?,4,'complete',1)",
                params: [id, h.chatId, revision, a!, b!]
              },
              ...parts.map((part, ordinal) => ({
                sql: "INSERT INTO summary_parents(summary_id,ordinal,parent_id,parent_revision_id) VALUES(?,?,?,?)",
                params: [id, ordinal, part.id, part.revisionId]
              })),
              { sql: "UPDATE summaries SET sealed=1 WHERE id=?", params: [id] }
            ])
          )
          assert.isTrue(Exit.isFailure(result))
          assert.include(String(result), "summary children must partition")
          const badHeader = yield* Effect.exit(
            fixtureSql(h.dataDir, [
              {
                sql: "INSERT INTO summary_revisions(id,summary_id,content,token_count,origin,created_at) VALUES(?,?,'s',1,'generated',1)",
                params: [revision, id]
              },
              {
                sql: "INSERT INTO summaries(id,chat_id,level,selected_revision_id,first_slot_id,last_slot_id,slot_count,status,created_at) VALUES(?,?,1,?,?,?,2,'complete',1)",
                params: [id, h.chatId, revision, x, y]
              }
            ])
          )
          assert.isTrue(Exit.isFailure(badHeader))
          assert.include(String(badHeader), "summary endpoints must form")
        })
      ),
    60_000
  )

  it.effect(
    "claims L1 work in display order when insertion depths put it after a later range",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [a, b] = yield* messages(h, 3)
          const x = yield* h.insert(h.main, a!, "x")
          const y = yield* h.insert(h.main, x, "y")
          const z = yield* h.insert(h.main, y, "z")
          const enqueue = (slot: SlotId) =>
            Effect.gen(function* () {
              const inputs = yield* h.inputsOf(h.main, [slot])
              const [job] = yield* h.writer.EnqueueSummaries({
                userId: h.userId,
                chatId: h.chatId,
                forkId: h.main,
                leafSlotId: (yield* h.tip(h.main))!,
                chunks: [{ inputs, target: 600, clipTokens: 6000, refresh: false }],
                requestClass: "interactive"
              })
              return { job: job!, inputs }
            })
          const later = yield* enqueue(b!)
          const earlier = yield* enqueue(z)
          const first = yield* h.writer.ClaimSummaryJob({ userId: h.userId })
          assert.strictEqual(first?.id, earlier.job.id)
          assert.isNull(yield* h.writer.ClaimSummaryJob({ userId: h.userId }), "one L1 job per fork at a time")
          yield* claimAndComplete(h, first!.id, earlier.inputs)
          assert.strictEqual((yield* h.writer.ClaimSummaryJob({ userId: h.userId }))?.id, later.job.id)
        })
      ),
    60_000
  )

  it.effect(
    "repairs deletion, restore and fork-local edits once, then stays settled",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [a, b, c, d] = yield* messages(h, 4)
          const left = yield* h.summarize(h.main, [a!, b!])
          const right = yield* h.summarize(h.main, [c!, d!])
          yield* h.condense(h.main, [left, right])
          const x = yield* h.insert(h.main, b!, "x")
          const atX = yield* h.fork(h.main, x)
          yield* h.append(atX, "after x")
          // This fork has x on the structural chain and also inherits other placed insertions.
          yield* h.insert(atX, a!, "before b")
          const settle = (fork: ForkId) =>
            Effect.gen(function* () {
              for (let pass = 0; pass < 5; pass++) {
                const plan = yield* h.planIn(fork)
                if (!plan.refresh.length && !plan.condensations.length) {
                  const layer = yield* h.layerIn(fork)
                  assert.isAbove(layer.summaries.length, 0, "repair retains coverage")
                  assert.isTrue(
                    layer.summaries.every((summary) => summary.fresh),
                    "repair leaves fresh coverage"
                  )
                  for (let reply = 0; reply < 3; reply++) {
                    const next = yield* h.planIn(fork)
                    assert.deepStrictEqual([next.refresh, next.condensations], [[], []], "settled on later replies")
                  }
                  return
                }
                for (const chunk of plan.refresh) {
                  const [job] = yield* h.writer.EnqueueSummaries({
                    userId: h.userId,
                    chatId: h.chatId,
                    forkId: fork,
                    leafSlotId: (yield* h.tip(fork))!,
                    chunks: [chunk],
                    requestClass: "interactive"
                  })
                  assert.isDefined(job, "repair must enqueue")
                  yield* claimAndComplete(h, job!.id, chunk.inputs)
                }
                for (const condensation of plan.condensations) {
                  const [job] = yield* h.writer.EnqueueCondensations({
                    userId: h.userId,
                    chatId: h.chatId,
                    forkId: fork,
                    leafSlotId: (yield* h.tip(fork))!,
                    jobs: [condensation],
                    requestClass: "interactive"
                  })
                  assert.isDefined(job, "repair must enqueue")
                  const parts = yield* Effect.forEach(condensation.children, (id) => h.summaryIn(fork, id))
                  yield* claimAndComplete(h, job!.id, [], parts)
                }
              }
              assert.fail("repair kept asking for paid work")
            })
          yield* settle(h.main)
          const bin = yield* h.writer.DeleteMessage({ userId: h.userId, slotId: x, forkId: h.main })
          yield* settle(h.main)
          yield* h.writer.RestoreBinItem({ userId: h.userId, itemId: bin.id })
          yield* settle(h.main)
          yield* h.summarize(atX, [a!, (yield* h.display(atX))[1]!, b!, x])
          const before = yield* h.reader.GetSlot({ userId: h.userId, slotId: x, forkId: atX })
          yield* h.writer.AmendVersion({
            userId: h.userId,
            versionId: before.entry.version.id,
            forkId: atX,
            content: "edited in the fork at x",
            expectedRowVersion: before.entry.version.rowVersion
          })
          yield* settle(atX)
          yield* settle(h.main)
        })
      ),
    120_000
  )
})

describe("a summary that includes an inserted message", () => {
  it.effect(
    "is ignored in a fork that doesn't show it and used in one made after the insertion",
    () =>
      run((h) =>
        Effect.gen(function* () {
          const [m0, m1, m2, m3] = yield* messages(h, 4)
          const g = yield* h.fork(h.main, m3!)
          const x = yield* h.insert(h.main, m1!, "x")
          const s = yield* h.summarize(h.main, [m0!, m1!, x, m2!])
          const later = yield* h.fork(h.main, m3!)
          assert.isFalse(yield* h.validIn(g, s.id))
          assert.deepStrictEqual((yield* h.layerIn(g)).summaries, [])
          assert.isTrue(Exit.isSuccess(yield* rawSummary(h, [m0!, m1!, x, m2!, m3!], "failed")))
          const failures = (forkId: ForkId) =>
            Effect.map(
              h.reader.GetLcmState({
                userId: h.userId,
                chatId: h.chatId,
                forkId,
                leafSlotId: m3!
              }),
              (state) => state.failed
            )
          assert.deepStrictEqual(yield* failures(g), [], "failed coverage also requires all its inputs in the fork")
          assert.lengthOf(yield* failures(h.main), 1)
          const coverage = (forkId: ForkId) =>
            h.reader.GetLcmCoverage({
              userId: h.userId,
              chatId: h.chatId,
              forkId,
              leafSlotId: m3!,
              fromDepth: 0,
              toDepth: 10
            })
          assert.deepStrictEqual(
            (yield* coverage(g)).summaries,
            [],
            "coverage ignores a summary containing an absent insertion"
          )
          yield* h.insert(g, m0!, "only in g")
          assert.deepStrictEqual(yield* failures(g), [], "an unrelated insertion cannot validate the failure")
          assert.deepStrictEqual((yield* coverage(g)).summaries, [], "another displayed insertion cannot validate x")
          assert.deepStrictEqual(
            (yield* coverage(h.main)).summaries
              .filter((row) => row.status !== "failed")
              .map((row) => [row.id, row.from, row.to]),
            [[s.id, 1, 4]]
          )
          assert.isTrue(yield* h.validIn(later, s.id))
          assert.deepStrictEqual(
            (yield* h.layerIn(later)).summaries.map((t) => [t.id, t.from, t.to, t.fresh]),
            [[s.id, 1, 4, true]]
          )
          // A fork made at the inserted message has it on its structural path, where it's fresh too.
          const atX = yield* h.fork(h.main, x)
          yield* h.append(atX, "after x")
          assert.isTrue(yield* h.validIn(atX, (yield* h.summarize(atX, [m0!, m1!, x])).id))
          assert.isFalse(yield* h.validIn(atX, s.id))
        })
      ),
    60_000
  )
})

/** A seeded generator (mulberry32), so a failing sequence can be replayed. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * What a summary is in a fork, from first principles: valid when its inputs (or its parts'
 * ranges) are in the fork's display order with only spliced-in slots between them and its ends
 * where it says; fresh when, besides, nothing it doesn't cover sits between its ends and its
 * parts are fresh. Its numbers are positions there.
 */
const judge = (
  shown: { readonly ids: ReadonlyArray<SlotId>; readonly spliced: ReadonlySet<SlotId> },
  byId: ReadonlyMap<string, Summary>,
  s: Summary
): { valid: boolean; fresh: boolean; from: number; to: number } => {
  const at = (slot: string) => shown.ids.indexOf(slot as SlotId)
  const follows = (ranges: ReadonlyArray<readonly [number, number]>) =>
    ranges.every(([a, b]) => a >= 0 && b >= a) &&
    ranges.every(
      ([a], n) =>
        n === 0 ||
        (a > ranges[n - 1]![1] && shown.ids.slice(ranges[n - 1]![1] + 1, a).every((id) => shown.spliced.has(id)))
    )
  const from = at(s.firstSlotId),
    to = at(s.lastSlotId)
  if (s.level === 1) {
    const valid = from >= 0 && to >= 0 && follows(s.inputs.map((i) => [at(i.slotId), at(i.slotId)] as const))
    return { valid, fresh: valid && to - from + 1 === s.inputs.length, from: from + 1, to: to + 1 }
  }
  const parts = s.children.map((c) => byId.get(c.summaryId)!)
  const judged = parts.map((part) => judge(shown, byId, part))
  const valid =
    from >= 0 &&
    to >= 0 &&
    judged.every((j) => j.valid) &&
    parts[0]!.firstSlotId === s.firstSlotId &&
    parts.at(-1)!.lastSlotId === s.lastSlotId &&
    follows(judged.map((j) => [j.from - 1, j.to - 1] as const))
  return {
    valid,
    fresh: valid && judged.every((j) => j.fresh) && to - from + 1 === s.slotCount,
    from: from + 1,
    to: to + 1
  }
}

describe("the LCM graph oracle, with insertions", () => {
  for (const seed of [11, 23, 37, 41])
    it.effect(
      `agrees on validity, freshness, positions and the layer in every fork (seed ${seed})`,
      () =>
        run((h) =>
          Effect.gen(function* () {
            const next = random(seed)
            const pick = <T>(items: ReadonlyArray<T>) => items[Math.floor(next() * items.length)]!
            yield* messages(h, 6)
            const forks: Array<ForkId> = [h.main]
            const summaries: Array<Summary> = []
            for (let step = 0; step < 28; step++) {
              const k = pick(forks)
              const shown = yield* h.display(k)
              const r = next()
              if (r < 0.3) yield* h.insert(k, next() < 0.1 ? null : pick(shown), `x${step}`)
              else if (r < 0.42) forks.push(yield* h.fork(k, pick(shown)))
              else if (r < 0.52) yield* h.append(k, `a${step}`)
              else if (r < 0.85) {
                // Half of them continue the fork's layer, so layers and seams form.
                const start = next() < 0.5 ? (yield* h.layerIn(k)).cursorDepth + 1 : Math.floor(next() * shown.length)
                const slots = shown.slice(start, start + 1 + Math.floor(next() * 3))
                if (slots.length) summaries.push(yield* h.summarize(k, slots))
              } else {
                // Two summaries next to each other and fresh in k, condensed there.
                const fresh: Array<Summary> = []
                for (const s of summaries)
                  if ((yield* h.validIn(k, s.id)) && (yield* h.summaryIn(k, s.id)).fresh)
                    fresh.push(yield* h.summaryIn(k, s.id))
                const pair = fresh.flatMap((a) => fresh.filter((b) => a.to + 1 === b.from).map((b) => [a, b] as const))
                if (pair.length) summaries.push(yield* h.condense(k, pick(pair)))
              }
            }
            const byId = new Map(summaries.map((s) => [s.id as string, s]))
            const seen = { staleByInsertion: 0, seams: 0, displayForks: 0, layered: 0 }
            for (const k of forks) {
              const shown = yield* h.pieces(k)
              for (const s of summaries) {
                // Validity matters where a summary can be a candidate: ending on the fork's path. (A
                // fork without insertions checks lineage by parent links alone, the path read finds it.)
                if (!shown.ids.includes(s.lastSlotId)) continue
                const expected = judge(shown, byId, s)
                const label = `fork ${forks.indexOf(k)}, summary ${summaries.indexOf(s)}`
                assert.strictEqual(yield* h.validIn(k, s.id), expected.valid, `${label}: valid`)
                if (!expected.valid) continue
                const got = yield* h.summaryIn(k, s.id)
                if (got.to - got.from + 1 > s.slotCount) seen.staleByInsertion++
                assert.deepStrictEqual(
                  [got.from, got.to, got.fresh],
                  [expected.from, expected.to, expected.fresh],
                  label
                )
              }
              // The layer is a continuous prefix of positions, of summaries valid in the fork, fresh only when they are.
              const layer = yield* h.layerIn(k)
              let position = 1
              for (const t of layer.summaries) {
                const expected = judge(shown, byId, byId.get(t.id)!)
                assert.isTrue(expected.valid, `fork ${forks.indexOf(k)}: layer member valid`)
                assert.strictEqual(t.from, position, `fork ${forks.indexOf(k)}: layer continuous`)
                assert.isTrue(t.to >= expected.to, `fork ${forks.indexOf(k)}: layer covers its summary`)
                assert.isTrue(
                  shown.ids.slice(expected.to, t.to).every((id) => shown.spliced.has(id)),
                  `fork ${forks.indexOf(k)}: a seam covers only inserted messages`
                )
                if (t.to > expected.to || t.from < expected.from) seen.seams++
                if (t.fresh) assert.isTrue(expected.fresh && t.to === expected.to && t.from === expected.from)
                position = t.to + 1
              }
              if (shown.spliced.size) seen.displayForks++
              if (layer.summaries.length) seen.layered++
              assert.strictEqual(layer.cursorDepth, position - 2)
              assert.strictEqual(layer.cursor, layer.summaries.length ? shown.ids[position - 2] : null)
            }
            // The sequence reached what this is about.
            assert.isAbove(seen.displayForks, 0)
            assert.isAbove(seen.staleByInsertion + seen.seams, 0)
          })
        ),
      { timeout: 600_000, tags: seed !== 23 ? ["slow"] : [] }
    )
})

/** Claims an enqueued job as the scheduler would (processing, with a running rollout) and completes it. */
const claimAndComplete = (
  h: Harness,
  jobId: string,
  inputs: Summary["inputs"],
  children: ReadonlyArray<Summary> = []
) =>
  Effect.gen(function* () {
    const rolloutId = uuidv7()
    yield* fixtureSql(h.dataDir, [
      { sql: "UPDATE summarization_jobs SET status = 'processing' WHERE id = ?", params: [jobId] },
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES(?,?,?,'running','summarizer','background',1,1)",
        params: [rolloutId, h.chatId, children.length ? "condense" : "summarize"]
      }
    ])
    return yield* h.complete({ jobId, rolloutId }, inputs, children)
  })
