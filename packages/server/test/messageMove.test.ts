// Moving messages up and down in one branch (owner, 2026-11-16), through the real writer: the
// fork shows the new order, reads (GetPath) follow it, forks made before or beside it keep
// theirs, forks made after inherit it, Undo restores it, and a random sequence of moves,
// deletions and insertions matches an array oracle at a few hundred messages.
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { type ChatId, type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { MoveStep } from "@rp/shared/messagesApi.ts"
import { Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { pathPieces, placedMoves } from "../src/db/displayPath.ts"
import { slotDeletedIn } from "../src/db/forkState.ts"
import { docFor } from "./support/docs.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

const said = (content: string, speaker: string) =>
  new NewVersion({
    speakerEntityId: speaker as never,
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
    const mira = (yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: docFor("card", "Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })).entityId
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Harbor",
      participants: [mira],
      greeting: null
    })
    const chatId = chat.id as ChatId
    const main = chat.currentForkId! as ForkId
    const append = (forkId: ForkId, parent: SlotId | null, content: string) =>
      Effect.map(
        writer.AppendMessage({
          userId,
          chatId,
          forkId,
          parentSlotId: parent,
          branch: false,
          version: said(content, mira),
          commitDraft: null
        }),
        (sent) => sent.slotId
      )
    const move = (forkId: ForkId, slotId: SlotId, direction: "up" | "down") =>
      writer.MoveMessage({ userId, chatId, forkId, slotId, direction, expectedRowVersion: 0 })
    const undo = (forkId: ForkId, steps: ReadonlyArray<MoveStep>) =>
      writer.UndoMove({ userId, chatId, forkId, undo: steps })
    const fork = (from: ForkId, at: SlotId | null) =>
      Effect.map(writer.CreateFork({ userId, chatId, fromForkId: from, atSlotId: at }), (made) => made.fork.id)
    const insert = (forkId: ForkId, anchor: SlotId, content: string) =>
      Effect.map(
        writer.InsertMessage({
          userId,
          chatId,
          forkId,
          anchorSlotId: anchor,
          expectedRowVersion: 0,
          body: { _tag: "Write", speaker: mira, content }
        }),
        (made) => made.slotId
      )
    const remove = (forkId: ForkId, slotId: SlotId) =>
      writer.DeleteMessages({ userId, forkId, slotIds: [slotId] as never })

    /** Every slot on the fork's display path, in order, and whether it's deleted there. */
    const display = (forkId: ForkId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ tip: string | null }>`SELECT tip_slot_id AS tip FROM forks WHERE id = ${forkId}`
        const slots: Array<{ id: SlotId; deleted: number }> = []
        for (const piece of yield* pathPieces(sql, chatId, forkId, row!.tip))
          slots.push(
            ...(piece.kind !== "run"
              ? yield* sql<{ id: SlotId; deleted: number }>`
                  SELECT s.id, ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s WHERE s.id = ${piece.slotId}`
              : yield* sql<{ id: SlotId; deleted: number }>`
                  SELECT s.id, ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s
                  WHERE s.chain_id = ${piece.chainId} AND s.depth BETWEEN ${piece.lo} AND ${piece.hi} ORDER BY s.depth`)
          )
        return slots
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
    const moves = (forkId: ForkId) =>
      Effect.gen(function* () {
        return yield* placedMoves(yield* SqlClient.SqlClient, chatId, forkId)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
    const order = (forkId: ForkId) => Effect.map(display(forkId), (slots) => slots.map((s) => s.id))
    /** What the fork shows through GetPath, in order. */
    const path = (forkId: ForkId) =>
      Effect.map(reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 1000 }), (found) =>
        found.entries.map((e) => e.slotId)
      )
    return {
      writer,
      reader,
      userId,
      chatId,
      main,
      append,
      move,
      undo,
      fork,
      insert,
      remove,
      display,
      order,
      path,
      moves
    }
  })

const run = <A, E>(body: (dataDir: string) => Effect.Effect<A, E, Database.Writer | Database.Reader>) => {
  const dataDir = tempDir("message-move")
  return body(dataDir).pipe(
    Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers }))
  )
}

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => {
    assert.isTrue(Exit.isFailure(exit), "refused")
    return Exit.isFailure(exit) ? String(exit.cause) : ""
  })

