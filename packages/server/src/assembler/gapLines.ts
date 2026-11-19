// Gap lines in a separate context (spec/CHARACTER-CONTEXT.md §2.2 [D], owner 2026-11-06; §9.2
// unit C4). Where a character's history leaves out a stretch it wasn't present for, between
// messages it was present for (or before its own reply, when it's back), one system message
// without a name says so, from the preset's `absent_gap_prompt`. Nothing is said before the
// character's first message, nor for a merged-in storyline it was never in; there the optional
// join line (`absent_join_prompt`, empty by default) is sent at the merge point. In a chat read
// whole, a separate join (spec/THREADS.md §7.3) gets only the join line: the other thread's
// stretch is someone else's storyline. Its own stage, after `merge-layout`, registered and
// replaceable like the others.
import { Effect } from "effect"
import { modelName } from "@dreamspan/shared/cardNames.ts"
import { ABSENT_GAP_DEFAULT, ABSENT_JOIN_DEFAULT } from "@dreamspan/shared/knowledge.ts"
import { AssemblySources, need, type AssemblerStage, type Assembly, type ProjectedEntry } from "./pipeline.ts"
import type { SourceDescriptor } from "./sourceDescriptors.ts"
import { ownLine } from "./merges.ts"
import type { HistoryEntry } from "./types.ts"

/** "Mira", "Mira and Tobin", "Mira, Tobin and Kai". */
const listed = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

/** A stretch the viewer missed: its messages, and the known message after it (null: the reply). */
interface Stretch {
  readonly missed: ReadonlyArray<HistoryEntry>
  readonly next: HistoryEntry | null
}

/**
 * The stretches to mark, in order: runs of messages the viewer didn't know with one it knew
 * before them (in the history read, or in the summaries before it) and one after, or the reply.
 * Hidden messages neither count nor break a run; a merge's join it wasn't in is never part of one.
 */
const stretchesOf = (assembly: Assembly, history: ReadonlyArray<HistoryEntry>) => {
  const stretches: Array<Stretch> = []
  const joins: Array<HistoryEntry> = []
  // The destination's parallel span is somebody else's line when the join supplies the
  // viewer's own history. It did not miss a stretch of that history: no gap may rewrite it.
  const elsewhere = history
    .filter((join) => join.merge && ownLine(assembly, history, join))
    .map((join) => ({
      from: history.find((e) => e.slotId === join.merge!.start)?.depth ?? Number.NEGATIVE_INFINITY,
      to: join.depth
    }))
  let present = assembly.lcm?.cursor != null
  let run: Array<HistoryEntry> = []
  for (const entry of history) {
    if (entry.unknown) {
      if (entry.merge) joins.push(entry)
      else if (present && !elsewhere.some((span) => entry.depth >= span.from && entry.depth < span.to)) run.push(entry)
      continue
    }
    if (!entry.inContext) continue
    if (run.length) stretches.push({ missed: run, next: entry })
    run = []
    present = true
  }
  if (run.length) stretches.push({ missed: run, next: null })
  return { stretches, joins }
}

/** Where a line goes: before the first message of the history after `depth`, else at the end. */
const placeAfter = (projected: ReadonlyArray<ProjectedEntry>, depth: number) => {
  const at = projected.findIndex((p) => !p.system && p.entry.depth > depth)
  return at < 0 ? projected.length : at
}

/** A system line in the place of `entry`, without its images, in the context. */
const lineAt = (entry: HistoryEntry, piece: number): ProjectedEntry => {
  const { images: _images, unknown: _unknown, ...rest } = entry
  return { entry: { ...rest, inContext: true }, role: "user", name: "", persona: false, piece, system: true }
}

