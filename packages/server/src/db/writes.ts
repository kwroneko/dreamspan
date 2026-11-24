import { refusePending, refusePendingOf } from "./chatKindPolicy.ts"
import { chatKinds } from "@dreamspan/shared/chatKinds.ts"
import { displayEndOf, pathPieces, positionOf } from "./displayPath.ts"
import { presenceBefore } from "./participation.ts"
import { canonicalJson } from "@dreamspan/shared/editing.ts"
import { previewFork } from "./forkNotes.ts"
import { ForkNotesChanged } from "@dreamspan/shared/chatApi.ts"
import { composerImages } from "./composerImages.ts"
import { composerLibrary } from "./composerLibrary.ts"
import { recordHistoryReduction, recordReduction } from "./historyChanges.ts"
import { contextExcludedIn } from "./lcmVisibility.ts"
// Write operation handlers. They run inside the writer worker, each as one transaction.
import type { ChatId, ForkId, MessageImages, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { cleanName, renamedTitle } from "@dreamspan/shared/chatName.ts"
import { remoteOf } from "@dreamspan/shared/cardSources.ts"
import { composerKey, Draft, DraftHistoryPolicy, DraftKey, parseDraftTarget } from "@dreamspan/shared/drafts.ts"
import { heldRemoteCards } from "./cardOrigins.ts"
import { legacyPendingDraft } from "./migrationPendingChats.ts"
import { droppedReplyLabel, legacyWorkshopDraft, legacyWorkshopLabel } from "./pendingChats.ts"
import type { Bin } from "./bin.ts"
import { EDIT_THINKING_FIELD, NotAmendable } from "@dreamspan/shared/chatApi.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { DraftTooLarge, NotFound, StaleWrite, WriteOps } from "./ops.ts"
import { newChatLcmSettings, ownedModel } from "./generationSettings.ts"
import { forkColumns, forkThrough, shownElsewhere, withDisplayEnd } from "./forks.ts"
import {
  forkAt,
  imageExcludedSql,
  imageTarget,
  insertFork,
  slotDeletedIn,
  thinkingHiddenSql,
  thinkingTarget,
  versionAsShown,
  withFork,
  writeOverride,
  writeSelect
} from "./forkState.ts"
import { reachableSlot } from "./graphReachability.ts"
import { type ChatRow, type ForkRow, rewriteColumns, toChat, toFork, toVersion } from "./rows.ts"
import { transaction as runTransaction } from "./tx.ts"
import { recordStoryAt } from "./workshopPairing.ts"
import { copyLibrary } from "./libraryAttachments.ts"

/**
 * The columns a fork's copy of a version doesn't take from it: its identity, text and
 * provenance, and what belongs to the original (its generation, its place in the bin).
 */
const copiedFresh = new Set([
  "seq",
  "id",
  "ordinal",
  "content",
  "origin",
  "source_version_id",
  "fork_id",
  "authoring_fork_id",
  "created_at",
  "updated_at",
  "rollout_id",
  "changeset_id",
  "usage_json",
  "recorded_generation_json",
  "deleted_at",
  "bin_item_id",
  "purged_at",
  // An amended copy's text is the user's: what scripts did to the copied text doesn't apply.
  "raw_content",
  "raw_reasoning",
  "raw_sections",
  "rewrite_json"
])

type Count = Effect.Effect<ReadonlyArray<{ readonly n: number }>, SqlError.SqlError>

type WriteHandlers = Parameters<typeof WriteOps.of>[0]
/** Graph and chat write handlers. Library handlers are in libraryWrites.ts. */
export const makeWriteHandlers = (bin: Bin) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const transaction = (operation: string) => runTransaction(sql, operation)
    const { drafts } = bin

    const {
      found,
      slotInFork,
      selectVersion,
      ownedChat,
      ownedSlot,
      ownedVersion,
      ownedFork,
      createFork,
      carryChatNoteDrafts,
      placeAsShown,
      chatIn,
      checkSpeaker,
      checkImages,
      insertVersion,
      insertSlot,
      insertStateEvent,
      appendMessage
    } = makeGraphWrites(sql, drafts)

    const statePosition = Effect.fnUntraced(function* (
      userId: UserId,
      chatId: ChatId,
      slotId: SlotId | null,
      forkId: ForkId | null,
      displayEnd: boolean | undefined
    ) {
      if (!displayEnd) return slotId
      const fork = yield* ownedFork(userId, chatId, forkId)
      return fork.tip_slot_id === slotId ? ((yield* displayEndOf(sql, chatId, fork)) as SlotId | null) : slotId
    })

    /** A draft's target must belong to the user. */
    const draftTargets: Record<DraftKey["targetKind"], (userId: UserId, key: DraftKey) => Count> = {
      user_field: (userId) => sql`SELECT count(*) AS n FROM users WHERE id = ${userId}`,
      // A source's card is the user's to try; the source and the card are checked where its drafts are read.
      remote_card: (userId) => sql`SELECT count(*) AS n FROM users WHERE id = ${userId}`,
      // A path of the user's own Files, checked against the tree by the caller (api/fileDrafts.ts).
      file: (userId) => sql`SELECT count(*) AS n FROM users WHERE id = ${userId}`,
      composer: (userId, key) => sql`SELECT count(*) AS n FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = ${key.field} AND c.id = ${key.targetId} AND c.owner_user_id = ${userId}
          AND f.deleted_at IS NULL AND c.deleted_at IS NULL`,
      version_edit: (userId, key) => sql`SELECT count(*) AS n FROM versions v JOIN slots s ON s.id = v.slot_id
        JOIN chats c ON c.id = s.chat_id WHERE v.id = ${key.targetId} AND c.owner_user_id = ${userId}
          AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
      scratchpad: (userId, key) => sql`SELECT count(*) AS n FROM slots s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${key.targetId} AND c.owner_user_id = ${userId} AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
      entity_field: (userId, key) => {
        const target = parseDraftTarget(key.targetId)
        // A chat's own note's branch: a fork of its chat.
        return target.fork === null
          ? sql`SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
        WHERE r.id = ${key.targetId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL`
          : sql`SELECT count(*) AS n FROM entity_refs r JOIN entities e ON e.id = r.entity_id
        JOIN entity_revisions h ON h.id = r.head_revision_id
        JOIN forks f ON f.id = ${target.fork} AND f.chat_id = json_extract(h.doc_json, '$.owner.chat')
        JOIN chats c ON c.id = f.chat_id AND c.owner_user_id = ${userId}
        WHERE r.id = ${target.refId} AND e.owner_user_id = ${userId} AND e.deleted_at IS NULL AND e.kind = 'note'
          AND f.deleted_at IS NULL AND c.deleted_at IS NULL`
      },
      // The chat owns an edit even after its queue entry posts or is withdrawn.
      queue_edit: (userId, key) => sql`SELECT count(*) AS n FROM chats c
        WHERE c.id = ${key.targetId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`,
      summary_edit: (userId, key) => sql`SELECT count(*) AS n FROM summaries s JOIN chats c ON c.id = s.chat_id
        WHERE s.id = ${key.targetId} AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL`,
      // The user's chat and a live fork of it, and an anchor of the chat or none (`fork:anchor`).
      // The text stays the user's whatever becomes of the anchor, as a composer's does.
      insert: (userId, key) => {
        const [forkId = "", anchor = ""] = key.field.split(":")
        return sql`SELECT count(*) AS n FROM forks f JOIN chats c ON c.id = f.chat_id
          WHERE f.id = ${forkId} AND c.id = ${key.targetId} AND c.owner_user_id = ${userId}
            AND f.deleted_at IS NULL AND c.deleted_at IS NULL
            AND (${anchor} = '' OR EXISTS (SELECT 1 FROM slots s WHERE s.id = ${anchor} AND s.chat_id = c.id))`
      }
    }
    const draftTarget = (userId: UserId, key: DraftKey) =>
      found(Effect.orDie(draftTargets[key.targetKind](userId, key)), key.targetKind, key.targetId)

    /** The bodies of SaveDraft and SaveComposer: one transaction each, or all in SaveDraftBatch. */
    const saveDraft = ({
      userId,
      key: requestedKey,
      draftId,
      content,
      images,
      expectedRowVersion,
      expectedSession,
      baseRevision: requestedRevision,
      observedDeletion,
      seed,
      editingFrom
    }: Parameters<WriteHandlers["SaveDraft"]>[0]) =>
      Effect.gen(function* () {
        let key = requestedKey
        let baseRevision = requestedRevision
        // Adoption and draft saves share the writer, so either adoption moves this draft
        // or this save already sees the local ref and uses its normal conflict handling.
        const remote = key.targetKind === "remote_card" ? remoteOf(`src:${key.targetId}`) : null
        if (remote) {
          const [held] = yield* heldRemoteCards(sql, {
            userId,
            sourceId: remote.sourceId,
            items: [{ remoteId: remote.remoteId, sha256: null }]
          })
          if (held) {
            key = new DraftKey({ targetKind: "entity_field", targetId: held.refId, field: key.field })
            if (baseRevision === null || remoteOf(baseRevision) !== null) {
              const [ref] = yield* sql<{ head_revision_id: string }>`
                SELECT head_revision_id FROM entity_refs WHERE id = ${held.refId}`
              baseRevision = ref?.head_revision_id ?? null
            }
          } else baseRevision = null
        }
        // A swipe of one's own, an edit, or text to insert below, of a reply that finished empty
        // and was removed meanwhile (its first save, or a browser's retry): the text goes to
        // recovered texts, once, and the answer is a discarded draft with nothing in it. An
        // insertion's anchor is its field's slot, in a chat of the user's (rev-dd2 #1).
        const droppedTarget =
          key.targetKind === "scratchpad" || key.targetKind === "version_edit"
            ? key.targetId
            : key.targetKind === "insert"
              ? key.field.slice(key.field.indexOf(":") + 1)
              : null
        if (droppedTarget !== null && droppedTarget !== "") {
          const dropped = yield* droppedReplyLabel(sql, userId, droppedTarget)
          const owned =
            key.targetKind !== "insert" ||
            (yield* sql<{
              n: number
            }>`SELECT 1 AS n FROM chats /* chat:includes-pending: the one chat an insertion draft names, the user's own; a pending chat's dropped reply files its text too */
              WHERE id = ${key.targetId} AND owner_user_id = ${userId}`).length > 0
          // Images can't be kept in recovered texts: the save isn't taken, so the browser keeps
          // its copy, images and all, for Browser recovery (rev-dd2 #2).
          if (dropped !== null && owned && images !== undefined && images.length > 0)
            return yield* new NotFound({ entity: "message", id: droppedTarget })
          if (dropped !== null && owned) {
            if (content.length > DraftHistoryPolicy.maxContentChars)
              return yield* new DraftTooLarge({ length: content.length, max: DraftHistoryPolicy.maxContentChars })
            const filed = yield* fileLate(userId, key, content, dropped)
            const now = Date.now()
            return new Draft({
              id: draftId ?? "",
              key,
              content: "",
              status: "discarded",
              baseRevision: null,
              rowVersion: (expectedRowVersion ?? 0) + 1,
              session: (expectedSession ?? 0) + 1,
              createdAt: now,
              updatedAt: now,
              recovered: filed ? 1 : 0,
              displaced: null,
              historyLength: 0
            })
          }
        }
        if (images !== undefined) yield* checkImages(userId, images)
        // An edit of a new chat's greeting that was made again (its cast changed in another tab):
        // its draft moved to the greeting made in its place, so a save naming the old greeting
        // goes there.
        if (key.targetKind === "version_edit" && draftId !== null) {
          const [moved] = yield* sql<{ target_id: string }>`SELECT d.target_id FROM drafts d
            WHERE d.id = ${draftId} AND d.user_id = ${userId} AND d.target_kind = 'version_edit'
              AND d.field = ${key.field} AND d.target_id <> ${key.targetId}
              AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = ${key.targetId})`
          if (moved !== undefined) key = new DraftKey({ ...key, targetId: moved.target_id })
        }
        const saved = yield* drafts.save({
          userId,
          key,
          draftId,
          content,
          base: expectedRowVersion === null ? null : { rowVersion: expectedRowVersion, session: expectedSession },
          baseRevision,
          checkTarget: draftTarget(userId, key),
          observedDeletion,
          seed,
          editingFrom,
          images
        })
        // An old new-chat page's first message (a browser's copy sent on, or a tab from before):
        // nothing reads its draft any more, so its text goes to recovered texts (0018_pending_chats).
        // Every text its history holds goes too, as the draft and its history are deleted.
        // So does an old workshop page's (`pending-workshop:`, pendingChats.ts).
        const workshop = legacyWorkshopDraft(key.targetId, key.field)
        if (key.targetKind === "user_field" && (workshop || legacyPendingDraft(key.targetId, key.field))) {
          const [row] = yield* sql<{ id: string }>`SELECT id FROM drafts WHERE user_id = ${userId}
            AND target_kind = 'user_field' AND target_id = ${key.targetId} AND field = ${key.field}`
          const texts = row === undefined ? [content] : yield* drafts.unsaved(row.id, content, [])
          const label = workshop ? yield* legacyWorkshopLabel(sql, userId, key.targetId) : "New chat"
          for (const text of texts.toReversed()) yield* fileLate(userId, key, text, label)
          yield* sql`DELETE FROM drafts WHERE user_id = ${userId} AND target_kind = 'user_field'
            AND target_id = ${key.targetId} AND field = ${key.field}`
        }
        return saved
      })

    /** Text for a draft that's gone, to recovered texts, unless that draft already filed the same text. */
    const fileLate = (userId: UserId, key: DraftKey, content: string, label: string, anyField = false) =>
      Effect.gen(function* () {
        if (content.trim() === "") return false
        // Any text filed from this draft before, not only the latest: a retry replayed after a
        // newer save is filed once (rev-dd2 #7). `anyField`: under any field of its target.
        const [filed] = yield* sql<{ n: number }>`SELECT 1 AS n FROM recovered_texts
          WHERE user_id = ${userId} AND source_kind = ${key.targetKind} AND source_id = ${key.targetId}
            AND (${anyField ? 1 : 0} = 1 OR source_field = ${key.field}) AND content = ${content} LIMIT 1`
        if (filed !== undefined) return false
        yield* bin.recover(userId, key, [content], "discard", label)
        return true
      })
    const saveComposer = ({
      userId,
      chatId,
      draftId,
      rowVersion,
      session,
      next,
      operationId,
      content
    }: Parameters<WriteHandlers["SaveComposer"]>[0]) =>
      Effect.gen(function* () {
        // A pending chat swept since (another device opened a new chat): what the tab typed after
        // its last save still reaches recovered texts, under the name the sweep filed it with.
        const [live] = yield* Effect.orDie(
          sql<{ n: number }>`SELECT count(*) AS n FROM chats WHERE id = ${chatId} AND owner_user_id = ${userId}`
        )
        if (live?.n === 0) {
          // Held to the size a live save is held to, before anything is filed.
          if (content.length > DraftHistoryPolicy.maxContentChars)
            return yield* new DraftTooLarge({ length: content.length, max: DraftHistoryPolicy.maxContentChars })
          const [swept] = yield* sql<{ label: string }>`
            SELECT label FROM swept_pending_chats WHERE chat_id = ${chatId} AND user_id = ${userId}`
          if (swept === undefined) return yield* new NotFound({ entity: "chat", id: chatId })
          const [done] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM swept_pending_saves
            WHERE chat_id = ${chatId} AND operation_id = ${operationId}`
          if ((done?.n ?? 0) > 0) return { draft: null, recovered: true, accepted: false }
          yield* sql`INSERT INTO swept_pending_saves (chat_id, operation_id) VALUES (${chatId}, ${operationId})`
          // A pending chat has one fork, so one composer: what the sweep filed from it, under its
          // fork's key, is this text too (a save that reached the server, its answer lost, retried
          // after the sweep, rev-dd4b #7). Filed under that key, as the sweep filed the rest.
          const [prior] = yield* sql<{ field: string }>`SELECT source_field AS field FROM recovered_texts
            WHERE user_id = ${userId} AND source_kind = 'composer' AND source_id = ${chatId}
            ORDER BY created_at LIMIT 1`
          const key = composerKey(chatId, prior === undefined || prior.field === "" ? null : prior.field)
          yield* fileLate(userId, key, content, swept.label, true)
          return { draft: null, recovered: content.trim() !== "", accepted: false }
        }
        return yield* drafts.saveComposer(userId, chatId, { draftId, rowVersion, session, next, operationId }, content)
      })

    /** A position for state events: the user's chat, and a live slot of it unless it's the start. */
    const ownedPosition = (userId: UserId, chatId: ChatId, slotId: SlotId | null) =>
      Effect.gen(function* () {
        yield* ownedChat(userId, chatId)
        if (slotId !== null) {
          yield* found(
            sql`SELECT count(*) AS n FROM slots WHERE id = ${slotId} AND chat_id = ${chatId} AND deleted_at IS NULL`,
            "slot",
            slotId
          )
        }
      })

    /** A live fork of a live chat of the user's. */
    const ownedForkById = (userId: UserId, forkId: ForkId) =>
      sql<ForkRow>`SELECT f.* FROM forks f JOIN chats c ON c.id = f.chat_id
        WHERE f.id = ${forkId} AND c.owner_user_id = ${userId} AND f.deleted_at IS NULL AND c.deleted_at IS NULL`.pipe(
        Effect.flatMap(([row]) =>
          row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "fork", id: forkId }))
        )
      )

    /** The fork named, else the one through the slot (`forkAt`), as a read there would be. */
    const forkOf = (slotId: string, forkId: ForkId | null | undefined) =>
      forkId != null
        ? Effect.succeed(forkId)
        : Effect.gen(function* () {
            const [slot] = yield* sql<{ chat_id: string }>`SELECT chat_id FROM slots WHERE id = ${slotId}`
            return (yield* forkAt(sql, slot!.chat_id, slotId)) as ForkId | null
          })

    /**
     * Hides `slotId` from the model in `fork`, or shows it again: a `hide` row of the fork's own
     * (spec/FORK-INDEPENDENCE-DELTA.md §2.4). Whether it wasn't so already.
     */
    const setSlotHidden = (fork: ForkRow, slotId: string, hidden: boolean) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ effective: number }>`
          SELECT ${contextExcludedIn(sql, fork.id, "s")} AS effective FROM slots s WHERE s.id = ${slotId}`
        if ((row!.effective === 1) === hidden) return false
        yield* writeOverride(
          sql,
          { id: fork.id, chatId: fork.chat_id },
          { kind: "hide", targetId: slotId, slotId, valueId: null, flag: hidden ? 1 : 0 }
        )
        // A hide is a history reduction in the fork (stepped history, historyChanges.ts).
        if (hidden) yield* recordReduction(sql, slotId, fork.id)
        return true
      })

    const forkOut = (forkId: string) =>
      sql<
        Parameters<typeof toFork>[0]
      >`SELECT ${sql.literal(forkColumns("f"))} FROM forks f WHERE f.id = ${forkId}`.pipe(
        // Its tip text is the last message it shows (an inserted one can follow the tip).
        Effect.flatMap(([row]) => withDisplayEnd(sql, row!)),
        Effect.map(toFork)
      )

    const handlers = {
      Ready: () => Effect.void,

      CreateChat: ({ userId, kind, status, title, participants, greeting }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const chatId = uuidv7()
          yield* sql`INSERT INTO chats ${sql.insert({ id: chatId, owner_user_id: userId, kind, status, title, created_at: at })}`
          yield* insertStateEvent(userId, chatId, null, null, null, {
            key: "lcm.settings",
            value: yield* newChatLcmSettings(sql, userId, chatKinds.get(kind)?.allowsSummaries ? undefined : false)
          })
          for (const entity of participants) {
            yield* insertStateEvent(userId, chatId, null, null, null, { key: "participant.join", value: { entity } })
          }
          if (greeting) {
            yield* checkSpeaker(userId, greeting.speakerEntityId)
            const { slotId } = yield* insertSlot(chatId, null, greeting, at)
            yield* sql`UPDATE chats SET active_leaf_slot_id = ${slotId} WHERE id = ${chatId}`
          }
          const [row] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return toChat(row!)
        }).pipe(transaction("CreateChat")),

      SaveDraft: (payload) => saveDraft(payload).pipe(transaction("SaveDraft")),

      SaveDraftBatch: ({ userId, entries }) =>
        Effect.gen(function* () {
          const done: Array<{
            draft: Effect.Success<ReturnType<typeof saveDraft>> | null
            recovered: number
          }> = []
          for (const entry of entries) {
            if (entry._tag === "draft") {
              const draft = yield* saveDraft({ ...entry, userId })
              done.push({ draft, recovered: draft.recovered })
            } else {
              const saved = yield* saveComposer({ ...entry, userId })
              done.push({
                draft: saved.draft,
                recovered: Math.max(saved.draft?.recovered ?? 0, saved.recovered ? 1 : 0)
              })
            }
          }
          return done
        }).pipe(transaction("SaveDraftBatch")),

      OpenComposer: ({ userId, chatId, forkId, copyFrom }) =>
        Effect.gen(function* () {
          const fork = yield* ownedFork(userId, chatId, forkId)
          const key = composerKey(chatId, fork.id)
          yield* drafts.checkIdentity(userId, copyFrom)
          const from = copyFrom === null ? null : yield* drafts.findComposer(userId, chatId, copyFrom)
          if (copyFrom !== null && from === null) return yield* new NotFound({ entity: "draft", id: copyFrom })
          return yield* drafts.openComposer(userId, key, from)
        }).pipe(transaction("OpenComposer")),

      SetComposerImage: ({ userId, chatId, draftId, id, mediaId, altText, kind, name, path }) =>
        composerImages(sql)
          .set(userId, chatId, draftId, id, mediaId, altText, {
            ...(kind ? { kind } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(path !== undefined ? { path } : {})
          })
          .pipe(transaction("SetComposerImage")),
      SetComposerLibrary: ({ userId, chatId, draftId, add, remove }) =>
        composerLibrary(sql).set(userId, chatId, draftId, add, remove).pipe(transaction("SetComposerLibrary")),
      SetComposerChoice: ({
        userId,
        chatId,
        draftId,
        guidance,
        speakerEntityId,
        replyFromEntityId,
        noReplies,
        guidanceSlotId,
        consumeReplyFromEntityId
      }) =>
        drafts
          .setComposerChoice(userId, chatId, draftId, {
            ...(guidance === undefined ? {} : { guidance }),
            ...(speakerEntityId === undefined ? {} : { speakerEntityId }),
            ...(replyFromEntityId === undefined ? {} : { replyFromEntityId }),
            ...(noReplies === undefined ? {} : { noReplies }),
            ...(guidanceSlotId === undefined ? {} : { guidanceSlotId }),
            ...(consumeReplyFromEntityId === undefined ? {} : { consumeReplyFromEntityId })
          })
          .pipe(transaction("SetComposerChoice")),

      // Into a chat of the user's, live or in the bin: text typed as it was deleted is kept too.
      SaveComposer: (payload) => saveComposer(payload).pipe(transaction("SaveComposer")),

      RestoreComposer: ({ userId, chatId, draftId, seq, expectedRowVersion, content }) =>
        drafts
          .restoreComposer(userId, chatId, draftId, seq, expectedRowVersion, content)
          .pipe(transaction("RestoreComposer")),

      RestoreDraftState: ({ userId, key, draftId, seq, expectedRowVersion, content, images }) =>
        Effect.gen(function* () {
          if (images !== undefined) yield* checkImages(userId, images)
          return yield* drafts.restore(userId, key, draftId, seq, expectedRowVersion, content, images)
        }).pipe(transaction("RestoreDraftState")),

      ClearDraft: ({ userId, key, draftId, outcome, expectedRowVersion }) =>
        drafts.clear(userId, key, draftId, outcome, expectedRowVersion).pipe(transaction("ClearDraft")),

      AppendMessage: (params) => appendMessage(params).pipe(transaction("AppendMessage")),

      AddVersion: ({ userId, slotId, forkId, version, select, commitDraft }) =>
        Effect.gen(function* () {
          const at = Date.now()
          const { slot, fork } = yield* slotInFork(userId, slotId, forkId ?? null)
          yield* checkSpeaker(userId, version.speakerEntityId)
          const [next] = yield* sql<{
            n: number
          }>`SELECT coalesce(max(ordinal), -1) + 1 AS n FROM versions WHERE slot_id = ${slotId}`
          const cast = yield* presenceBefore(sql, slot.chat_id, slotId, fork.id)
          const row = yield* insertVersion(slotId, next!.n, version, at, fork.id, undefined, cast)
          yield* recordStoryAt(sql, slot.chat_id, slotId, [row.id], fork.id)
          if (select) {
            yield* recordHistoryReduction(sql, slotId, row.content, null, fork.id)
            yield* writeSelect(sql, { id: fork.id, chatId: slot.chat_id }, slotId, row.id)
          }
          // A new version is chatting in the fork (UX-REWORK §3, owner 2026-10-27).
          yield* chatIn(fork.id, at)
          yield* drafts.commit(userId, commitDraft, {
            targetKind: "version_edit",
            targetId: version.sourceVersionId ?? "",
            content: version.rewrite?.raw ?? row.content,
            images: toVersion(row).images ?? [],
            // The edit's history goes on with the version its Save made (owner, 2026-11-02).
            moveTo: row.id
          })
          return toVersion(row)
        }).pipe(transaction("AddVersion")),

      SelectVersion: ({ userId, slotId, versionId, forkId, expectedVersionId }) =>
        selectVersion(userId, slotId, versionId, forkId ?? null, expectedVersionId).pipe(
          Effect.map(({ forkId }) => ({ forkId })),
          transaction("SelectVersion")
        ),

      // Hides a message from the model, or shows it again, in a fork: a `hide` row of the fork's
      // own (spec/FORK-INDEPENDENCE-DELTA.md §2.4), so another fork's context and stepped
      // history are untouched. A staged LCM unhide's overlay (lcmVisibility.ts) counts as shown here.
      SetSlotHidden: ({ userId, slotId, forkId, hidden }) =>
        Effect.gen(function* () {
          yield* ownedSlot(userId, slotId)
          const named = yield* forkOf(slotId, forkId)
          if (named === null) return yield* new NotFound({ entity: "fork", id: forkId ?? slotId })
          const fork = yield* ownedForkById(userId, named)
          return { changed: yield* setSlotHidden(fork, slotId, hidden) }
        }).pipe(transaction("SetSlotHidden")),

      // Several at once (Select messages): each as SetSlotHidden, in this one transaction.
      SetSlotsHidden: ({ userId, forkId, slotIds, hidden }) =>
        Effect.gen(function* () {
          const fork = yield* ownedForkById(userId, forkId)
          const unique = [...new Set(slotIds)]
          // Each must be shown in the fork, as DeleteMessages requires (db/bin.ts): one read of
          // the path's pieces, then one query for all of them.
          const pieces = yield* pathPieces(sql, fork.chat_id, fork.id, fork.tip_slot_id)
          const rows = yield* sql<{ id: string; chain_id: string; depth: number }>`
            SELECT s.id, s.chain_id, s.depth FROM json_each(${JSON.stringify(unique)}) asked
              CROSS JOIN slots s ON s.id = asked.value
            WHERE s.chat_id = ${fork.chat_id} AND NOT ${slotDeletedIn(sql, fork.id, "s")}`
          const shown = new Set(
            rows
              .filter((row) => positionOf(pieces, { id: row.id, chainId: row.chain_id, depth: row.depth }) !== null)
              .map((row) => row.id)
          )
          const missing = unique.find((id) => !shown.has(id))
          if (missing !== undefined) return yield* new NotFound({ entity: "slot", id: missing })
          const changed: Array<SlotId> = []
          for (const slotId of unique) if (yield* setSlotHidden(fork, slotId, hidden)) changed.push(slotId)
          return { chatId: fork.chat_id as ChatId, changed }
        }).pipe(transaction("SetSlotsHidden")),

      AddStateEvent: ({ userId, chatId, slotId, versionId, scope, data, forkId, displayEnd }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId)
          const at =
            versionId === null && data.key !== "lcm.settings"
              ? yield* statePosition(userId, chatId, slotId, forkId ?? null, displayEnd)
              : slotId
          // The slot written to must be live: a retained deleted tip (spec/MESSAGE-INSERT.md
          // §2.4) resolves to the live inserted message after it, where the event folds.
          yield* ownedPosition(userId, chatId, at)
          if (versionId !== null) {
            yield* found(
              sql`SELECT count(*) AS n FROM versions WHERE id = ${versionId} AND slot_id IS ${slotId} AND deleted_at IS NULL`,
              "version",
              versionId
            )
          }
          return yield* insertStateEvent(userId, chatId, at, versionId, scope, data, forkId ?? null)
        }).pipe(transaction("AddStateEvent")),

      AddStateEvents: ({ userId, chatId, slotId, data, forkId, displayEnd }) =>
        Effect.gen(function* () {
          yield* ownedChat(userId, chatId)
          const at = yield* statePosition(userId, chatId, slotId, forkId ?? null, displayEnd)
          yield* ownedPosition(userId, chatId, at)
          for (const event of data)
            yield* insertStateEvent(
              userId,
              chatId,
              event.key === "lcm.settings" ? slotId : at,
              null,
              null,
              event,
              forkId ?? null
            )
        }).pipe(transaction("AddStateEvents")),

      // --- Chats

      AddSelectedVersion: ({
        userId,
        slotId,
        forkId,
        version,
        expectedRowVersion,
        model,
        commitDraft,
        commitReasoningDraft
      }) =>
        Effect.gen(function* () {
          // The row version the user saw is the slot's as their fork shows it (slotInFork).
          const { slot, fork, rowVersion } = yield* slotInFork(userId, slotId, forkId ?? null)
          if (rowVersion !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "slot",
              id: slotId,
              expected: expectedRowVersion,
              actual: rowVersion
            })
          }
          yield* checkSpeaker(userId, version.speakerEntityId)
          if (model && (version.writer !== "model" || !(yield* ownedModel(sql, userId, model.connection, model.model))))
            return yield* new NotFound({ entity: "model", id: model.model })
          const [next] = yield* sql<{
            n: number
          }>`SELECT coalesce(max(ordinal), -1) + 1 AS n FROM versions WHERE slot_id = ${slotId}`
          const cast = yield* presenceBefore(sql, slot.chat_id, slotId, fork.id)
          const inserted = yield* insertVersion(slotId, next!.n, version, Date.now(), fork.id, undefined, cast)
          // A workshop reply's version records where the story stands: its run reads there (§2.2).
          yield* recordStoryAt(sql, slot.chat_id, slotId, [inserted.id], fork.id)
          // The model chosen for it shows from the start; its rollout records the same one.
          if (model)
            yield* sql`UPDATE versions SET connection_id = ${model.connection}, model_id = ${model.model}
              WHERE id = ${inserted.id}`
          const row = model ? yield* ownedVersion(userId, inserted.id as VersionId, true) : inserted
          yield* recordHistoryReduction(sql, slotId, row.content, null, fork.id)
          yield* writeSelect(sql, { id: fork.id, chatId: slot.chat_id }, slotId, row.id)
          // A swipe, a continue or an edit is chatting in the fork (UX-REWORK §3, owner 2026-10-27).
          yield* chatIn(fork.id, Date.now())
          // An edit's text was typed into the edit of its source; a version of one's own, into the slot's.
          yield* drafts.commit(
            userId,
            commitDraft ?? null,
            version.sourceVersionId
              ? {
                  targetKind: "version_edit",
                  targetId: version.sourceVersionId,
                  matchesField: (_kind, field) => field === "",
                  content: version.rewrite?.raw ?? row.content,
                  images: toVersion(row).images ?? [],
                  // The edit's history goes on with the version its Save made (owner, 2026-11-02).
                  moveTo: row.id
                }
              : {
                  targetKind: "scratchpad",
                  targetId: slotId,
                  content: version.rewrite?.raw ?? row.content,
                  images: toVersion(row).images ?? []
                }
          )
          // Its thinking, typed into the same edit's thinking field, goes on with it the same way.
          if (version.sourceVersionId && commitReasoningDraft)
            yield* drafts.commit(userId, commitReasoningDraft, {
              targetKind: "version_edit",
              targetId: version.sourceVersionId,
              matchesField: (_kind, field) => field === EDIT_THINKING_FIELD,
              content: commitReasoningDraft.text,
              moveTo: row.id
            })
          return { chatId: slot.chat_id as ChatId, forkId: fork.id as ForkId, version: toVersion(row) }
        }).pipe(transaction("AddSelectedVersion")),

      AmendVersion: ({
        userId,
        versionId,
        forkId,
        content,
        keepContent,
        images,
        reasoning,
        replySections,
        expectedRowVersion,
        commitDraft,
        commitReasoningDraft,
        rewrite
      }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          if (row.writer !== "human") return yield* new NotAmendable({ versionId })
          const { slot, fork } = yield* slotInFork(userId, row.slot_id as SlotId, yield* forkOf(row.slot_id, forkId))
          const original = (row.fork_id === null ? row.id : row.source_version_id)!
          // The tab amends what it saw the fork show there; the fork showing another text in
          // its place since (an amend in another tab) makes it stale, as an amend in place does.
          const shown = (yield* versionAsShown(sql, fork.id, versionId))!
          const rowVersion = 1 + (shown.amend_count ?? 0)
          if (shown.id !== versionId || rowVersion !== expectedRowVersion) {
            return yield* new StaleWrite({
              entity: "version",
              id: versionId,
              expected: expectedRowVersion,
              actual: rowVersion
            })
          }
          yield* drafts.commit(userId, commitDraft ?? null, {
            targetKind: "version_edit",
            targetId: versionId,
            matchesField: (_kind, field) => field === "",
            content: rewrite?.raw ?? content,
            images: images ?? (JSON.parse(row.images_json ?? "[]") as MessageImages)
          })
          // The thinking, typed into the edit's thinking field, is committed the same way.
          yield* drafts.commit(userId, commitReasoningDraft ?? null, {
            targetKind: "version_edit",
            targetId: versionId,
            matchesField: (_kind, field) => field === EDIT_THINKING_FIELD,
            content: commitReasoningDraft?.text ?? ""
          })
          // The images it had, as its history keeps them, when this amend changes them.
          const had = JSON.parse(row.images_json ?? "[]") as MessageImages
          const normal = (list: MessageImages) =>
            JSON.stringify(
              list.map((image) => ({
                mediaId: image.mediaId,
                altText: image.altText ?? "",
                ...(image.kind ? { kind: image.kind } : {}),
                ...(image.name !== undefined ? { name: image.name } : {}),
                ...(image.path !== undefined ? { path: image.path } : {})
              }))
            )
          const before = images !== undefined && normal(images) !== normal(had) ? normal(had) : null
          // Its thinking, when this amend changes it: plain text, never a provider's signed block.
          const thinking = reasoning === undefined ? (row.reasoning ?? null) : reasoning || null
          const reasoningChanged = thinking !== (row.reasoning ?? null)
          // Or its reply sections, the thinking of a version without reasoning.
          const sections =
            replySections === undefined
              ? (row.reply_sections ?? null)
              : replySections === null || replySections.sections.length === 0
                ? null
                : JSON.stringify(replySections)
          const sectionsChanged = sections !== (row.reply_sections ?? null)
          const thinkingChanged = reasoningChanged || sectionsChanged
          // What its history keeps of the thinking it had (JSON: a string, or null for none).
          const hadThinking = JSON.stringify(row.reasoning ?? null)
          const hadSections = row.reply_sections ?? null
          const rewritten = rewriteColumns(rewrite)
          // Scripts' record of the thinking only changes with the thinking.
          const rawReasoning = reasoningChanged ? rewritten.raw_reasoning : (row.raw_reasoning ?? null)
          const rawSections = sectionsChanged ? rewritten.raw_sections : (row.raw_sections ?? null)
          if (content === row.content && before === null && !thinkingChanged) return toVersion(shown)
          if (before !== null) yield* checkImages(userId, images!, slot.chat_id)
          const attach = (target: string) =>
            Effect.forEach(
              images!,
              (
                image,
                ordinal
              ) => sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text, name, path)
                VALUES (${target}, ${ordinal}, ${image.mediaId}, ${image.kind ?? "image"}, ${image.altText || null},
                  ${image.name ?? null}, ${image.path ?? null})`,
              { discard: true }
            )
          // Changeset before/after identities are durable snapshots too: a later undo may
          // restore a version no fork currently shows. Preserve that row by copying here.
          const [retained] = yield* sql`SELECT 1 FROM changeset_items WHERE target_kind='version_replace'
            AND (before_json ->> '$.id'=${versionId} OR after_json ->> '$.id'=${versionId}) LIMIT 1`
          if (!retained && !(yield* shownElsewhere(sql, slot.chat_id, fork.id, row.slot_id, original, versionId))) {
            // No other fork shows it: the trigger keeps the previous text in version_history (DESIGN §3.1).
            yield* recordHistoryReduction(sql, row.slot_id, content, versionId)
            const at = Date.now()
            if (content !== row.content) {
              // The trigger keeps the earlier text and thinking in version_history.
              yield* sql`UPDATE version_records SET content = ${content}, reasoning = ${thinking},
                reply_sections = ${sections}, raw_content = ${rewritten.raw_content}, raw_reasoning = ${rawReasoning},
                raw_sections = ${rawSections}, rewrite_json = ${rewritten.rewrite_json}, updated_at = ${at}
                WHERE id = ${versionId}`
            } else {
              yield* sql`UPDATE versions SET updated_at = ${at} WHERE id = ${versionId}`
              // Images or thinking alone: the entry the trigger would have written.
              yield* sql`INSERT INTO version_history (version_id, content, replaced_at, images_json, reasoning_json, sections_json)
                VALUES (${versionId}, ${row.content}, ${at}, ${before ?? normal(had)}, ${hadThinking}, ${hadSections})`
              if (thinkingChanged)
                yield* sql`UPDATE version_records SET reasoning = ${thinking}, raw_reasoning = ${rawReasoning},
                  reply_sections = ${sections}, raw_sections = ${rawSections},
                  rewrite_json = ${keepContent ? rewritten.rewrite_json : (row.rewrite_json ?? null)},
                  updated_at = ${at} WHERE id = ${versionId}`
              // The import matcher reads whether this history exists, even when text did
              // not change. Certify image- and thinking-only amends in its whole-chat snapshot too.
              yield* sql`UPDATE chats SET shell_stamp = shell_stamp + 1 WHERE id = ${slot.chat_id}`
            }
            if (before !== null) {
              // The trigger kept the earlier text, if it changed; that entry keeps the earlier images too.
              if (content !== row.content)
                yield* sql`UPDATE version_history SET images_json = ${before}
                  WHERE id = (SELECT max(id) FROM version_history WHERE version_id = ${versionId})`
              yield* sql`DELETE FROM version_attachments WHERE version_id = ${versionId}`
              yield* attach(versionId)
            }
            return toVersion((yield* versionAsShown(sql, fork.id, versionId))!)
          }
          // Another fork shows it, so this fork gets a copy with the new text, standing in for
          // the message's own version, with its history as an amend in place would have it
          // (spec/FORK-INDEPENDENCE-DELTA.md §2.2).
          const at = Date.now()
          const copy = uuidv7()
          const columns = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('version_records')`)
            .map((c) => c.name)
            .filter((name) => !copiedFresh.has(name))
          yield* sql.unsafe(
            `INSERT INTO version_records (id, ordinal, content, origin, source_version_id, fork_id, authoring_fork_id, created_at, updated_at,
               ${columns.join(", ")})
             SELECT ?, (SELECT max(ordinal) + 1 FROM versions WHERE slot_id = v.slot_id), ?, 'edited', ?, ?, ?, ?, ?,
               ${columns.map((c) => `v.${c}`).join(", ")}
             FROM version_records v WHERE v.id = ?`,
            [copy, content, original, fork.id, fork.id, at, at, versionId]
          )
          yield* sql`UPDATE version_records SET reasoning = ${thinking}, reply_sections = ${sections},
            raw_content = ${rewritten.raw_content}, raw_reasoning = ${rawReasoning}, raw_sections = ${rawSections},
            rewrite_json = ${rewritten.rewrite_json} WHERE id = ${copy}`
          yield* sql`INSERT INTO version_history (version_id, content, replaced_at, images_json, reasoning_json, sections_json)
            SELECT ${copy}, content, replaced_at, images_json, reasoning_json, sections_json FROM version_history WHERE version_id = ${versionId} ORDER BY id`
          yield* sql`INSERT INTO version_history (version_id, content, replaced_at, images_json, reasoning_json, sections_json)
            VALUES (${copy}, ${row.content}, ${at}, ${normal(had)}, ${hadThinking}, ${hadSections})`
          if (before !== null) yield* attach(copy)
          else
            yield* sql`INSERT INTO version_attachments (version_id, ordinal, media_id, kind, alt_text, name, path)
              SELECT ${copy}, ordinal, media_id, kind, alt_text, name, path FROM version_attachments WHERE version_id = ${versionId}`
          yield* copyLibrary(sql, versionId, copy)
          // Shorter than what the fork showed, before the fork shows the copy.
          yield* recordHistoryReduction(sql, row.slot_id, content, null, fork.id)
          yield* writeOverride(
            sql,
            { id: fork.id, chatId: slot.chat_id },
            { kind: "replace", targetId: original, slotId: row.slot_id, valueId: copy, flag: null }
          )
          // The edit's history goes on with the copy that now shows its text (owner, 2026-11-02).
          if (commitDraft) yield* drafts.moveTo(commitDraft.draftId, versionId, copy)
          if (commitReasoningDraft) yield* drafts.moveTo(commitReasoningDraft.draftId, versionId, copy)
          return toVersion((yield* versionAsShown(sql, fork.id, copy))!)
        }).pipe(transaction("AmendVersion")),

      SaveGeneration: ({ userId, versionId, content, reasoning, replySections, status, error }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, false)
          // A version deleted for good stays empty, whatever was still generating into it.
          if (row.writer !== "model" || row.status !== "generating" || row.purged_at !== null) {
            return yield* new NotFound({ entity: "generating version", id: versionId })
          }
          yield* recordHistoryReduction(sql, row.slot_id, content, versionId)
          yield* sql`UPDATE version_records SET content = ${content}, status = ${status},
            reasoning = CASE WHEN ${reasoning === undefined ? 1 : 0} THEN reasoning ELSE ${reasoning || null} END,
            reply_sections = CASE WHEN ${replySections === undefined ? 1 : 0} THEN reply_sections
              ELSE ${replySections ? JSON.stringify(replySections) : null} END,
            error_json = ${error === null ? null : JSON.stringify(error)}, updated_at = ${Date.now()}
            WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, false))
        }).pipe(transaction("SaveGeneration")),

      // Flags are the fork's, on the message's own version a copy stands in for (§2.2).
      SetVersionFlags: ({ userId, versionId, forkId, starred, hidden }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          const { slot, fork } = yield* slotInFork(userId, row.slot_id as SlotId, yield* forkOf(row.slot_id, forkId))
          const original = (row.fork_id === null ? row.id : row.source_version_id)!
          const shown = (yield* versionAsShown(sql, fork.id, versionId))!
          const set = (kind: "star" | "picker_hide", value: boolean | undefined, now: number) =>
            value === undefined || (value ? 1 : 0) === now
              ? Effect.void
              : writeOverride(
                  sql,
                  { id: fork.id, chatId: slot.chat_id },
                  { kind, targetId: original, slotId: row.slot_id, valueId: null, flag: value ? 1 : 0 }
                )
          yield* set("star", starred, shown.starred)
          yield* set("picker_hide", hidden, shown.hidden)
          return {
            chatId: slot.chat_id as ChatId,
            forkId: fork.id as ForkId,
            version: toVersion((yield* versionAsShown(sql, fork.id, versionId))!)
          }
        }).pipe(transaction("SetVersionFlags")),

      // Taking an image out of the context is the fork's, on the message's own version (§2.2).
      SetImageExcluded: ({ userId, versionId, mediaId, forkId, excluded }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          const images = JSON.parse(row.images_json ?? "[]") as MessageImages
          if (!images.some((image) => image.mediaId === mediaId && image.kind !== "file"))
            return yield* new NotFound({ entity: "image", id: mediaId })
          const { slot, fork } = yield* slotInFork(userId, row.slot_id as SlotId, yield* forkOf(row.slot_id, forkId))
          const original = (row.fork_id === null ? row.id : row.source_version_id)!
          const [effective] = yield* sql<{ excluded: number }>`
            SELECT ${withFork(sql, fork.id, (f) => imageExcludedSql(f, "o.id", "m.id"))} AS excluded
            FROM versions o, (SELECT ${mediaId} AS id) m WHERE o.id = ${original}`
          if ((effective!.excluded === 1) !== excluded)
            yield* writeOverride(
              sql,
              { id: fork.id, chatId: slot.chat_id },
              {
                kind: "image_exclude",
                targetId: imageTarget(original, mediaId),
                slotId: row.slot_id,
                valueId: null,
                flag: excluded ? 1 : 0
              }
            )
          return { chatId: slot.chat_id as ChatId, forkId: fork.id as ForkId, slotId: row.slot_id as SlotId }
        }).pipe(transaction("SetImageExcluded")),

      // Hiding a version's thinking is the fork's, on the message's own version, as an image's is.
      SetThinkingHidden: ({ userId, versionId, part, forkId, hidden }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          const { slot, fork } = yield* slotInFork(userId, row.slot_id as SlotId, yield* forkOf(row.slot_id, forkId))
          const original = (row.fork_id === null ? row.id : row.source_version_id)!
          const [effective] = yield* sql<{ hidden: number }>`
            SELECT ${withFork(sql, fork.id, (f) => thinkingHiddenSql(f, "o.id"))} AS hidden
            FROM versions o WHERE o.id = ${original}`
          const bit = part === "reasoning" ? 1 : 2
          if (((effective!.hidden & bit) !== 0) !== hidden)
            yield* writeOverride(
              sql,
              { id: fork.id, chatId: slot.chat_id },
              {
                kind: "thinking_hide",
                targetId: thinkingTarget(original, part),
                slotId: row.slot_id,
                valueId: null,
                flag: hidden ? 1 : 0
              }
            )
          return { chatId: slot.chat_id as ChatId, forkId: fork.id as ForkId, slotId: row.slot_id as SlotId }
        }).pipe(transaction("SetThinkingHidden")),

      MarkVersion: ({ userId, versionId, mark }) =>
        Effect.gen(function* () {
          const row = yield* ownedVersion(userId, versionId, true)
          // A finished reply, or one that failed because it was never sent (the judge read what it
          // wrote instead, spec/REPLY-CONTRACT.md §3.6).
          const unsent =
            row.status === "failed" &&
            (JSON.parse(row.error_json ?? "null") as { class?: string } | null)?.class === "contract"
          if (row.writer !== "model" || (row.status !== "complete" && !unsent) || row.purged_at !== null)
            return yield* new NotFound({ entity: "version", id: versionId })
          yield* sql`UPDATE versions SET mark = ${mark} WHERE id = ${versionId}`
          return toVersion(yield* ownedVersion(userId, versionId, true))
        }).pipe(transaction("MarkVersion")),

      RenameChats: ({ userId, chats, name }) =>
        Effect.gen(function* () {
          const renamed: Array<ReturnType<typeof toChat>> = []
          for (const { chatId, from } of chats) {
            const chat = yield* ownedChat(userId, chatId)
            // Another rename came first. An automatic title is nobody's rename: a new chat's,
            // retitled by its cast or by its first turn, still takes the name meant for it.
            if (from !== null && chat.title !== from && chat.title_source !== "auto") continue
            const [row] = yield* sql<ChatRow>`
              UPDATE chats SET title = ${renamedTitle(chat.title, name)}, title_source = 'user',
                row_version = row_version + 1
              WHERE id = ${chatId} RETURNING *`
            renamed.push(toChat(row!))
          }
          return renamed
        }).pipe(transaction("RenameChats")),

      // --- Branches (DESIGN §3.2) and forks

      SetForkName: ({ userId, forkId, name }) =>
        Effect.gen(function* () {
          const fork = yield* ownedForkById(userId, forkId)
          const clean = cleanName(name)
          yield* sql`UPDATE forks SET name = ${clean === "" ? null : clean}, name_user = 1,
            row_version = row_version + 1 WHERE id = ${fork.id}`
          const [start] = yield* sql<{ id: SlotId }>`UPDATE slots SET row_version = row_version + 1
            WHERE fork_id = ${fork.id} AND parent_slot_id IS ${fork.base_slot_id} RETURNING id`
          return { fork: yield* forkOut(fork.id), startSlotId: start?.id ?? null }
        }).pipe(transaction("SetForkName")),

      SetForkPinned: ({ userId, forkId, pinned }) =>
        Effect.gen(function* () {
          yield* refusePendingOf(sql, "branch", forkId)
          const fork = yield* ownedForkById(userId, forkId)
          if ((fork.pinned_at !== null) !== pinned)
            yield* sql`UPDATE forks SET pinned_at = ${pinned ? Date.now() : null}, row_version = row_version + 1
              WHERE id = ${fork.id}`
          return yield* forkOut(fork.id)
        }).pipe(transaction("SetForkPinned")),

      CreateFork: ({ userId, chatId, fromForkId, atSlotId, notes, name }) =>
        Effect.gen(function* () {
          // A pending chat (DESIGN §2.1) has no branches until it is committed.
          yield* refusePending(sql, chatId)
          const from = yield* ownedFork(userId, chatId, fromForkId)
          if (atSlotId !== null)
            yield* found(
              sql`SELECT count(*) AS n FROM slots WHERE id = ${atSlotId} AND chat_id = ${chatId} AND deleted_at IS NULL`,
              "slot",
              atSlotId
            )
          const preview = notes
            ? yield* previewFork(sql, { userId, chatId, fromForkId: from.id as ForkId, atSlotId })
            : { notes: [], workshops: [] }
          const comparison = preview.notes
          const workshopChoices = notes?.workshops ?? []
          if (
            notes &&
            (notes.comparison !== canonicalJson(preview) ||
              notes.choices.some((choice) => !comparison.some((row) => row.note === choice.note)) ||
              new Set(notes.choices.map((choice) => choice.note)).size !== notes.choices.length ||
              workshopChoices.some((choice) => !preview.workshops.some((row) => row.workshop === choice.workshop)))
          )
            return yield* new ForkNotesChanged({
              message: "The notes or a workshop changed while this was open. Review them again."
            })
          const at = Date.now()
          const fork = yield* createFork(
            chatId,
            from,
            atSlotId,
            at,
            false,
            new Map(workshopChoices.map((choice) => [choice.workshop, choice.choice]))
          )
          // Making it is the user's activity in it: the shell's Recent counts it (db/shellReads.ts).
          yield* sql`UPDATE forks SET last_chatted_at = ${at} WHERE id = ${fork.id}`
          // An automatic name, not the user's (`name_user` stays 0): a label of the slot's own
          // (an ST import's) still wins among the alternates, and a rename replaces it.
          const automatic = cleanName(name ?? "")
          if (automatic !== "") yield* sql`UPDATE forks SET name = ${automatic} WHERE id = ${fork.id}`
          for (const row of comparison) {
            const choice = notes?.choices.find((choice) => choice.note === row.note)?.choice ?? "then"
            // Positional inheritance already gives "then". Rewriting it would detach
            // version-owned effects from their message and freeze default-on switches.
            if (choice === "then") continue
            const selected = row[choice]
            if (!row.card && selected.revision !== row.then.revision)
              yield* insertStateEvent(
                userId,
                chatId,
                atSlotId,
                null,
                null,
                { key: "note.binding", value: { note: row.note, revision: selected.revision as never } },
                fork.id as ForkId
              )
            if (selected.enabled !== row.then.enabled)
              yield* insertStateEvent(
                userId,
                chatId,
                atSlotId,
                null,
                null,
                { key: selected.enabled ? "note.activate" : "note.deactivate", value: { note: row.note } },
                fork.id as ForkId
              )
          }
          // The unsaved note text typed on the source goes with the branch, for each note it
          // starts with the version of (owner, 2026-11-02): the choices above are made first.
          const kept = comparison.filter(
            (row) => (notes?.choices.find((choice) => choice.note === row.note)?.choice ?? "then") === "then"
          )
          yield* carryChatNoteDrafts(userId, chatId, from, fork, new Set(kept.map((row) => row.note)))
          const [chat] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return { fork: yield* forkOut(fork.id), chat: toChat(chat!) }
        }).pipe(transaction("CreateFork")),

      SwitchBranch: ({ userId, chatId, slotId, index, forkId }) =>
        Effect.gen(function* () {
          const shown = yield* ownedFork(userId, chatId, forkId)
          const [slot] = yield* sql<{ parent_slot_id: string | null; inserted: number }>`
            SELECT parent_slot_id, inserted FROM slots WHERE id = ${slotId} AND chat_id = ${chatId}`
          if (!slot) return yield* new NotFound({ entity: "slot", id: slotId })
          // An inserted message has no alternates (ListBranches): index 0 is itself.
          const [sibling] =
            slot.inserted === 1
              ? index === 0
                ? [{ id: slotId }]
                : []
              : slot.parent_slot_id === null
                ? yield* sql<{ id: SlotId }>`
                  SELECT x.id FROM slots x INDEXED BY slots_chat_depth WHERE x.chat_id = ${chatId} AND x.depth = 0
                    AND ${sql.literal(reachableSlot("x"))}
                  ORDER BY x.id LIMIT 1 OFFSET ${index}`
                : yield* sql<{ id: SlotId }>`
                  SELECT x.id FROM slots x INDEXED BY slots_parent WHERE x.parent_slot_id = ${slot.parent_slot_id}
                    AND x.chat_id = ${chatId} AND ${sql.literal(reachableSlot("x"))}
                  ORDER BY x.id LIMIT 1 OFFSET ${index}`
          if (!sibling) return yield* new NotFound({ entity: "branch", id: `${slotId}#${index}` })
          let fork: ForkRow | null = yield* forkThrough(sql, chatId, sibling.id, shown.id)
          if (fork === null) {
            // A line no fork follows (a restored message's): one is made for it, from the
            // fork shown, ending on its newest replies, as a path opened there did before.
            const [tip] = yield* sql<{ id: string }>`
              WITH RECURSIVE down(id, n) AS (
                SELECT ${sibling.id}, 0
                UNION ALL
                SELECT (SELECT c.id FROM slots c WHERE c.parent_slot_id = d.id AND ${sql.literal(reachableSlot("c"))}
                    ORDER BY c.id DESC LIMIT 1), d.n + 1
                FROM down d WHERE d.id IS NOT NULL
              )
              SELECT id FROM down WHERE id IS NOT NULL ORDER BY n DESC LIMIT 1`
            fork = yield* insertFork(sql, {
              chatId,
              parent: shown,
              baseSlotId: slot.parent_slot_id,
              tipSlotId: tip!.id,
              at: Date.now()
            })
            yield* placeAsShown(chatId, shown, slot.parent_slot_id, fork)
          }
          const [chat] = yield* sql<ChatRow>`SELECT * FROM chats WHERE id = ${chatId}`
          return { slotId: sibling.id, fork: yield* forkOut(fork!.id), chat: toChat(chat!) }
        }).pipe(transaction("SwitchBranch"))
    } satisfies Partial<WriteHandlers>
    return handlers
  })
