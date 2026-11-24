// What one change row and its change view read (spec/WORKSHOP-CARDS.md §7.5): the item's two
// revisions, the fields between them, and its revisions since, to say whether it changed after.
import type { Doc, Revision } from "@dreamspan/shared/library.ts"
import type { RefId, RevisionId } from "@dreamspan/shared/library.ts"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { AppClient } from "../../rpc.ts"
import { changedFields, type FieldChange } from "../editor/fields.ts"
import { EFFECTS_KEY } from "./effects.ts"

export interface ItemChangeDetail {
  /** The revision before the turn; empty for an item the turn made. */
  readonly before: Doc
  readonly after: Doc
  readonly changes: ReadonlyArray<FieldChange>
  /** Its revisions, newest first, as far back as the turn's (or the newest fifty). */
  readonly revisions: ReadonlyArray<Revision>
}

const blank = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" && value !== null && Object.keys(value).length === 0)

/** Revisions read for "changed since": a turn's own are near the head. */
const SINCE_LIMIT = 50

/** By `itemChangeKey`: one read per item and revision pair, again after any library change or undo. */
export const itemChangeAtom = Atom.family((key: string) => {
  const { refId, from, to } = JSON.parse(key) as { refId: RefId; from: RevisionId | null; to: RevisionId }
  return AppClient.runtime.factory.withReactivity(["library", EFFECTS_KEY])(
    AppClient.runtime.atom(
      Effect.flatMap(AppClient, (client) =>
        Effect.all(
          {
            before: from === null ? Effect.succeed({} as Doc) : client("GetRevision", { refId, revisionId: from }),
            after: client("GetRevision", { refId, revisionId: to }),
            revisions: client("ListRevisions", { refId, limit: SINCE_LIMIT })
          },
          { concurrency: "unbounded" }
        )
      ).pipe(
        Effect.map(({ before, after, revisions }): ItemChangeDetail => ({
          before,
          after,
          // A made item is set against empty: its fields with something in them.
          changes: changedFields(before, after).filter((c) => from !== null || !blank(c.after)),
          revisions
        }))
      )
    )
  )
})

export const itemChangeKey = (refId: string, from: string | null, to: string) => JSON.stringify({ refId, from, to })
