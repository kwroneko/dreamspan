// What keeps a path's summaries current: condensing runs of same-level summaries into the next
// level, absorbing into a neighbour when the layer is over its budget, and re-summarizing stale
// summaries that the path uses (spec/LCM.md §2.2, ref §2 and §5). Pure: it reads summaries as the
// reader loaded them and says what to enqueue, so the planner's choices can be tested apart from SQL.
import type { Summary } from "@rp/shared/lcm.ts"

interface MaintenanceSettings {
  readonly fanout: number
  readonly condenseTarget: number
  /** An eager condensation needs at least this many children (reference-harness's eager_condense_min_children). */
  readonly eagerMinChildren: number
  /** An absorbing summary never has more children than this (eager_absorb_max_children). */
  readonly absorbMaxChildren: number
  /** The layer's rendered cost, its target and its maximum, in tokens. */
  readonly layerCost: number
  readonly layerTarget: number
  readonly layerMax: number
  /** The last finished job of the chat was a budget (eager) one: its episode goes on to the target. */
  readonly lastFinishedEager: boolean
}

interface PlannedCondensation {
  readonly level: number
  readonly children: ReadonlyArray<string>
  readonly absorbedParentId?: string
  /** The summary the user asked to have made again, which this condensation does. */
  readonly rerunOf?: string
  readonly eager: boolean
}

export interface Maintenance {
  /** Stale level-1 summaries to write again over the same chain: their ids. */
  readonly resummarize: ReadonlyArray<string>
  readonly condensations: ReadonlyArray<PlannedCondensation>
  /** Used summaries that are stale but not replaced automatically: hand-written, or built over one. */
  readonly flagged: ReadonlyArray<string>
}

/** A summary as the planner sees it. */
export type Candidate = Summary & {
  /** Its batch still has jobs running: not selectable yet, so not condensable. */
  readonly batchLive: boolean
}

interface LiveJob {
  readonly level: number
  readonly from: number
  readonly to: number
  readonly children: ReadonlyArray<string>
}

export interface MaintenanceInput {
  readonly summaries: ReadonlyArray<Candidate>
  /** The summaries a context on this path would send, oldest first. */
  readonly layer: ReadonlyArray<Summary>
  /** Jobs pending or processing: the ranges they cover and the children they claimed. */
  readonly liveJobs: ReadonlyArray<LiveJob>
  /** The depth ranges of failed summaries whose inputs have not changed: left alone until Retry. */
  readonly held: ReadonlyArray<{ readonly level: number; readonly from: number; readonly to: number }>
  /** Whether some slot of the L1's chain still has content to summarize. */
  readonly hasContent: (summary: Summary) => boolean
  /** Summaries the user asked to have made again with the next reply: done whether or not they are stale. */
  readonly forced: ReadonlySet<string>
  /** Which maintenance this pass may start: only a reply starts re-summarizing; a finished job only continues it. */
  readonly reason: "reply" | "completion"
  readonly settings: MaintenanceSettings
}

type Range = { readonly from: number; readonly to: number }
const handWritten = (s: Summary) => s.origin !== "generated"
const better = (a: Summary, b: Summary) =>
  Number(b.fresh) - Number(a.fresh) || b.level - a.level || b.id.localeCompare(a.id)
const overlaps = (a: Range, b: Range) => a.from <= b.to && b.from <= a.to

/** How a summary stands once the work this pass starts is done. */
type Standing = "current" | "pending" | "stuck" | "flagged"

