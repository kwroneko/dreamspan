// Projection of the already assembled next request. All reads stay in its reader transaction.
import { Effect } from "effect"
import type { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import type { Placement, ReplaceableCardField } from "@rp/shared/docs/note.ts"
import type { ContextSnapshot, Piece } from "../assembler/types.ts"
import { estimateTokens } from "../assembler/st.ts"

/** The editor's slot for a note: a card's note "with the definitions" sits in its card's part (DESIGN §4.1). */
const slotOf = (placement: Placement, card: boolean): Placement =>
  card && placement.mode === "section" && placement.section === "after_main_prompt"
    ? { ...placement, section: "card" }
    : placement

/** The preset block a card field is sent in: its marker, or the prompt its card override replaces. */
const FIELD_BLOCKS: Readonly<Record<ReplaceableCardField, string>> = {
  description: "charDescription",
  personality: "charPersonality",
  scenario: "scenario",
  mes_example: "dialogueExamples",
  system_prompt: "main",
  post_history_instructions: "jailbreak"
}

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
    // A note's text in a prompt's or card field's place counts as that prompt's (DESIGN §4.2).
    const replacements = snapshot.noteReplacements ?? []
    const replacing = new Map(
      replacements.flatMap((r) =>
        r.piece === undefined || snapshot.pieces[r.piece] === undefined
          ? []
          : [
              [
                snapshot.pieces[r.piece]!,
                r.target.kind === "preset_prompt" ? r.target.identifier : FIELD_BLOCKS[r.target.field]
              ] as const
            ]
      )
    )
    const inPlace = new Set(replacements.flatMap((r) => (r.ownPosition ? [] : [r.revision])))
    const owner = (p: Piece): string | null => {
      const marked = assigned.get(p) ?? replacing.get(p)
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
      if (s.kind === "summary") return "summaries"
      if (s.kind === "lorebook") return "worldInfoBefore"
      return null
    }
    // Empty and interval-skipped notes are still active notes worth showing in their slots.
    const activeNotes = new Map(
      snapshot.pieces.flatMap((p) =>
        p.source.kind === "note" ? [[p.source.revision, p.source.activation?.due ?? true] as const] : []
      )
    )
    const overrides = snapshot.cardOverrides ?? []
    const revisions = [
      ...new Set([
        ...sent.flatMap((p) => (p.source.kind === "card" ? [p.source.revision] : [])),
        ...activeNotes.keys(),
        ...overrides.map((o) => o.revision),
        ...replacements.map((r) => r.revision)
      ])
    ]
    const rows = revisions.length
      ? yield* sql<{
          id: string
          ref: RefId
          name: string | null
          title: string | null
          placement: string | null
          card: string | null
        }>`
    SELECT v.id, r.id AS ref, json_extract(v.doc_json, '$.name') AS name, json_extract(v.doc_json, '$.title') AS title,
      json_extract(v.doc_json, '$.placement') AS placement, json_extract(v.doc_json, '$.owner.card') AS card
    FROM entity_revisions v JOIN entities e ON e.id = v.entity_id
    JOIN entity_refs r ON r.entity_id = e.id
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
      cacheAfter: (snapshot.inputs.model?.cacheBreakpoints === "explicit" ? snapshot.request.breakpoints : []).map(
        (b) => {
          let identifier = "context_start"
          for (let message = b.message; message >= 0; message--) {
            const piece = sent.findLast((p) => p.messages.includes(message) && owner(p) !== null)
            if (piece) {
              identifier = owner(piece)!
              break
            }
          }
          return { identifier, reason: b.reason }
        }
      ),
      overrides: overrides.map(({ identifier, entity, revision, status }) => ({
        identifier,
        card: entity,
        name: names.get(revision) ?? "A card",
        status
      })),
      ...(replacements.length
        ? {
            replacements: replacements.flatMap((r) => {
              const row = rows.find((row) => row.id === r.revision)
              return row
                ? [
                    {
                      note: row.ref,
                      title: row.title || "Untitled note",
                      card: row.card,
                      target: r.target,
                      ownPosition: r.ownPosition,
                      status: r.status
                    }
                  ]
                : []
            })
          }
        : {}),
      // A note sent in a prompt's place has no slot of its own.
      notes: rows.flatMap((r) =>
        r.title !== null && r.placement !== null && !inPlace.has(r.id)
          ? [
              {
                ref: r.ref,
                title: r.title || "Untitled note",
                placement: slotOf(JSON.parse(r.placement) as Placement, r.card !== null),
                due: activeNotes.get(r.id) ?? true
              }
            ]
          : []
      ),
      ...(snapshot.summaryFill ? { summary: snapshot.summaryFill } : {})
    } satisfies PresetContext
  })
