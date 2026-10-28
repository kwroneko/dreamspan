// Library logic shared by the writer and the readers: ref rows, documents, and merge
// planning (DATA-MODEL §3.2). Merge planning is pure given the three documents, so the
// reader's preview and the writer's merge always agree.
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import {
  CardFamily,
  type Doc,
  type EntityKind,
  FamilyMember,
  type FamilyMemberState,
  LibraryRef,
  MergeConflictInfo,
  type MergeOutcome,
  type RefId,
  type RefKind,
  type RevisionId
} from "@rp/shared/library.ts"
import { hasSchema, validateDoc } from "@rp/shared/editing.ts"
import { merge3 } from "@rp/shared/merge.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { docHash } from "./documents.ts"

/** A chat's `card.binding` for one card, as the state fold leaves it. */
export interface CardBinding {
  readonly ref?: string | undefined
  readonly revision?: string | undefined
}
import { NotFound } from "./ops.ts"

export interface RefRow {
  readonly id: string
  readonly entity_id: string
  readonly kind: EntityKind
  readonly ref_kind: RefKind
  readonly label: string
  readonly subtitle: string
  readonly head_revision_id: string
  readonly follows_ref_id: string | null
  readonly merge_base_revision_id: string | null
  readonly chat_id: string | null
  readonly row_version: number
  readonly updated_at: number
  /** The head of the followed ref; for an upstream ref, its latest import. */
  readonly followed_head: string | null
  /** The followed ref's label; null for an upstream ref. */
  readonly followed_label: string | null
}

export const toLibraryRef = (row: RefRow) =>
  new LibraryRef({
    id: row.id as RefId,
    entityId: row.entity_id as EntityId,
    kind: row.kind,
    refKind: row.ref_kind,
    label: row.label,
    subtitle: row.subtitle,
    headRevisionId: row.head_revision_id as RevisionId,
    followsRefId: row.follows_ref_id as RefId | null,
    chatId: row.chat_id as ChatId | null,
    hasImport: row.ref_kind === "upstream" && row.followed_head !== null,
    updateAvailable: row.followed_head !== null && row.followed_head !== row.merge_base_revision_id,
    rowVersion: row.row_version,
    updatedAt: row.updated_at
  })

// An upstream ref follows its imports: the latest import is what it merges in, and its
// merge base is the import it last merged. So a re-import merges with the user's edits
// to the upstream the same way a variant merges with its upstream.
const refSelect = `
  SELECT r.id, r.entity_id, e.kind, r.ref_kind, r.label, r.subtitle, r.head_revision_id, r.follows_ref_id,
    r.merge_base_revision_id, r.chat_id, r.row_version, r.updated_at, f.label AS followed_label,
    CASE WHEN r.ref_kind = 'upstream'
      THEN (SELECT i.id FROM entity_revisions i WHERE i.entity_id = r.entity_id AND i.origin = 'import'
            ORDER BY i.seq DESC LIMIT 1)
      ELSE f.head_revision_id END AS followed_head
  FROM entity_refs r
  JOIN entities e ON e.id = r.entity_id
  LEFT JOIN entity_refs f ON f.id = r.follows_ref_id`

