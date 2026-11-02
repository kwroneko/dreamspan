// Library ancestry/merge reads, shared by reader previews and the writer transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import type { Doc, RefId, RevisionId } from "@rp/shared/library.ts"
import { Revision } from "@rp/shared/library.ts"
import { libraryMergePolicies } from "@rp/shared/forkMerge.ts"
import type { MergeRecord } from "@rp/shared/forkMerge.ts"
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
    const parentId = ref.follows_ref_id ?? ref.parent_ref_id
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
      theirs_revision_id: RevisionId
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
      AND status = 'active'`
    if (row!.n > 0) return yield* refused(ref, "Save or discard this entry's unsaved fields before merging.")
  })
  const preview = Effect.fnUntraced(function* (userId: UserId, refId: RefId, theirsRevisionId?: RevisionId) {
    const ref = yield* lib.ownedRef(userId, refId)
    yield* noDrafts(userId, ref)
    const src = yield* versions(userId, ref)
    if (src.parentRefId !== null && src.base === null)
      return yield* refused(
        ref,
        "This parent was linked without a known fork revision; its genealogy link does not establish a merge base."
      )
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
  const genealogy = Effect.fnUntraced(function* (userId: UserId, refId: RefId) {
    const ref = yield* lib.ownedRef(userId, refId)
    if (ref.kind === "card") {
      const family = (yield* lib.cardFamily(userId, ref.entity_id))!
      const dates = yield* sql<{ ref_id: string; at: number }>`SELECT ref_id, max(created_at) AS at FROM library_merges
        WHERE undone_by_revision_id IS NULL AND ref_id IN (SELECT r.id FROM entity_refs r JOIN entities e ON e.id = r.entity_id WHERE e.owner_user_id = ${userId}) GROUP BY ref_id`
      const last = new Map(dates.map((r) => [r.ref_id, r.at]))
      return {
        rootRefId: family.members.find((m) => m.entityId === family.rootEntityId)?.refId ?? null,
        rootNodeId: family.rootEntityId,
        members: family.members.map((m) => ({
          nodeId: m.entityId,
          parentNodeId: m.parentEntityId,
          refId: m.refId,
          entityId: m.entityId,
          kind: "card",
          refKind: "upstream",
          parentRefId: family.members.find((p) => p.entityId === m.parentEntityId)?.refId ?? null,
          label: m.label,
          subtitle: m.subtitle,
          state: m.state,
          forkedAt: m.forkedAt,
          forkedFromRevisionId: m.forkedFromRevisionId,
          lastMergeAt: m.refId === null ? null : (last.get(m.refId) ?? null)
        }))
      }
    }
    // Non-card forks already have their own ref identities. Cards use their existing entity parent.
    // Keep tombstone nodes in the card family API; this query also represents retained non-card refs.
    const rows = yield* sql<{
      id: RefId
      entity_id: string
      kind: string
      ref_kind: string
      parent: RefId | null
      label: string
      subtitle: string
      deleted_at: number | null
      purged_at: number | null
      archived_at: number | null
      forked_at: number | null
      fork_revision: RevisionId | null
      last_merge: number | null
    }>`
      WITH RECURSIVE nodes AS (
        SELECT r.id, r.entity_id, e.kind, r.ref_kind, coalesce(r.follows_ref_id,
          (SELECT p.id FROM entity_refs p WHERE p.entity_id = e.forked_from_entity_id AND p.ref_kind = 'upstream')) AS parent,
          r.label, r.subtitle, e.deleted_at, e.purged_at, e.archived_at,
          CASE WHEN r.follows_ref_id IS NOT NULL THEN r.created_at ELSE e.forked_at END AS forked_at,
          coalesce(r.forked_from_revision_id, e.forked_from_revision_id) AS fork_revision,
          (SELECT max(m.created_at) FROM library_merges m WHERE m.ref_id = r.id AND m.undone_by_revision_id IS NULL) AS last_merge
        FROM entity_refs r JOIN entities e ON e.id = r.entity_id WHERE e.owner_user_id = ${userId}
      ), up(id, parent) AS (SELECT id, parent FROM nodes WHERE id = ${refId}
        UNION SELECT n.id, n.parent FROM nodes n JOIN up ON n.id = up.parent),
      root(id) AS (SELECT id FROM up WHERE parent IS NULL),
      family(id) AS (SELECT id FROM root UNION SELECT n.id FROM nodes n JOIN family f ON n.parent = f.id)
      SELECT n.* FROM nodes n JOIN family f ON f.id = n.id`
    const root = rows.find((r) => r.parent === null)
    if (!root) return yield* new RefOperationRefused({ refId, reason: "This family has no retained root." })
    return {
      rootRefId: root.id,
      rootNodeId: root.id,
      members: rows.map((r) => ({
        nodeId: r.id,
        parentNodeId: r.parent,
        refId: r.id,
        entityId: r.entity_id,
        kind: r.kind,
        refKind: r.ref_kind,
        parentRefId: r.parent,
        label: r.label,
        subtitle: r.subtitle,
        state:
          r.purged_at !== null
            ? ("purged" as const)
            : r.deleted_at !== null
              ? ("binned" as const)
              : r.archived_at !== null
                ? ("archived" as const)
                : ("live" as const),
        forkedAt: r.forked_at,
        forkedFromRevisionId: r.fork_revision,
        lastMergeAt: r.last_merge
      }))
    }
  })
  return { preview, status, genealogy, noDrafts, policy }
}
