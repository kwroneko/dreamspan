import { composerKey, Draft } from "@dreamspan/shared/drafts.ts"
import { composerImages } from "./composerImages.ts"
import { newChatLcmSettings } from "./generationSettings.ts"
import { makeShellWriteHandlers } from "./shellWrites.ts"
import { recordHistoryReduction } from "./historyChanges.ts"
// Write handlers for chat setup, speakers and the send queue (DESIGN §2.1, §2.2). They run
// in the writer worker, each as one transaction.
//
// The queue (migration 0012): a message sent, or a reply asked for, onto a message whose
// selected version is still generating waits in `queued_messages` under that slot. When a
// generation of the slot ends and its selected version isn't generating any more, the
// first entry posts after it, in the same transaction (FinishGeneration): a message, then
// a reply to it, or the reply asked for. The rest wait for that reply. One rule covers
// Send and Generate: whatever is aimed at a reply still being written waits for it.
import {
  type ChatId,
  type EntityId,
  type ForkId,
  NewVersion,
  type QueuedMessage,
  type SlotId,
  type VersionId
} from "@dreamspan/shared/chat.ts"
import { ThreadsRefused } from "@dreamspan/shared/threads.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Bin } from "./bin.ts"
import { loadCards } from "./cards.ts"
import { forkRecency, forkThrough, onForkPath } from "./forks.ts"
import { selectedIn, slotDeletedIn, nextSeq } from "./forkState.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { LeafMoved, NotFound, StaleWrite, type WriteOps } from "./ops.ts"
import { chatQueue, ownedQueued, type QueuedRow, toQueued } from "./queueRows.ts"
import { type ChatRow, rewriteColumns, toVersion, toChat } from "./rows.ts"
import { separateThreads } from "./threads.ts"
import type { StoredRewrite } from "@dreamspan/shared/regexScripts.ts"
import { transaction as runTransaction } from "./tx.ts"
import { checkAutoTurn, claimAutoTurn } from "./autoGuard.ts"

const userMessage = (
  content: string,
  speakerEntityId: EntityId | null,
  images?: import("@dreamspan/shared/chat.ts").MessageImages,
  rewrite?: StoredRewrite
) =>
  new NewVersion({
    speakerEntityId,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written",
    ...(images === undefined ? {} : { images }),
    ...(rewrite === undefined ? {} : { rewrite })
  })

/** A queued message's rewrite, as SendOrQueue stored it, for the version it posts as. */
const queuedRewrite = (row: QueuedRow): StoredRewrite | undefined =>
  row.rewrite_json === null
    ? undefined
    : {
        ...(JSON.parse(row.rewrite_json) as Pick<StoredRewrite, "applied" | "failed">),
        raw: row.raw_content,
        rawReasoning: null
      }

const reply = (speakerEntityId: EntityId | null, direction: string | null, autoPick = false) =>
  new NewVersion({
    speakerEntityId,
    // Auto's pick: the decision model's "Who replies next" may choose another before it's written.
    ...(autoPick && speakerEntityId !== null ? { speakerPick: { by: "auto" as const } } : {}),
    writer: "model",
    content: "",
    status: "generating",
    macroMode: "verbatim",
    origin: "generated",
    ...(direction !== null && direction.trim() !== "" ? { direction } : {})
  })

