// Registries: how the client assembles its features, and later how plugins add, replace
// or disable them (spec/PLUGINS.md §3.1, §8). The same rules as the server's
// (packages/server/src/registry.ts), with a disposer in place of a scope.
const DISABLED: unique symbol = Symbol("disabled")

interface Registration<A> {
  readonly value: A | typeof DISABLED
}

export interface Registry<A extends { readonly id: string }> {
  /**
   * Adds an entry, or overrides the entry with the same id. The returned function undoes
   * the registration, and whatever it overrode is back. To wrap an entry, `get` it first
   * and register a replacement that renders it.
   */
  readonly register: (entry: A) => () => void
  /** Hides the entry with this id until the returned function is called. */
  readonly disable: (id: string) => () => void
  /** The entry currently in effect for an id. */
  readonly get: (id: string) => A | undefined
  /** Every entry in effect, in the order their ids were first registered. */
  readonly list: () => ReadonlyArray<A>
}

export const makeRegistry = <A extends { readonly id: string }>(): Registry<A> => {
  // Each id keeps a stack of registrations; the newest is in effect. A registration
  // removes itself wherever it is in the stack, so they may be undone in any order.
  const stacks = new Map<string, Array<Registration<A>>>()

  const push = (id: string, value: A | typeof DISABLED) => {
    const registration: Registration<A> = { value }
    const stack = stacks.get(id) ?? []
    stack.push(registration)
    stacks.set(id, stack)
    return () => {
      const index = stack.indexOf(registration)
      if (index >= 0) stack.splice(index, 1)
    }
  }

  const get = (id: string) => {
    const top = stacks.get(id)?.at(-1)?.value
    return top === undefined || top === DISABLED ? undefined : top
  }

  return {
    register: (entry) => push(entry.id, entry),
    disable: (id) => push(id, DISABLED),
    get,
    list: () => [...stacks.keys()].flatMap((id) => get(id) ?? [])
  }
}
