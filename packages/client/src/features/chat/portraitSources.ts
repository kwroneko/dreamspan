// The workbench's one portrait column (owner, 2026-11-07: "one image column for the whole
// workbench, not one per frame"). Each view keeps its own pictures (its tab's URL, as before);
// here they meet as one stack, the newest on top, with the same rules as one view's: a new one
// goes on top, "Keep one image open" keeps one in the whole column, closing one leaves the
// others. A column action computes the whole stack's next state and hands each view its part.
import { useSyncExternalStore } from "react"
import type { Portrait, PortraitViewer } from "../../ui/Portrait.tsx"
import { pictureUrl } from "../../ui/mediaImage.ts"
import { even, keepOnly, move, split, type Stack, type StackEntry } from "../../ui/portraitStack.ts"
import type { WorkbenchStore } from "../workbench/store.ts"
import type { useOpenAsTab } from "../workbench/tab.tsx"

type OpenAsTab = NonNullable<ReturnType<typeof useOpenAsTab>>

/** What a view gives the column: its pictures as they show now, and how to change them. */
interface PortraitSource {
  readonly viewer: PortraitViewer
  readonly asTab: OpenAsTab | null
}

/** A holder in the shared stack: its view's tab and its own id. */
const keyOf = (tabId: string, id: string) => `${tabId}\u0001${id}`
const tabOf = (key: string) => key.slice(0, key.indexOf("\u0001"))
const idOf = (key: string) => key.slice(key.indexOf("\u0001") + 1)

/** Each card can show a different image or crop in a different view. */
const pictureKey = ({ id, src, mediaId, picture }: Portrait) =>
  JSON.stringify([id, src ?? (mediaId === null ? null : pictureUrl(mediaId, picture))])

const signature = (stack: Stack<Portrait>, single: boolean) =>
  JSON.stringify([
    single,
    stack.map(({ portrait: p, weight }) => [p.id, p.name, p.mediaId, p.picture, p.src, p.image, weight])
  ])

interface Owned {
  readonly tabId: string
  readonly portrait: Portrait
}

/** A picture has a stable key and uses the first holder in column order as its source. */
type Entries = ReadonlyArray<{ key: string; owned: Owned; weight: number; holders: ReadonlyArray<string> }>

/** What the column shows, as of the last change: a new object on each, so renders follow it. */
interface PortraitColumnState {
  readonly entries: Entries
}

class PortraitSources {
  /** Each tab's latest viewer and tab actions. */
  private readonly sources = new Map<string, PortraitSource>()
  /** Each view's ids at its last change, to tell what it opened since. */
  private readonly published = new Map<string, ReadonlyArray<string>>()
  private readonly signatures = new Map<string, string>()
  /** The column's order, top first. */
  private order: ReadonlyArray<string> = []
  private state: PortraitColumnState = { entries: [] }
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  readonly snapshot = () => this.state

  private notify() {
    this.state = { entries: this.entries() }
    for (const listener of this.listeners) listener()
  }

  /** A view's pictures as they are now. URL and cast changes affect only this view's entries. */
  publish(tabId: string, source: PortraitSource) {
    this.sources.set(tabId, source)
    const shown = source.viewer.shown
    const sig = signature(shown, source.viewer.single)
    if (this.signatures.get(tabId) === sig) return
    this.signatures.set(tabId, sig)
    const first = !this.published.has(tabId)
    const before = this.published.get(tabId) ?? []
    const ids = shown.map((e) => e.portrait.id)
    // A view's first pictures that the column already shows from another view (a pane split
    // from this one, or the tabs coming back after a reload) keep their place, below it.
    const held = first ? new Map(this.state.entries.map((e) => [e.key, e.holders[0]!])) : null
    this.published.set(tabId, ids)
    const removed = new Set(before.filter((id) => !ids.includes(id)).map((id) => keyOf(tabId, id)))
    // One swapped for another (a card replaced) keeps its place; a new one goes on top, as does
    // one that replaced the rest with "Keep one image open".
    const inPlace = new Map<string, string>()
    const below = new Map<string, string>()
    const onTop: Array<string> = []
    for (const [index, { portrait }] of shown.entries()) {
      const id = portrait.id
      if (before.includes(id)) continue
      const key = keyOf(tabId, id)
      const existing = held?.get(pictureKey(portrait))
      const was = before[index]
      const wasKey = was === undefined ? undefined : keyOf(tabId, was)
      if (existing !== undefined) below.set(existing, key)
      else if (!source.viewer.single && wasKey && removed.has(wasKey)) inPlace.set(wasKey, key)
      else onTop.push(key)
    }
    this.order = [
      ...onTop,
      ...this.order.flatMap((key) =>
        inPlace.has(key) ? [inPlace.get(key)!] : removed.has(key) ? [] : below.has(key) ? [key, below.get(key)!] : [key]
      )
    ]
    this.notify()
  }

