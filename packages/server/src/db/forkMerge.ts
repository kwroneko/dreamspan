// Library ancestry/merge reads, shared by reader previews and the writer transaction.
import { Effect } from "effect"
import { HELD_FIELD } from "@dreamspan/shared/editing.ts"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { Doc, RefId, RevisionId } from "@dreamspan/shared/library.ts"
import { Revision } from "@dreamspan/shared/library.ts"
import { libraryMergePolicies } from "@dreamspan/shared/forkMerge.ts"
import type { MergeRecord } from "@dreamspan/shared/forkMerge.ts"
import { makeLibraryQueries, toLibraryRef, type RefRow } from "./library.ts"
import { RefOperationRefused } from "./ops.ts"

export const makeForkMergeQueries = (sql: SqlClient.SqlClient) => {
  const lib = makeLibraryQueries(sql)
  const refused = (ref: RefRow, reason: string) => new RefOperationRefused({ refId: ref.id, reason })
  const policy = (ref: RefRow) => {
    const p = libraryMergePolicies.get("library.merge")
    return p ? Effect.succeed(p) : Effect.fail(refused(ref, "Library merging is disabled."))
  }
  const getSource = Effect.fnUntraced(function* (userId: UserId, ref: RefRow) {
    const parentId = ref.parent_ref_id
    if (parentId !== null) yield* lib.ownedRef(userId, parentId)
    return { parentRefId: parentId as RefId | null, head: ref.followed_head, base: ref.merge_base_revision_id }
  })
  const versions = Effect.fnUntraced(function* (userId: UserId, ref: RefRow) {
    const src = yield* getSource(userId, ref)
    if (src.head === null || src.head === src.base) return { ...src, versions: [] }
    const rows = yield* sql<{
      id: string
      parents: string
      origin: Revision["origin"]
      message: string | null
      doc_hash: string
      created_at: number
    }>`
      WITH RECURSIVE line(id) AS (
        SELECT ${src.head} WHERE ${src.head} IS NOT ${src.base}
        UNION
        SELECT json_extract(r.parents, '$[0]') FROM entity_revisions r JOIN line ON line.id = r.id
        WHERE json_extract(r.parents, '$[0]') IS NOT NULL AND json_extract(r.parents, '$[0]') IS NOT ${src.base}
      ) SELECT r.id, r.parents, r.origin, r.message, r.doc_hash, r.created_at FROM line JOIN entity_revisions r ON r.id = line.id
      ORDER BY r.seq DESC`
    return {
      ...src,
      versions: rows.map(
        (r) =>
          new Revision({
            id: r.id as RevisionId,
            parents: JSON.parse(r.parents),
            origin: r.origin,
            message: r.message,
            docHash: r.doc_hash,
            createdAt: r.created_at
          })
      )
    }
  })
  const records = (refId: string) =>
    sql<{
      revision_id: RevisionId
      ours_revision_id: RevisionId
      base_revision_id: RevisionId | null
      theirs_revision_id: RevisionId | null
      source_ref_id: RefId | null
      selection_json: string
      created_at: number
      undone_by_revision_id: RevisionId | null
    }>`SELECT * FROM library_merges WHERE ref_id = ${refId} ORDER BY created_at DESC, rowid DESC`.pipe(
      Effect.map((rows): Array<typeof MergeRecord.Type> =>
        rows.map((r) => ({
          revisionId: r.revision_id,
          oursRevisionId: r.ours_revision_id,
          baseRevisionId: r.base_revision_id,
          theirsRevisionId: r.theirs_revision_id,
          sourceRefId: r.source_ref_id,
          selection: JSON.parse(r.selection_json),
          createdAt: r.created_at,
          undoneByRevisionId: r.undone_by_revision_id
        }))
      )
    )
  const noDrafts = Effect.fnUntraced(function* (userId: UserId, ref: RefRow) {
    const [row] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM drafts WHERE user_id = ${userId}
      AND target_kind = 'entity_field' AND (target_id = ${ref.id} OR target_id LIKE ${ref.id + "/%"})
      AND status = 'active'
      -- Save/Revert retains the cleared structural draft's history; it holds no changes.
      AND NOT (${ref.kind} = 'preset' AND field = ${HELD_FIELD} AND content = '')`
    if (row!.n > 0) return yield* refused(ref, "Save or discard this entry's unsaved fields before merging.")
  })
  const preview = Effect.fnUntraced(function* (userId: UserId, refId: RefId, theirsRevisionId?: RevisionId) {
    const ref = yield* lib.ownedRef(userId, refId)
    yield* noDrafts(userId, ref)
    const src = yield* versions(userId, ref)
    yield* lib.checkMergeBase(ref)
    const theirsId = theirsRevisionId ?? src.head
    if (theirsId === null || !src.versions.some((r) => r.id === theirsId))
      return yield* refused(ref, "Choose a new parent version after the fork or last merge.")
    const ours = yield* lib.loadDoc(ref.head_revision_id)
    const base: Doc = src.base === null ? {} : yield* lib.loadDoc(src.base)
    const theirs = yield* lib.loadDoc(theirsId)
    const p = yield* policy(ref)
    return {
      ref,
      sourceRefId: src.parentRefId,
      value: {
        ref: toLibraryRef(ref),
        baseRevisionId: src.base as RevisionId | null,
        oursRevisionId: ref.head_revision_id as RevisionId,
        theirsRevisionId: theirsId as RevisionId,
        base,
        ours,
        theirs,
        ...p.prepare(base, ours, theirs, ref.kind)
      }
    }
  })
  const status = Effect.fnUntraced(function* (userId: UserId, refId: RefId) {
    const ref = yield* lib.ownedRef(userId, refId)
    const src = yield* versions(userId, ref)
    return {
      ref: toLibraryRef(ref),
      parentRefId: src.parentRefId,
      baseRevisionId: src.base as RevisionId | null,
      versions: src.versions,
      records: yield* records(refId)
    }
  })
  // One family read for every kind (spec/LIBRARY-FORKS.md): a fork is an entity of its own, so
  // its node is the entity, purged members kept as tombstones without a ref.
  const genealogy = Effect.fnUntraced(function* (userId: UserId, refId: RefId) {
    const ref = yield* lib.ownedRef(userId, refId)
    const family = (yield* lib.libraryFamily(userId, ref.entity_id, ref.kind))!
    const refs = family.members.flatMap((m) => (m.refId === null ? [] : [m.refId]))
    const dates = yield* sql<{ ref_id: string; at: number }>`SELECT ref_id, max(created_at) AS at FROM library_merges
      WHERE undone_by_revision_id IS NULL AND ${sql.in("ref_id", refs)} GROUP BY ref_id`
    const last = new Map(dates.map((r) => [r.ref_id, r.at]))
    return {
      rootRefId: family.members.find((m) => m.entityId === family.rootEntityId)?.refId ?? null,
      rootNodeId: family.rootEntityId,
      members: family.members.map((m) => ({
        nodeId: m.entityId,
        parentNodeId: m.parentEntityId,
        refId: m.refId,
        entityId: m.entityId,
        kind: ref.kind,
        parentRefId: family.members.find((p) => p.entityId === m.parentEntityId)?.refId ?? null,
        label: m.label,
        subtitle: m.subtitle,
        state: m.state,
        forkedAt: m.forkedAt,
        forkedFromRevisionId: m.forkedFromRevisionId,
        lastMergeAt: m.refId === null ? null : (last.get(m.refId) ?? null)
      }))
    }
  })
  return { preview, status, genealogy, noDrafts, policy }
}
