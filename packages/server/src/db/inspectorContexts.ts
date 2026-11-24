// Whose view a reply's context was written from, for the request inspector (spec/CHARACTER-
// CONTEXT.md §9.2 unit CU5; DESIGN §7.4): in a separate context, the speaker and the messages left
// out because it wasn't present for them; a narrator's reply, that it saw the whole chat. Read
// from the context snapshot alone so the inspector follows the view used for the reply.
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { SeparateContext } from "@dreamspan/shared/inspectorApi.ts"
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { ContextSnapshot } from "../assembler/types.ts"
import { cardSummary, type CardSummaryRow } from "./cards.ts"

/** At most this many left-out messages are listed; the rest are counted. */
const LISTED = 200

type Inputs = Pick<
  ContextSnapshot["inputs"],
  "contextView" | "viewer" | "viewerAliases" | "speaker" | "presence" | "cards"
>

/** Who the snapshot's context was written for, if anyone; null: one shared context. */
export const viewOf = (snapshot: { readonly inputs: Inputs }) => {
  const { contextView, viewer, speaker, presence } = snapshot.inputs
  if (viewer) return { viewer, narrator: false }
  if (contextView === "separate" && speaker !== null && presence?.narrators?.some((id) => id === speaker))
    return { viewer: speaker, narrator: true }
  return null
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
    const entries = (snapshot.sources?.history ?? []).flatMap((pin) => pin.entries)
    const byVersion = new Map(entries.map((entry) => [entry.versionId, entry]))
    const merges = snapshot.inputs.viewer
      ? [...new Map(entries.filter((entry) => entry.merge).map((entry) => [entry.merge!.id, entry])).values()]
      : []
    const mergeVersions = new Set(merges.map((entry) => entry.versionId))
    const ids = unknownVersions(snapshot).filter((id) => !mergeVersions.has(id))
    const rows = ids.length
      ? yield* sql<{
          readonly id: string
          readonly slot_id: string
          readonly depth: number
          readonly speaker_entity_id: string | null
        }>`
          SELECT v.id, v.slot_id, s.depth, v.speaker_entity_id FROM json_each(${JSON.stringify(ids)}) requested CROSS JOIN versions v ON v.id=requested.value CROSS JOIN slots s ON s.id = v.slot_id ORDER BY s.depth`
      : []
    const leftOut: Array<SeparateContext["leftOut"][number]> = rows.map((row) => ({
      slotId: row.slot_id as SlotId,
      number: (byVersion.get(row.id)?.depth ?? row.depth) + 1,
      speaker: who(row.speaker_entity_id)
    }))
    const identities = snapshot.inputs.viewerAliases ?? (snapshot.inputs.viewer ? [snapshot.inputs.viewer] : [])
    for (const entry of merges) {
      const missed = yield* sql<{ ordinal: number; speaker_name: string }>`
        SELECT mm.ordinal,mm.speaker_name FROM chat_merge_messages mm JOIN chat_merges m ON m.id=mm.merge_id
        WHERE mm.merge_id=${entry.merge!.id} AND mm.included IN ('verbatim','left_out') AND NOT EXISTS (
          SELECT 1 FROM json_each(coalesce(mm.knowers_json,(SELECT json_group_array(c.value ->> 'entity') FROM json_each(m.cast_json) c WHERE c.value ->> 'from'<>'destination'))) k
          WHERE k.value IN (SELECT value FROM json_each(${JSON.stringify(identities)}))) ORDER BY mm.ordinal`
      for (const row of missed)
        leftOut.push({
          slotId: entry.slotId as SlotId,
          number: entry.depth + 1,
          speaker: row.speaker_name,
          merged: { title: entry.merge!.title, ordinal: row.ordinal + 1 }
        })
    }
    leftOut.sort((a, b) => a.number - b.number || (a.merged?.ordinal ?? 0) - (b.merged?.ordinal ?? 0))
    return {
      viewer: who(view.viewer) ?? "",
      narrator: view.narrator,
      leftOut: leftOut.slice(0, LISTED),
      more: Math.max(0, leftOut.length - LISTED)
    } satisfies SeparateContext
  })
