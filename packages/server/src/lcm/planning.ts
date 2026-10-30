import { tokensOf } from "../assembler/st.ts"
// Pure policies called by reader workers. Ownership, admission and writes stay in db/.
import type { LcmSlot } from "../db/lcmPath.ts"
import { slotInput } from "../db/lcmPath.ts"
import { MAX_CHUNK_SLOTS } from "../db/lcmLimits.ts"
import { planMaintenance } from "./maintenance.ts"
import type { MaintenanceInput, Maintenance } from "./maintenance.ts"

interface LeafPlanningInput {
  readonly raw: ReadonlyArray<LcmSlot>
  readonly recent: { readonly target: number; readonly maximum: number }
  readonly leafInput: number
  readonly target: number
  readonly covered: ReadonlySet<string>
  readonly held: ReadonlySet<string>
  readonly limit: number
}
interface LeafChunk {
  readonly inputs: ReturnType<typeof slotInput>[]
  readonly target: number
  readonly clipTokens: number
}
export interface LeafPlanner {
  readonly id: string
  readonly plan: (input: LeafPlanningInput) => ReadonlyArray<LeafChunk>
}
export interface MaintenancePlanner {
  readonly id: string
  readonly plan: (input: MaintenanceInput) => Maintenance
}
export const slotCost = (s: LcmSlot) => tokensOf(s)

export const defaultLeafPlanner: LeafPlanner = {
  id: "leaf",
  plan: ({ raw, recent, leafInput, target, covered, held, limit }) => {
    if (raw.reduce((n, s) => n + slotCost(s), 0) <= (recent.target + recent.maximum) / 2) return []
    let keep = 0,
      end = raw.length
    while (end > 0 && keep < recent.target) keep += slotCost(raw[--end]!)
    const chunks: LeafChunk[] = []
    let chunk: LcmSlot[] = [],
      tokens = 0
    const flush = () => {
      if (chunk.length)
        chunks.push({ inputs: chunk.map(slotInput), target, clipTokens: Math.max(1, Math.floor(leafInput * 1.5)) })
      chunk = []
      tokens = 0
    }
    for (const s of raw.slice(0, end)) {
      if (chunks.length >= limit) break
      if (covered.has(s.id) || held.has(s.id)) {
        flush()
        continue
      }
      if (s.generating || s.merged) break
      chunk.push(s)
      tokens += slotCost(s)
      if (chunk.length >= MAX_CHUNK_SLOTS || tokens >= leafInput || (s.children >= 2 && tokens >= leafInput / 4))
        flush()
    }
    if (chunks.length < limit) flush()
    return chunks
  }
}
export const defaultMaintenancePlanner: MaintenancePlanner = { id: "maintenance", plan: planMaintenance }
