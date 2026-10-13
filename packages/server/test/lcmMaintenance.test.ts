import { assert, describe, it } from "@effect/vitest"
import type { Summary } from "@rp/shared/lcm.ts"
import { type Candidate, type MaintenanceInput, planMaintenance } from "../src/lcm/maintenance.ts"

// The planner's choices over hand-built summaries: no database, no provider.
let serial = 0
const summary = (
  level: number,
  from: number,
  to: number,
  extra: Partial<Candidate> & { readonly kids?: ReadonlyArray<string> } = {}
): Candidate => {
  const { kids = [], ...rest } = extra
  const id = rest.id ?? `s${String(++serial).padStart(4, "0")}`
  return {
    id,
    chatId: "chat",
    level,
    firstSlotId: `slot${from}`,
    lastSlotId: `slot${to}`,
    from,
    to,
    slotCount: to - from + 1,
    revisionNumber: 1,
    revisionId: `${id}-r1`,
    content: "x",
    tokens: 400,
    origin: "generated",
    status: "complete",
    error: null,
    batchId: null,
    rowVersion: 1,
    fresh: true,
    inputs: [],
    children: kids.map((k) => ({ summaryId: k, revisionId: `${k}-r1` })),
    batchLive: false,
    ...rest
  } as unknown as Candidate
}
const settings = {
  fanout: 3,
  condenseTarget: 100,
  eagerMinChildren: 2,
  absorbMaxChildren: 6,
  layerCost: 0,
  layerTarget: 1000,
  layerMax: 2000,
  lastFinishedEager: false
}
const plan = (summaries: ReadonlyArray<Candidate>, extra: Partial<MaintenanceInput> = {}) =>
  planMaintenance({
    summaries,
    layer: summaries.filter((s) => s.status !== "superseded"),
    liveJobs: [],
    held: [],
    forced: new Set<string>(),
    hasContent: () => true,
    reason: "reply",
    settings,
    ...extra
  })
const row = (n: number, from = 1) => Array.from({ length: n }, (_, i) => summary(1, from + i * 2, from + i * 2 + 1))

describe("ordinary condensation", () => {
  it("condenses a fanout of adjacent unconsumed summaries, oldest first, and leaves the rest waiting", () => {
    const l1 = row(7)
    const result = plan(l1)
    assert.deepStrictEqual(
      result.condensations.map((c) => [c.level, c.children]),
      [
        [2, l1.slice(0, 3).map((s) => s.id)],
        [2, l1.slice(3, 6).map((s) => s.id)]
      ]
    )
    assert.isFalse(result.condensations.some((c) => c.eager))
  })

  it("never condenses fewer than a fanout, a gap, a summary in a running batch, or one that already has a parent", () => {
    const l1 = row(6)
    assert.lengthOf(plan(l1.slice(0, 2)).condensations, 0)
    const gap = [...l1.slice(0, 2), ...l1.slice(3, 5)]
    assert.lengthOf(plan(gap).condensations, 0, "a run is split where a summary is missing")
    const batched = l1.map((s, i) => (i === 1 ? { ...s, batchLive: true } : s))
    assert.lengthOf(plan(batched).condensations, 1, "only the three after the running batch's summary are a run")
    const parent = summary(2, 1, 6, { kids: l1.slice(0, 3).map((s) => s.id) })
    const result = plan([...l1, parent])
    assert.deepStrictEqual(
      result.condensations.map((c) => c.children),
      [l1.slice(3, 6).map((s) => s.id)],
      "children of a summary stay with it"
    )
  })

  it("condenses hand-written summaries and builds levels upward one at a time", () => {
    const l1 = row(3).map((s) => ({ ...s, origin: "user" as const }))
    assert.lengthOf(plan(l1).condensations, 1)
    const l2 = [summary(2, 1, 6, { kids: [] }), summary(2, 7, 12, { kids: [] }), summary(2, 13, 18, { kids: [] })]
    assert.deepStrictEqual(
      plan(l2).condensations.map((c) => c.level),
      [3]
    )
  })

  it("leaves a range alone while a live job covers it or its failure stands", () => {
    const l1 = row(3)
    assert.lengthOf(plan(l1, { liveJobs: [{ level: 2, from: 1, to: 6, children: [] }] }).condensations, 0)
    assert.lengthOf(plan(l1, { liveJobs: [{ level: 2, from: 3, to: 4, children: [l1[1]!.id] }] }).condensations, 0)
    assert.lengthOf(plan(l1, { held: [{ level: 2, from: 1, to: 6 }] }).condensations, 0)
  })
})

