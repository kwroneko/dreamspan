// How a merged chat reaches the model (spec/CHAT-MERGE.md §4, §5; owner decisions DESIGN §3.3,
// 2026-11-05). A merge's join message holds what the model reads of the source; the
// `merge-layout` stage decides where that section is sent, by the layout the chat names
// (`merge.layout`, an open id resolved at use), and puts the join marker at the join. Layouts
// are a registry of their own, like role projections; the stage, the layouts and the summary
// transform are each registered and replaceable. This is its own stage, after `roles`, so the
// stages other work changes stay as they are.
import { Effect } from "effect"
import { MERGE_JOIN_DEFAULT, MERGE_LAYOUT_DEFAULT, MERGE_SECTION_DEFAULT, fillMergeTemplate } from "@rp/shared/mergeApi.ts"
import { makeRegistry, type Registry } from "../registry.ts"
import { need, type AssemblerStage, type AssemblyTransform, type ProjectedEntry } from "./pipeline.ts"
import type { HistoryEntry, HistoryMerge } from "./types.ts"

export interface MergeLayout {
  readonly id: string
  /** Shown where the chat's layout is chosen. */
  readonly label: string
  readonly description: string
  /** Its framing line where neither the merge nor the preset has one; absent: `MERGE_SECTION_DEFAULT`. */
  readonly framing?: string
  /**
   * Where the merge's section is sent: before the projected entry at the returned index (at
   * most `join`), or with the join marker at the join itself (null).
   */
  readonly place: (input: {
    readonly projected: ReadonlyArray<ProjectedEntry>
    readonly history: ReadonlyArray<HistoryEntry>
    /** The join's index in `projected`. */
    readonly join: number
    readonly merge: HistoryMerge
  }) => number | null
}

export type MergeLayoutRegistry = Registry<MergeLayout>

export const makeMergeLayoutRegistry = (): MergeLayoutRegistry => makeRegistry<MergeLayout>()

/**
 * Parallel span (the default): the section goes before the destination's own messages that ran
 * beside it, from the span's start; when the start isn't among the messages read (summarized
 * or cut), before the first one read. An empty span puts it right before the join.
 */
export const parallelLayout: MergeLayout = {
  id: "parallel",
  label: "Parallel span",
  description:
    "The merged chat's messages go before this chat's own messages from the same stretch, marked as happening alongside them.",
  place: ({ projected, history, join, merge }) => {
    if (merge.start === null) return join
    const start = history.find((entry) => entry.slotId === merge.start)
    if (start === undefined) return 0
    const at = projected.findIndex((p) => p.entry.depth >= start.depth)
    return at < 0 || at > join ? join : at
  }
}

/** Block at the join: the whole section where the merge is, then the marker. */
export const joinLayout: MergeLayout = {
  id: "join",
  label: "Block at the join",
  description: "The merged chat's messages go in one block where the merge is, after this chat's own messages.",
  framing: "Meanwhile, elsewhere: {{title}}, with {{cast}}.",
  place: () => null
}

export const builtinMergeLayouts: ReadonlyArray<MergeLayout> = [parallelLayout, joinLayout]

const fallbackLayouts = (() => {
  const map = new Map(builtinMergeLayouts.map((layout) => [layout.id, layout]))
  return { get: (id: string) => map.get(id), list: () => builtinMergeLayouts }
})()

/** The ids a chat can name, read off a merge's entries in `projected`. */
const isJoin = (p: ProjectedEntry) => p.entry.merge !== undefined && p.system !== true

/**
 * Each join of the history read becomes two system messages without a name (as summaries are
 * sent): the section, placed by the chat's layout, and the join marker at the join. Their text
 * runs through the prompt regex scripts at `compose`, at their new depths.
 */