/**
 * A chat's default title: its characters, never just the first character's name (DESIGN §2.1).
 * The persona the user plays is left out, as the client's automatic name leaves it out
 * (`chatTitle.ts` `castCharacters`), so a 1:1 reads "Mira, Oct 31" much as an imported one does.
 */
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

    /** A message sent to several threads that queued keeps its group when it posts (spec/THREADS.md §6.2). */
    const keepGroup = (entry: QueuedRow, chatId: string, slotId: string) =>
      entry.send_group === null
        ? Effect.void
        : sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES (${slotId}, ${chatId}, ${entry.send_group})`.pipe(
            Effect.asVoid
          )

    const nothing = { posted: [] as Array<SlotId>, next: null, withdrawn: 0, queueChanged: false, queue: [] }

    /**
     * The queue behind a slot whose generation just ended, each fork's entries in that fork.
     * `reply`: a fork's first entry posts and the rest wait for its reply. `restart` (no generation can start: the server is
     * starting up): every queued message posts in order, without replies, and queued
     * replies are dropped, so the server doesn't spend on a provider with nobody there.
     */
    const afterReply = (replySlotId: string, mode: "reply" | "restart") =>
      Effect.gen(function* () {
        // A restart pauses a round rather than dropping it: Continue round picks it up.
        if (mode === "restart")
          yield* sql`UPDATE queued_messages SET held = 1, updated_at = ${Date.now()}
            WHERE reply_slot_id = ${replySlotId} AND round = 1 AND held = 0`
        // A stopped round's entries wait for Continue round, not for this reply.
        const entries = yield* sql<QueuedRow>`
          SELECT * FROM queued_messages WHERE reply_slot_id = ${replySlotId} AND held = 0 ORDER BY seq`
        if (entries.length === 0) return nothing
        const [slot] = yield* sql<{
          chat_id: string
          slot_deleted: number | null
          chat_deleted: number | null
          owner_user_id: string
        }>`
          SELECT s.chat_id, s.deleted_at AS slot_deleted, c.deleted_at AS chat_deleted, c.owner_user_id
          FROM slots s JOIN chats c ON c.id = s.chat_id WHERE s.id = ${replySlotId}`
        const chatId = slot!.chat_id as ChatId
        const owner = slot!.owner_user_id as UserId
        // The reply went to the bin (or its chat did): what waited for it is withdrawn.
        if (slot!.slot_deleted !== null || slot!.chat_deleted !== null) {
          yield* bin.recoverQueued(owner, entries)
          yield* sql`DELETE FROM queued_messages WHERE reply_slot_id = ${replySlotId}`
          return {
            ...nothing,
            withdrawn: entries.length,
            queueChanged: true,
            queue: yield* chatQueue(sql, chatId)
          }
        }
        // Each fork's entries post in that fork: two forks can wait on one reply when a fork
        // was made at it while it was being written. In the order each fork queued first.
        const groups = new Map<string | null, Array<QueuedRow>>()
        for (const entry of entries) groups.set(entry.fork_id, [...(groups.get(entry.fork_id) ?? []), entry])
        const posted: Array<SlotId> = []
        const replies: Array<{ slotId: SlotId; versionId: VersionId; forkId: ForkId }> = []
        let changed = false
        for (const [queuedIn, group] of groups) {
          const done = yield* postQueued(owner, chatId, replySlotId, queuedIn, group, mode)
          if (done === null) continue
          changed = true
          posted.push(...done.posted)
          if (done.next !== null) replies.push(done.next)
        }
        if (!changed) return nothing
        return {
          posted,
          next: replies[0] ?? null,
          ...(replies.length > 1 ? { more: replies.slice(1) } : {}),
          withdrawn: 0,
          queueChanged: true,
          queue: yield* chatQueue(sql, chatId)
        }
      })

    /**
     * The entries of one fork (`queuedIn`; null: queued before forks) waiting on a reply that
     * isn't being written any more, posted; null while that fork's reply is still generating.
     */
    const postQueued = (
      owner: UserId,
      chatId: ChatId,
      replySlotId: string,
      queuedIn: string | null,
      entries: ReadonlyArray<QueuedRow>,
      mode: "reply" | "restart"
    ) =>
      Effect.gen(function* () {
        const [slot] = yield* sql<{ status: string }>`
          SELECT v.status FROM slots s JOIN chats c ON c.id = s.chat_id
            JOIN versions v ON v.id = ${selectedIn(sql, queuedIn ?? sql.literal("c.current_fork_id"), "s")}
          WHERE s.id = ${replySlotId}`
        // Still being written: the fork it was sent in selects another version, generating.
        if (slot!.status === "generating") return null
        // It posts in the fork it was sent in, which was chatted in when it was sent: the
        // chat stays where the user is now, since silently moving them back would hide what
        // they sent there since. One queued before forks posts in a
        // fork ending at its reply. Should that fork have gone on elsewhere, or be gone, the
        // post makes a fork of its own there.
        const [fork] = yield* sql<{ id: ForkId }>`
          SELECT f.id FROM forks f WHERE f.chat_id = ${chatId} AND f.deleted_at IS NULL
            AND (f.id = ${queuedIn} OR (${queuedIn} IS NULL AND f.tip_slot_id = ${replySlotId}))
          ORDER BY f.id = ${queuedIn} DESC, ${sql.literal(forkRecency("f"))} DESC LIMIT 1`
        let forkId: ForkId | null = fork?.id ?? null
        // A live slot of a live chat: neither NotFound nor LeafMoved can happen.
        const append = (parentSlotId: string, version: NewVersion) =>
          graph
            .appendMessage({
              userId: owner,
              chatId,
              forkId,
              parentSlotId: parentSlotId as SlotId,
              branch: true,
              version,
              commitDraft: null,
              chatted: false
            })
            .pipe(
              Effect.tap((result) => Effect.sync(() => (forkId = result.forkId))),
              Effect.catchTag(["NotFound", "LeafMoved"], (error) => Effect.die(error))
            )
        const posted: Array<SlotId> = []
        const ids = entries.map((entry) => entry.id)
        if (mode === "restart") {
          yield* bin.recoverQueued(
            owner,
            entries.filter((entry) => entry.kind === "generate")
          )
          let parent = replySlotId
          for (const entry of entries) {
            if (entry.kind === "message") {
              const message = yield* append(
                parent,
                userMessage(
                  entry.content,
                  yield* liveSpeaker(owner, entry.speaker_entity_id),
                  JSON.parse(entry.images_json),
                  queuedRewrite(entry)
                )
              )
              posted.push(message.slotId)
              yield* keepGroup(entry, chatId, message.slotId)
              parent = message.slotId
            }
          }
          yield* sql`DELETE FROM queued_messages WHERE id IN ${sql.in(ids)}`
          return { posted, next: null }
        }
        // Messages sent with no one to reply (every character muted, DESIGN §3.5) post at
        // once, one after another, as they would have then; the first entry that wants a
        // reply goes on from the last of them.
        let replyParent = replySlotId
        let waiting = entries
        while (waiting[0]?.kind === "message" && waiting[0].no_reply === 1) {
          const entry = waiting[0]
          const message = yield* append(
            replyParent,
            userMessage(
              entry.content,
              yield* liveSpeaker(owner, entry.speaker_entity_id),
              JSON.parse(entry.images_json),
              queuedRewrite(entry)
            )
          )
          posted.push(message.slotId)
          yield* keepGroup(entry, chatId, message.slotId)
          replyParent = message.slotId
          waiting = waiting.slice(1)
        }
        if (waiting.length === 0) {
          yield* sql`DELETE FROM queued_messages WHERE id IN ${sql.in(ids)}`
          return { posted, next: null }
        }
        const [first] = waiting
        // A message's reply comes from whoever was picked when it was sent, as for a send then.
        const replySpeaker = yield* liveSpeaker(owner, first!.reply_speaker_entity_id)
        const speaker = yield* liveSpeaker(owner, first!.speaker_entity_id)
        if (first!.kind === "message") {
          const message = yield* append(
            replyParent,
            userMessage(first!.content, speaker, JSON.parse(first!.images_json), queuedRewrite(first!))
          )
          posted.push(message.slotId)
          yield* keepGroup(first!, chatId, message.slotId)
          replyParent = message.slotId
        }
        const next = yield* append(
          replyParent,
          first!.kind === "message"
            ? reply(replySpeaker, null, first!.auto_pick === 1)
            : reply(speaker, first!.direction, first!.auto_pick === 1)
        )
        posted.push(next.slotId)
        yield* sql`DELETE FROM queued_messages WHERE id IN ${sql.in(ids.slice(0, entries.length - waiting.length + 1))}`
        const rest = waiting.slice(1).map((entry) => entry.id)
        if (rest.length > 0) {
          yield* sql`UPDATE queued_messages SET reply_slot_id = ${next.slotId}, fork_id = ${forkId},
              updated_at = ${Date.now()}
            WHERE id IN ${sql.in(rest)}`
          // Only this reply's immediately following round starts here. Later queued
          // actions have not posted their first reply yet and must retain a null start.
          // This also establishes a start when startup recovered the queued action
          // without generating its first reply and Continue resumes its remaining round.
          const following = waiting.slice(1)
          const nextAction = following.findIndex((entry) => entry.round === 0)
          const starting = following.slice(0, nextAction < 0 ? following.length : nextAction).map((entry) => entry.id)
          if (starting.length > 0)
            yield* sql`UPDATE queued_messages SET round_start_slot_id = coalesce(round_start_slot_id, ${next.slotId})
              WHERE id IN ${sql.in(starting)}`
        }
        return {
          posted,
          next: {
            slotId: next.slotId,
            versionId: next.version.id as VersionId,
            forkId: next.forkId
          }
        }
      })

    /**
     * A round's later replies (DESIGN §2.3), each a `generate` entry waiting behind `replySlotId` in order.
     * `startSlotId`: the round's first reply, null while it waits in the queue itself.
     */
    const queueRound = (
      chatId: string,
      replySlotId: string,
      forkId: string,
      members: ReadonlyArray<EntityId>,
      seq: number,
      at: number,
      autoPick: boolean,
      startSlotId: string | null
    ) =>
      Effect.forEach(
        members,
        (speaker, i) =>
          sql`INSERT INTO queued_messages ${sql.insert({
            id: uuidv7(),
            chat_id: chatId,
            reply_slot_id: replySlotId,
            fork_id: forkId,
            seq: seq + i,
            kind: "generate",
            content: "",
            images_json: "[]",
            speaker_entity_id: speaker,
            reply_speaker_entity_id: null,
            no_reply: 0,
            direction: null,
            round: 1,
            held: 0,
            auto_pick: autoPick ? 1 : 0,
            round_start_slot_id: startSlotId,
            created_at: at,
            updated_at: at
          })}`,
        { discard: true }
      )

    const greetingChat = ({
      userId,
      cards,
      persona,
      greeters,
      title
    }: Parameters<WriteHandlers["StartGreetingChat"]>[0]) =>
      Effect.gen(function* () {
        const ids = [...new Set([...cards, ...(persona === null ? [] : [persona])])]
        const loaded = yield* loadCards(sql, userId, ids)
        for (const id of ids) {
          if (!loaded.some(({ card }) => card.entityId === id && !card.inBin)) {
            return yield* new NotFound({ entity: "card", id })
          }
        }
        const byId = new Map(loaded.map((card) => [card.card.entityId as string, card]))
        for (const greeter of greeters) {
          if (!cards.includes(greeter.entityId)) return yield* new NotFound({ entity: "card", id: greeter.entityId })
        }
        const at = Date.now()
        const chatId = uuidv7() as ChatId
        const names = ids.filter((id) => cards.includes(id)).map((id) => byId.get(id)!.card.name)
        yield* sql`INSERT INTO chats ${sql.insert({
          id: chatId,
          owner_user_id: userId,
          kind: "rp",
          status: "active",
          title: title?.trim() || titleFor(names, at),
          created_at: at
        })}`
        yield* graph.insertStateEvent(userId, chatId, null, null, null, {
          key: "lcm.settings",
          value: yield* newChatLcmSettings(sql, userId)
        })
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
        // Each greeter's greeting is a message of its own, in order, as ST starts a group
        // chat; every greeting of its card is a version of it, its macros kept for display
        // and assembly to resolve against the chat's state (DESIGN §5.6).
        let root: SlotId | null = null
        let depth = -1
        for (const { entityId, greeting, options } of greeters) {
          const greeter = byId.get(entityId)!
          if (options.length === 0) continue
          const greetingVersion = (i: number) => {
            const option = options[i]!
            const originalIndex = greeter.greetingIndexes[option.index]
            return new NewVersion({
              speakerEntityId: greeter.card.entityId,
              writer: "model",
              content: options[i]!.text,
              status: "complete",
              macroMode: "template",
              origin: "greeting",
              ...(originalIndex === undefined
                ? {}
                : { greetingRef: { entity: greeter.card.entityId, index: originalIndex } }),
              ...(option.frozen && Object.keys(option.frozen).length > 0 ? { frozenMacros: option.frozen } : {})
            })
          }
          const parent = root === null ? null : { id: root, depth }
          const more = options.slice(1).map((_, i) => greetingVersion(i + 1))
          const picked = Math.max(
            0,
            options.findIndex((option) => option.index === greeting)
          )
          const inserted = yield* graph.insertSlot(chatId, parent, greetingVersion(0), at, null, more, picked)
          const slotId = inserted.slotId as SlotId
          yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId}, last_message_at = ${at} WHERE id = ${chatId}`
          root = slotId
          depth++
        }
        return { chatId, root }
      })

    type SendInput = Parameters<WriteHandlers["SendOrQueue"]>[0]

    /** SendOrQueue's write, which SendToThreads makes once per thread inside its own transaction. */
    const sendOrQueue = ({
      userId,
      chatId,
      forkId,
      parentSlotId,
      branch,
      kind,
      content,
      speakerEntityId,
      replySpeakerEntityId,
      noReply,
      images,
      imageDraftIds,
      direction,
      commitDraft,
      rewrite,
      round,
      autoPick,
      immediate,
      auto,
      autoConfiguration
    }: SendInput) =>
      Effect.gen(function* () {
        yield* graph.ownedChat(userId, chatId)
        let fork = yield* graph.ownedFork(userId, chatId, forkId ?? null)
        const draftForkId = fork.id
        // An Auto turn is admitted here, in the transaction that writes its reply: nothing can
        // change between this check and the reply's placeholder (db/autoGuard.ts).
        const autoAt = { userId, chatId, forkId: fork.id }
        const run =
          auto == null || auto.token === null
            ? null
            : yield* checkAutoTurn(sql, autoAt, auto.token, autoConfiguration ?? "")
        // A turn added at the fork's tip is a new user action: the round already there, waiting
        // or stopped, ends (DESIGN §2.3). A branch elsewhere leaves it be.
        const endedRound =
          parentSlotId === fork.tip_slot_id
            ? yield* sql`DELETE FROM queued_messages WHERE chat_id = ${chatId} AND fork_id = ${fork.id} AND round = 1 RETURNING id`
            : []
        for (const id of round ?? []) yield* graph.checkSpeaker(userId, id)
        yield* graph.checkImages(userId, images ?? [])
        yield* composerImages(sql).consume(userId, chatId, commitDraft?.draftId, imageDraftIds ?? [], images ?? [])
        yield* graph.checkSpeaker(userId, speakerEntityId)
        if (kind === "message") yield* graph.checkSpeaker(userId, replySpeakerEntityId)
        if (parentSlotId !== null) {
          const [parent] = yield* sql<{ status: string; deleted: number }>`
              SELECT v.status, ${slotDeletedIn(sql, fork.id, "s")} AS deleted
              FROM slots s JOIN versions v ON v.id = ${selectedIn(sql, fork.id, "s")}
              WHERE s.id = ${parentSlotId} AND s.chat_id = ${chatId}
                AND (s.deleted_at IS NULL OR s.id = ${fork.tip_slot_id})`
          if (!parent) return yield* new NotFound({ entity: "slot", id: parentSlotId })
          // A tab that missed a newer message hears about it, queued or not.
          if (!branch && parentSlotId !== fork.tip_slot_id) {
            return yield* new LeafMoved({ chatId, activeLeafSlotId: fork.tip_slot_id })
          }
          // A deleted anchor can remain the tip to retain its gap. Nothing waits on its
          // hidden generation: afterReply withdraws entries whose reply was deleted.
          if (parent.status === "generating" && !parent.deleted) {
            if (immediate) return yield* new LeafMoved({ chatId, activeLeafSlotId: fork.tip_slot_id })
            const at = Date.now()
            // A branch queued onto a reply still being written waits in a fork of its own.
            if (branch && parentSlotId !== fork.tip_slot_id) {
              const through = (yield* onForkPath(sql, chatId, fork, parentSlotId))
                ? fork
                : ((yield* forkThrough(sql, chatId, parentSlotId)) ?? fork)
              if (through.tip_slot_id === parentSlotId) fork = through
              else {
                fork = yield* graph.createFork(chatId, through, parentSlotId, at, true)
                yield* graph.carryChatNoteDrafts(userId, chatId, through, fork)
              }
            }
            const [next] = yield* sql<{ n: number }>`
                SELECT coalesce(max(seq), -1) + 1 AS n FROM queued_messages WHERE chat_id = ${chatId}`
            // Sent now, posted later: the fork is chatted in now.
            yield* graph.chatIn(fork.id, at)
            const [row] = yield* sql<QueuedRow>`INSERT INTO queued_messages ${sql.insert({
              id: uuidv7(),
              chat_id: chatId,
              reply_slot_id: parentSlotId,
              fork_id: fork.id,
              seq: next!.n,
              kind,
              content: kind === "message" ? content : "",
              ...(kind === "message"
                ? {
                    raw_content: rewriteColumns(rewrite).raw_content,
                    rewrite_json: rewriteColumns(rewrite).rewrite_json
                  }
                : {}),
              images_json: JSON.stringify(images ?? []),
              speaker_entity_id: speakerEntityId,
              reply_speaker_entity_id: kind === "message" ? replySpeakerEntityId : null,
              no_reply: kind === "message" && noReply === true ? 1 : 0,
              direction: kind === "generate" && direction !== null && direction.trim() !== "" ? direction : null,
              auto_pick: autoPick === true && (kind === "generate" || noReply !== true) ? 1 : 0,
              created_at: at,
              updated_at: at
            })} RETURNING *`
            // The rest of the round waits behind it: postQueued moves each on to the reply before.
            if (kind === "generate" || noReply !== true)
              yield* queueRound(chatId, parentSlotId, fork.id, round ?? [], next!.n + 1, at, autoPick === true, null)
            // The text waits in the queue now, and comes back to the composer if withdrawn.
            const { draft, recovered } = yield* bin.drafts.commit(userId, commitDraft, {
              // The composer's, or the insertion editor's below the tip, whose insertion is an append
              // (spec/MESSAGE-INSERT.md §4.2).
              targetKind: ["composer", "insert"],
              targetId: chatId,
              matchesField: (kind, field) =>
                field === (kind === "insert" ? `${draftForkId}:${parentSlotId ?? ""}` : draftForkId),
              content: row!.kind === "generate" ? (row!.direction ?? "") : (rewrite?.raw ?? row!.content)
            })
            return {
              _tag: "Queued" as const,
              queued: toQueued(row!),
              queue: yield* chatQueue(sql, chatId),
              draft,
              recovered
            }
          }
        }
        const result = yield* graph.appendMessage({
          userId,
          chatId,
          forkId: fork.id as ForkId,
          parentSlotId,
          branch,
          version:
            kind === "message"
              ? userMessage(content, speakerEntityId, images, rewrite)
              : reply(speakerEntityId, direction, autoPick === true),
          commitDraft
        })
        const next =
          auto == null || kind !== "generate"
            ? {}
            : {
                auto: {
                  token: yield* claimAutoTurn(
                    sql,
                    autoAt,
                    run,
                    { slotId: result.slotId, versionId: result.version.id },
                    autoConfiguration ?? ""
                  )
                }
              }
        // A reply posted now: the rest of its round waits for it.
        if (kind === "generate" && (round ?? []).length > 0) {
          const [next] = yield* sql<{ n: number }>`
              SELECT coalesce(max(seq), -1) + 1 AS n FROM queued_messages WHERE chat_id = ${chatId}`
          yield* queueRound(
            chatId,
            result.slotId,
            result.forkId,
            round ?? [],
            next!.n,
            Date.now(),
            autoPick === true,
            result.slotId
          )
          return { _tag: "Posted" as const, result, ...next, queue: yield* chatQueue(sql, chatId) }
        }
        return {
          _tag: "Posted" as const,
          result,
          ...next,
          ...(endedRound.length > 0 ? { queue: yield* chatQueue(sql, chatId) } : {})
        }
      })

    /** `sendOrQueue` for a send that is never an Auto turn, which only one can be refused as. */
    const sendPlain = (input: SendInput) =>
      sendOrQueue(input).pipe(Effect.catchTag("AutoRefused", (refused) => Effect.die(refused)))

    const handlers = {
      ...(yield* makeShellWriteHandlers),
      StartGreetingChat: (input) =>
        Effect.gen(function* () {
          const { chatId } = yield* greetingChat(input)
          yield* graph.ownedFork(input.userId, chatId, null)
          return toChat(yield* graph.ownedChat(input.userId, chatId))
        }).pipe(transaction("StartGreetingChat")),
      StartChat: ({ guidance, userId, cards, persona, greeters, first, title }) =>
        Effect.gen(function* () {
          const { chatId, root } = yield* greetingChat({ userId, cards, persona, greeters, title })
          const version =
            first._tag === "Send"
              ? userMessage(first.content, first.speakerEntityId, first.images)
              : reply(first.speakerEntityId, first.direction)
          const added = yield* graph
            .appendMessage({ userId, chatId, parentSlotId: root, branch: false, version, commitDraft: null })
            .pipe(
              // Its parent is the new chat's leaf; only a speaker can be missing.
              Effect.catchTag("LeafMoved", (error) => Effect.die(error))
            )
          const composer = yield* bin.drafts.openComposer(userId, composerKey(chatId, added.forkId), null)
          yield* bin.drafts.setComposerChoice(userId, chatId, composer.id, {
            speakerEntityId: first.speakerEntityId,
            guidance: guidance ?? false
          })
          return { ...added, composer: new Draft({ ...composer, guidance: guidance ?? false }) }
        }).pipe(transaction("StartChat")),

      SendOrQueue: (input) => sendOrQueue(input).pipe(transaction("SendOrQueue")),

      // One message to several threads (spec/THREADS.md §6.2): per thread, exactly SendOrQueue's
      // append in that thread's fork, then the reply its Next asked for, all in one transaction
      // and one send group. The thread the user is in goes last, so it stays the current fork.
      SendToThreads: ({ userId, chatId, images, imageDraftIds, commitDraft, targets }) =>
        Effect.gen(function* () {
          yield* graph.ownedChat(userId, chatId)
          const forks = yield* Effect.forEach(targets, (target) => graph.ownedFork(userId, chatId, target.forkId))
          if (
            new Set(forks.map((fork) => fork.id)).size !== forks.length ||
            !(yield* separateThreads(sql, chatId, forks))
          )
            return yield* new ThreadsRefused({ message: "Each copy goes to another thread of the same threads." })
          const groupId = uuidv7()
          const copies: Array<
            | {
                readonly _tag: "Posted"
                readonly forkId: ForkId
                readonly slotId: SlotId
                readonly reply: { slotId: SlotId; versionId: VersionId } | null
              }
            | { readonly _tag: "Queued"; readonly forkId: ForkId; readonly queued: QueuedMessage }
          > = []
          let committed: { draft: Draft | null; recovered: number } = { draft: null, recovered: 0 }
          const order = [...targets.keys()].slice(1).concat([0])
          for (const index of order) {
            const target = targets[index]!
            const fork = forks[index]!
            const first = index === 0
            const sent = yield* sendPlain({
              userId,
              chatId,
              forkId: fork.id as ForkId,
              // The first thread's tip is the one its tab saw; the others' copies go under theirs now.
              parentSlotId: first ? target.parentSlotId : (fork.tip_slot_id as SlotId | null),
              branch: false,
              kind: "message",
              content: target.content,
              ...(target.rewrite === undefined ? {} : { rewrite: target.rewrite }),
              speakerEntityId: target.speakerEntityId,
              replySpeakerEntityId: target.replySpeakerEntityId,
              ...(target.reply ? {} : { noReply: true }),
              ...(images === undefined ? {} : { images }),
              ...(first && imageDraftIds !== undefined ? { imageDraftIds } : {}),
              direction: null,
              commitDraft: first ? commitDraft : null,
              ...(target.round === undefined ? {} : { round: target.round }),
              ...(target.autoPick === true ? { autoPick: true } : {})
            })
            if (sent._tag === "Queued") {
              // It keeps its group, and joins it when it posts (keepGroup).
              yield* sql`UPDATE queued_messages SET send_group = ${groupId} WHERE id = ${sent.queued.id}`
              copies[index] = { _tag: "Queued", forkId: fork.id as ForkId, queued: sent.queued }
              if (first) committed = { draft: sent.draft, recovered: sent.recovered }
              continue
            }
            const { result } = sent
            if (first) committed = { draft: result.draft, recovered: result.recovered }
            yield* sql`INSERT INTO thread_sends (slot_id, chat_id, group_id) VALUES (${result.slotId}, ${chatId}, ${groupId})`
            let reply: { slotId: SlotId; versionId: VersionId } | null = null
            if (target.reply) {
              // The reply the client would ask for after an immediate send, as Generate does.
              const asked = yield* sendPlain({
                userId,
                chatId,
                forkId: result.forkId,
                parentSlotId: result.slotId,
                branch: false,
                kind: "generate",
                content: "",
                speakerEntityId: target.replySpeakerEntityId,
                replySpeakerEntityId: null,
                direction: null,
                commitDraft: null,
                ...(target.round === undefined ? {} : { round: target.round }),
                ...(target.autoPick === true ? { autoPick: true } : {})
              })
              // Its parent was just written, so it posts.
              if (asked._tag === "Posted") reply = { slotId: asked.result.slotId, versionId: asked.result.version.id }
            }
            copies[index] = { _tag: "Posted", forkId: result.forkId, slotId: result.slotId, reply }
          }
          const [chat] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return { groupId, copies, chat: toChat(chat!), queue: yield* chatQueue(sql, chatId), ...committed }
        }).pipe(transaction("SendToThreads")),

      EditQueued: ({ userId, queuedId, content, speakerEntityId, expectedRowVersion, draft, rewrite }) =>
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
          const columns = rewriteColumns(row.kind === "message" ? rewrite : undefined)
          const [updated] = yield* sql<QueuedRow>`
            UPDATE queued_messages SET content = ${row.kind === "message" ? content : ""},
              raw_content = ${columns.raw_content}, rewrite_json = ${columns.rewrite_json},
              direction = ${row.kind === "message" ? row.direction : content},
              speaker_entity_id = ${speakerEntityId}, row_version = row_version + 1, updated_at = ${Date.now()}
            WHERE id = ${queuedId} RETURNING *`
          yield* bin.drafts.commit(userId, draft ?? null, {
            targetKind: "queue_edit",
            targetId: row.chat_id,
            content: (field) => (field === queuedId ? (rewrite?.raw ?? content) : null)
          })
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
          yield* bin.recoverQueued(userId, [row])
          // A queued action owns the round entries immediately following it in this fork's
          // queue. Withdrawing it cancels those replies, but keeps a later action's round.
          if (row.round === 0) {
            const [next] = yield* sql<{ seq: number | null }>`
              SELECT min(seq) AS seq FROM queued_messages
              WHERE chat_id = ${row.chat_id} AND reply_slot_id = ${row.reply_slot_id}
                AND fork_id IS ${row.fork_id} AND round = 0 AND seq > ${row.seq}`
            yield* sql`DELETE FROM queued_messages
              WHERE chat_id = ${row.chat_id} AND reply_slot_id = ${row.reply_slot_id}
                AND fork_id IS ${row.fork_id} AND round = 1 AND seq > ${row.seq}
                AND seq < ${next?.seq ?? Number.MAX_SAFE_INTEGER}`
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

      PostRolloutMessage: ({ userId, rolloutId, versionId, toolCallId, content, reasoning, replySections, rewrite }) =>
        Effect.gen(function* () {
          const row = yield* graph.ownedVersion(userId, versionId, true)
          const [run] = yield* sql<{ fork_id: string; chat_id: string }>`
            SELECT r.fork_id, r.chat_id FROM rollouts r JOIN rollout_payloads p ON p.rollout_id = r.id
            WHERE r.id = ${rolloutId} AND r.status = 'running'
              AND json_extract(p.context_snapshot_json, '$.agent.contract') = 'several'`
          const [receipt] = yield* sql<{ result_json: string }>`SELECT result_json FROM rollout_receipts
            WHERE rollout_id = ${rolloutId} AND tool_call_id = ${toolCallId}`
          if (run && row.rollout_id === rolloutId && receipt)
            return JSON.parse(JSON.parse(receipt.result_json) as string) as {
              slotId: SlotId
              versionId: VersionId
              postedVersionId: VersionId
            }
          if (!run || row.rollout_id !== rolloutId || row.status !== "generating")
            return yield* new NotFound({ entity: "working message", id: versionId })
          const columns = rewriteColumns(rewrite)
          yield* sql`UPDATE version_records SET content = ${content}, reasoning = ${reasoning || null},
            reply_sections = ${replySections ? JSON.stringify(replySections) : null}, status = 'complete',
            raw_content = ${columns.raw_content}, raw_reasoning = ${columns.raw_reasoning},
            raw_sections = ${columns.raw_sections}, rewrite_json = ${columns.rewrite_json}, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          const [parent] = yield* sql<{
            id: string
            depth: number
          }>`SELECT id, depth FROM slots WHERE id = ${row.slot_id}`
          const next = yield* graph.insertSlot(
            run.chat_id,
            parent!,
            {
              speakerEntityId: row.speaker_entity_id as never,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            },
            Date.now(),
            run.fork_id
          )
          yield* sql`UPDATE version_records SET rollout_id = ${rolloutId}, connection_id = (SELECT connection_id FROM versions WHERE id = ${versionId}),
            model_id = (SELECT model_id FROM versions WHERE id = ${versionId}), cast_json = (SELECT cast_json FROM version_records WHERE id = ${versionId})
            WHERE id = ${next.version.id}`
          yield* sql`UPDATE forks SET tip_slot_id = ${next.slotId}, row_version = row_version + 1 WHERE id = ${run.fork_id}`
          // Queued user input waits for the whole run, including after this message.
          yield* sql`UPDATE queued_messages SET reply_slot_id = ${next.slotId} WHERE reply_slot_id = ${row.slot_id}
            AND fork_id IS ${run.fork_id}`
          const result = {
            slotId: next.slotId as SlotId,
            versionId: next.version.id as VersionId,
            postedVersionId: versionId
          }
          yield* sql`INSERT INTO rollout_receipts (rollout_id, tool_call_id, result_json, created_at)
            VALUES (${rolloutId}, ${toolCallId}, ${JSON.stringify(JSON.stringify(result))}, ${Date.now()})`
          return result
        }).pipe(transaction("PostRolloutMessage")),

      FinishGeneration: ({
        userId,
        versionId,
        content,
        reasoning,
        replySections,
        status,
        error,
        rewrite,
        discardEmpty,
        mark
      }) =>
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
          yield* recordHistoryReduction(sql, row.slot_id, content, versionId)
          const columns = rewriteColumns(rewrite)
          yield* sql`UPDATE version_records SET content = ${content}, status = ${status},
            reasoning = CASE WHEN ${reasoning === undefined ? 1 : 0} THEN reasoning ELSE ${reasoning || null} END,
            raw_content = ${columns.raw_content}, raw_reasoning = ${columns.raw_reasoning},
            raw_sections = ${columns.raw_sections},
            rewrite_json = ${columns.rewrite_json},
            reply_sections = CASE WHEN ${replySections === undefined ? 1 : 0} THEN reply_sections
              ELSE ${replySections ? JSON.stringify(replySections) : null} END,
            error_json = ${error === null ? null : JSON.stringify(error)},
            mark = CASE WHEN ${mark === undefined ? 1 : 0} THEN mark ELSE ${mark ?? null} END, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          const version = toVersion(yield* graph.ownedVersion(userId, versionId, false))
          const [slot] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM slots WHERE id = ${row.slot_id}`
          // A round stops with a reply that's stopped or fails (as ST's does), where the fork
          // waiting on it shows this version: the rest waits for Continue round (DESIGN §2.3).
          const held =
            status === "stopped" || status === "failed"
              ? yield* sql`UPDATE queued_messages SET held = 1, updated_at = ${Date.now()}
              WHERE reply_slot_id = ${row.slot_id} AND round = 1 AND held = 0 AND id IN (
                SELECT q.id FROM queued_messages q JOIN slots s ON s.id = q.reply_slot_id
                  JOIN chats c ON c.id = s.chat_id
                WHERE q.reply_slot_id = ${row.slot_id}
                  AND ${selectedIn(sql, sql.literal("coalesce(q.fork_id, c.current_fork_id)"), "s")} = ${versionId}
                  -- A replacement send's round hasn't begun yet: its queued action must
                  -- post first. Stopping the old reply doesn't stop that new round.
                  AND NOT EXISTS (SELECT 1 FROM queued_messages action
                    WHERE action.reply_slot_id = q.reply_slot_id AND action.fork_id IS q.fork_id
                      AND action.round = 0 AND action.seq < q.seq))
                RETURNING id`
              : []
          if (
            discardEmpty &&
            status === "complete" &&
            !content.trim() &&
            !replySections?.sections.some((section) => section.text.trim())
          ) {
            const [safe] = yield* sql<{ parent_slot_id: string | null }>`SELECT parent_slot_id FROM slots s
              WHERE s.id = ${row.slot_id} AND s.bin_item_id IS NULL
                AND (SELECT count(*) FROM versions WHERE slot_id = s.id) = 1
                AND NOT EXISTS (SELECT 1 FROM slots WHERE parent_slot_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM state_events WHERE slot_id = s.id
                  AND (origin <> 'rollout' OR version_id IS NOT ${versionId}))`
            if (safe) {
              const events = yield* sql<{
                key: string
                scope: string | null
                value_json: string
                origin_ref: string | null
                fork_id: string | null
                created_at: number
              }>`
                SELECT key, scope, value_json, origin_ref, fork_id, created_at FROM state_events WHERE slot_id = ${row.slot_id} ORDER BY seq`
              if (events.length && safe.parent_slot_id) {
                const [parent] = yield* sql<{
                  selected_version_id: string
                }>`SELECT selected_version_id FROM slots WHERE id = ${safe.parent_slot_id}`
                const [last] = yield* sql<{
                  n: number
                }>`SELECT coalesce(max(seq), -1) + 1 AS n FROM state_events WHERE slot_id = ${safe.parent_slot_id}`
                for (const [i, event] of events.entries())
                  yield* sql`INSERT INTO state_events ${sql.insert({
                    id: uuidv7(),
                    chat_id: slot!.chat_id,
                    slot_id: safe.parent_slot_id,
                    version_id: parent!.selected_version_id,
                    seq: last!.n + i,
                    key: event.key,
                    scope: event.scope,
                    value_json: event.value_json,
                    origin: "rollout",
                    origin_ref: event.origin_ref,
                    fork_id: event.fork_id,
                    fork_seq: event.fork_id ? yield* nextSeq(sql, slot!.chat_id) : null,
                    created_at: event.created_at
                  })}`
              }
              yield* sql`UPDATE forks SET tip_slot_id = ${safe.parent_slot_id}, row_version = row_version + 1 WHERE tip_slot_id = ${row.slot_id}`
              yield* sql`UPDATE rollouts SET slot_id = ${safe.parent_slot_id} WHERE slot_id = ${row.slot_id}`
              yield* sql`UPDATE queued_messages SET reply_slot_id = ${safe.parent_slot_id} WHERE reply_slot_id = ${row.slot_id}`
              yield* sql`DELETE FROM slots WHERE id = ${row.slot_id}`
              const queue = safe.parent_slot_id ? yield* afterReply(safe.parent_slot_id, "reply") : nothing
              const [parent] = safe.parent_slot_id
                ? yield* sql<{
                    selected_version_id: string
                  }>`SELECT selected_version_id FROM slots WHERE id = ${safe.parent_slot_id}`
                : []
              const last = parent
                ? toVersion(yield* graph.ownedVersion(userId, parent.selected_version_id as VersionId, false))
                : version
              return { version: last, chatId: slot!.chat_id as ChatId, ...queue, removedSlotId: row.slot_id as SlotId }
            }
          }
          // A reply interrupted by the server going down leaves its queue to the next start.
          const queue = status === "interrupted" ? nothing : yield* afterReply(row.slot_id, "reply")
          // A round held here changed the queue too, though nothing posted.
          if (held.length > 0 && !queue.queueChanged)
            return {
              version,
              chatId: slot!.chat_id as ChatId,
              ...queue,
              queueChanged: true,
              queue: yield* chatQueue(sql, slot!.chat_id)
            }
          return { version, chatId: slot!.chat_id as ChatId, ...queue }
        }).pipe(transaction("FinishGeneration")),

      ContinueRound: ({ userId, chatId, forkId }) =>
        Effect.gen(function* () {
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)
          const held = yield* sql<{ id: string }>`
            SELECT id FROM queued_messages WHERE chat_id = ${chatId} AND fork_id = ${fork.id} AND round = 1 AND held = 1`
          if (held.length === 0 || fork.tip_slot_id === null)
            return { chatId, ...nothing, queue: yield* chatQueue(sql, chatId) }
          // They wait at the tip as it is now (after an edit, a deletion or a new version there),
          // and post at once unless a reply is still being written there.
          yield* sql`UPDATE queued_messages SET held = 0, reply_slot_id = ${fork.tip_slot_id}, updated_at = ${Date.now()}
            WHERE ${sql.in(
              "id",
              held.map((row) => row.id)
            )}`
          const outcome = yield* afterReply(fork.tip_slot_id, "reply")
          return {
            chatId,
            ...outcome,
            queueChanged: true,
            queue: outcome.queueChanged ? outcome.queue : yield* chatQueue(sql, chatId)
          }
        }).pipe(transaction("ContinueRound")),

      EndRound: ({ userId, chatId, forkId }) =>
        Effect.gen(function* () {
          yield* graph.ownedChat(userId, chatId)
          const fork = yield* graph.ownedFork(userId, chatId, forkId)
          yield* sql`DELETE FROM queued_messages WHERE chat_id = ${chatId} AND fork_id = ${fork.id} AND round = 1`
          return { chatId, ...nothing, queueChanged: true, queue: yield* chatQueue(sql, chatId) }
        }).pipe(transaction("EndRound")),

      SelectAndDrain: ({ userId, slotId, versionId, forkId, expectedVersionId }) =>
        Effect.gen(function* () {
          const { chatId } = yield* graph.selectVersion(userId, slotId, versionId, forkId ?? null, expectedVersionId)
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