export const planMaintenance = (input: MaintenanceInput): Maintenance => {
  const { settings } = input
  const live = input.summaries.filter(
    (s) => s.status === "complete" || s.status === "truncated" || s.status === "superseded"
  )
  const byId = new Map<string, Candidate>(live.map((s) => [s.id, s]))
  const parentsOf = new Map<string, Array<string>>()
  for (const s of live)
    for (const child of s.children) parentsOf.set(child.summaryId, [...(parentsOf.get(child.summaryId) ?? []), s.id])
  const claimed = new Set(input.liveJobs.flatMap((j) => j.children))
  const held = (level: number, range: Range) => input.held.some((h) => h.level === level && overlaps(h, range))
  const busy = (level: number, range: Range) => input.liveJobs.some((j) => j.level === level && overlaps(j, range))
  const selectable = (s: Candidate) => s.status !== "superseded" && !s.batchLive

  // The summaries for an exact range below a level, best first: fresh, then higher, then newer.
  const optionsFor = (range: Range, below: number) =>
    live.filter((s) => s.from === range.from && s.to === range.to && s.level < below && selectable(s)).sort(better)
  // A fresh summary of the same range and at least its level has already taken its place.
  const replaced = (s: Candidate) =>
    live.some(
      (o) => o.id !== s.id && o.from === s.from && o.to === s.to && o.level >= s.level && o.fresh && selectable(o)
    )

  // Whether something fresh at this level or above already stands over exactly this range.
  const covered = (level: number, range: Range) =>
    live.some((o) => o.from === range.from && o.to === range.to && o.level >= level && o.fresh && selectable(o))

  // --- Which summaries the path uses: the layer and what is built over it.
  const used = new Set<string>()
  const climb = (id: string) => {
    for (const parent of parentsOf.get(id) ?? [])
      if (!used.has(parent)) {
        used.add(parent)
        climb(parent)
      }
  }
  for (const s of input.layer) {
    used.add(s.id)
    climb(s.id)
  }
  const stale = [...used]
    .map((id) => byId.get(id))
    .filter((s): s is Candidate => s !== undefined && !s.fresh && s.status !== "superseded")
    .sort((a, b) => a.level - b.level || a.from - b.from)

  const flagged = new Set<string>()
  const resummarize = new Set<string>()
  const recreate: Array<PlannedCondensation> = []
  const standing = new Map<string, Standing>()
  const standingOf = (s: Candidate): Standing => {
    if (s.fresh || replaced(s)) return "current"
    const known = standing.get(s.id)
    if (known) return known
    standing.set(s.id, "pending") // a cycle in malformed lineage ends here
    const result = settle(s)
    standing.set(s.id, result)
    return result
  }
  const settle = (s: Candidate): Standing => {
    if (handWritten(s)) {
      flagged.add(s.id)
      return "flagged"
    }
    if (s.level === 1) {
      if (!input.hasContent(s) || held(1, s)) return "stuck"
      if (!busy(1, s) && input.reason === "reply") resummarize.add(s.id)
      return "pending"
    }
    // A condensation is written again over the same chain once each of its parts has a fresh summary.
    const chosen: Array<string> = []
    let worst: Standing = "current"
    for (const child of s.children) {
      const part = byId.get(child.summaryId)
      if (!part) return "stuck"
      const options = optionsFor(part, s.level)
      if (options[0]?.fresh) {
        chosen.push(options[0].id)
        continue
      }
      // Nothing fresh yet: write again one the user didn't write, if the range has such a summary.
      const state = standingOf(options.find((o) => !handWritten(o)) ?? options[0] ?? part)
      if (state === "flagged") worst = "flagged"
      else if (state === "stuck" && worst !== "flagged") worst = "stuck"
      else if (state === "pending" && worst === "current") worst = "pending"
    }
    if (worst === "flagged") {
      flagged.add(s.id)
      return "flagged"
    }
    if (worst !== "current") return worst
    if (held(s.level, s)) return "stuck"
    if (!busy(s.level, s) && !input.forced.has(s.id)) recreate.push({ level: s.level, children: chosen, eager: false })
    return "pending"
  }
  for (const s of stale) standingOf(s)

  // What the user asked for is done as asked: a new summary over the same chain, hand-written or not,
  // stale or fresh, whatever stands against it. Only a reply starts it.
  if (input.reason === "reply")
    for (const id of input.forced) {
      const s = byId.get(id)
      if (!s || s.status === "superseded") continue
      if (s.level === 1) {
        if (input.hasContent(s)) resummarize.add(s.id)
        continue
      }
      const children = s.children.map((c) => {
        const part = byId.get(c.summaryId)
        return (part && optionsFor(part, s.level)[0]?.id) ?? c.summaryId
      })
      recreate.push({ level: s.level, children, eager: false, rerunOf: s.id })
    }

  // --- Ordinary condensation: unconsumed fresh summaries of one level, adjacent, in fanout-sized groups.
  const condensations: Array<PlannedCondensation> = [...recreate]
  const consumed = (s: Summary) => (parentsOf.get(s.id)?.length ?? 0) > 0 || claimed.has(s.id)
  const pool = (level: number) => {
    const members = new Map<string, Candidate>()
    for (const s of live)
      if (s.level === level && s.fresh && selectable(s) && !consumed(s)) {
        const key = `${s.from}:${s.to}`
        const other = members.get(key)
        if (!other || better(other, s) > 0) members.set(key, s)
      }
    return [...members.values()].sort((a, b) => a.from - b.from)
  }
  const runsOf = (members: ReadonlyArray<Candidate>) => {
    const runs: Array<Array<Candidate>> = []
    for (const s of members) {
      const run = runs.at(-1)
      if (run && run.at(-1)!.to + 1 === s.from) run.push(s)
      else runs.push([s])
    }
    return runs
  }
  const top = Math.max(0, ...live.map((s) => s.level))
  for (let level = 1; level <= top; level++)
    for (const run of runsOf(pool(level)))
      for (let at = 0; at + settings.fanout <= run.length; at += settings.fanout) {
        const group = run.slice(at, at + settings.fanout)
        const range = { from: group[0]!.from, to: group.at(-1)!.to }
        if (busy(level + 1, range) || held(level + 1, range) || covered(level + 1, range)) continue
        condensations.push({ level: level + 1, children: group.map((s) => s.id), eager: false })
      }

  // --- Budget: when the layer is over its maximum, shrink it even with fewer than a fanout of parts.
  const episode =
    settings.layerCost > settings.layerMax || (settings.layerCost > settings.layerTarget && settings.lastFinishedEager)
  if (condensations.length === 0 && episode && input.liveJobs.length === 0) {
    const eager = eagerCondensation(
      input,
      byId,
      pool,
      runsOf,
      (level, range) => held(level, range) || covered(level, range)
    )
    if (eager) condensations.push(eager)
  }
  return { resummarize: [...resummarize], condensations, flagged: [...flagged] }
}

