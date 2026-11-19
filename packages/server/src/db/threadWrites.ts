// Starting parallel threads (spec/THREADS.md §5.2, TH2; DESIGN §3.3 [D]), in the writer worker:
// one transaction makes the split, a fork per new thread at S beside the branch F the user is
// in (which continues as the first thread), each thread's away marks at S, each new thread's
// composer, and, started at an earlier message, the played stretch's correction (§5.2 step 5,
// [D] 2026-11-12): the characters moved to another thread count as not there for the messages F
// shows after S, in F and branches made from it later only. Rename and Undo (a bin item).
import type { EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import { cleanName } from "@dreamspan/shared/chatName.ts"
import { composerKey } from "@dreamspan/shared/drafts.ts"
import { type FoldableEvent, foldState } from "@dreamspan/shared/state.ts"
import { ThreadsRefused } from "@dreamspan/shared/threads.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { identitiesOf } from "../assembler/knowledge.ts"
import { type Bin, toBinItem } from "./bin.ts"
import { displayLength, displaySlots, pathPieces, positionOf, slotPlace } from "./displayPath.ts"
import { insertFork, selectionIn, slotDeletedIn } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { type ChatRow, type ForkRow, toChat } from "./rows.ts"
import { stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { insertCorrections, insertSplit, insertThreadMember } from "./threads.ts"
import { transaction } from "./tx.ts"

export const makeThreadWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const graph = makeGraphWrites(sql, bin.drafts)

    /** Fork `fork`'s state at slot `slotId` on its display path: its cast, who's away, its narrators. */
    const stateAt = (chatId: string, fork: string, slotId: string) =>
      Effect.gen(function* () {
        const rows = yield* stateEventsThrough(sql, chatId as never, slotId as never, fork)
        const events = yield* withoutPurged(
          sql,
          rows.map((e) => ({
            scope: e.scope,
            data: { key: e.key, value: JSON.parse(e.value_json) }
          })) as Array<FoldableEvent>
        )
        return { state: foldState(events), identities: identitiesOf(events) }
      })

    const handlers = {
      StartThreads: ({ userId, chatId, forkId, slotId, expectedRowVersion, threads }) =>
        Effect.gen(function* () {
          const at = Date.now()
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)

          // 1. S is on F's display path and not deleted there, as the tab saw it.
          const place = yield* slotPlace(sql, chatId, slotId)
          if (place === null) return yield* new NotFound({ entity: "slot", id: slotId })
          const pieces = yield* pathPieces(sql, chatId, fork.id, fork.tip_slot_id)
          const position = positionOf(pieces, place)
          const [slot] = yield* sql<{ row_version: number; deleted: number }>`
            SELECT s.row_version, ${slotDeletedIn(sql, fork.id, "s")} AS deleted FROM slots s WHERE s.id = ${slotId}`
          const selection = yield* selectionIn(sql, fork.id, slotId)
          const rowVersion = slot!.row_version + (selection?.seq ?? 0)
          if (position === null || slot!.deleted === 1 || rowVersion !== expectedRowVersion)
            return yield* new StaleWrite({
              entity: "slot",
              id: slotId,
              expected: expectedRowVersion,
              actual: rowVersion
            })

          // Who is in each thread: cast members and the user's own cards (narrators are in every
          // one and need no listing). Only cast characters are marked away.
          const { state, identities } = yield* stateAt(chatId, fork.id, slotId)
          const narrators = new Set(state.participants.filter((id) => state.roles[id] === "narrator"))
          const characters = state.participants.filter((id) => !narrators.has(id))
          const known = new Set<string>([...state.participants, ...state.playedByMe])
          if (threads.length < 2) return yield* new ThreadsRefused({ message: "Start at least two threads." })
          for (const [index, thread] of threads.entries()) {
            if (thread.cast.some((id) => !known.has(id)))
              return yield* new ThreadsRefused({ message: "A thread names someone who isn't in this chat's cast." })
            if (!thread.cast.some((id) => characters.includes(id)) && narrators.size === 0)
              return yield* new ThreadsRefused({ message: `Thread ${index + 1} has no character in it.` })
            if (thread.writesAs !== null && !known.has(thread.writesAs))
              return yield* new ThreadsRefused({ message: "A thread writes as someone who isn't in this chat's cast." })
          }

          // 2–3. The split, F continuing as its first thread, then a fork per new thread at S.
          const names = threads.map((thread) => {
            const name = cleanName(thread.name ?? "")
            return name === "" ? null : name
          })
          const split = yield* insertSplit(sql, { chatId, slotId, forkId: fork.id, name: names[0]!, at })
          const forks: Array<ForkRow> = [fork]
          for (let ordinal = 1; ordinal < threads.length; ordinal++) {
            const made = yield* insertFork(sql, { chatId, parent: fork, baseSlotId: slotId, tipSlotId: slotId, at })
            yield* graph.placeAsShown(chatId, fork, slotId, made)
            yield* insertThreadMember(sql, {
              splitId: split.id,
              ordinal,
              forkId: made.id,
              starts: true,
              name: names[ordinal]!
            })
            forks.push(made)
          }

          // Each new thread's composer: empty, with F's choices, writing as its card.
          const [from] = yield* sql<{
            speaker_entity_id: string | null
            reply_from_entity_id: string | null
            guidance: number
            no_replies: number
          }>`SELECT speaker_entity_id, reply_from_entity_id, guidance, no_replies FROM drafts
            WHERE user_id = ${userId} AND target_kind = 'composer' AND target_id = ${chatId} AND field = ${fork.id}`
          for (const [ordinal, member] of forks.entries()) {
            const writesAs = threads[ordinal]!.writesAs
            if (ordinal === 0 && writesAs === null) continue
            const composer = yield* bin.drafts.openComposer(userId, composerKey(chatId, member.id), null)
            yield* bin.drafts.setComposerChoice(userId, chatId, composer.id, {
              ...(ordinal === 0 || from === undefined
                ? {}
                : {
                    replyFromEntityId: from.reply_from_entity_id as EntityId | null,
                    guidance: from.guidance === 1,
                    noReplies: from.no_replies === 1
                  }),
              speakerEntityId: (writesAs ?? from?.speaker_entity_id ?? null) as EntityId | null
            })
          }

          // 4. In each thread at S: the cast of the others away, its own back if away. Written
          // after the forks were made, so each thread's marks are its own.
          const marks = (ordinal: number) => {
            const cast = new Set<string>(threads[ordinal]!.cast)
            return characters.flatMap((entity) => {
              const away = state.away.includes(entity)
              return cast.has(entity) === !away ? [] : [{ entity, away: !cast.has(entity) }]
            })
          }
          for (const [ordinal, member] of forks.entries())
            for (const mark of marks(ordinal))
              yield* graph.insertStateEvent(
                userId,
                chatId,
                slotId,
                null,
                null,
                { key: "away.set", value: { entity: mark.entity as EntityId, away: mark.away } },
                member.id,
                { origin: "user", ref: split.id }
              )

          // 5. At an earlier message, the played stretch is F's thread's: characters assigned elsewhere
          // count as not there for the messages F shows after S, deleted ones included.
          const end = displayLength(pieces) - 1
          if (position < end) {
            const cast = new Set<string>(threads[0]!.cast)
            const moved = [
              ...new Set(characters.filter((id) => !cast.has(id)).flatMap((id) => identities.get(id) ?? [id]))
            ]
            const played = yield* sql<{ id: string }>`
              ${displaySlots(sql, pieces, position + 1, end)} SELECT id FROM display_slots ORDER BY position`
            yield* insertCorrections(
              sql,
              { id: split.id, chatId, forkId: fork.id },
              played.map((row) => row.id),
              moved
            )
          }

          // The user stays where they were: F stays current, and the shell lists the new forks.
          const [chat] =
            yield* sql<ChatRow>`UPDATE chats SET row_version = row_version + 1 WHERE id = ${chatId} RETURNING *`
          return { splitId: split.id, forkIds: forks.map((f) => f.id as ForkId), chat: toChat(chat!) }
        }).pipe(transaction(sql, "StartThreads")),

      RenameThread: ({ userId, chatId, splitId, ordinal, name, rowVersion }) =>
        Effect.gen(function* () {
          const [member] = yield* sql<{ row_version: number }>`
            SELECT m.row_version FROM thread_members m JOIN thread_splits x ON x.id = m.split_id
              JOIN chats c ON c.id = x.chat_id
            WHERE m.split_id = ${splitId} AND m.ordinal = ${ordinal} AND x.chat_id = ${chatId}
              AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`
          if (!member) return yield* new NotFound({ entity: "thread", id: `${splitId}#${ordinal}` })
          if (member.row_version !== rowVersion)
            return yield* new StaleWrite({
              entity: "thread",
              id: `${splitId}#${ordinal}`,
              expected: rowVersion,
              actual: member.row_version
            })
          const clean = cleanName(name)
          const [renamed] = yield* sql<{ row_version: number }>`UPDATE thread_members
            SET name = ${clean === "" ? null : clean}, name_user = ${clean === "" ? 0 : 1}, row_version = row_version + 1
            WHERE split_id = ${splitId} AND ordinal = ${ordinal} RETURNING row_version`
          yield* sql`UPDATE chats SET row_version = row_version + 1 WHERE id = ${chatId}`
          return renamed!.row_version
        }).pipe(transaction(sql, "RenameThread")),

      UndoThreads: ({ userId, chatId, splitId }) =>
        Effect.gen(function* () {
          const itemId = yield* bin.removeThreads(userId, chatId, splitId)
          yield* bin.evictDeleted(userId, itemId)
          return toBinItem(yield* bin.loadItem(userId, itemId))
        }).pipe(transaction(sql, "UndoThreads"))
    } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
    return handlers
  })
