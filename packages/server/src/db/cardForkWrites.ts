// Card forks (spec/CARD-FORKS-DELTA.md §2, ARCHITECTURE.md §3.9): a fork is a card of its
// own, an entity with one ref, tied to the card it came from only by the relationship
// recorded on it. Each handler is one writer transaction, through the library's steps.
import { cardNameClash } from "@rp/shared/cardNames.ts"
import type { EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
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

  const handlers = {
    ForkCard: ({ userId, refId, name, nickname, characterVersion, moveDrafts }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        if (ref.kind !== "card") {
          return yield* new RefOperationRefused({ refId, reason: "Only cards fork into cards of their own." })
        }
        if (ref.ref_kind === "chat_override") {
          return yield* new RefOperationRefused({
            refId,
            reason: "A chat override can't be forked; promote it to a variant instead."
          })
        }
        // The pair tells cards apart (DESIGN §4), checked here in the same transaction as the
        // write, against the same cards the client checks (live and archived, not in the bin).
        const same = yield* sql<{ id: RefId; label: string; subtitle: string }>`
          SELECT r.id, r.label, r.subtitle FROM entity_refs r JOIN entities e ON e.id = r.entity_id
          WHERE e.owner_user_id = ${userId} AND e.kind = 'card' AND e.deleted_at IS NULL
            AND r.ref_kind <> 'chat_override' AND r.label = ${name} AND r.subtitle = ${characterVersion}`
        const clash = cardNameClash(same, name, characterVersion)
        if (clash !== null) return yield* new RefOperationRefused({ refId, reason: clash })

        const source = ref.head_revision_id
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
        return toLibraryRef(yield* steps.reload(fork.id))
      }).pipe(transaction(sql, "ForkCard")),

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