describe("stale summaries", () => {
  const stale = (s: Candidate): Candidate => ({ ...s, fresh: false })

  it("writes a stale level-1 summary again only with a reply, and only if it is used", () => {
    const l1 = row(2)
    const edited = [stale(l1[0]!), l1[1]!]
    assert.deepStrictEqual(plan(edited).resummarize, [l1[0]!.id])
    assert.lengthOf(
      plan(edited, { reason: "completion" }).resummarize,
      0,
      "a finished job does not start re-summarizing"
    )
    const unused = plan(edited, { layer: [l1[1]!] })
    assert.lengthOf(unused.resummarize, 0, "a stale summary off the path's layer is left as it is")
  })

  it("flags a hand-written stale summary and does not replace it", () => {
    const l1 = row(2)
    const mine = { ...stale(l1[0]!), origin: "user" as const }
    const result = plan([mine, l1[1]!])
    assert.deepStrictEqual(result.flagged, [mine.id])
    assert.lengthOf(result.resummarize, 0)
  })

  it("does not write a summary again when nothing in its range has content", () => {
    const l1 = row(1)
    assert.lengthOf(plan([stale(l1[0]!)], { hasContent: () => false }).resummarize, 0)
  })

  it("does not write it again while a job for it runs, or after its failure with unchanged inputs", () => {
    const [one] = row(1)
    assert.lengthOf(plan([stale(one!)], { liveJobs: [{ level: 1, from: 1, to: 2, children: [] }] }).resummarize, 0)
    assert.lengthOf(plan([stale(one!)], { held: [{ level: 1, from: 1, to: 2 }] }).resummarize, 0)
  })

  it("does not write a summary again once a fresh one covers its range", () => {
    const [one] = row(1)
    const replacement = summary(1, 1, 2)
    assert.lengthOf(plan([stale(one!), replacement]).resummarize, 0)
  })

  it("writes a condensation again over fresh parts, after the stale parts below it are written again", () => {
    const l1 = row(3)
    const top = summary(2, 1, 6, { kids: l1.map((s) => s.id) })
    const staleTop = stale(top)
    // One part is stale and used through the condensation: it is written again first; the condensation waits.
    const first = plan([stale(l1[1]!), l1[0]!, l1[2]!, staleTop], { layer: [staleTop] })
    assert.deepStrictEqual(first.resummarize, [l1[1]!.id])
    assert.lengthOf(first.condensations, 0)
    // Its replacement exists: the condensation is written again over the replacement and the untouched parts.
    const replacement = summary(1, 3, 4)
    const second = plan([stale(l1[1]!), replacement, l1[0]!, l1[2]!, staleTop], {
      layer: [l1[0]!, replacement, l1[2]!],
      reason: "completion"
    })
    assert.lengthOf(second.resummarize, 0)
    assert.deepStrictEqual(second.condensations, [
      { level: 2, children: [l1[0]!.id, replacement.id, l1[2]!.id], eager: false }
    ])
  })

  it("flags a condensation that is stale because a part is hand-written and stale", () => {
    const l1 = row(2)
    const mine = { ...stale(l1[0]!), origin: "user" as const }
    const top = stale(summary(2, 1, 4, { kids: l1.map((s) => s.id) }))
    const result = plan([mine, l1[1]!, top], { layer: [top] })
    assert.sameMembers([...result.flagged], [mine.id, top.id])
    assert.lengthOf(result.condensations, 0)
  })
})

describe("requests to redo", () => {
  it("redoes a fresh or hand-written level-1 summary on a reply, and a condensation over its best parts, not on a finished job", () => {
    const l1 = row(2)
    const mine = { ...l1[0]!, origin: "user" as const }
    const top = summary(2, 1, 4, { kids: [mine.id, l1[1]!.id] })
    const forced = new Set([mine.id, top.id])
    const result = plan([mine, l1[1]!, top], { forced })
    assert.deepStrictEqual(result.resummarize, [mine.id])
    assert.deepStrictEqual(result.condensations, [
      { level: 2, children: [mine.id, l1[1]!.id], eager: false, rerunOf: top.id }
    ])
    const later = plan([mine, l1[1]!, top], { forced, reason: "completion" })
    assert.lengthOf(later.resummarize, 0)
    assert.lengthOf(later.condensations, 0)
  })
})

