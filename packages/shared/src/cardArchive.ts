import { DateTime, Schema } from "effect"
import { EntityId } from "./chat.ts"
import { RefId } from "./library.ts"
import { makeRegistry } from "./registry.ts"

export const ArchiveCriteria = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36000 }))
)
export type ArchiveCriteria = typeof ArchiveCriteria.Type

/** Shared criterion descriptors and predicates; additional sources can register their own. */
export const cardArchiveCriteria = makeRegistry<{
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly inputLabel: string
  readonly initial: number
  readonly enabled: boolean
  readonly matches: (addedAt: number, lastUsedAt: number | null, now: number, amount: number) => boolean
}>([
  {
    id: "never",
    label: "Never used, added more than",
    unit: "days ago",
    inputLabel: "Days",
    initial: 30,
    enabled: true,
    matches: (added, used, now, n) => used === null && added < now - n * 86400000
  },
  {
    id: "inactive",
    label: "Not used in the last",
    unit: "months",
    inputLabel: "Months",
    initial: 6,
    enabled: false,
    matches: (_added, used, now, n) => {
      const cutoff = DateTime.subtract(DateTime.makeUnsafe(now), { months: n })
      return used !== null && used < DateTime.toEpochMillis(cutoff)
    }
  }
])

export const ArchiveCandidate = Schema.Struct({
  entityId: EntityId,
  refId: RefId,
  name: Schema.String,
  avatarMediaId: Schema.NullOr(Schema.String),
  addedAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number)
})
export type ArchiveCandidate = typeof ArchiveCandidate.Type
export const CardArchiveReceipt = Schema.Struct({ entityIds: Schema.Array(EntityId), archivedAt: Schema.Number })
