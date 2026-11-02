// The portraits open beside the chat, top first (owner, 2026-11-02): a click on one that isn't
// open puts it on top, splitting the column; a click on one that's open closes it. With
// "Only keep one image open at a time" (`single`), a click replaces the image instead, as the
// column did before. Each has a share of the column's height (`weight`), split by dragging the
// boundary between two. Pure functions over an immutable list, so the provider and the tests
// share them.

export interface StackPortrait {
  readonly id: string
  readonly name: string
  readonly mediaId: string | null
}
export interface StackEntry<P extends StackPortrait = StackPortrait> {
  readonly portrait: P
  /** Its share of the column's height: its weight over the sum of all of them. */
  readonly weight: number
}
export type Stack<P extends StackPortrait = StackPortrait> = ReadonlyArray<StackEntry<P>>

export const isOpen = (stack: Stack, id: string) => stack.some((entry) => entry.portrait.id === id)

/** A new one takes an equal share: the others' average, so each of n + 1 has 1 / (n + 1) if they were equal. */
const add = <P extends StackPortrait>(stack: Stack<P>, portrait: P): Stack<P> => [
  { portrait, weight: stack.length === 0 ? 1 : stack.reduce((sum, entry) => sum + entry.weight, 0) / stack.length },
  ...stack
]

/** A portrait's click: closes it when it's open; else puts it on top, or (`single`) in place of the rest. */
export const toggle = <P extends StackPortrait>(stack: Stack<P>, portrait: P, single: boolean): Stack<P> =>
  isOpen(stack, portrait.id) ? close(stack, portrait.id) : single ? [{ portrait, weight: 1 }] : add(stack, portrait)

/** Shows a portrait without ever closing it: open already, it stays as it is. */
export const show = <P extends StackPortrait>(stack: Stack<P>, portrait: P, single: boolean): Stack<P> =>
  isOpen(stack, portrait.id)
    ? single && stack.length > 1
      ? keepOnly(stack, portrait.id)
      : stack
    : single
      ? [{ portrait, weight: 1 }]
      : add(stack, portrait)

/** The one with id `from`, when it's open, becomes `portrait` in its place (a card swapped for another). */
export const replace = <P extends StackPortrait>(stack: Stack<P>, from: string, portrait: P): Stack<P> => {
  if (!isOpen(stack, from)) return stack
  // Swapped in for one while the new one is open too: it stays where it was, and the old one goes.
  if (from !== portrait.id && isOpen(stack, portrait.id)) return close(stack, from)
  return stack.map((entry) => (entry.portrait.id === from ? { ...entry, portrait } : entry))
}

export const close = <P extends StackPortrait>(stack: Stack<P>, id: string): Stack<P> =>
  stack.filter((entry) => entry.portrait.id !== id)

/** "Only keep one image open at a time": that one stays, the whole column's. */
export const keepOnly = <P extends StackPortrait>(stack: Stack<P>, id: string): Stack<P> =>
  stack.filter((entry) => entry.portrait.id === id).map((entry) => ({ ...entry, weight: 1 }))

/**
 * The boundary below `index` moved: the one above it is now `upper` pixels high of the
 * `total` the two have (their heights as shown), each kept at least `min`. Only the two
 * change; their weights keep their sum, so the others keep their heights.
 */
export const split = <P extends StackPortrait>(
  stack: Stack<P>,
  index: number,
  upper: number,
  total: number,
  min: number
): Stack<P> => {
  const above = stack[index],
    below = stack[index + 1]
  if (!above || !below || total <= 0) return stack
  const height = Math.max(min, Math.min(total - min, upper))
  const share = total < 2 * min ? 0.5 : height / total
  const sum = above.weight + below.weight
  return stack.map((entry, at) =>
    at === index
      ? { ...entry, weight: sum * share }
      : at === index + 1
        ? { ...entry, weight: sum * (1 - share) }
        : entry
  )
}

/** A double-click on a boundary: the two either side of it share their height equally. */
export const even = <P extends StackPortrait>(stack: Stack<P>, index: number): Stack<P> => {
  const above = stack[index],
    below = stack[index + 1]
  if (!above || !below) return stack
  const half = (above.weight + below.weight) / 2
  return stack.map((entry, at) => (at === index || at === index + 1 ? { ...entry, weight: half } : entry))
}
