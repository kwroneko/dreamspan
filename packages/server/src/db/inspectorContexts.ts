// Whose view a reply's context was written from, for the request inspector (spec/CHARACTER-
// CONTEXT.md §9.2 unit CU5; DESIGN §7.4): in a separate context, the speaker and the messages left
// out because it wasn't present for them; a narrator's reply, that it saw the whole chat. Read
// from the context snapshot alone (`inputs.viewer`, `inputs.presence`, the `knowers` pins), so an
// old reply shows what it was built from, not what the chat says now.
import type { SlotId } from "@rp/shared/chat.ts"
import type { SeparateContext } from "@rp/shared/inspectorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { cardSummary, type CardSummaryRow } from "./cards.ts"

/** At most this many left-out messages are listed; the rest are counted. */
const LISTED = 200

type Inputs = Pick<ContextSnapshot["inputs"], "viewer" | "viewerAliases" | "speaker" | "presence" | "cards">

/** Who the snapshot's context was written for, if anyone; null: one shared context. */
export const viewOf = (snapshot: { readonly inputs: Inputs }) => {
  const { viewer, speaker, presence } = snapshot.inputs
  const narrator = !viewer && speaker !== null && (presence?.narrators ?? []).includes(speaker as never)
  return viewer ? { viewer, narrator: false } : narrator ? { viewer: speaker!, narrator: true } : null
}

/** The versions the viewer didn't know among those the context read, from the `knowers` pins. */
export const unknownVersions = (snapshot: {
  readonly inputs: Inputs
  readonly sources?: Pick<NonNullable<ContextSnapshot["sources"]>, "knowers">
}) => {
  const { viewer, viewerAliases } = snapshot.inputs
  if (!viewer) return []
  const identities = new Set(viewerAliases ?? [viewer])
  return [
    ...new Set(
      (snapshot.sources?.knowers ?? [])
        .flatMap((pin) => pin.found)
        .filter((found) => found.knowers !== null && !found.knowers.some((k) => identities.has(k)))
        .map((found) => found.versionId)
    )
  ]
}

export const separateContextOf = (sql: SqlClient.SqlClient, snapshot: ContextSnapshot) =>
  Effect.gen(function* () {
    const view = viewOf(snapshot)
    if (view === null) return undefined
    // The names the model read: each card at the revision this request used.
    const { cards } = snapshot.inputs
    const revisions = [...new Set(cards.map((card) => card.revision))]
    const names = new Map<string, string>()
    if (revisions.length) {
      const rows = yield* sql<CardSummaryRow & { readonly revision_id: string }>`
        SELECT revision_id, fields AS card_fields, book AS card_book, book_entries AS card_book_entries
        FROM card_summaries WHERE revision_id IN ${sql.in(revisions)}`
      const byRevision = new Map(rows.map((row) => [row.revision_id, cardSummary(row).name]))
      for (const card of cards) {
        const name = byRevision.get(card.revision)
        if (name) names.set(card.entity, name)
      }
    }
    const who = (entity: string | null) => (entity === null ? null : (names.get(entity) ?? null))
    const ids = unknownVersions(snapshot)
    const rows = ids.length
      ? yield* sql<{ readonly slot_id: string; readonly depth: number; readonly speaker_entity_id: string | null }>`
          SELECT v.slot_id, s.depth, v.speaker_entity_id FROM versions v JOIN slots s ON s.id = v.slot_id
          WHERE v.id IN ${sql.in(ids)} ORDER BY s.depth`
      : []
    return {
      viewer: who(view.viewer) ?? "",
      narrator: view.narrator,
      leftOut: rows.slice(0, LISTED).map((row) => ({
        slotId: row.slot_id as SlotId,
        number: row.depth + 1,
        speaker: who(row.speaker_entity_id)
      })),
      more: Math.max(0, rows.length - LISTED)
    } satisfies SeparateContext
  })
