// Search and replace across the library, the writes (ARCHITECTURE §14.6 "Across the library"),
// in the writer worker, each one transaction. A replace stores what the reader planned
// (libraryReplace.ts): per entry, a `changeset` revision with the replacements, under one
// changeset group; `library_edit_items` records each entry's revisions before and after, so the
// whole replace is undone at once. An entry that moved since the plan, or has unsaved changes, is
// left as it is.
import { withHtmlApprovals, withoutGrantedAgentEdits } from "@rp/shared/editing.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Doc } from "@rp/shared/library.ts"
import { LIBRARY_UNSAVED_REASON, type LibrarySkipped } from "@rp/shared/libraryReplace.ts"
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { NotFound, type LibraryReplaceEntry } from "./ops.ts"
import { transaction } from "./tx.ts"

const CHANGED = "It changed since the search. Find again to include it."

export const makeLibraryReplaceWrites = (steps: LibrarySteps) => {
  const { sql, lib } = steps

  /** A revision of `doc` on the ref's head, which becomes its head; null when it changes nothing. */
  const write = (
    ref: { readonly id: string; readonly entity_id: string; readonly head_revision_id: string },
    doc: Doc,
    origin: "user" | "changeset",
    originRef: string | null,
    message: string
  ) =>
    Effect.gen(function* () {
      const current = yield* steps.revision(ref.head_revision_id)
      const encoded = steps.encode(doc)
      if (encoded.hash === current.doc_hash) return null
      const id = yield* steps.insertRevision({
        entityId: ref.entity_id,
        schemaVersion: current.schema_version,
        doc: encoded,
        parents: [ref.head_revision_id],
        origin,
        originRef,
        message
      })
      yield* steps.moveHead(ref.id, id, null)
      return id
    })

  return {
    ApplyLibraryReplace: ({
      userId,
      title,
      entries,
      skipped: planned
    }: {
      readonly userId: UserId
      readonly title: string
      readonly entries: ReadonlyArray<LibraryReplaceEntry>
      readonly skipped: ReadonlyArray<LibrarySkipped>
    }) =>
      Effect.gen(function* () {
        const skipped = [...planned]
        const groupId = uuidv7()
        const originRef = JSON.stringify({ libraryEdit: groupId })
        let changed = 0
        let matches = 0
        const approvedScripts: Array<{ refId: LibraryReplaceEntry["refId"]; label: string; name: string }> = []
        for (const entry of entries) {
          const skip = (reason: string) => skipped.push({ refId: entry.refId, label: entry.label, reason })
          const ref = yield* lib
            .ownedRef(userId, entry.refId)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
          if (ref === null) {
            skip("It's no longer in the library.")
            continue
          }
          if (ref.head_revision_id !== entry.head || ref.row_version !== entry.rowVersion) {
            skip(CHANGED)
            continue
          }
          // An entry that gained unsaved changes since the plan is skipped, as the plan skips one with some.
          const [active] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM drafts WHERE user_id = ${userId}
            AND target_kind = 'entity_field' AND target_id = ${ref.id} AND status = 'active'`
          if (active!.n > 0) {
            skip(LIBRARY_UNSAVED_REASON)
            continue
          }
          if (changed === 0)
            yield* sql`INSERT INTO changeset_groups (id, owner_user_id, title, origin, created_at)
              VALUES (${groupId}, ${userId}, ${title}, 'user', ${Date.now()})`
          const head = ref.head_revision_id
          const after = yield* write(ref, entry.doc, "changeset", originRef, title)
          if (after === null) {
            skip("Nothing in it changes.")
            continue
          }
          yield* sql`INSERT INTO library_edit_items (group_id, ref_id, before_revision_id, after_revision_id, matches)
            VALUES (${groupId}, ${ref.id}, ${head}, ${after}, ${entry.matches})`
          for (const name of entry.approvedScripts)
            approvedScripts.push({ refId: entry.refId, label: entry.label, name })
          changed++
          matches += entry.matches
        }
        return { editId: changed > 0 ? groupId : null, entries: changed, matches, skipped, approvedScripts }
      }).pipe(transaction(sql, "ApplyLibraryReplace")),

    UndoLibraryEdit: ({ userId, editId }: { readonly userId: UserId; readonly editId: string }) =>
      Effect.gen(function* () {
        const [group] = yield* sql<{ title: string }>`SELECT title FROM changeset_groups
          WHERE id = ${editId} AND owner_user_id = ${userId}`
        if (!group) return yield* new NotFound({ entity: "library edit", id: editId })
        const items = yield* sql<{
          id: number
          ref_id: string
          before_revision_id: string
          after_revision_id: string
        }>`SELECT id, ref_id, before_revision_id, after_revision_id FROM library_edit_items
          WHERE group_id = ${editId} AND undone_by_revision_id IS NULL ORDER BY id`
        const [move] =
          yield* sql`SELECT 1 FROM library_edit_items i JOIN entity_revisions v ON v.id = i.after_revision_id
          WHERE i.group_id = ${editId} AND json_extract(CASE WHEN json_valid(v.origin_ref) THEN v.origin_ref ELSE '{}' END, '$.ownTurnMove') = ${editId} LIMIT 1`
        // A moved pair has one meaning. Refuse the whole inverse when either side changed,
        // rather than restoring shared secrets alongside a still-active private note.
        if (move) {
          const conflicts: Array<LibrarySkipped> = []
          for (const item of items) {
            const ref = yield* lib
              .ownedRef(userId, item.ref_id)
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
            const [draft] = yield* sql`SELECT 1 FROM drafts WHERE user_id = ${userId} AND target_kind = 'entity_field'
              AND target_id = ${item.ref_id} AND status = 'active' LIMIT 1`
            if (!ref || ref.head_revision_id !== item.after_revision_id || draft)
              conflicts.push({
                refId: item.ref_id as LibrarySkipped["refId"],
                label: ref?.label ?? "",
                reason: "A moved note changed since. Both sides were kept; use their History or switch the group off."
              })
          }
          if (conflicts.length) return { undone: 0, kept: conflicts }
        }
        const kept: Array<LibrarySkipped> = []
        let undone = 0
        const originRef = JSON.stringify({ undid: editId })
        for (const item of items) {
          const ref = yield* lib
            .ownedRef(userId, item.ref_id)
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
          if (ref === null) {
            kept.push({ refId: item.ref_id as LibrarySkipped["refId"], label: "", reason: "It's in the bin." })
            continue
          }
          const [drafted] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM drafts
            WHERE user_id = ${userId} AND target_kind = 'entity_field' AND target_id = ${ref.id} AND status = 'active'`
          if (ref.head_revision_id !== item.after_revision_id || drafted!.n > 0) {
            kept.push({
              refId: ref.id as LibrarySkipped["refId"],
              label: ref.label,
              reason: "It was changed since, so its later changes were kept."
            })
            continue
          }
          const head = yield* lib.loadDoc(ref.head_revision_id)
          const before = withHtmlApprovals(
            head,
            withoutGrantedAgentEdits(ref.kind, head, yield* lib.loadDoc(item.before_revision_id))
          )
          const id = yield* write(ref, before, "changeset", originRef, `Undid: ${group.title}`)
          yield* sql`UPDATE library_edit_items SET undone_by_revision_id = ${id ?? item.before_revision_id}
            WHERE id = ${item.id}`
          undone++
        }
        return { undone, kept }
      }).pipe(transaction(sql, "UndoLibraryEdit"))
  }
}
