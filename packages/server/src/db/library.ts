// Library logic shared by the writer and the readers: ref rows, documents, and merge
// planning (DATA-MODEL §3.2). Merge planning is pure given the three documents, so the
// reader's preview and the writer's merge always agree.
import { createHash } from "node:crypto"
import type { ChatId, EntityId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import {
  type Doc,
  type EntityKind,
  LibraryRef,
  MergeConflictInfo,
  type MergeOutcome,
  type RefId,
  type RefKind,
  type RevisionId
} from "@rp/shared/library.ts"
import { merge3 } from "@rp/shared/merge.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
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
  /** The head of the followed ref, joined in. */
  readonly followed_head: string | null
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
    updateAvailable: row.followed_head !== null && row.followed_head !== row.merge_base_revision_id,
    rowVersion: row.row_version,
    updatedAt: row.updated_at
  })

const refSelect = `
  SELECT r.id, r.entity_id, e.kind, r.ref_kind, r.label, r.subtitle, r.head_revision_id, r.follows_ref_id,
    r.merge_base_revision_id, r.chat_id, r.row_version, r.updated_at, f.head_revision_id AS followed_head
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

  /** What merging `ref` with the ref it follows would do. */
  const planMerge = (ref: RefRow) =>
    Effect.gen(function* () {
      const theirsHead = ref.followed_head
      if (theirsHead === null || ref.merge_base_revision_id === null) {
        return {
          outcome: "up_to_date" as MergeOutcome,
          merged: yield* loadDoc(ref.head_revision_id),
          conflicts: [],
          theirsHead: ref.head_revision_id
        }
      }
      if (theirsHead === ref.merge_base_revision_id) {
        return {
          outcome: "up_to_date" as MergeOutcome,
          merged: yield* loadDoc(ref.head_revision_id),
          conflicts: [],
          theirsHead
        }
      }
      const theirs = yield* loadDoc(theirsHead)
      // No edits of its own since the last merge: just move to theirs.
      if (ref.head_revision_id === ref.merge_base_revision_id) {
        return { outcome: "fast_forward" as MergeOutcome, merged: theirs, conflicts: [], theirsHead }
      }
      const base = yield* loadDoc(ref.merge_base_revision_id)
      const ours = yield* loadDoc(ref.head_revision_id)
      const result = merge3(base, ours, theirs)
      return {
        outcome: (result.conflicts.length > 0 ? "conflicts" : "merged") as MergeOutcome,
        merged: result.value as Doc,
        conflicts: result.conflicts.map(
          (c) => new MergeConflictInfo({ path: [...c.path], base: c.base, ours: c.ours, theirs: c.theirs })
        ),
        theirsHead
      }
    })

  return { ownedRef, refsWhere, loadDoc, planMerge }
}

/** JSON with object keys sorted, so equal documents hash equally whatever their key order. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
        )
      : value

export const docHash = (doc: Doc) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(doc)))
    .digest("hex")

/** Text extracted from a document for full-text search: every string value in it. */
export const searchText = (doc: unknown): string => {
  const parts: Array<string> = []
  const walk = (value: unknown) => {
    if (typeof value === "string") parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk)
  }
  walk(doc)
  return parts.join("\n")
}