export const gapLinesStage: AssemblerStage = {
  id: "gap-lines",
  run: (assembly) =>
    Effect.gen(function* () {
      const whole = assembly.knowledge?.viewer ?? null
      // Read whole, only a separate join's stretch is filtered: a join line, never a gap line.
      const stretch = whole === null ? (assembly.knowledge?.stretch ?? null) : null
      const viewer = whole ?? stretch?.viewer ?? null
      // A view's summary request leaves what its character missed out without a line (unit C7).
      if (viewer === null || assembly.request.summaryJob) return assembly
      const history = need(assembly, "history")
      if (!history.some((e) => e.unknown)) return assembly
      const env = need(assembly, "macros")
      const cast = need(assembly, "cast")
      const utility = need(assembly, "preset").doc.utility_prompts
      // The viewer under every identity it had (card replacements): never named in its own line.
      const self = new Set((stretch ? stretch.aliases : assembly.knowledge?.aliases) ?? [viewer])
      const projected = [...need(assembly, "projected")]
      // {{char}} is the character the line is for, as in the tail directive.
      const own = cast.speaker ? { names: { char: modelName(cast.speaker.doc) } } : {}
      const found = stretchesOf(assembly, history)
      const stretches = stretch ? [] : found.stretches
      const joins = found.joins
      const gap = utility.absent_gap_prompt ?? ABSENT_GAP_DEFAULT
      // Those who took part and have since left the cast are named too, from their cards (read
      // only when a line names one, so a chat where nobody left reads nothing more).
      const inCast = (entity: string) =>
        cast.personas.some((p) => p.entity === entity) || cast.characters.some((c) => c.entity === entity)
      const gone = gap.trim()
        ? [
            ...new Set(
              stretches.flatMap(({ missed }) =>
                missed.flatMap((e) =>
                  (e.unknown?.knowers ?? []).filter((k) => !self.has(k) && !inCast(k) && !assembly.departed?.has(k))
                )
              )
            )
          ]
        : []
      const left = new Map((assembly.departed ?? new Map()).entries())
      if (gone.length > 0)
        for (const card of yield* (yield* AssemblySources).cards(gone, need(assembly, "state").cardBindings))
          left.set(card.entity, card)
      const nameOf = (entity: string) => {
        if (cast.personas.some((p) => p.entity === entity)) return env.names.user
        const card = cast.characters.find((c) => c.entity === entity) ?? left.get(entity)
        return card ? modelName(card.doc) : null
      }
      if (gap.trim())
        for (const { missed } of stretches) {
          const first = missed[0]!
          const last = missed.at(-1)!
          // Who took part, in order: each message's knowers, and the user for their own messages
          // written without a speaker (as the composer writes them).
          const names = [
            ...new Set(
              missed.flatMap((e) => [
                ...(e.unknown?.knowers ?? []).flatMap((k) => (self.has(k) ? [] : (nameOf(k) ?? []))),
                ...(e.speaker === null && e.side === "user" ? [env.names.user] : [])
              ])
            )
          ]
          const text = gap
            .replaceAll("{{absentCount}}", String(missed.length))
            .replaceAll("{{absentNames}}", listed(names) || "the others")
          const piece = env.piece(
            `layout:gap:${first.slotId}`,
            { kind: "context/gap", data: { from: first.depth + 1, to: last.depth + 1, count: missed.length } },
            text,
            own
          )
          projected.splice(placeAfter(projected, last.depth), 0, lineAt(first, piece))
        }
      const join = utility.absent_join_prompt ?? ABSENT_JOIN_DEFAULT
      if (join.trim())
        for (const entry of joins) {
          const text = join.replaceAll("{{mergedNames}}", listed(entry.merge!.cast))
          const piece = env.piece(
            `layout:gap-join:${entry.merge!.id}`,
            { kind: "context/join", data: { merge: entry.merge!.id, title: entry.merge!.title } },
            text,
            own
          )
          projected.splice(placeAfter(projected, entry.depth), 0, lineAt(entry, piece))
        }
      assembly.projected = projected
      return assembly
    })
}

/** How the inspector names the lines (`sourceDescriptors`). */
export const gapLineDescriptors: ReadonlyArray<SourceDescriptor> = [
  {
    id: "context/gap",
    describe: (source) => {
      const data = ("data" in source ? source.data : {}) as { from?: number; to?: number }
      return {
        label:
          data.from === data.to
            ? `Gap line: message ${data.from} left out`
            : `Gap line: messages ${data.from}–${data.to} left out`,
        slotId: null
      }
    }
  },
  {
    id: "context/join",
    describe: () => ({ label: "Join line: a storyline new to this character", slotId: null })
  }
]