export const makeLibraryQueries = (sql: SqlClient.SqlClient) => {
  const ownedRef = (userId: UserId, refId: string) =>
    sql
      .unsafe<RefRow>(`${refSelect} WHERE r.id = ? AND e.owner_user_id = ? AND e.deleted_at IS NULL`, [refId, userId])
      .pipe(
        Effect.flatMap(([row]) => (row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity: "ref", id: refId }))))
      )

  const refsWhere = (where: string, params: ReadonlyArray<unknown>) =>
    sql.unsafe<RefRow>(`${refSelect} WHERE ${where} ORDER BY r.label, r.id`, params)

  const loadDoc = (revisionId: string) =>
    sql<{ doc_json: string }>`SELECT doc_json FROM entity_revisions WHERE id = ${revisionId}`.pipe(
      Effect.map(([row]) => JSON.parse(row!.doc_json) as Doc)
    )

  /** What merging `ref` with what it follows would do. */
  const planMerge = (ref: RefRow) =>
    Effect.gen(function* () {
      const theirsHead = ref.followed_head
      const ours = yield* loadDoc(ref.head_revision_id)
      const upToDate = { outcome: "up_to_date" as MergeOutcome, merged: ours, conflicts: [] }
      if (theirsHead === null || theirsHead === ref.merge_base_revision_id) {
        return { ...upToDate, theirsHead: theirsHead ?? ref.head_revision_id }
      }
      const theirs = yield* loadDoc(theirsHead)
      // No edits of its own since the last merge: just move to theirs.
      if (ref.head_revision_id === ref.merge_base_revision_id) {
        return { outcome: "fast_forward" as MergeOutcome, merged: theirs, conflicts: [], theirsHead }
      }
      // An upstream that has no import yet shares no ancestor with its first one.
      const base = ref.merge_base_revision_id === null ? {} : yield* loadDoc(ref.merge_base_revision_id)
      const result = merge3(base, ours, theirs)
      // Theirs brings nothing new: only the merge base moves.
      if (result.conflicts.length === 0 && docHash(result.value as Doc) === docHash(ours)) {
        return { ...upToDate, theirsHead }
      }
      // Two valid edits can merge into an invalid document (an order entry naming a prompt
      // the other side deleted). The fields the schema refuses become conflicts to resolve.
      const merged = result.value as Doc
      if (result.conflicts.length === 0 && hasSchema(ref.kind)) {
        const check = validateDoc(ref.kind, merged)
        if (!check.ok) {
          const fields = [...new Set(check.paths.map((path) => String(path[0] ?? "")))]
          return {
            outcome: "conflicts" as MergeOutcome,
            merged,
            conflicts: fields.map((field) =>
              field === ""
                ? new MergeConflictInfo({ path: [], base, ours, theirs })
                : new MergeConflictInfo({
                    path: [field],
                    ...(Object.hasOwn(base, field) ? { base: base[field] } : {}),
                    ...(Object.hasOwn(ours, field) ? { ours: ours[field] } : {}),
                    ...(Object.hasOwn(theirs, field) ? { theirs: theirs[field] } : {})
                  })
            ),
            theirsHead
          }
        }
      }
      return {
        outcome: (result.conflicts.length > 0 ? "conflicts" : "merged") as MergeOutcome,
        merged: result.value as Doc,
        conflicts: result.conflicts,
        theirsHead
      }
    })

  /**
   * The upstream ref of the card's first note, the one ST's Character's Note maps to: not a
   * module made a note, nor ST's Character Author's Note.
   */
  const cardNote = (userId: UserId, cardEntityId: string) =>
    sql<{ id: string }>`
      SELECT r.id FROM entity_refs r
      JOIN entities e ON e.id = r.entity_id
      JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
        AND json_extract(h.doc_json, '$.owner.card') = ${cardEntityId}
        AND json_extract(h.doc_json, '$.module_id') IS NULL
        AND coalesce(json_extract(h.doc_json, '$.kind'), '') <> 'character_author_note'
      ORDER BY e.id LIMIT 1`.pipe(Effect.flatMap(([row]) => (row ? ownedRef(userId, row.id) : Effect.succeed(null))))

  /** The upstream ref of the card's note an import made from the card module or exported note `id`. */
  const cardNoteFrom = (userId: UserId, cardEntityId: string, id: string) =>
    sql<{ id: string }>`
      SELECT r.id FROM entity_refs r
      JOIN entities e ON e.id = r.entity_id
      JOIN entity_revisions h ON h.id = r.head_revision_id
      WHERE e.owner_user_id = ${userId} AND e.kind = 'note' AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
        AND json_extract(h.doc_json, '$.owner.card') = ${cardEntityId}
        AND json_extract(h.doc_json, '$.module_id') = ${id}
      ORDER BY e.id LIMIT 1`.pipe(Effect.flatMap(([row]) => (row ? ownedRef(userId, row.id) : Effect.succeed(null))))

  /**
   * The chats a change to this ref reaches: those whose state names it, those with an
   * override following it, and, for the entity's upstream, those the card joined. A chat
   * counts even if the card left it since: better to say too many than too few.
   */
  const usedByChats = (userId: UserId, ref: Pick<RefRow, "id" | "ref_kind" | "entity_id">) =>
    sql<{ n: number }>`
      SELECT count(*) AS n FROM chats c
      WHERE c.owner_user_id = ${userId} AND c.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM state_events s WHERE s.chat_id = c.id
          AND s.key IN ('card.binding', 'preset.binding', 'lorebook.attach')
          AND json_extract(s.value_json, '$.ref') = ${ref.id})
        OR EXISTS (SELECT 1 FROM entity_refs o WHERE o.chat_id = c.id AND o.follows_ref_id = ${ref.id})
        OR (${ref.ref_kind === "upstream" ? 1 : 0} AND EXISTS (SELECT 1 FROM state_events s
          WHERE s.chat_id = c.id AND s.key IN ('participant.join', 'card.swap')
            AND json_extract(s.value_json, '$.entity') = ${ref.entity_id})))`.pipe(Effect.map(([row]) => row!.n))

  /**
   * A live card's single upstream ref. Null when it isn't the user's live card.
   */
  const cardLibraryRef = (userId: UserId, entityId: string) =>
    sql<{ id: string }>`
      SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
      WHERE r.entity_id = ${entityId} AND e.owner_user_id = ${userId} AND e.kind = 'card'
        AND e.deleted_at IS NULL AND r.ref_kind = 'upstream'
      LIMIT 1`.pipe(Effect.flatMap(([row]) => (row ? ownedRef(userId, row.id) : Effect.succeed(null))))

  /**
   * The version of a card a chat reads at a position, by the context assembler's rules
   * (assemblySources.ts `card`): a revision the chat's state binds, else its upstream head.
   * A ref binding can name only that same upstream. `binding` is
   * the folded `card.binding` there. Null when that isn't the user's live card.
   */
  const cardInChat = (userId: UserId, _chatId: string, entityId: string, binding: CardBinding | undefined) =>
    Effect.gen(function* () {
      if (binding?.revision) {
        const [row] = yield* sql<{ id: string }>`
          SELECT v.id FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
          WHERE v.id = ${binding.revision} AND e.id = ${entityId} AND e.owner_user_id = ${userId}
            AND e.kind = 'card' AND e.deleted_at IS NULL`
        return row ? { refId: binding.ref ?? null, revisionId: row.id } : null
      }
      const which = binding?.ref ? sql`r.id = ${binding.ref} AND r.ref_kind = 'upstream'` : sql`r.ref_kind = 'upstream'`
      const [row] = yield* sql<{ id: string; head_revision_id: string }>`
        SELECT r.id, r.head_revision_id FROM entity_refs r JOIN entities e ON e.id = r.entity_id
        WHERE r.entity_id = ${entityId} AND e.owner_user_id = ${userId} AND e.kind = 'card'
          AND e.deleted_at IS NULL AND ${which}
        LIMIT 1`
      return row ? { refId: row.id as string | null, revisionId: row.head_revision_id } : null
    })

  /**
   * A revision a ref's drafts can start from: of the ref's own entity, or, for a draft moved
   * along with a fork (ForkCard), of the card it was forked from. Null when it's neither, or gone.
   */
  const draftBase = (entityId: string, revisionId: string) =>
    sql<{ doc_json: string }>`
      SELECT doc_json FROM entity_revisions WHERE id = ${revisionId}
        AND entity_id IN (${entityId}, (SELECT forked_from_entity_id FROM entities WHERE id = ${entityId}))`.pipe(
      Effect.map(([row]) => row ?? null)
    )

  /**
   * A card's family (spec/CARD-FORKS-DELTA.md §2): up its parents to the root, the member with
   * none, then down from there to every fork of a fork, so it's the same from any member.
   * Binned and purged members stay, marked. UNION, not UNION ALL, so even a cycle the writer
   * should have refused ends the walk. Null when `entityId` isn't the user's live card.
   */
  const cardFamily = (userId: UserId, entityId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        id: string
        parent: string | null
        revision: string | null
        chat: string | null
        forked_at: number | null
        archived_at: number | null
        deleted_at: number | null
        purged_at: number | null
        ref_id: string | null
        label: string | null
        subtitle: string | null
        used: string
        root: string
      }>`
        WITH RECURSIVE
          asked(id) AS (
            SELECT id FROM entities WHERE id = ${entityId} AND owner_user_id = ${userId} AND kind = 'card'
              AND deleted_at IS NULL),
          up(id, parent) AS (
            SELECT e.id, e.forked_from_entity_id FROM entities e JOIN asked ON asked.id = e.id
            UNION
            SELECT e.id, e.forked_from_entity_id FROM entities e JOIN up ON e.id = up.parent
            WHERE e.owner_user_id = ${userId}),
          root(id) AS (SELECT coalesce((SELECT id FROM up WHERE parent IS NULL LIMIT 1), (SELECT id FROM asked))),
          family(id) AS (
            SELECT id FROM root WHERE id IS NOT NULL
            UNION
            SELECT e.id FROM entities e JOIN family f ON e.forked_from_entity_id = f.id
            WHERE e.owner_user_id = ${userId})
        SELECT e.id, e.forked_from_entity_id AS parent, e.forked_from_revision_id AS revision,
          e.forked_in_chat_id AS chat, e.forked_at, e.archived_at, e.deleted_at, e.purged_at,
          r.id AS ref_id, r.label, r.subtitle, (SELECT id FROM root) AS root,
          (SELECT json_object('chats', count(DISTINCT c.id), 'last', max(c.last_message_at))
            FROM state_events s JOIN chats c ON c.id = s.chat_id
            WHERE json_extract(s.value_json, '$.entity') = +e.id
              AND s.key IN ('participant.join', 'card.swap') AND s.superseded_by_changeset IS NULL
              AND c.owner_user_id = ${userId} AND c.deleted_at IS NULL) AS used
        FROM family JOIN entities e ON e.id = family.id
        LEFT JOIN entity_refs r ON r.id = (
          SELECT r2.id FROM entity_refs r2 WHERE r2.entity_id = e.id AND r2.ref_kind = 'upstream'
          LIMIT 1)
        ORDER BY e.id`
      if (rows.length === 0) return null
      const state = (row: (typeof rows)[number]): FamilyMemberState =>
        row.purged_at !== null
          ? "purged"
          : row.deleted_at !== null
            ? "binned"
            : row.archived_at !== null
              ? "archived"
              : "live"
      return new CardFamily({
        rootEntityId: rows[0]!.root as EntityId,
        members: rows.map((row) => {
          const used = JSON.parse(row.used) as { chats: number; last: number | null }
          return new FamilyMember({
            entityId: row.id as EntityId,
            parentEntityId: row.parent as EntityId | null,
            refId: row.ref_id as RefId | null,
            label: row.label ?? "",
            subtitle: row.subtitle ?? "",
            state: state(row),
            forkedFromRevisionId: row.revision as RevisionId | null,
            forkedInChatId: row.chat as ChatId | null,
            forkedAt: row.forked_at,
            chats: used.chats,
            lastMessageAt: used.last
          })
        })
      })
    })

  return {
    cardFamily,
    draftBase,
    ownedRef,
    refsWhere,
    loadDoc,
    planMerge,
    cardNote,
    cardNoteFrom,
    usedByChats,
    cardLibraryRef,
    cardInChat
  }
}
