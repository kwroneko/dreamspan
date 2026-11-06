// The display path (spec/MESSAGE-INSERT.md §2.3, unit 1) against an oracle that builds what
// each fork shows from first principles: a fork is a list of messages; appending adds at its
// end, inserting below P puts the new message directly after P, and a fork made at P starts
// as its parent's list up to P and changes alone from then on. Random sequences of appends,
// insertions, forks (lineage compaction included) and deletions run on the real schema, and
// `pathPieces` must give each fork's list, positions and membership.
import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import {
  displayEnd,
  displayLength,
  hiddenAtFork,
  onDisplayPath,
  pathPieces,
  type PathPiece,
  positionOf,
  type SlotPlace
} from "../src/db/displayPath.ts"
import { insertFork, slotDeletedIn, writeInsert, writeOverride } from "../src/db/forkState.ts"
import { migrations } from "../src/db/migrations.ts"
import type { ForkRow } from "../src/db/rows.ts"
import { tempDir } from "./support/tempDir.ts"

/** A small seeded generator, so a failing sequence can be replayed by its seed. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1
  return (n: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % n
  }
}

interface Model {
  /** Every slot shown, deleted ones included, in order. */
  list: Array<string>
  deleted: Set<string>
  tip: string | null
}

const world = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
  yield* sql`INSERT INTO users (id, handle, display_name, role, created_at) VALUES ('u', 'u', 'u', 'admin', 1)`
  let chats = 0

  const newChat = Effect.gen(function* () {
    const chatId = `chat${++chats}`
    yield* sql`INSERT INTO chats (id, owner_user_id, kind, status, created_at) VALUES (${chatId}, 'u', 'rp', 'active', 1)`
    yield* sql`INSERT INTO lanes (id, chat_id, name, created_at) VALUES (${`${chatId}-lane`}, ${chatId}, 'main', 1)`
    return chatId
  })

  const place = (id: string) =>
    Effect.map(
      sql<{ id: string; chain_id: string; depth: number }>`SELECT id, chain_id, depth FROM slots WHERE id = ${id}`,
      ([row]): SlotPlace => ({ id: row!.id, chainId: row!.chain_id, depth: row!.depth })
    )

  /** A slot below `parent` (null: a root) with one version; `inserted` marks it so. */
  const slot = (chatId: string, forkId: string, parent: string | null, inserted: boolean) =>
    Effect.gen(function* () {
      const id = uuidv7()
      const versionId = uuidv7()
      const depth = parent === null ? 0 : (yield* place(parent)).depth + 1
      yield* sql`INSERT INTO versions (id, slot_id, ordinal, status, writer, content, macro_mode, origin, created_at, updated_at)
        VALUES (${versionId}, ${id}, 0, 'complete', 'human', ${id}, 'verbatim', 'user_written', 1, 1)`
      yield* sql`INSERT INTO slots (id, chat_id, lane_id, parent_slot_id, depth, selected_version_id, created_at, fork_id, inserted)
        VALUES (${id}, ${chatId}, ${`${chatId}-lane`}, ${parent}, ${depth}, ${versionId}, 1, ${forkId}, ${inserted ? 1 : 0})`
      return id
    }).pipe(sql.withTransaction)

  const forkRow = (forkId: string) =>
    Effect.map(sql<ForkRow>`SELECT * FROM forks WHERE id = ${forkId}`, ([row]) => row!)

  const pieces = (chatId: string, forkId: string) =>
    Effect.gen(function* () {
      const fork = yield* forkRow(forkId)
      return yield* pathPieces(sql, chatId, forkId, fork.tip_slot_id)
    })

  /** The slots the pieces stand for, in order. */
  const expand = (all: ReadonlyArray<PathPiece>) =>
    Effect.gen(function* () {
      const ids: Array<string> = []
      for (const piece of all) {
        if (piece.kind === "inserted") ids.push(piece.slotId)
        else {
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM slots WHERE chain_id = ${piece.chainId} AND depth BETWEEN ${piece.lo} AND ${piece.hi}
            ORDER BY depth`
          assert.strictEqual(rows.length, piece.hi - piece.lo + 1, "a run has a slot at each depth")
          ids.push(...rows.map((row) => row.id))
        }
      }
      return ids
    })

  return { sql, newChat, place, slot, forkRow, pieces, expand }
})

type World = Effect.Success<typeof world>

/** Operations on the real schema, mirrored on the oracle. */
const operations = (w: World, chatId: string) => {
  const { sql } = w
  const models = new Map<string, Model>([[chatId, { list: [], deleted: new Set(), tip: null }]])
  const fork = (id: string) => ({ id, chatId })

  const setTip = (forkId: string, tip: string | null) => sql`UPDATE forks SET tip_slot_id = ${tip} WHERE id = ${forkId}`

  const append = (forkId: string) =>
    Effect.gen(function* () {
      const model = models.get(forkId)!
      const id = yield* w.slot(chatId, forkId, model.tip, false)
      yield* setTip(forkId, id)
      model.list.push(id)
      model.tip = id
      return id
    })

  /** Inserts below `anchor` (null: above the first message) in the fork. */
  const insert = (forkId: string, anchor: string | null) =>
    Effect.gen(function* () {
      const model = models.get(forkId)!
      assert.isTrue(anchor === null || model.list.includes(anchor), "inserts below a message the fork shows")
      const id = yield* w.slot(chatId, forkId, anchor, true)
      yield* writeInsert(sql, fork(forkId), id, 1)
      model.list.splice(anchor === null ? 0 : model.list.indexOf(anchor) + 1, 0, id)
      return id
    })

  /** A fork of `from` at `at` (null: before the first message), as CreateFork makes one. */
  const forkAt = (from: string, at: string | null) =>
    Effect.gen(function* () {
      const parent = yield* w.forkRow(from)
      const shown = yield* w.pieces(chatId, from)
      const row = yield* insertFork(sql, { chatId, parent, baseSlotId: at, tipSlotId: at, at: 1 })
      const hidden = hiddenAtFork(shown, at === null ? null : yield* w.place(at), yield* w.pieces(chatId, row.id))
      for (const x of hidden) yield* writeInsert(sql, fork(row.id), x, 0)
      const model = models.get(from)!
      models.set(row.id, {
        list: at === null ? [] : model.list.slice(0, model.list.indexOf(at) + 1),
        deleted: new Set(model.deleted),
        tip: at
      })
      return row.id
    })

  const remove = (forkId: string, slotId: string) =>
    Effect.gen(function* () {
      yield* writeOverride(sql, fork(forkId), {
        kind: "delete_slot",
        targetId: slotId,
        slotId,
        valueId: null,
        flag: 1
      })
      models.get(forkId)!.deleted.add(slotId)
    })

  /** Every fork's display path matches its model: order, positions, membership, the end and the deletions. */
  const check = (label: string) =>
    Effect.gen(function* () {
      const everySlot = yield* sql<{ id: string }>`SELECT id FROM slots WHERE chat_id = ${chatId}`
      for (const [forkId, model] of models) {
        const pieces = yield* w.pieces(chatId, forkId)
        const ids = yield* w.expand(pieces)
        assert.deepStrictEqual(ids, model.list, `${label}: fork ${forkId}`)
        assert.strictEqual(displayLength(pieces), model.list.length)
        assert.strictEqual(displayEnd(pieces, model.tip), model.list.at(-1) ?? null)
        for (const { id } of everySlot) {
          const place = yield* w.place(id)
          const index = model.list.indexOf(id)
          assert.strictEqual(positionOf(pieces, place), index < 0 ? null : index, `${label}: position of ${id}`)
          assert.strictEqual(onDisplayPath(pieces, place), index >= 0)
        }
        const deleted = yield* sql<{ id: string }>`
          SELECT s.id FROM slots s WHERE s.chat_id = ${chatId} AND ${slotDeletedIn(sql, forkId, "s")}`
        assert.deepStrictEqual(
          model.list.filter((id) => deleted.some((row) => row.id === id)),
          model.list.filter((id) => model.deleted.has(id)),
          `${label}: deletions in ${forkId}`
        )
      }
    })

  return { models, append, insert, forkAt, remove, check }
}

const layer = () => writerConnection(join(tempDir("display-path"), "db.sqlite"))

describe("the display path", () => {
  it.effect("splices insertions in order: the newest directly below its anchor, each followed by its own gap", () =>
    Effect.gen(function* () {
      const w = yield* world
      const chatId = yield* w.newChat
      const ops = operations(w, chatId)
      const main = chatId
      const a = yield* ops.append(main)
      const b = yield* ops.append(main)
      yield* ops.append(main)
      // A, then X₁ and X₂ below A, then X₃ below X₁: A, X₂, X₁, X₃, B.
      const x1 = yield* ops.insert(main, a)
      const x2 = yield* ops.insert(main, a)
      const x3 = yield* ops.insert(main, x1)
      assert.deepStrictEqual(ops.models.get(main)!.list.slice(0, 5), [a, x2, x1, x3, b])
      // Above the first message, and at the tip (the display end is then an inserted slot).
      yield* ops.insert(main, null)
      const tip = ops.models.get(main)!.tip!
      const atTip = yield* ops.insert(main, tip)
      yield* ops.check("built")
      const pieces = yield* w.pieces(chatId, main)
      assert.strictEqual(displayEnd(pieces, tip), atTip)
      // Appending after an inserted display end puts the new message after it.
      yield* ops.append(main)
      yield* ops.check("appended")
    }).pipe(Effect.provide(layer()))
  )

  it.effect("keeps a fork made before an insertion as it was, and gives later forks what their parent showed", () =>
    Effect.gen(function* () {
      const w = yield* world
      const chatId = yield* w.newChat
      const ops = operations(w, chatId)
      const main = chatId
      const a = yield* ops.append(main)
      const b = yield* ops.append(main)
      yield* ops.append(main)
      const before = yield* ops.forkAt(main, b)
      const x1 = yield* ops.insert(main, a)
      const x2 = yield* ops.insert(main, a)
      const x3 = yield* ops.insert(main, x1)
      // At A: the gap after A in main isn't spliced in. At X₁: X₂ comes before it, X₃ (its gap) doesn't follow.
      const atA = yield* ops.forkAt(main, a)
      const atX1 = yield* ops.forkAt(main, x1)
      const atX2 = yield* ops.forkAt(main, x2)
      const atB = yield* ops.forkAt(main, b)
      const atNull = yield* ops.forkAt(main, null)
      yield* ops.check("forked")
      assert.deepStrictEqual(ops.models.get(atX1)!.list.slice(-3), [a, x2, x1])
      assert.deepStrictEqual(ops.models.get(atB)!.list.slice(-5), [a, x2, x1, x3, b])
      // Each continues alone.
      for (const forkId of [before, atA, atX1, atX2, atB, atNull]) yield* ops.append(forkId)
      yield* ops.insert(atX1, a)
      yield* ops.insert(atA, a)
      yield* ops.insert(main, b)
      yield* ops.check("continued")
      // A fork at an inserted slot appends below it: the new message is its child.
      const child = ops.models.get(atX1)!.tip!
      assert.strictEqual((yield* w.place(child)).depth, (yield* w.place(x1)).depth + 1)
    }).pipe(Effect.provide(layer()))
  )

  it.effect("holds through a 70-deep chain of forks, which copies nothing", () =>
    Effect.gen(function* () {
      const w = yield* world
      const chatId = yield* w.newChat
      const ops = operations(w, chatId)
      let current = chatId
      let previous = yield* ops.append(current)
      for (let i = 0; i < 70; i++) {
        const next = yield* ops.append(current)
        yield* ops.insert(current, previous)
        if (i % 3 === 0) yield* ops.insert(current, null)
        // Alternate: a fork at the tip, and one at the message before it (its gap stays behind).
        current = yield* ops.forkAt(current, i % 2 === 0 ? next : previous)
        if (i % 2 === 0) previous = next
      }
      yield* ops.check("deep")
      // The deepest fork holds at most the row its own fork point wrote; nothing it inherits
      // from the 70 forks above was copied into it.
      const [row] = yield* w.sql<{
        n: number
      }>`SELECT count(*) AS n FROM fork_overrides WHERE fork_id = ${current}`
      assert.isAtMost(row!.n, 1)
    }).pipe(Effect.provide(layer()))
  )

  it.effect(
    "matches the oracle over random sequences of appends, insertions, forks and deletions",
    () =>
      Effect.gen(function* () {
        const w = yield* world
        for (let seed = 1; seed <= 40; seed++) {
          const chatId = yield* w.newChat
          const ops = operations(w, chatId)
          const next = random(seed * 7919)
          const pick = <T>(xs: ReadonlyArray<T>) => xs[next(xs.length)]!
          yield* ops.append(chatId)
          for (let step = 0; step < 60; step++) {
            const forkId = pick([...ops.models.keys()])
            const model = ops.models.get(forkId)!
            const live = model.list.filter((id) => !model.deleted.has(id))
            const roll = next(100)
            if (roll < 30 || live.length === 0) yield* ops.append(forkId)
            else if (roll < 65) yield* ops.insert(forkId, next(8) === 0 ? null : pick(live))
            else if (roll < 85) yield* ops.forkAt(forkId, next(10) === 0 ? null : pick(live))
            else {
              const candidates = live.filter((id) => id !== model.tip)
              if (candidates.length > 0) yield* ops.remove(forkId, pick(candidates))
            }
          }
          yield* ops.check(`seed ${seed}`)
        }
      }).pipe(Effect.provide(layer())),
    { timeout: 60_000, tags: ["slow"] }
  )
})
