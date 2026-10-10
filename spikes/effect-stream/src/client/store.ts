// Two interchangeable stores for per-version streaming state, so the spike can
// compare Effect atoms with a hand-written external store on the same UI.
import { useAtomValue } from "@effect/atom-react"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { useSyncExternalStore } from "react"
import type { VersionStatus } from "../shared/api.ts"

export interface VersionState {
  readonly text: string
  readonly status: VersionStatus
  readonly rowVersion: number
}

const EMPTY: VersionState = { text: "", status: "generating", rowVersion: 0 }

export interface VersionStore {
  readonly kind: "atom" | "plain"
  get(id: string): VersionState
  setMany(entries: ReadonlyArray<readonly [string, VersionState]>): void
  useVersion(id: string): VersionState
}

export const createPlainStore = (): VersionStore => {
  const values = new Map<string, VersionState>()
  const listeners = new Map<string, Set<() => void>>()
  const subscribers = new Map<string, (cb: () => void) => () => void>()

  // One stable subscribe function per id, so useSyncExternalStore never resubscribes.
  const subscriberFor = (id: string) => {
    let subscribe = subscribers.get(id)
    if (!subscribe) {
      subscribe = (cb) => {
        let set = listeners.get(id)
        if (!set) listeners.set(id, set = new Set())
        set.add(cb)
        return () => set.delete(cb)
      }
      subscribers.set(id, subscribe)
    }
    return subscribe
  }

  const get = (id: string) => values.get(id) ?? EMPTY

  return {
    kind: "plain",
    get,
    setMany(entries) {
      for (const [id, value] of entries) values.set(id, value)
      for (const [id] of entries) listeners.get(id)?.forEach((cb) => cb())
    },
    useVersion(id) {
      return useSyncExternalStore(subscriberFor(id), () => get(id))
    }
  }
}

// keepAlive: rows unmount as they scroll out of the virtualized window, and the
// state must survive that.
const versionAtom = Atom.family((_id: string) => Atom.make<VersionState>(EMPTY).pipe(Atom.keepAlive))

export const createAtomStore = (registry: AtomRegistry.AtomRegistry): VersionStore => ({
  kind: "atom",
  get: (id) => registry.get(versionAtom(id)),
  setMany(entries) {
    Atom.batch(() => {
      for (const [id, value] of entries) registry.set(versionAtom(id), value)
    })
  },
  useVersion(id) {
    return useAtomValue(versionAtom(id))
  }
})
