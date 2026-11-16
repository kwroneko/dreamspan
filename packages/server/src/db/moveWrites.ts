// Moving a message up or down in one branch (owner, 2026-11-16): `move` overrides of that fork,
// which show the slot directly after another one (displayPath.ts). Forks made from it later
// inherit the order; no other fork changes. One writer transaction each; Undo writes back what
// the move replaced, while nothing changed it since.
import type { SlotId } from "@rp/shared/chat.ts"
import { MoveRefused, type MoveStep } from "@rp/shared/messagesApi.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import {
  arrange,
  arrangementOf,
  type Moved,
  type PathPiece,
  positionOf,
  segmentsTo,
  slotAtPosition,
  slotPlace
} from "./displayPath.ts"
import { selectionIn, slotDeletedIn, writeOverride } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { type ChatRow, toChat } from "./rows.ts"
import { transaction } from "./tx.ts"

type Handlers = Parameters<typeof WriteOps.of>[0]
type Place = MoveStep["before"]

/** Where the fork shows `slotId` by its moves: after an anchor, or at its own place (null). */
const placeOf = (moves: ReadonlyArray<Moved>, slotId: string): Place => {
  const move = moves.find((m) => m.id === slotId)
  return move === undefined ? null : { anchor: (move.anchorId ?? null) as SlotId | null, seq: move.seq }
}

const samePlace = (a: Place, b: Place) => (a === null ? b === null : b !== null && a.anchor === b.anchor)

