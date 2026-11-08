import { DateTime, Schema } from "effect"
import { EntityId } from "./chat.ts"
import { RefId } from "./library.ts"
import { makeRegistry } from "./registry.ts"

export const ArchiveCriteria = Schema.Record(
  Schema.String,
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36000 }))
)
export type ArchiveCriteria = typeof ArchiveCriteria.Type

/** What a criterion sees of a card: no documents or message text. */
export interface ArchiveCardFacts {
  readonly addedAt: number
  readonly lastUsedAt: number | null
  /** The card source it was added from (its `card_origins` row), else null. */
  readonly fromSource: string | null
  /** The user's own messages in the chats the card was in; counted only for a card from a source. */
  readonly userMessages: number
}

/** Shared criterion descriptors and predicates; additional sources can register their own. */
export const cardArchiveCriteria = makeRegistry<{
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly inputLabel: string
  readonly initial: number
  readonly enabled: boolean
  /**
   * Offered only while a card source is on: its label then, naming them, and the dialog shows
   * how many cards it matches beside it.
   */
  readonly forCardSources?: (sourceNames: ReadonlyArray<string>) => string
  readonly matches: (card: ArchiveCardFacts, now: number, amount: number) => boolean
}>([
  {
    id: "never",
    label: "Never used, added more than",
    unit: "days ago",
    inputLabel: "Days",
    initial: 30,
    enabled: true,
    matches: (card, now, n) => card.lastUsedAt === null && card.addedAt < now - n * 86400000
  },
  {
    id: "inactive",
    label: "Not used in the last",
    unit: "months",
    inputLabel: "Months",
    initial: 6,
    enabled: false,
    matches: (card, now, n) => {
      const cutoff = DateTime.subtract(DateTime.makeUnsafe(now), { months: n })
      return card.lastUsedAt !== null && card.lastUsedAt < DateTime.toEpochMillis(cutoff)
    }
  },
  // Cards added only by trying them (spec/CARD-SOURCES.md §9 D3): the card sources' part of the
  // dialog. Sending a message counts as use, so "Never used" can't catch them.
  {
    id: "tried",
    label: "Only tried: added from a card source, with at most",
    forCardSources: (names) => `Only tried: added from ${names.join(" or ")}, with at most`,
    unit: "of your messages in all its chats",
    inputLabel: "Messages",
    initial: 1,
    enabled: false,
    matches: (card, _now, n) => card.fromSource !== null && card.userMessages <= n
  }
])

export const ArchiveCandidate = Schema.Struct({
  entityId: EntityId,
  refId: RefId,
  name: Schema.String,
  avatarMediaId: Schema.NullOr(Schema.String),
  addedAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
  /** For a card added from a card source: that source, and the user's own messages in its chats. */
  fromSource: Schema.optionalKey(Schema.String),
  userMessages: Schema.optionalKey(Schema.Int)
})
export type ArchiveCandidate = typeof ArchiveCandidate.Type
export const CardArchiveReceipt = Schema.Struct({ entityIds: Schema.Array(EntityId), archivedAt: Schema.Number })
