import { Effect } from "effect"
import type { Doc } from "@dreamspan/shared/library.ts"
import { InvalidDocument } from "@dreamspan/shared/editorApi.ts"
import { hasSchema, protectedChanges, validateDoc } from "@dreamspan/shared/editing.ts"
import type { LibrarySteps } from "./editorWrites.ts"
import type { RefRow } from "./library.ts"
import { makeForkMergeQueries } from "./forkMerge.ts"
import { NotFound, RefOperationRefused, type WriteOps } from "./ops.ts"
import { transaction } from "./tx.ts"

export const makeForkMergeWriteHandlers = (
  steps: LibrarySteps & {
    readonly withoutGrants: (ref: RefRow, doc: Doc) => Effect.Effect<Doc, import("effect/sql").SqlError.SqlError>
  }
) => {
  const { sql, lib } = steps
  const q = makeForkMergeQueries(sql)
  return {
    CommitForkMerge: ({ userId, refId, theirsRevisionId, baseRevisionId, expectedRowVersion, selection, message }) =>
      Effect.gen(function* () {
        const { ref, value: plan, sourceRefId } = yield* q.preview(userId, refId, theirsRevisionId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        if (plan.baseRevisionId !== baseRevisionId)
          return yield* new RefOperationRefused({ refId, reason: "The merge base changed; preview again." })
        const p = yield* q.policy(ref)
        const doc = yield* Effect.try({
          try: () => p.resolve(plan.base, plan.ours, plan.theirs, selection, ref.kind),
          catch: (e) =>
            new RefOperationRefused({ refId, reason: e instanceof Error ? e.message : "Invalid merge choices." })
        })
        const valid = hasSchema(ref.kind) ? validateDoc(ref.kind, doc) : { ok: true as const, doc }
        if (!valid.ok) return yield* new InvalidDocument({ problems: valid.problems })
        yield* steps.checkReferences(userId, valid.doc)
        const moved = protectedChanges(ref.kind, valid.doc, [plan.ours, plan.theirs])
        if (moved.length)
          return yield* new InvalidDocument({ problems: moved.map((f) => `${f}: keep this from one side.`) })
        const next = yield* steps.withoutGrants(ref, valid.doc)
        const revision = yield* steps.insertRevision({
          entityId: ref.entity_id,
          schemaVersion: (yield* steps.revision(ref.head_revision_id)).schema_version,
          doc: steps.encode(next),
          parents: [ref.head_revision_id, theirsRevisionId],
          origin: "merge",
          originRef: sourceRefId,
          message: message ?? "Merged parent changes"
        })
        yield* sql`INSERT INTO library_merges ${sql.insert({
          revision_id: revision,
          ref_id: refId,
          ours_revision_id: ref.head_revision_id,
          base_revision_id: baseRevisionId,
          theirs_revision_id: theirsRevisionId,
          source_ref_id: sourceRefId,
          selection_json: JSON.stringify(selection),
          created_at: Date.now()
        })}`
        yield* steps.moveHead(refId, revision, theirsRevisionId)
        return yield* steps.changed(refId)
      }).pipe(transaction(sql, "CommitForkMerge")),
    UndoForkMerge: ({ userId, refId, mergeRevisionId, expectedRowVersion }) =>
      Effect.gen(function* () {
        const ref = yield* lib.ownedRef(userId, refId)
        yield* steps.checkRowVersion(ref, expectedRowVersion)
        yield* q.noDrafts(userId, ref)
        const [record] = yield* sql<{
          ours_revision_id: string
          base_revision_id: string | null
          undone_by_revision_id: string | null
        }>`
          SELECT * FROM library_merges WHERE ref_id = ${refId} AND revision_id = ${mergeRevisionId}`
        if (!record) return yield* new NotFound({ entity: "merge", id: mergeRevisionId })
        // Undo never silently removes subsequent edits, even when their content happens to match.
        if (ref.head_revision_id !== mergeRevisionId || record.undone_by_revision_id !== null)
          return yield* new RefOperationRefused({
            refId,
            reason: "Only the merge at the current head can be undone. Restore content from history after later edits."
          })
        const doc = yield* lib.loadDoc(record.ours_revision_id)
        // A restored approval must still describe the current scripts.
        const next = yield* steps.withoutGrants(ref, doc)
        const revision = yield* steps.insertRevision({
          entityId: ref.entity_id,
          schemaVersion: (yield* steps.revision(ref.head_revision_id)).schema_version,
          doc: steps.encode(next),
          parents: [ref.head_revision_id],
          origin: "user",
          originRef: null,
          message: "Undid parent merge"
        })
        yield* sql`UPDATE library_merges SET undone_by_revision_id = ${revision} WHERE revision_id = ${mergeRevisionId}`
        // moveHead intentionally coalesces null; undo must restore null as well.
        yield* sql`UPDATE entity_refs SET head_revision_id = ${revision}, merge_base_revision_id = ${record.base_revision_id},
          row_version = row_version + 1, updated_at = ${Date.now()} WHERE id = ${refId}`
        return yield* steps.changed(refId)
      }).pipe(transaction(sql, "UndoForkMerge"))
  } satisfies Partial<Parameters<typeof WriteOps.of>[0]>
}