export const makeMoveWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)

    const deletedIn = (forkId: string, slotId: string) =>
      Effect.map(
        sql<{
          deleted: number
        }>`SELECT ${slotDeletedIn(sql, forkId, "s")} AS deleted FROM slots s WHERE s.id = ${slotId}`,
        ([row]) => row?.deleted === 1
      )

    const writePlace = (fork: { id: string; chatId: string }, slotId: string, place: Place) =>
      writeOverride(sql, fork, {
        kind: "move",
        targetId: slotId,
        slotId,
        valueId: place?.anchor ?? null,
        flag: place === null ? 0 : 1
      })

    const display = (chatId: string, forkId: string, tip: string | null) =>
      Effect.gen(function* () {
        const arrangement = yield* arrangementOf(sql, chatId, forkId)
        const segments = yield* segmentsTo(sql, chatId, tip)
        return { arrangement, segments, pieces: arrange(segments, arrangement) }
      })

    /** The next shown, not deleted slot from `position` in steps of `step`, with its position. */
    const neighbour = (pieces: ReadonlyArray<PathPiece>, forkId: string, position: number, step: 1 | -1) =>
      Effect.gen(function* () {
        for (let i = position + step; i >= 0; i += step) {
          const id = yield* slotAtPosition(sql, pieces, i)
          if (id === null) return null
          if (!(yield* deletedIn(forkId, id))) return { id, position: i }
        }
        return null
      })

    const bumpChat = (chatId: string) =>
      Effect.map(
        sql<ChatRow>`UPDATE chats SET row_version = row_version + 1 WHERE id = ${chatId} RETURNING *`,
        ([chat]) => toChat(chat!)
      )

    return {
      MoveMessage: ({ userId, chatId, forkId, slotId, direction, expectedRowVersion }) =>
        Effect.gen(function* () {
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)
          const ref = { id: fork.id, chatId }
          const [row] = yield* sql<{ row_version: number }>`
            SELECT row_version FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`
          if (!row) return yield* new NotFound({ entity: "slot", id: slotId })
          const place = (yield* slotPlace(sql, chatId, slotId))!
          const before = yield* display(chatId, fork.id, fork.tip_slot_id)
          const position = positionOf(before.pieces, place)
          if (position === null || (yield* deletedIn(fork.id, slotId))) {
            const selection = yield* selectionIn(sql, fork.id, slotId)
            return yield* new StaleWrite({
              entity: "slot",
              id: slotId,
              expected: expectedRowVersion,
              actual: row.row_version + (selection?.seq ?? 0)
            })
          }
          const next = yield* neighbour(before.pieces, fork.id, position, direction === "up" ? -1 : 1)
          if (next === null)
            return yield* new MoveRefused({
              message: direction === "up" ? "This is already the first message." : "This is already the last message."
            })
          // Up: after whatever is shown directly above the neighbour (the top when it's first).
          // Down: after the neighbour.
          const anchor =
            direction === "down"
              ? next.id
              : next.position === 0
                ? null
                : yield* slotAtPosition(sql, before.pieces, next.position - 1)
          const above = position === 0 ? null : yield* slotAtPosition(sql, before.pieces, position - 1)

          const steps: Array<MoveStep> = []
          // What was shown after the slot by a move stays where it is: after what was above it.
          // Oldest first, so they keep their order (the newest shows first).
          const children = before.arrangement.moves.filter((m) => m.anchorId === slotId).sort((a, b) => a.seq - b.seq)
          for (const child of children) {
            const after: Place = { anchor: above as SlotId | null }
            steps.push({ slotId: child.id as SlotId, before: { anchor: slotId, seq: child.seq }, after })
            yield* writePlace(ref, child.id, after)
          }
          let after: Place = { anchor: anchor as SlotId | null }
          yield* writePlace(ref, slotId, after)
          // Back where it would be without a move: its own place, with no row in effect.
          const moved = yield* arrangementOf(sql, chatId, fork.id)
          const without = arrange(before.segments, {
            placed: moved.placed,
            moves: moved.moves.filter((m) => m.id !== slotId)
          })
          const own = positionOf(without, place)
          if (
            own !== null &&
            (own === 0 ? anchor === null : (yield* slotAtPosition(sql, without, own - 1)) === anchor)
          ) {
            after = null
            yield* writePlace(ref, slotId, null)
          }
          steps.push({ slotId: slotId as SlotId, before: placeOf(before.arrangement.moves, slotId), after })
          const now = yield* display(chatId, fork.id, fork.tip_slot_id)
          return { position: positionOf(now.pieces, place)!, undo: steps, chat: yield* bumpChat(chatId) }
        }).pipe(transaction(sql, "MoveMessage")),

      UndoMove: ({ userId, chatId, forkId, undo }) =>
        Effect.gen(function* () {
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)
          const { moves } = yield* arrangementOf(sql, chatId, fork.id)
          for (const step of undo) {
            const [slot] = yield* sql<{ row_version: number }>`
              SELECT row_version FROM slots WHERE id = ${step.slotId} AND chat_id = ${chatId}`
            if (!slot) return yield* new NotFound({ entity: "slot", id: step.slotId })
            if (!samePlace(placeOf(moves, step.slotId), step.after))
              return yield* new StaleWrite({
                entity: "slot",
                id: step.slotId,
                expected: slot.row_version,
                actual: slot.row_version
              })
          }
          // Each slot back after its anchor, in the order it had among the slots moved there: those
          // and the restored ones are written again oldest first (by the seq each had then).
          const restored = new Set<string>(undo.map((step) => step.slotId))
          const ref = { id: fork.id, chatId }
          const anchors = new Map<string | null, Array<{ id: string; seq: number }>>()
          for (const step of undo) {
            if (step.before === null) {
              yield* writePlace(ref, step.slotId, null)
              continue
            }
            const anchor = step.before.anchor
            let list = anchors.get(anchor)
            if (list === undefined) {
              list = moves
                .filter((m) => m.anchorId === anchor && !restored.has(m.id))
                .map((m) => ({ id: m.id, seq: m.seq }))
              anchors.set(anchor, list)
            }
            list.push({ id: step.slotId, seq: step.before.seq ?? Number.MAX_SAFE_INTEGER })
          }
          for (const [anchor, list] of anchors)
            for (const slot of list.sort((a, b) => a.seq - b.seq))
              yield* writePlace(ref, slot.id, { anchor: anchor as SlotId | null })
          return yield* bumpChat(chatId)
        }).pipe(transaction(sql, "UndoMove"))
    } satisfies Partial<Handlers>
  })
