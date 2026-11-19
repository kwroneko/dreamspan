// A confirmed re-import's plan of one batch (ARCHITECTURE.md §13 "Preparing the write"): what the
// matcher (`placeStMessages`, stImportPlace.ts) decided in a reader worker, with the ids of
// everything it adds already chosen. The writer's transaction applies it as it stands, after
// confirming the chat is as the plan's snapshot read it (its stamp): it matches nothing,
// looks nothing up per message and parses no message text.
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { StPlanCounts } from "@dreamspan/shared/stReimportPlan.ts"
import type { RecordPayload } from "./stImportPlace.ts"

/** A version a matched slot gains: message `m`'s version `v` of the batch, as `id`. */
interface StPlanVersionOp {
  readonly k: "v"
  readonly slot: string
  readonly id: string
  readonly ordinal: number
  readonly m: number
  readonly v: number
}

/** The file's selection in its fork: version `version` (message `m`'s version `v`) of `slot`. */
interface StPlanSelectOp {
  readonly k: "s"
  readonly slot: string
  readonly version: string
  readonly m: number
  readonly v: number
}

export type StPlanOp = StPlanVersionOp | StPlanSelectOp

/** One batch's plan. */
export interface StBatchPlan {
  /** The chat's stamp (stImportPlanStamp.ts) in the snapshot the plan read. */
  readonly stamp: string
  /** In the matcher's order. */
  readonly ops: ReadonlyArray<StPlanOp>
  /** The new path the batch ends with: its messages from `from` on, under `parent`, as `ids`. */
  readonly tail: {
    readonly from: number
    readonly parent: { readonly id: string; readonly depth: number } | null
    readonly ids: ReadonlyArray<string>
  } | null
  readonly slotIds: ReadonlyArray<SlotId>
  readonly matching: boolean
  readonly added: number
  readonly updated: number
  readonly differing: number
  readonly firstAdded: string | null
  readonly branchDeleted: boolean
  readonly keepTip: boolean
  /** Where the fork's tip would go after the batch: its last slot, or the nearest live one above. */
  readonly tip: string | null
  /** Imported versions of slots it matched that no import has pinned a cast on yet. */
  readonly uncast: ReadonlyArray<string>
  readonly counts: StPlanCounts
  readonly digest: string
}

/** The fork tip and record the writer leaves, batch by batch, as `placeBatch` moves them. */
export interface StPlanTip {
  /** The fork's tip now. */
  tip: string | null
  /** How many batches moved it, each a `row_version` and a shell stamp. */
  moves: number
  payload: RecordPayload
  /** Where the record says the import last left the fork (`advanced`, else `end`, else `last`)... */
  ref: string | null
  /** ...and that slot, or the nearest live one above it in the fork (`relocatedEnd`). */
  relocated: string | null
}

/** The record's mark of where the import last left the fork. */
export const planTipRef = (payload: RecordPayload) => payload.advanced ?? payload.end ?? payload.last ?? null

/**
 * Steps `state` over one batch's plan as `placeBatch` (stImportWrites.ts) steps the fork and
 * the record, batch by batch. `forkLive`: the fork is out of the bin.
 */
export const stepPlanTip = (
  state: StPlanTip,
  plan: StBatchPlan,
  options: { readonly advanceLeaf: boolean; readonly forkId: string; readonly forkLive: boolean }
) => {
  const payload = state.payload
  let advanced = payload.advanced ?? null
  let moved = false
  if (
    (options.advanceLeaf || payload.end == null || plan.added > 0 || payload.advanced != null) &&
    !plan.branchDeleted &&
    !plan.keepTip &&
    plan.slotIds.length > 0 &&
    options.forkLive &&
    (state.tip === null || state.tip === state.relocated)
  ) {
    state.tip = plan.tip
    state.moves++
    advanced = plan.tip
    moved = true
  }
  state.payload = {
    ...payload,
    forkId: options.forkId,
    firstAdded: payload.firstAdded ?? plan.firstAdded,
    advanced,
    branchDeleted: plan.branchDeleted,
    keepTip: plan.keepTip,
    forkPrior: payload.forkPrior ?? null,
    last: plan.slotIds.at(-1) ?? payload.last ?? null
  }
  // Where the next batch finds the import's mark: a tip just set is live already, and a last
  // slot relocates as this batch's own tip did.
  const ref = planTipRef(state.payload)
  if (ref !== state.ref) {
    state.relocated = moved && ref === advanced ? advanced : ref === plan.slotIds.at(-1) ? plan.tip : ref
    state.ref = ref
  }
}
