// Projection of the already assembled next request. All reads stay in its reader transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import type { Placement } from "@rp/shared/docs/note.ts"
import type { ContextSnapshot, Piece } from "../assembler/types.ts"
import { estimateTokens } from "../assembler/st.ts"

export const presetContext = (sql: SqlClient.SqlClient, userId: UserId, snapshot: ContextSnapshot) =>
  Effect.gen(function* () {
    const sent = snapshot.pieces.filter((p) => p.messages.length > 0 && p.text.length > 0)
    const last = sent.findLast((p) => p.source.kind === "message")
    const assigned = new Map<Piece, string>()
    const roots = new Set<Piece>()
    const assign = (piece: Piece, id: string) => {
      assigned.set(piece, id)
      for (const index of piece.parts ?? []) assign(snapshot.pieces[index]!, id)
    }
    for (const piece of sent)
      if (piece.marker) {
        roots.add(piece)
        assign(piece, piece.marker)
      }
    const owner = (p: Piece): string | null => {
      const marked = assigned.get(p)
      if (marked) return marked
      const s = p.source
      if (s.kind === "preset") return s.identifier
      if (s.kind === "message") return p === last ? "newestMessage" : "chatHistory"
      if (s.kind === "card")
        return s.field === "mes_example"
          ? "dialogueExamples"
          : s.field === "personality"
            ? "charPersonality"
            : s.field === "scenario"
              ? "scenario"
              : "charDescription"
      if (s.kind === "summary") return "chatHistory"
      if (s.kind === "lorebook") return "worldInfoBefore"
      return null
    }
    // Empty and interval-skipped notes are still active notes worth showing in their slots.
    const activeNotes = new Map(
      snapshot.pieces.flatMap((p) =>
        p.source.kind === "note" ? [[p.source.revision, p.source.activation?.due ?? true] as const] : []
      )
    )
    const revisions = [
      ...new Set([...sent.flatMap((p) => (p.source.kind === "card" ? [p.source.revision] : [])), ...activeNotes.keys()])
    ]
    const rows = revisions.length
      ? yield* sql<{ id: string; name: string | null; title: string | null; placement: string | null }>`
    SELECT v.id, json_extract(v.doc_json, '$.name') AS name, json_extract(v.doc_json, '$.title') AS title,
      json_extract(v.doc_json, '$.placement') AS placement
    FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
    WHERE v.id IN ${sql.in(revisions)} AND e.owner_user_id = ${userId}`
      : []
    const names = new Map(rows.map((r) => [r.id, r.name]))
    const blocks = new Map<string, { identifier: string; tokens: number; labels: Array<string> }>()
    for (const p of sent) {
      const id = owner(p)
      if (!id) continue
      const block = blocks.get(id) ?? { identifier: id, tokens: 0, labels: [] }
      if (!assigned.has(p) || roots.has(p)) block.tokens += estimateTokens(p.text)
      if (p.source.kind === "card") {
        const name = names.get(p.source.revision)
        if (name && !block.labels.includes(name)) block.labels.push(name)
      }
      blocks.set(id, block)
    }
    return {
      blocks: [...blocks.values()],
      cacheAfter: snapshot.request.breakpoints.map((b) => {
        let identifier = "context_start"
        for (let message = b.message; message >= 0; message--) {
          const piece = sent.findLast((p) => p.messages.includes(message) && owner(p) !== null)
          if (piece) {
            identifier = owner(piece)!
            break
          }
        }
        return { identifier, reason: b.reason }
      }),
      notes: rows.flatMap((r) =>
        r.title !== null && r.placement !== null
          ? [
              {
                title: r.title || "Untitled note",
                placement: JSON.parse(r.placement) as Placement,
                due: activeNotes.get(r.id) ?? true
              }
            ]
          : []
      )
    } satisfies PresetContext
  })