describe("moving messages", () => {
  it.live(
    "moves in one fork only, inherited by forks made after, and Undo restores the order",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const a = yield* t.append(t.main, null, "a")
          const b = yield* t.append(t.main, a, "b")
          const c = yield* t.append(t.main, b, "c")
          const d = yield* t.append(t.main, c, "d")
          const before = yield* t.fork(t.main, d)
          const moved = yield* t.move(t.main, c, "up")
          assert.strictEqual(moved.position, 1)
          assert.deepStrictEqual(yield* t.order(t.main), [a, c, b, d])
          assert.deepStrictEqual(yield* t.path(t.main), [a, c, b, d])
          assert.deepStrictEqual(yield* t.order(before), [a, b, c, d])
          const after = yield* t.fork(t.main, d)
          assert.deepStrictEqual(yield* t.order(after), [a, c, b, d])
          // A move in the later fork leaves the first alone.
          yield* t.move(after, a, "down")
          assert.deepStrictEqual(yield* t.order(after), [c, a, b, d])
          assert.deepStrictEqual(yield* t.order(t.main), [a, c, b, d])
          yield* t.undo(t.main, moved.undo)
          assert.deepStrictEqual(yield* t.order(t.main), [a, b, c, d])
          assert.include(yield* failure(t.undo(t.main, moved.undo)), "StaleWrite")
          assert.deepStrictEqual(yield* t.order(after), [c, a, b, d])
          // Down past the tip: the last message shown is the moved one.
          yield* t.move(t.main, c, "down")
          assert.deepStrictEqual(yield* t.path(t.main), [a, b, d, c])
          yield* t.move(t.main, c, "up")
          assert.deepStrictEqual(yield* t.path(t.main), [a, b, c, d])
          // Back at its own place: no move in effect.
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ flag: number }>`SELECT flag FROM fork_overrides
            WHERE fork_id = ${t.main} AND kind = 'move' AND target_id = ${c} ORDER BY seq DESC LIMIT 1`
          assert.strictEqual(rows[0]!.flag, 0)
          assert.include(yield* failure(t.move(t.main, a, "up")), "MoveRefused")
          assert.include(yield* failure(t.move(t.main, d, "down")), "MoveRefused")
        }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(dataDir), readonly: true })))
      ),
    60_000
  )

  it.live(
    "skips deleted neighbours, and what was moved after the message stays in place",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          const a = yield* t.append(t.main, null, "a")
          const b = yield* t.append(t.main, a, "b")
          const c = yield* t.append(t.main, b, "c")
          const d = yield* t.append(t.main, c, "d")
          yield* t.remove(t.main, b)
          yield* t.move(t.main, c, "up")
          assert.deepStrictEqual(yield* t.order(t.main), [c, a, b, d])
          // d moved up lands after c; moving c down again leaves d where it is.
          yield* t.move(t.main, d, "up")
          assert.deepStrictEqual(yield* t.order(t.main), [c, d, a, b])
          const result = yield* t.move(t.main, c, "down")
          assert.deepStrictEqual(yield* t.order(t.main), [d, c, a, b])
          yield* t.undo(t.main, result.undo)
          assert.deepStrictEqual(yield* t.order(t.main), [c, d, a, b])
        })
      ),
    60_000
  )

  it.live(
    "matches an array oracle over random moves, deletions, insertions and forks at hundreds of messages",
    () =>
      run((dataDir) =>
        Effect.gen(function* () {
          const t = yield* setup(dataDir)
          let seed = 7
          const random = (n: number) => {
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed % n
          }
          const ids: Array<SlotId> = []
          let parent: SlotId | null = null
          for (let i = 0; i < 600; i++) {
            parent = yield* t.append(t.main, parent, `m${i}`)
            ids.push(parent)
          }
          // Oracle: the full display order (deleted included) and the deleted set, per fork.
          const forks = new Map<ForkId, { order: Array<SlotId>; deleted: Set<SlotId> }>([
            [t.main, { order: [...ids], deleted: new Set() }]
          ])
          const forkIds = [t.main]
          const names = new Map<string, string>(ids.map((id, i) => [id, `m${i}`]))
          const label = (id: string | undefined) => (id === undefined ? "-" : (names.get(id) ?? "?"))
          const log: Array<string> = []
          let last = ""
          // Sibling forks from the start: moves in one never reach another.
          for (let i = 0; i < 3; i++) {
            const made = yield* t.fork(t.main, ids.at(-1)!)
            forks.set(made, { order: [...ids], deleted: new Set() })
            forkIds.push(made)
          }
          for (let step = 0; step < 300; step++) {
            const forkId = forkIds[random(forkIds.length)]!
            const state = forks.get(forkId)!
            const visible = state.order.filter((id) => !state.deleted.has(id))
            const roll = random(20)
            last = `fork ${forkIds.indexOf(forkId)}: `
            // A fork at the tip while the tip is shown last: it shows exactly what its parent shows.
            if (
              roll === 0 &&
              forkIds.length < 6 &&
              state.order.at(-1) === ids.at(-1) &&
              !state.deleted.has(ids.at(-1)!)
            ) {
              const made = yield* t.fork(forkId, ids.at(-1)!)
              forks.set(made, { order: [...state.order], deleted: new Set(state.deleted) })
              forkIds.push(made)
              last += "fork"
            } else if (roll === 1 && visible.length > 10) {
              const victim = visible[random(visible.length)]!
              yield* t.remove(forkId, victim)
              state.deleted.add(victim)
              last += `delete ${label(victim)}`
            } else if (roll === 2) {
              const anchor = visible[random(visible.length)]!
              const made = yield* t.insert(forkId, anchor, `x${step}`)
              names.set(made, `x${step}`)
              last += `insert x${step} below ${label(anchor)}`
              state.order.splice(state.order.indexOf(anchor) + 1, 0, made)
            } else {
              const index = random(visible.length)
              const slot = visible[index]!
              const direction = random(2) === 0 ? "up" : "down"
              const exit = yield* Effect.exit(t.move(forkId, slot, direction))
              const neighbour = visible[direction === "up" ? index - 1 : index + 1]
              last += `${label(slot)} ${direction}`
              if (neighbour === undefined) {
                assert.isTrue(Exit.isFailure(exit), "an end can't move further")
                continue
              }
              assert.isTrue(Exit.isSuccess(exit), `moved ${direction}`)
              if ((roll === 3 || roll === 4) && Exit.isSuccess(exit)) {
                // Undone at once: the order is back as it was.
                yield* t.undo(forkId, exit.value.undo)
                last += " undone"
              } else {
                state.order.splice(state.order.indexOf(slot), 1)
                const at = state.order.indexOf(neighbour)
                state.order.splice(direction === "up" ? at : at + 1, 0, slot)
              }
            }
            log.push(last)
            for (const [id, expected] of forks) {
              const actual = yield* t.order(id)
              const at = actual.findIndex((slot, i) => slot !== expected.order[i])
              if (at >= 0 || actual.length !== expected.order.length)
                assert.fail(
                  `moves ${(yield* t.moves(id)).map((m) => `${label(m.id)}>${label(m.anchorId ?? undefined)}@${m.seq}`).join(" ")}; ` +
                    `step ${step} (${log.slice(-4).join("; ")}), fork ${forkIds.indexOf(id)}, from ${at}: ` +
                    `${actual
                      .slice(Math.max(0, at - 3), at + 4)
                      .map(label)
                      .join(" ")} instead of ` +
                    `${expected.order
                      .slice(Math.max(0, at - 3), at + 4)
                      .map(label)
                      .join(" ")}`
                )
            }
          }
          for (const [id, expected] of forks)
            assert.deepStrictEqual(
              yield* t.path(id),
              expected.order.filter((slot) => !expected.deleted.has(slot))
            )
        })
      ),
    300_000
  )
})
