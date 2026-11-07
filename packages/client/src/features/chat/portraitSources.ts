// The workbench's one portrait column (owner, 2026-11-07: "one image column for the whole
// workbench, not one per frame"). Each view keeps its own pictures (its tab's URL, as before);
// here they meet as one stack, the newest on top, with the same rules as one view's: a new one
// goes on top, "Keep one image open" keeps one in the whole column, closing one leaves the
// others. A column action computes the whole stack's next state and hands each view its part.
import { useSyncExternalStore } from "react"
import type { Portrait, PortraitViewer } from "../../ui/Portrait.tsx"
import { even, keepOnly, move, split, type Stack, type StackEntry } from "../../ui/portraitStack.ts"
import type { WorkbenchStore } from "../workbench/store.ts"
import type { useOpenAsTab } from "../workbench/tab.tsx"

type OpenAsTab = NonNullable<ReturnType<typeof useOpenAsTab>>

/** What a view gives the column: its pictures as they show now, and how to change them. */
interface PortraitSource {
  readonly viewer: PortraitViewer
  readonly asTab: OpenAsTab | null
}

/** A picture in the shared stack: its view's tab and its own id, as one id. */
const keyOf = (tabId: string, id: string) => `${tabId}\u0001${id}`

const signature = (stack: Stack<Portrait>, single: boolean) =>
  JSON.stringify([
    single,
    stack.map((e) => [e.portrait.id, e.portrait.name, e.portrait.mediaId, e.portrait.picture ?? null, e.weight])
  ])

interface Owned {
  readonly tabId: string
  readonly portrait: Portrait
}

type Entries = ReadonlyArray<{ key: string; owned: Owned; weight: number }>

/** What the column shows, as of the last change: a new object on each, so renders follow it. */
interface PortraitColumnState {
  /** The tab that renders the column. */
  readonly renderer: string | null
  readonly entries: Entries
}

class PortraitSources {
  /** By tab, oldest first: the oldest renders the column, so it stays mounted while views come and go. */
  private readonly sources = new Map<string, PortraitSource>()
  /** Each view's ids at its last change, to tell what it opened since. */
  private readonly published = new Map<string, ReadonlyArray<string>>()
  private readonly signatures = new Map<string, string>()
  /** The column's order, top first. */
  private order: ReadonlyArray<string> = []
  private state: PortraitColumnState = { renderer: null, entries: [] }
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly snapshot = () => this.state

  private notify() {
    this.state = { renderer: this.sources.keys().next().value ?? null, entries: this.entries() }
    for (const listener of this.listeners) listener()
  }

  /** A view's pictures as they are now; called on each of its renders. */
  publish(tabId: string, source: PortraitSource) {
    this.sources.set(tabId, source)
    const shown = source.viewer.shown
    const sig = signature(shown, source.viewer.single)
    if (this.signatures.get(tabId) === sig) return
    this.signatures.set(tabId, sig)
    const before = this.published.get(tabId) ?? []
    const ids = shown.map((e) => e.portrait.id)
    this.published.set(tabId, ids)
    const removed = new Set(before.filter((id) => !ids.includes(id)).map((id) => keyOf(tabId, id)))
    const added = ids.filter((id) => !before.includes(id))
    // One swapped for another (a card replaced) keeps its place; a new one goes on top, as does
    // one that replaced the rest with "Keep one image open".
    const inPlace = new Map<string, string>()
    const onTop: Array<string> = []
    for (const id of added) {
      const was = before[ids.indexOf(id)]
      const wasKey = was === undefined ? undefined : keyOf(tabId, was)
      if (!source.viewer.single && wasKey && removed.has(wasKey)) inPlace.set(wasKey, keyOf(tabId, id))
      else onTop.push(keyOf(tabId, id))
    }
    this.order = [
      ...onTop,
      ...this.order.flatMap((key) => (inPlace.has(key) ? [inPlace.get(key)!] : removed.has(key) ? [] : [key]))
    ]
    // "Keep one image open": one opened here closes the other views' ones.
    if (onTop.length > 0 && source.viewer.single) {
      for (const [other, s] of this.sources) if (other !== tabId && s.viewer.shown.length > 0) s.viewer.set([])
    }
    this.notify()
  }