describe("the layer's budget", () => {
  const over = { ...settings, layerCost: 3000 }

  it("does nothing with the layer under its maximum, whatever is condensable below a fanout", () => {
    assert.lengthOf(plan(row(2), { settings: { ...settings, layerCost: 1500 } }).condensations, 0)
  })

  it("condenses fewer than a fanout once over the maximum, but never the newest run", () => {
    const run = row(2)
    const newest = summary(3, 5, 30, { kids: ["a", "b", "c"] })
    const result = plan([...run, newest], { settings: { ...over, fanout: 5 }, layer: [...run, newest] })
    assert.deepStrictEqual(result.condensations, [{ level: 2, children: run.map((s) => s.id), eager: true }])
    const alone = plan(run, { settings: { ...over, fanout: 5 } })
    assert.lengthOf(alone.condensations, 0, "a run that includes the newest summary is left alone")
  })

  it("absorbs the run into the generated parent on its left, keeping the parent's own parts first", () => {
    const old = row(3)
    const parent = summary(2, 1, 6, { kids: old.map((s) => s.id) })
    const run = row(2, 7)
    const newest = summary(2, 11, 16, { kids: ["a", "b", "c"] })
    const result = plan([...old, parent, ...run, newest], {
      settings: { ...over, fanout: 5 },
      layer: [parent, ...run, newest]
    })
    assert.deepStrictEqual(result.condensations, [
      {
        level: 2,
        children: [...old.map((s) => s.id), ...run.map((s) => s.id)],
        absorbedParentId: parent.id,
        eager: true
      }
    ])
  })

  it("will not absorb into a hand-written parent, or past the parts cap", () => {
    const old = row(3)
    const run = row(2, 7)
    const newest = summary(2, 11, 16, { kids: ["a", "b", "c"] })
    const mine = summary(2, 1, 6, { kids: old.map((s) => s.id), origin: "user" })
    const handWritten = plan([...old, mine, ...run, newest], {
      settings: { ...over, fanout: 5 },
      layer: [mine, ...run, newest]
    })
    assert.isUndefined(handWritten.condensations[0]?.absorbedParentId)
    const full = summary(2, 1, 6, { kids: old.map((s) => s.id) })
    const capped = plan([...old, full, ...run, newest], {
      settings: { ...over, fanout: 5, absorbMaxChildren: 3 },
      layer: [full, ...run, newest]
    })
    assert.isUndefined(capped.condensations[0]?.absorbedParentId)
  })

  it("needs the parts to be worth twice the target, and does not stack on a running job", () => {
    const run = row(2).map((s) => ({ ...s, tokens: 40 }))
    const newest = summary(2, 5, 10, { kids: ["a", "b", "c"] })
    assert.lengthOf(
      plan([...run, newest], { settings: { ...over, fanout: 5 }, layer: [...run, newest] }).condensations,
      0
    )
    const big = row(2)
    assert.lengthOf(
      plan([...big, newest], {
        settings: { ...over, fanout: 5 },
        layer: [...big, newest],
        liveJobs: [{ level: 5, from: 100, to: 101, children: [] }]
      }).condensations,
      0
    )
  })

  it("keeps shrinking toward the target after a budget job finished, and stops under it", () => {
    const run = row(2)
    const newest = summary(2, 5, 10, { kids: ["a", "b", "c"] })
    const between = { ...settings, fanout: 5, layerCost: 1500, lastFinishedEager: true }
    assert.lengthOf(plan([...run, newest], { settings: between, layer: [...run, newest] }).condensations, 1)
    assert.lengthOf(
      plan([...run, newest], { settings: { ...between, layerCost: 900 }, layer: [...run, newest] }).condensations,
      0
    )
    assert.lengthOf(
      plan([...run, newest], { settings: { ...between, lastFinishedEager: false }, layer: [...run, newest] })
        .condensations,
      0
    )
  })
})

it("is the same planner for any order the summaries are loaded in", () => {
  const l1 = row(7)
  const forward = plan(l1)
  const shuffled = plan([...l1].reverse() as ReadonlyArray<Summary> as ReadonlyArray<Candidate>)
  assert.deepStrictEqual(shuffled.condensations, forward.condensations)
})
