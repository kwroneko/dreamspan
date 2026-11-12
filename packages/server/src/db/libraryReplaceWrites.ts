// Search and replace across the library, the writes (ARCHITECTURE §14.6 "Across the library"),
// in the writer worker, each one transaction. A replace stores what the reader planned
// (libraryReplace.ts): per entry, its unsaved changes saved first as a revision of their own (as
// a reply cuts one of the live text it used), ending their drafts on it, then a `changeset`
// revision with the replacements, under one changeset group; `library_edit_items` records each
// entry's revisions before and after, so the whole replace is undone at once. An entry that moved
// since the plan (its head, row version or drafts) is left as it is.
import { keepsRegexApproval, withHtmlApprovals, withoutGrantedAgentEdits } from "@rp/shared/editing.ts"
import { DraftKey } from "@rp/shared/drafts.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Doc } from "@rp/shared/library.ts"
import type { LibrarySkipped } from "@rp/shared/libraryReplace.ts"
import { Effect } from "effect"
import type { LibrarySteps } from "./editorWrites.ts"
import { NotFound, type LibraryReplaceEntry } from "./ops.ts"
import { transaction } from "./tx.ts"

const CHANGED = "It changed since the search. Find again to include it."

export const makeLibraryReplaceWrites = (steps: LibrarySteps) => {
  const { sql, lib, drafts } = steps

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
          // The drafts it was read with, and no others since.
          const [active] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM drafts WHERE user_id = ${userId}
            AND target_kind = 'entity_field' AND target_id = ${ref.id} AND status = 'active'`
          const rows = []
          for (const planned of entry.drafts) {
            const row = yield* drafts.find(
              userId,
              new DraftKey({ targetKind: "entity_field", targetId: ref.id, field: planned.field })
            )
            if (
              row === null ||
              row.id !== planned.id ||
              row.status !== "active" ||
              row.row_version !== planned.rowVersion
            )
              break
            rows.push(row)
          }
          if (rows.length !== entry.drafts.length || active!.n !== rows.length) {
            skip(CHANGED)
            continue
          }
          if (changed === 0)
            yield* sql`INSERT INTO changeset_groups (id, owner_user_id, title, origin, created_at)
              VALUES (${groupId}, ${userId}, ${title}, 'user', ${Date.now()})`
          // Its unsaved changes are saved first, as their own revision, ending their drafts on it.
          let head = ref.head_revision_id
          if (entry.checkpoint !== null) {
            const saved = yield* write(
              ref,
              entry.checkpoint,
              "user",
              null,
              "Unsaved changes, saved before a search and replace across the library"
            )
            if (saved !== null) head = saved
            for (const row of rows) yield* drafts.end(row, "committed", head)
          }
          const after = yield* write({ ...ref, head_revision_id: head }, entry.doc, "changeset", originRef, title)
          if (after === null) {
            skip("Nothing in it changes.")
            continue
          }
          yield* sql`INSERT INTO library_edit_items (group_id, ref_id, before_revision_id, after_revision_id, matches)
            VALUES (${groupId}, ${ref.id}, ${head}, ${after}, ${entry.matches})`
          changed++
          matches += entry.matches
        }
        return { editId: changed > 0 ? groupId : null, entries: changed, matches, skipped }
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
          let before = withHtmlApprovals(
            head,
            withoutGrantedAgentEdits(ref.kind, head, yield* lib.loadDoc(item.before_revision_id))
          )
          if (before.regex_approved === true && !keepsRegexApproval(head, before))
            before = { ...before, regex_approved: false }
          const id = yield* write(ref, before, "changeset", originRef, `Undid: ${group.title}`)
          yield* sql`UPDATE library_edit_items SET undone_by_revision_id = ${id ?? item.before_revision_id}
            WHERE id = ${item.id}`
          undone++
        }
        return { undone, kept }
      }).pipe(transaction(sql, "UndoLibraryEdit"))
  }
}