  /** The view is gone, or no longer shows the column (a phone). */
  remove(tabId: string) {
    if (!this.sources.delete(tabId)) return
    this.published.delete(tabId)
    this.signatures.delete(tabId)
    const prefix = keyOf(tabId, "")
    this.order = this.order.filter((key) => !key.startsWith(prefix))
    this.notify()
  }

  /** Every view's pictures, in the column's order, each under its shared id. */
  private entries(): Entries {
    const all = new Map<string, { owned: Owned; weight: number }>()
    for (const [tabId, source] of this.sources) {
      for (const entry of source.viewer.shown)
        all.set(keyOf(tabId, entry.portrait.id), { owned: { tabId, portrait: entry.portrait }, weight: entry.weight })
    }
    return this.order.flatMap((key) => {
      const found = all.get(key)
      return found ? [{ key, ...found }] : []
    })
  }

  /** The source of the picture with shared id `key`. */
  sourceOf(key: string) {
    const tabId = key.slice(0, key.indexOf("\u0001"))
    return this.sources.get(tabId) ?? null
  }

  /** The whole stack changed: the column's order follows it and each view gets its part. */
  private apply(change: (stack: Stack<Portrait>) => Stack<Portrait>) {
    const entries = this.entries()
    const owners = new Map(entries.map((e) => [e.key, e.owned]))
    const next = change(entries.map((e) => ({ portrait: { ...e.owned.portrait, id: e.key }, weight: e.weight })))
    this.order = next.map((e) => e.portrait.id)
    for (const [tabId, source] of this.sources) {
      const part: Array<StackEntry<Portrait>> = next.flatMap((e) => {
        const owned = owners.get(e.portrait.id)
        return owned && owned.tabId === tabId ? [{ portrait: owned.portrait, weight: e.weight }] : []
      })
      if (signature(part, source.viewer.single) !== signature(source.viewer.shown, source.viewer.single))
        source.viewer.set(part)
    }
    this.notify()
  }

  /** The column's viewer: the shared stack as `state` has it, with `own` (the rendering view) for what opens. */
  viewer(state: PortraitColumnState, ownTab: string, own: PortraitViewer): PortraitViewer {
    const shown = state.entries.map((e) => ({ portrait: { ...e.owned.portrait, id: e.key }, weight: e.weight }))
    const run = (change: (stack: Stack<Portrait>) => Stack<Portrait>) => this.apply(change)
    return {
      open: own.open,
      show: own.show,
      replace: own.replace,
      shown,
      close: (id) => run((stack) => (id === undefined ? stack.slice(1) : stack.filter((e) => e.portrait.id !== id))),
      split: (index, upper, total, min) => run((stack) => split(stack, index, upper, total, min)),
      even: (index) => run((stack) => even(stack, index)),
      move: (id, index) => run((stack) => move(stack, id, index)),
      single: own.single,
      setSingle: (on, keep) => {
        if (on) run((stack) => keepOnly(stack, keep))
        // The account's choice, through the rendering view, which keeps its own part as above.
        const owned = this.entries().find((e) => e.key === keep)?.owned
        own.setSingle(on, owned?.tabId === ownTab ? owned.portrait.id : "")
      },
      set: (next) => run(() => next)
    }
  }
}

const all = new WeakMap<WorkbenchStore, PortraitSources>()

/** The workbench's shared column. */
export function portraitSources(store: WorkbenchStore) {
  let sources = all.get(store)
  if (!sources) {
    sources = new PortraitSources()
    all.set(store, sources)
  }
  return sources
}

export function usePortraitSources(sources: PortraitSources): PortraitColumnState {
  return useSyncExternalStore(sources.subscribe, sources.snapshot)
}
