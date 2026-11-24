// A log scale for a slider whose range spans orders of magnitude (1,024 to 1,000,000 tokens): a
// thumb's place is log(value) between log(min) and log(max), so the low end gets as much of the
// track as the high end. Positions run 0..LOG_POSITIONS. A range starting at 0 or below is
// shifted to start at 1 for the logarithm, so 0 sits at the left end.

/** A log slider's positions: 0 to this. */
export const LOG_POSITIONS = 1000

/** `n` to `digits` significant figures. */
export const significant = (n: number, digits: number) => {
  if (n === 0 || !Number.isFinite(n)) return n
  const unit = 10 ** (Math.floor(Math.log10(Math.abs(n))) - digits + 1)
  return Math.round(n / unit) * unit
}

/** Powers of two that take the place of a round number next to them: 64 to 4,096. */
const POWERS_OF_TWO = Array.from({ length: 7 }, (_, i) => 2 ** (i + 6))

/**
 * A readable value near `n`: whole numbers below 100, two significant figures up to 100,000 and
 * three from there (8,000; 16,000; 128,000; 200,000), except that a power of two from 64 to
 * 4,096 within 2.5% of that takes its place (1,024 rather than 1,000; 4,096 rather than 4,100).
 * A readable value is its own readable value.
 */
export const readable = (n: number) => {
  if (n < 100) return Math.round(n)
  const round = significant(n, n < 99_500 ? 2 : 3)
  return POWERS_OF_TWO.find((power) => Math.abs(round / power - 1) <= 0.025) ?? round
}

export interface LogScale {
  /** The position, 0..LOG_POSITIONS (fractional), of a value: exact, not snapped. */
  readonly positionOf: (value: number) => number
  /** The value at a position, snapped to a readable one; the ends are `min` and `max` exactly. */
  readonly valueAt: (position: number) => number
  /**
   * The value a key moves to from `value`: a hundredth of the track (`large`: a tenth) in
   * `direction`, and always at least to the next value the scale gives.
   */
  readonly stepFrom: (value: number, direction: 1 | -1, large: boolean) => number
}

export function logScale(min: number, max: number, snap: (n: number) => number = readable): LogScale {
  const offset = min <= 0 ? 1 - min : 0
  const low = Math.log(min + offset)
  const span = Math.log(Math.max(max, min) + offset) - low
  const clamp = (value: number) => Math.min(max, Math.max(min, value))
  const positionOf = (value: number) =>
    span <= 0 ? 0 : ((Math.log(clamp(value) + offset) - low) / span) * LOG_POSITIONS
  const valueAt = (position: number) => {
    if (position <= 0) return min
    if (position >= LOG_POSITIONS) return max
    return clamp(snap(Math.exp(low + (position / LOG_POSITIONS) * span) - offset))
  }
  const stepFrom = (value: number, direction: 1 | -1, large: boolean) => {
    const delta = (large ? LOG_POSITIONS / 10 : LOG_POSITIONS / 100) * direction
    let position = positionOf(value)
    for (;;) {
      position += delta
      const next = valueAt(position)
      if (direction > 0 ? next > value : next < value) return next
      if (position <= 0 || position >= LOG_POSITIONS) return next
    }
  }
  return { positionOf, valueAt, stepFrom }
}
