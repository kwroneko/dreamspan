// Write handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the writer worker, each as one transaction.
//
// The queue (migration 0012): a message sent, or a reply asked for, onto a message whose
// selected version is still generating waits in `queued_messages` under that slot. When a
// generation of the slot ends and its selected version isn't generating any more, the
// first entry posts after it, in the same transaction (FinishGeneration): a message, then
// a reply to it, or the reply asked for. The rest wait for that reply. One rule covers
// Send and Generate: whatever is aimed at a reply still being written waits for it.
import { type ChatId, type EntityId, NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { loadCards } from "./cards.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { LeafMoved, NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { chatQueue, ownedQueued, type QueuedRow, toQueued } from "./queueRows.ts"
import { toVersion } from "./rows.ts"
import { transaction as runTransaction } from "./tx.ts"

const userMessage = (content: string, speakerEntityId: EntityId | null) =>
  new NewVersion({
    speakerEntityId,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })

const reply = (speakerEntityId: EntityId | null, direction: string | null) =>
  new NewVersion({
    speakerEntityId,
    writer: "model",
    content: "",
    status: "generating",
    macroMode: "verbatim",
    origin: "generated",
    ...(direction !== null && direction.trim() !== "" ? { direction } : {})
  })

/** A chat's default title: its cast, never just the first character's name (DESIGN §2.1). */
const titleFor = (names: ReadonlyArray<string>, at: number) =>
  names.length > 1
    ? names.join(" & ")
    : `${names[0] ?? "Chat"}, ${new Date(at).toLocaleDateString("en", { day: "numeric", month: "short" })}`

type WriteHandlers = Parameters<typeof WriteOps.of>[0]

export const makeChatSetupWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const transaction = (operation: string) => runTransaction(sql, operation)
    const graph = makeGraphWrites(sql, bin.drafts)

    /** The speaker still a live card of the owner's, else nobody: posting never fails on a card binned since. */
    const liveSpeaker = (owner: UserId, speaker: string | null) =>
      speaker === null
        ? Effect.succeed(null)
        : sql<{ n: number }>`SELECT count(*) AS n FROM entities WHERE id = ${speaker} AND owner_user_id = ${owner}
            AND kind = 'card' AND deleted_at IS NULL`.pipe(
            Effect.map(([row]) => (row?.n === 1 ? (speaker as EntityId) : null))
          )

    const nothing = { posted: [] as Array<SlotId>, next: null, withdrawn: 0, queueChanged: false, queue: [] }

    /**
     * The queue behind a slot whose generation just ended. `reply`: the first entry posts
     * and the rest wait for its reply. `restart` (no generation can start: the server is
     * starting up): every queued message posts in order, without replies, and queued
     * replies are dropped, so the server doesn't spend on a provider with nobody there.
     */
    const afterReply = (replySlotId: string, mode: "reply" | "restart") =>
      Effect.gen(function* () {
        const entries = yield* sql<QueuedRow>`
          SELECT * FROM queued_messages WHERE reply_slot_id = ${replySlotId} ORDER BY seq`
        if (entries.length === 0) return nothing
        const [slot] = yield* sql<{
          chat_id: string
          slot_deleted: number | null
          chat_deleted: number | null
          owner_user_id: string
          active_leaf_slot_id: string | null
          status: string
        }>`
          SELECT s.chat_id, s.deleted_at AS slot_deleted, c.deleted_at AS chat_deleted, c.owner_user_id,
            c.active_leaf_slot_id, v.status
          FROM slots s JOIN chats c ON c.id = s.chat_id JOIN versions v ON v.id = s.selected_version_id
          WHERE s.id = ${replySlotId}`
        const chatId = slot!.chat_id as ChatId
        const owner = slot!.owner_user_id as UserId
        // The reply went to the bin (or its chat did): what waited for it is withdrawn.
        if (slot!.slot_deleted !== null || slot!.chat_deleted !== null) {
          yield* sql`DELETE FROM queued_messages WHERE reply_slot_id = ${replySlotId}`
          return { ...nothing, withdrawn: entries.length, queueChanged: true, queue: yield* chatQueue(sql, chatId) }
        }
        // Still being written: another version of the slot is selected and generating.
        if (slot!.status === "generating") return nothing
        // The user moved to another branch while it waited: it posts where it was sent, and
        // the chat stays where the user is. Silently moving them back would hide what they
        // sent there since.
        const keepLeaf = slot!.active_leaf_slot_id !== replySlotId
        // A branch from a live slot of a live chat: neither NotFound nor LeafMoved can happen.
        const append = (parentSlotId: string, version: NewVersion) =>
          graph
            .appendMessage({
              userId: owner,
              chatId,
              parentSlotId: parentSlotId as SlotId,
              branch: true,
              version,
              commitDraft: null,
              keepLeaf
            })
            .pipe(Effect.catchTag(["NotFound", "LeafMoved"], (error) => Effect.die(error)))
        const posted: Array<SlotId> = []
        if (mode === "restart") {
          let parent = replySlotId
          for (const entry of entries) {
            if (entry.kind === "message") {
              const message = yield* append(
                parent,
                userMessage(entry.content, yield* liveSpeaker(owner, entry.speaker_entity_id))
              )
              posted.push(message.slotId)
              parent = message.slotId
            }
          }
          yield* sql`DELETE FROM queued_messages WHERE reply_slot_id = ${replySlotId}`
          return { ...nothing, posted, queueChanged: true, queue: yield* chatQueue(sql, chatId) }
        }
        const [first] = entries
        // A message's reply comes from whoever was picked when it was sent, as for a send then.
        const replySpeaker = yield* liveSpeaker(owner, first!.reply_speaker_entity_id)
        const speaker = yield* liveSpeaker(owner, first!.speaker_entity_id)
        let replyParent = replySlotId
        if (first!.kind === "message") {
          const message = yield* append(replySlotId, userMessage(first!.content, speaker))
          posted.push(message.slotId)
          replyParent = message.slotId
        }
        const next = yield* append(
          replyParent,
          first!.kind === "message" ? reply(replySpeaker, null) : reply(speaker, first!.direction)
        )
        posted.push(next.slotId)
        yield* sql`DELETE FROM queued_messages WHERE id = ${first!.id}`
        yield* sql`UPDATE queued_messages SET reply_slot_id = ${next.slotId}, updated_at = ${Date.now()}
          WHERE reply_slot_id = ${replySlotId}`
        return {
          posted,
          next: { slotId: next.slotId, versionId: next.version.id as VersionId },
          withdrawn: 0,
          queueChanged: true,
          queue: yield* chatQueue(sql, chatId)
        }
      })

    const handlers = {
      StartChat: ({ userId, cards, persona, greeting, first, frozen }) =>
        Effect.gen(function* () {
          const ids = [...new Set([...cards, ...(persona === null ? [] : [persona])])]
          const loaded = yield* loadCards(sql, userId, ids)
          for (const id of ids) {
            if (!loaded.some(({ card }) => card.entityId === id && !card.inBin)) {
              return yield* new NotFound({ entity: "card", id })
            }
          }
          const byId = new Map(loaded.map((card) => [card.card.entityId as string, card]))
          const lead = byId.get(cards[0]!)!
          const at = Date.now()
          const chatId = uuidv7() as ChatId
          const laneId = uuidv7()
          const names = ids.map((id) => byId.get(id)!.card.name)
          yield* sql`INSERT INTO chats ${sql.insert({
            id: chatId,
            owner_user_id: userId,
            kind: "rp",
            status: "active",
            title: titleFor(names, at),
            created_at: at
          })}`
          yield* sql`INSERT INTO lanes ${sql.insert({ id: laneId, chat_id: chatId, name: "main", created_at: at })}`
          for (const entity of ids) {
            yield* graph.insertStateEvent(userId, chatId, null, null, null, {
              key: "participant.join",
              value: { entity }
            })
          }
          if (persona !== null) {
            yield* graph.insertStateEvent(userId, chatId, null, null, null, {
              key: "played_by_me.set",
              value: { entities: [persona] }
            })
          }
          // Every greeting is a version of the first message, its macros kept for display
          // and assembly to resolve against the chat's state (DESIGN §5.6).
          let root: SlotId | null = null
          const greetingVersion = (i: number) =>
            new NewVersion({
              speakerEntityId: lead.card.entityId,
              writer: "model",
              content: lead.greetings[i]!,
              status: "complete",
              macroMode: "template",
              origin: "greeting",
              greetingRef: { entity: lead.card.entityId, index: lead.greetingIndexes[i]! },
              ...(frozen[i] && Object.keys(frozen[i]).length > 0 ? { frozenMacros: frozen[i] } : {})
            })
          if (lead.greetings.length > 0) {
            const { slotId, version } = yield* graph.insertSlot(chatId, laneId, null, greetingVersion(0), at)
            let selected = version.id
            for (let i = 1; i < lead.greetings.length; i++) {
              const row = yield* graph.insertVersion(slotId, i, greetingVersion(i), at)
              if (i === greeting) selected = row.id
            }
            yield* sql`UPDATE slots SET selected_version_id = ${selected} WHERE id = ${slotId}`
            yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId}, last_message_at = ${at} WHERE id = ${chatId}`
            root = slotId as SlotId
          }
          const version =
            first._tag === "Send"
              ? userMessage(first.content, first.speakerEntityId)
              : reply(first.speakerEntityId, first.direction)
          return yield* graph
            .appendMessage({ userId, chatId, parentSlotId: root, branch: false, version, commitDraft: null })
            .pipe(
              // Its parent is the new chat's leaf; only a speaker can be missing.
              Effect.catchTag("LeafMoved", (error) => Effect.die(error))
            )
        }).pipe(transaction("StartChat")),

      SendOrQueue: ({
        userId,
        chatId,
        parentSlotId,
        branch,
        kind,
        content,
        speakerEntityId,
        replySpeakerEntityId,
        direction
      }) =>
        Effect.gen(function* () {
          const chat = yield* graph.ownedChat(userId, chatId)
          yield* graph.checkSpeaker(userId, speakerEntityId)
          if (kind === "message") yield* graph.checkSpeaker(userId, replySpeakerEntityId)
          if (parentSlotId !== null) {
            const [parent] = yield* sql<{ status: string }>`
              SELECT v.status FROM slots s JOIN versions v ON v.id = s.selected_version_id
              WHERE s.id = ${parentSlotId} AND s.chat_id = ${chatId} AND s.deleted_at IS NULL`
            if (!parent) return yield* new NotFound({ entity: "slot", id: parentSlotId })
            // A tab that missed a newer message hears about it, queued or not.
            if (!branch && parentSlotId !== chat.active_leaf_slot_id) {
              return yield* new LeafMoved({ chatId, activeLeafSlotId: chat.active_leaf_slot_id })
            }
            if (parent.status === "generating") {
              const at = Date.now()
              const [next] = yield* sql<{ n: number }>`
                SELECT coalesce(max(seq), -1) + 1 AS n FROM queued_messages WHERE chat_id = ${chatId}`
              const [row] = yield* sql<QueuedRow>`INSERT INTO queued_messages ${sql.insert({
                id: uuidv7(),
                chat_id: chatId,
                reply_slot_id: parentSlotId,
                seq: next!.n,
                kind,
                content: kind === "message" ? content : "",
                speaker_entity_id: speakerEntityId,
                reply_speaker_entity_id: kind === "message" ? replySpeakerEntityId : null,
                direction: kind === "generate" && direction !== null && direction.trim() !== "" ? direction : null,
                created_at: at,
                updated_at: at
              })} RETURNING *`
              return { _tag: "Queued" as const, queued: toQueued(row!), queue: yield* chatQueue(sql, chatId) }
            }
          }
          const result = yield* graph.appendMessage({
            userId,
            chatId,
            parentSlotId,
            branch,
            version: kind === "message" ? userMessage(content, speakerEntityId) : reply(speakerEntityId, direction),
            commitDraft: null
          })
          return { _tag: "Posted" as const, result }
        }).pipe(transaction("SendOrQueue")),

      EditQueued: ({ userId, queuedId, content, speakerEntityId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const row = yield* ownedQueued(sql, userId, queuedId)
          if (row === null) return yield* new NotFound({ entity: "queued message", id: queuedId })
          if (row.row_version !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "queued message",
              id: queuedId,
              expected: expectedRowVersion,
              actual: row.row_version
            })
          }
          yield* graph.checkSpeaker(userId, speakerEntityId)
          const [updated] = yield* sql<QueuedRow>`
            UPDATE queued_messages SET content = ${row.kind === "message" ? content : ""},
              speaker_entity_id = ${speakerEntityId}, row_version = row_version + 1, updated_at = ${Date.now()}
            WHERE id = ${queuedId} RETURNING *`
          return { queued: toQueued(updated!), queue: yield* chatQueue(sql, row.chat_id) }
        }).pipe(transaction("EditQueued")),

      WithdrawQueued: ({ userId, queuedId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const row = yield* ownedQueued(sql, userId, queuedId)
          if (row === null) return yield* new NotFound({ entity: "queued message", id: queuedId })
          // A tab that hasn't seen another's edit doesn't throw it away.
          if (row.row_version !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "queued message",
              id: queuedId,
              expected: expectedRowVersion,
              actual: row.row_version
            })
          }
          yield* sql`DELETE FROM queued_messages WHERE id = ${queuedId}`
          return { queued: toQueued(row), queue: yield* chatQueue(sql, row.chat_id) }
        }).pipe(transaction("WithdrawQueued")),

      SetPersona: ({ userId, entityId, persona }) =>
        Effect.gen(function* () {
          yield* graph.checkSpeaker(userId, entityId)
          if (persona) yield* sql`INSERT OR IGNORE INTO entity_tags (entity_id, tag) VALUES (${entityId}, 'persona')`
          else yield* sql`DELETE FROM entity_tags WHERE entity_id = ${entityId} AND tag = 'persona'`
        }).pipe(transaction("SetPersona")),

      FinishGeneration: ({ userId, versionId, content, status, error }) =>
        Effect.gen(function* () {
          const row = yield* graph.ownedVersion(userId, versionId, false)
          // A version deleted for good stays empty, whatever was still generating into it.
          if (
            row.writer !== "model" ||
            row.status !== "generating" ||
            row.purged_at !== null ||
            status === "generating"
          ) {
            return yield* new NotFound({ entity: "generating version", id: versionId })
          }
          yield* sql`UPDATE versions SET content = ${content}, status = ${status},
            error_json = ${error === null ? null : JSON.stringify(error)}, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          const version = toVersion(yield* graph.ownedVersion(userId, versionId, false))
          const [slot] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM slots WHERE id = ${row.slot_id}`
          // A reply interrupted by the server going down leaves its queue to the next start.
          const queue = status === "interrupted" ? nothing : yield* afterReply(row.slot_id, "reply")
          return { version, chatId: slot!.chat_id as ChatId, ...queue }
        }).pipe(transaction("FinishGeneration")),

      SelectAndDrain: ({ userId, slotId, versionId, expectedRowVersion }) =>
        Effect.gen(function* () {
          const { chatId } = yield* graph.selectVersion(userId, slotId, versionId, expectedRowVersion)
          // Selecting a finished version ends the wait, as its generation's end would have.
          return { chatId, ...(yield* afterReply(slotId, "reply")) }
        }).pipe(transaction("SelectAndDrain")),

      InterruptGenerations: () =>
        Effect.gen(function* () {
          const interrupted = yield* sql`UPDATE versions SET status = 'interrupted', updated_at = ${Date.now()}
            WHERE status = 'generating' RETURNING id`
          const waiting = yield* sql<{ reply_slot_id: string; n: number }>`
            SELECT reply_slot_id, count(*) AS n FROM queued_messages GROUP BY reply_slot_id`
          for (const { reply_slot_id } of waiting) yield* afterReply(reply_slot_id, "restart")
          return { interrupted: interrupted.length, queued: waiting.reduce((sum, { n }) => sum + n, 0) }
        }).pipe(transaction("InterruptGenerations"))
    } satisfies Partial<WriteHandlers>
    return handlers
  })
