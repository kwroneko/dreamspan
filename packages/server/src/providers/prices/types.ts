// The built-in price supplement's data shape (spec/PRICES.md §3.2). Data only: one file per
// provider, each entry naming the public page it was read from and the date it was checked.
import type { Price } from "@rp/shared/providers.ts"

/**
 * Cheaper hours: outside the listed UTC hours of the listed weekdays (0 = Sunday) every rate is
 * multiplied by `multiplier` (DeepSeek's off-peak discount).
 */
export interface OffPeak {
  readonly multiplier: number
  readonly peakHoursUtc: ReadonlyArray<readonly [from: number, to: number]>
  readonly peakDays: ReadonlyArray<number>
}

export interface PriceEntry {
  readonly price: Price
  /** Announced later prices, each in effect from its UTC date (`YYYY-MM-DD`), oldest first. */
  readonly changes?: ReadonlyArray<{ readonly from: string; readonly price: Price }>
  readonly offPeak?: OffPeak
  /** The provider's public pricing page this entry was read from. */
  readonly source: string
  /** When the page was read (`YYYY-MM-DD`). */
  readonly checked: string
  /** What the page says that the entry can't express. */
  readonly note?: string
}

export type PriceTable = Readonly<Record<string, PriceEntry>>
