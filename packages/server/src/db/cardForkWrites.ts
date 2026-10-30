// Card forks (spec/CARD-FORKS-DELTA.md §2, ARCHITECTURE.md §3.9): a fork is a card of its
// own, an entity with one ref, tied to the card it came from only by the relationship
// recorded on it. Each handler is one writer transaction, through the library's steps.
import { cardNameClash } from "@rp/shared/cardNames.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import { Effect, Schema } from "effect"
import { FoldableEvent, foldState } from "@rp/shared/state.ts"
import { ComposerChoice } from "@rp/shared/composerApi.ts"
import { makeGraphWrites } from "./graphWrites.ts"
import { noteSwitchesOnPath, stateEventsThrough } from "./stateRead.ts"
import { withoutPurged } from "./stateRefs.ts"
import { onForkPath } from "./forks.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import { toLibraryRef } from "./library.ts"
import { NotFound, RefOperationRefused, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

/** The name drafts a fork's dialog decides, so they stay on the card forked from. */
const NAME_FIELDS = ["name", "nickname", "character_version"].flatMap((key) => [`["${key}"]`, `=["${key}"]`])

export const makeCardForkWriteHandlers = (steps: LibrarySteps) => {
  const { sql, lib } = steps

  /** The user's card, not in the bin, or NotFound. */
  const liveCard = (userId: UserId, entityId: string) =>
    sql<{ id: string; forked_from_entity_id: string | null }>`
      SELECT id, forked_from_entity_id FROM entities
      WHERE id = ${entityId} AND owner_user_id = ${userId} AND kind = 'card' AND deleted_at IS NULL`.pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "card", id: entityId }))
      )
    )

  const family = (userId: UserId, entityId: string) => Effect.map(lib.cardFamily(userId, entityId), (found) => found!)

  const graph = makeGraphWrites(sql, steps.drafts)
  const copyCard = (
    {
      userId,
      refId,
      name,
      nickname,
      characterVersion,
      moveDrafts
    }: {
      userId: UserId
      refId: RefId
      name: string
      nickname: string
      characterVersion: string
      moveDrafts: boolean
    },
    sourceRevision?: string
  ) =>
    Effect.gen(function* () {
      const ref = yield* lib.ownedRef(userId, refId)
      if (ref.kind !== "card") {
        return yield* new RefOperationRefused({ refId, reason: "Only cards fork into cards of their own." })
      }
      // The pair tells cards apart (DESIGN §4), checked here in the same transaction as the
      // write, against the same cards the client checks (live and archived, not in the bin).
      const same = yield* sql<{ id: RefId; label: string; subtitle: string }>`
          SELECT r.id, r.label, r.subtitle FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL
            AND r.ref_kind = 'upstream' AND r.label = ${name} AND r.subtitle = ${characterVersion}`
      const clash = cardNameClash(same, name, characterVersion)
      if (clash !== null) return yield* new RefOperationRefused({ refId, reason: clash })

      const source = sourceRevision ?? ref.head_revision_id
      const doc: Doc = {
        ...(yield* lib.loadDoc(source)),
        name,
        nickname,
        character_version: characterVersion
      }
      const fork = yield* steps.createUpstream({
        userId,
        kind: "card",
        label: name,
        subtitle: characterVersion,
        doc: steps.encode(doc),
        schemaVersion: (yield* steps.revision(source)).schema_version,
        origin: "user",
        originRef: JSON.stringify({ forked: source }),
        sourcePath: null,
        sourceHash: null,
        message: `Forked from ${ref.label}${ref.subtitle ? ` · ${ref.subtitle}` : ""}`
      })
      const at = Date.now()
      yield* sql`UPDATE entities SET forked_from_entity_id = ${ref.entity_id}, forked_from_revision_id = ${source},
                   forked_at = ${at} WHERE id = ${fork.entity_id}`
      // Folders, the persona folder included.
      yield* sql`INSERT INTO entity_tags (entity_id, tag)
                   SELECT ${fork.entity_id}, tag FROM entity_tags WHERE entity_id = ${ref.entity_id}`

      // The card's own notes, each a new note of the fork's from its head (DESIGN §4, Q2).
      const notes = yield* lib.refsWhere(
        `e.owner_user_id = ? AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
           AND json_extract((SELECT h.doc_json FROM entity_revisions h WHERE h.id = r.head_revision_id),
             '$.owner.card') = ?`,
        [userId, ref.entity_id]
      )
      const noteCopies = new Map<string, EntityId>()
      for (const note of notes.toSorted((a, b) => (a.entity_id < b.entity_id ? -1 : 1))) {
        const noteDoc = yield* lib.loadDoc(note.head_revision_id)
        const copy = yield* steps.createUpstream({
          userId,
          kind: "note",
          label: note.label,
          subtitle: note.subtitle,
          doc: steps.encode({ ...noteDoc, owner: { card: fork.entity_id as EntityId } }),
          schemaVersion: (yield* steps.revision(note.head_revision_id)).schema_version,
          origin: "user",
          originRef: JSON.stringify({ forked: note.head_revision_id }),
          sourcePath: null,
          sourceHash: null,
          message: "Copied with the card's fork"
        })
        noteCopies.set(note.entity_id, copy.entity_id as EntityId)
        yield* sql`INSERT INTO entity_tags (entity_id, tag)
                     SELECT ${copy.entity_id}, tag FROM entity_tags WHERE entity_id = ${note.entity_id}`
      }

      // The ref's unsaved drafts, but its names, which the dialog gave. One that started from
      // the head copied starts from the fork's first revision, the same content; an older
      // base stays the parent's, which the commit reads through the relationship.
      if (moveDrafts) {
        yield* sql`UPDATE drafts SET target_id = ${fork.id},
                       base_revision = CASE WHEN base_revision = ${source} THEN ${fork.head_revision_id} ELSE base_revision END,
                       row_version = row_version + 1, updated_at = ${at}
                     WHERE user_id = ${userId} AND target_kind = 'entity_field' AND target_id = ${refId}
                       AND status = 'active' AND field NOT IN ${sql.in(NAME_FIELDS)}`
      }
      return { ref: toLibraryRef(yield* steps.reload(fork.id)), noteCopies }
    })

  const handlers = {
    ForkCard: (input) =>
      copyCard(input).pipe(
        Effect.map(({ ref }) => ref),
        transaction(sql, "ForkCard")
      ),

    ForkCardForChat: ({ userId, chatId, slotId, forkId, entityId, ...names }) =>
      Effect.gen(function* () {
        const fork = yield* graph.ownedFork(userId, chatId, forkId ?? null)
        if (slotId !== null && !(yield* onForkPath(sql, chatId, fork, slotId)))
          return yield* new NotFound({ entity: "fork position", id: slotId })
        const rows = yield* stateEventsThrough(sql, chatId, slotId, fork.id)
        const events = yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(FoldableEvent)({
            scope: row.scope,
            data: { key: row.key, value: JSON.parse(row.value_json) }
          }).pipe(Effect.orDie)
        )
        const state = foldState(yield* withoutPurged(sql, events))
        if (!state.participants.includes(entityId)) return yield* new NotFound({ entity: "cast card", id: entityId })
        const library = yield* lib.cardLibraryRef(userId, entityId)
        const binding = state.cardBindings[entityId]
        const used = yield* lib.cardInChat(userId, chatId, entityId, binding)
        if (!library || !used) return yield* new NotFound({ entity: "card", id: entityId })
        const { ref, noteCopies } = yield* copyCard(
          { userId, refId: (used.refId ?? library.id) as RefId, ...names },
          used.revisionId
        )
        yield* sql`UPDATE entities SET forked_in_chat_id = ${chatId} WHERE id = ${ref.entityId}`
        yield* graph.insertStateEvent(
          userId,
          chatId,
          slotId,
          null,
          null,
          {
            key: "card.swap",
            value: { entity: ref.entityId, replaces: entityId }
          },
          fork.id
        )
        // Copy switches even on unselected versions or deleted slots: a later swipe or
        // restore must recover the note's setting too. Sibling forks stay untouched.
        const switches = yield* noteSwitchesOnPath(sql, chatId, slotId, fork.id)
        for (const row of switches) {
          const note = noteCopies.get((JSON.parse(row.value_json) as { note: string }).note)
          if (!note) continue
          yield* graph.insertStateEvent(
            userId,
            chatId,
            row.slot_id,
            row.version_id,
            null,
            {
              key: row.key,
              value: { note }
            },
            fork.id
          )
        }
        const at = Date.now()
        yield* sql`UPDATE queued_messages SET
          speaker_entity_id = CASE WHEN speaker_entity_id = ${entityId} THEN ${ref.entityId} ELSE speaker_entity_id END,
          reply_speaker_entity_id = CASE WHEN reply_speaker_entity_id = ${entityId} THEN ${ref.entityId} ELSE reply_speaker_entity_id END,
          row_version = row_version + 1, updated_at = ${at}
          WHERE chat_id = ${chatId} AND fork_id = ${fork.id}
            AND (speaker_entity_id = ${entityId} OR reply_speaker_entity_id = ${entityId})`
        const choices = yield* sql<{
          id: string
          speaker_entity_id: EntityId | null
          reply_from_entity_id: EntityId | null
        }>`
          UPDATE drafts SET
            speaker_entity_id = CASE WHEN speaker_entity_id = ${entityId} THEN ${ref.entityId} ELSE speaker_entity_id END,
            reply_from_entity_id = CASE WHEN reply_from_entity_id = ${entityId} THEN ${ref.entityId} ELSE reply_from_entity_id END
          WHERE user_id = ${userId} AND target_kind = 'composer' AND target_id = ${chatId} AND field = ${fork.id}
            AND (speaker_entity_id = ${entityId} OR reply_from_entity_id = ${entityId})
          RETURNING id, speaker_entity_id, reply_from_entity_id`
        return {
          ref,
          choices: choices.map(
            (c) =>
              new ComposerChoice({
                draftId: c.id,
                speakerEntityId: c.speaker_entity_id,
                replyFromEntityId: c.reply_from_entity_id
              })
          )
        }
      }).pipe(transaction(sql, "ForkCardForChat")),

    SetCardParent: ({ userId, entityId, parentEntityId }) =>
      Effect.gen(function* () {
        const card = yield* liveCard(userId, entityId)
        if (parentEntityId === null) {
          yield* sql`UPDATE entities SET forked_from_entity_id = NULL, forked_from_revision_id = NULL,
                     forked_in_chat_id = NULL, forked_at = NULL WHERE id = ${entityId}`
          return yield* family(userId, entityId)
        }
        yield* liveCard(userId, parentEntityId)
        if (parentEntityId === entityId) {
          return yield* new RefOperationRefused({ refId: entityId, reason: "A card can't be a fork of itself." })
        }
        // Already so: the relationship, and the revision a fork copied, stay as they are.
        if (card.forked_from_entity_id === parentEntityId) return yield* family(userId, entityId)
        const [cycle] = yield* sql<{ n: number }>`
          WITH RECURSIVE up(id) AS (
            SELECT ${parentEntityId}
            UNION
            SELECT e.forked_from_entity_id FROM entities e JOIN up ON e.id = up.id
            WHERE e.forked_from_entity_id IS NOT NULL)
          SELECT count(*) AS n FROM up WHERE id = ${entityId}`
        if (cycle!.n > 0) {
          return yield* new RefOperationRefused({
            refId: entityId,
            reason: "That card is already a fork of this one, so this can't be a fork of it."
          })
        }
        yield* sql`UPDATE entities SET forked_from_entity_id = ${parentEntityId}, forked_from_revision_id = NULL,
                   forked_in_chat_id = NULL, forked_at = ${Date.now()} WHERE id = ${entityId}`
        return yield* family(userId, entityId)
      }).pipe(transaction(sql, "SetCardParent"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
  return handlers
}
