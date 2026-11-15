// Registries: how the core assembles its features, and later how plugins extend, wrap,
// replace or disable them (spec/PLUGINS.md §3.1). The core registers its own features
// through the same registries plugins will use, so the seams exist where the app has them.
// It lives in shared so that pure features the client also runs (macros) can use it.
import { Effect, type Scope } from "effect"

/** A registration that hides the entry with its id, for disabling a feature. */
const DISABLED: unique symbol = Symbol("disabled")

interface Registration<A> {
  readonly value: A | typeof DISABLED
}

export interface Registry<A extends { readonly id: string }> {
  /** Monotonic mutation revision, including scope restoration (optional for custom registries). */
  readonly revision?: () => number
  /**
   * Adds an entry, or overrides the entry with the same id. When the scope closes, the
   * registration is undone and whatever it overrode is back. To wrap an entry, `get` it
   * first and register a replacement that calls it.
   */
  readonly register: (entry: A) => Effect.Effect<void, never, Scope.Scope>
  /** Hides the entry with this id while the scope is open. */
  readonly disable: (id: string) => Effect.Effect<void, never, Scope.Scope>
  /** The entry currently in effect for an id. */
  readonly get: (id: string) => A | undefined
  /** Every entry in effect, in the order their ids were first registered. */
  readonly list: () => ReadonlyArray<A>
}

export const makeRegistry = <A extends { readonly id: string }>(initial: ReadonlyArray<A> = []): Registry<A> => {
  // Each id keeps a stack of registrations; the newest is in effect. A registration
  // removes itself, wherever it is in the stack, so scopes may close in any order.
  const stacks = new Map<string, Array<Registration<A>>>(initial.map((value) => [value.id, [{ value }]]))
  let revision = 0

  const push = (id: string, value: A | typeof DISABLED) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const registration: Registration<A> = { value }
        const stack = stacks.get(id) ?? []
        stack.push(registration)
        stacks.set(id, stack)
        revision++
        return registration
      }),
      (registration) =>
        Effect.sync(() => {
          const stack = stacks.get(id)
          if (!stack) return
          const index = stack.indexOf(registration)
          if (index >= 0) {
            stack.splice(index, 1)
            revision++
          }
        })
    ).pipe(Effect.asVoid)

  const get = (id: string) => {
    const top = stacks.get(id)?.at(-1)?.value
    return top === undefined || top === DISABLED ? undefined : top
  }

  return {
    revision: () => revision,
    register: (entry) => push(entry.id, entry),
    disable: (id) => push(id, DISABLED),
    get,
    list: () => [...stacks.keys()].flatMap((id) => get(id) ?? [])
  }
}
