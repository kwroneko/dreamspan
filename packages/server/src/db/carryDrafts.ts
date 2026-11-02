// Unsaved note text goes with a fork (owner, 2026-11-02; DESIGN §4.1): as git carries
// uncommitted changes onto a new branch, a note's live text moves to the same note in what the
// fork made, still unsaved, and the source goes back to its last revision, the moved text one
// step back in its edit history, so restoring it there is one pick. No dialog, no extra step.
// Every way of making a fork runs it: a chat's branch for the chat's own notes
// (`carryChatNoteDrafts`, from graphWrites' fork paths), a card's fork for the card's notes
// (`carryFieldDrafts`, from cardForkWrites). Each runs inside the writer transaction that
// makes the fork.
import type { ChatId } from "@rp/shared/chat.ts"
import { DraftKey, entityDraftTarget, parseDraftTarget } from "@rp/shared/drafts.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { isHeldField } from "@rp/shared/editing.ts"
import type { Doc } from "@rp/shared/library.ts"
import { editedDoc } from "@rp/shared/presetConditions.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { fieldContent, type makeDraftStore } from "./drafts.ts"
import { makeLibraryQueries } from "./library.ts"
import { noteAt } from "./noteAt.ts"

/** A fork's id and latest message, as the fork rows hold them. */
interface ForkEnd {
  readonly id: string
  readonly tip_slot_id: string | null
}

export const makeDraftCarry = (sql: SqlClient.SqlClient, drafts: ReturnType<typeof makeDraftStore>) => {
  const lib = makeLibraryQueries(sql)

  /** The drafts at a library target with unsaved text, but the held structural changes. */
  const liveAt = (userId: UserId, target: string) =>
    Effect.gen(function* () {
      const fields = yield* sql<{ field: string }>`SELECT field FROM drafts WHERE user_id = ${userId}
        AND target_kind = 'entity_field' AND target_id = ${target} AND status = 'active' ORDER BY field`
      const rows = []
      for (const { field } of fields) {
        if (isHeldField(field)) continue
        const row = yield* drafts.find(userId, new DraftKey({ targetKind: "entity_field", targetId: target, field }))
        if (row !== null) rows.push(row)
      }
      return rows
    })

  /**
   * Moves the unsaved fields at `from.target` to `to.target`, still unsaved, typed on
   * `to.revision` (or, for the same entity, on the revision they were typed on); `from` goes
   * back to `from.revision`, keeping the moved text in its history. Returns how many moved.
   */
  const carryFieldDrafts = (
    userId: UserId,
    kind: string,
    from: { readonly target: string; readonly revision: string; readonly doc: Doc },
    to: { readonly target: string; readonly revision: string; readonly sameEntity: boolean }
  ) =>
    Effect.gen(function* () {
      const saved = editedDoc(kind, from.doc)
      let moved = 0
      for (const row of yield* liveAt(userId, from.target)) {
        const back = fieldContent(saved, row.field)
        if (back === null) continue
        yield* drafts
          .save({
            userId,
            key: new DraftKey({ targetKind: "entity_field", targetId: to.target, field: row.field }),
            draftId: null,
            content: row.content,
            base: null,
            baseRevision: to.sameEntity ? (row.base_revision ?? to.revision) : to.revision,
            checkTarget: Effect.void
          })
          // Its text was taken by a draft already: it fits.
          .pipe(Effect.catchTag("DraftTooLarge", (error) => Effect.die(error)))
        yield* drafts.settleOn(row, back, from.revision)
        moved++
      }
      return moved
    })

  /**
   * A new branch `to` of `from`: each of the chat's own notes with unsaved text at `from`'s
   * latest message moves it to `to`, when `to` starts with the version of the note that text
   * was typed on. A note the branch takes as it was at an earlier message (its "As it was
   * then", in `keep` by entity) keeps the text where it was typed. Text typed at an earlier
   * message of `from` stays there.
   */
  const carryChatNoteDrafts = (
    userId: UserId,
    chatId: ChatId,
    from: ForkEnd,
    to: ForkEnd,
    keep: ReadonlySet<string> = new Set()
  ) =>
    Effect.gen(function* () {
      const scoped = yield* sql<{ target_id: string }>`SELECT DISTINCT target_id FROM drafts
        WHERE user_id = ${userId} AND target_kind = 'entity_field' AND status = 'active'
          AND target_id LIKE '%/' || ${from.id} ORDER BY target_id`
      let moved = 0
      for (const { target_id } of scoped) {
        const { refId, fork, slot } = parseDraftTarget(target_id)
        if (fork !== from.id || slot !== null) continue
        const owned = yield* lib.ownedRef(userId, refId).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
        if (owned === null || keep.has(owned.entity_id)) continue
        const at = (end: ForkEnd) =>
          noteAt(sql, lib, userId, owned, {
            chatId,
            forkId: end.id as never,
            slotId: end.tip_slot_id as never
          }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)))
        const here = yield* at(from)
        const there = here === null ? null : yield* at(to)
        if (here === null || there === null || here.ref.head_revision_id !== there.ref.head_revision_id) continue
        moved += yield* carryFieldDrafts(
          userId,
          owned.kind,
          { target: entityDraftTarget(refId, here.scope), revision: here.ref.head_revision_id, doc: here.doc },
          { target: entityDraftTarget(refId, there.scope), revision: there.ref.head_revision_id, sameEntity: true }
        )
      }
      return moved
    })

  return { carryFieldDrafts, carryChatNoteDrafts }
}