/**
 * One budget job, as reference-harness picks it: oldest run first, never the run holding the newest
 * summary; absorb the run into the generated parent beside it (the left one first), or else start
 * the next level from the oldest few. Either must be worth twice the condensation target.
 */
const eagerCondensation = (
  input: MaintenanceInput,
  byId: ReadonlyMap<string, Candidate>,
  pool: (level: number) => ReadonlyArray<Candidate>,
  runsOf: (members: ReadonlyArray<Candidate>) => Array<Array<Candidate>>,
  held: (level: number, range: Range) => boolean
): PlannedCondensation | undefined => {
  const { settings } = input
  const layer = [...input.layer].sort((a, b) => a.from - b.from)
  if (layer.length < 2) return undefined
  const newest = layer.at(-1)!
  const inLayer = new Set(layer.map((s) => s.id))
  const highest = Math.max(...layer.map((s) => s.level))
  const worth = (ids: ReadonlyArray<string>) =>
    ids.reduce((n, id) => n + (byId.get(id)?.tokens ?? 0), 0) >= 2 * settings.condenseTarget
  const clear = (level: number, ids: ReadonlyArray<string>) => {
    const members = ids.map((id) => byId.get(id))
    if (members.some((m) => m === undefined)) return false
    const range = { from: Math.min(...members.map((m) => m!.from)), to: Math.max(...members.map((m) => m!.to)) }
    return !held(level, range)
  }
  for (let level = 1; level <= highest; level++)
    for (const run of runsOf(pool(level).filter((s) => inLayer.has(s.id)))) {
      if (run.some((s) => s.id === newest.id)) continue
      for (const side of ["left", "right"] as const) {
        const parent = layer.find((s) => (side === "left" ? s.to + 1 === run[0]!.from : s.from === run.at(-1)!.to + 1))
        if (
          !parent ||
          parent.level !== level + 1 ||
          !parent.fresh ||
          handWritten(parent) ||
          parent.status === "superseded"
        )
          continue
        const original = parent.children.map((c) => c.summaryId)
        const room = settings.absorbMaxChildren - original.length
        if (room < 1) continue
        const taken = (side === "left" ? run.slice(0, room) : run.slice(Math.max(0, run.length - room))).map(
          (s) => s.id
        )
        const children = side === "left" ? [...original, ...taken] : [...taken, ...original]
        if (worth([parent.id, ...taken]) && clear(parent.level, children))
          return { level: parent.level, children, absorbedParentId: parent.id, eager: true }
      }
      if (level < highest && run.length >= settings.eagerMinChildren) {
        const group = run.slice(0, Math.min(run.length, settings.fanout)).map((s) => s.id)
        if (worth(group) && clear(level + 1, group)) return { level: level + 1, children: group, eager: true }
      }
    }
  return undefined
}