  /** A portrait click or single-image open also updates the other views' stacks. */
  changeOtherViews(tabId: string, portrait: Portrait, action: "close" | "keep") {
    const key = pictureKey(portrait)
    for (const [other, { viewer }] of this.sources) {
      if (other === tabId) continue
      const next = viewer.shown.filter(({ portrait }) => {
        const samePicture = pictureKey(portrait) === key
        return action === "keep" ? samePicture : !samePicture
      })
      if (next.length !== viewer.shown.length) viewer.set(next)
    }
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

  /** Every view's pictures, in the column's order, each once under its shared id. */
  private entries(): Entries {
    const all = new Map<string, { owned: Owned; weight: number }>()
    for (const [tabId, source] of this.sources) {
      for (const entry of source.viewer.shown)
        all.set(keyOf(tabId, entry.portrait.id), { owned: { tabId, portrait: entry.portrait }, weight: entry.weight })
    }
    const byPicture = new Map<string, { key: string; owned: Owned; weight: number; holders: Array<string> }>()
    for (const holder of this.order) {
      const found = all.get(holder)
      if (!found) continue
      const key = pictureKey(found.owned.portrait)
      const entry = byPicture.get(key)
      if (entry) entry.holders.push(holder)
      else byPicture.set(key, { key, ...found, holders: [holder] })
    }
    return [...byPicture.values()]
  }

  /** Opens beside the view that most recently opened this picture. */
  asTabOf(state: PortraitColumnState, key: string) {
    const entry = state.entries.find((e) => e.key === key)
    return entry ? (this.sources.get(entry.owned.tabId)?.asTab ?? null) : null
  }

  /** The whole stack changed: the column's order follows it and each view gets its part. */
  private apply(change: (stack: Stack<Portrait>) => Stack<Portrait>) {
    const entries = this.entries()
    const holders = new Map(entries.map((e) => [e.key, e.holders]))
    const next = change(entries.map((e) => ({ portrait: { ...e.owned.portrait, id: e.key }, weight: e.weight })))
    // Each change applies to every view that shows the picture: closing it closes it in all.
    this.order = next.flatMap((e) => holders.get(e.portrait.id) ?? [])
    for (const [tabId, { viewer }] of this.sources) {
      const own = new Map(viewer.shown.map((s) => [s.portrait.id, s.portrait]))
      const part: Array<StackEntry<Portrait>> = next.flatMap((e) => {
        const key = holders.get(e.portrait.id)?.find((k) => tabOf(k) === tabId)
        const portrait = key === undefined ? undefined : own.get(idOf(key))
        return portrait ? [{ portrait, weight: e.weight }] : []
      })
      if (signature(part, viewer.single) !== signature(viewer.shown, viewer.single)) viewer.set(part)
    }
    this.notify()
  }

  /** The column's viewer, using the top picture's source for view-level actions. */
  viewer(state: PortraitColumnState): PortraitViewer | null {
    const top = state.entries[0]
    const own = top && this.sources.get(top.owned.tabId)?.viewer
    if (!own) return null
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
        // Write the preference through the view that holds the selected picture.
        const holder = this.entries().find((e) => e.key === keep)?.holders[0]
        if (holder !== undefined) this.sources.get(tabOf(holder))?.viewer.setSingle(on, idOf(holder))
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