export const mergeLayoutStage: AssemblerStage = {
  id: "merge-layout",
  run: (assembly) =>
    Effect.sync(() => {
      const projected = [...need(assembly, "projected")]
      if (!projected.some(isJoin)) return assembly
      const layouts = assembly.request.mergeLayouts ?? fallbackLayouts
      const chosen = need(assembly, "state").mergeLayout ?? MERGE_LAYOUT_DEFAULT
      const found = layouts.get(chosen)
      if (!found)
        assembly.issues.push({
          kind: "merge_layout_missing",
          message: `This chat's merge layout "${chosen}" isn't installed (a plugin may be off); merged chats are laid out in parallel instead.`
        })
      const layout = found ?? layouts.get(MERGE_LAYOUT_DEFAULT) ?? parallelLayout
      const utility = need(assembly, "preset").doc.utility_prompts
      const env = need(assembly, "macros")
      const history = need(assembly, "history")
      const scripted = new Map(need(assembly, "scripted"))
      for (let join = projected.findIndex(isJoin); join >= 0; join = projected.findIndex(isJoin)) {
        const p = projected[join]!
        const merge = p.entry.merge!
        const heading = fillMergeTemplate(
          merge.framing ?? utility.merge_section_prompt ?? layout.framing ?? MERGE_SECTION_DEFAULT,
          merge.title,
          merge.cast
        )
        const marker = fillMergeTemplate(utility.merge_join_prompt ?? MERGE_JOIN_DEFAULT, merge.title, merge.cast)
        // The join's own piece holds the section: the inspector shows it as the join message.
        const text = env.text(p.piece)
        const sectionText = heading.trim() ? `${heading.trim()}\n\n${text}` : text
        assembly.pieces[p.piece] = { ...assembly.pieces[p.piece]!, text: sectionText }
        const markerPiece = env.verbatim(
          `layout:merge-join:${merge.id}`,
          { kind: "merge/join", data: { merge: merge.id, title: merge.title } },
          marker
        )
        // The scripts run again on both at their new places (`compose`).
        scripted.delete(p.entry.versionId)
        const place = layout.place({ projected, history, join, merge })
        const markerEntry: ProjectedEntry = { ...p, piece: markerPiece, system: true }
        if (place === null || place >= join) {
          projected.splice(join, 1, { ...p, system: true }, markerEntry)
        } else {
          // Placed before another message: it takes that message's place in the history's numbering,
          // so the history's start and cut treat it as part of the stretch it opens.
          const next = projected[place]!
          const section: ProjectedEntry = {
            ...p,
            entry: { ...p.entry, slotId: next.entry.slotId, depth: next.entry.depth },
            system: true
          }
          projected.splice(join, 1, markerEntry)
          projected.splice(place, 0, section)
        }
      }
      assembly.projected = projected
      assembly.scripted = scripted
      return assembly
    })
}

/**
 * Summary blocks over a merge carry both lines (owner's multi-room addition, DESIGN §3.3): a
 * summary request whose material holds a join asks for one section per line, this chat's first.
 * After `summary-request`, which wrote the instruction.
 */
export const mergeSectionsTransform: AssemblyTransform = {
  id: "merge-sections",
  run: (snapshot) =>
    Effect.sync(() => {
      if (!snapshot.summaryJob) return snapshot
      const titles = [
        ...new Set(
          snapshot.pieces.flatMap((piece) =>
            piece.source.kind === "merge/join"
              ? [String((piece.source.data as { title?: unknown }).title ?? "")]
              : []
          )
        )
      ].filter((title) => title !== "")
      const joins = snapshot.pieces.filter((piece) => piece.source.kind === "merge/join").length
      if (joins === 0) return snapshot
      const named = titles.length ? titles.map((t) => `“${t}”`).join(", ") : "the merged chat"
      const extra = `\n\nThis part includes ${named}, merged in as a line that ran in parallel. Write the summary in one section per line, each under its own heading: first what happened in this chat, then what happened in ${named}.`
      const at = snapshot.pieces.findIndex((piece) => piece.id === "lcm:instruction")
      if (at < 0) return snapshot
      const instruction = snapshot.pieces[at]!
      const message = instruction.messages[0]
      const pieces = snapshot.pieces.map((piece, i) => (i === at ? { ...piece, text: piece.text + extra } : piece))
      const messages = snapshot.request.messages.map((m, i) =>
        i === message && typeof m.content === "string" ? { ...m, content: m.content + extra } : m
      )
      return {
        ...snapshot,
        pieces,
        summaryJob: { ...snapshot.summaryJob, tail: snapshot.summaryJob.tail + extra },
        request: { ...snapshot.request, messages }
      }
    })
}
