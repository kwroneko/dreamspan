// Saved card media at render time (spec/SAVED-MEDIA.md §3.4): which remote addresses this
// account has a copy of. Rendering is synchronous, so this answers from what it knows and asks
// the server in batches about the rest; each answer that changes something bumps the revision,
// which re-renders the messages that read it. Card text is never rewritten.
import { mediaKey, savedMediaPath, type SavedMediaLookup } from "@dreamspan/shared/savedMedia.ts"

export type SavedMediaAnswer =
  | { readonly kind: "saved"; readonly path: string }
  /** Not known yet, or still downloading: show a blank placeholder, never the other site. */
  | { readonly kind: "pending" }
  /** Not saved: the consent rules decide. */
  | { readonly kind: "missing" }

type Lookup = (urls: ReadonlyArray<string>) => Promise<ReadonlyArray<SavedMediaLookup> | null>

const BATCH = 500
const MAX_KNOWN = 20_000
const POLL_MS = 3000
const PENDING: SavedMediaAnswer = { kind: "pending" }
const MISSING: SavedMediaAnswer = { kind: "missing" }

export const makeSavedMediaStore = (schedule: (run: () => void, ms: number) => unknown = setTimeout) => {
  let lookup: Lookup | null = null
  let expected = false
  const known = new Map<string, SavedMediaAnswer>()
  const queued = new Set<string>()
  const asking = new Set<string>()
  let generation = 0
  let flushing = false
  let revision = 0
  const listeners = new Set<() => void>()
  const bump = () => {
    revision++
    for (const listener of listeners) listener()
  }
  const flush = () => {
    flushing = false
    const version = generation
    const ask = lookup
    if (!ask) return
    const urls = [...queued].slice(0, BATCH)
    for (const url of urls) {
      queued.delete(url)
      asking.add(url)
    }
    if (queued.size) {
      flushing = true
      schedule(flush, 0)
    }
    if (!urls.length) return
    void ask(urls).then(
      (answers) => {
        if (version !== generation) return
        let changed = false
        const found = new Map((answers ?? []).map((answer) => [answer.url, answer]))
        if (known.size > MAX_KNOWN) known.clear()
        for (const url of urls) {
          asking.delete(url)
          const answer = found.get(url)
          const next: SavedMediaAnswer = answer?.mediaId
            ? { kind: "saved", path: savedMediaPath(answer.mediaId) }
            : answer?.waiting || answers === null
              ? PENDING
              : MISSING
          const before = known.get(url)
          if (
            before?.kind !== next.kind ||
            (before.kind === "saved" && next.kind === "saved" && before.path !== next.path)
          )
            changed = true
          known.set(url, next)
          if (next === PENDING)
            schedule(() => {
              if (version === generation) enqueue(url)
            }, POLL_MS)
        }
        if (changed) bump()
      },
      () => {
        if (version !== generation) return
        for (const url of urls) {
          asking.delete(url)
          known.set(url, PENDING)
          schedule(() => {
            if (version === generation) enqueue(url)
          }, POLL_MS)
        }
        bump()
      }
    )
  }
  const enqueue = (url: string) => {
    if (asking.has(url) || queued.has(url)) return
    queued.add(url)
    if (!flushing) {
      flushing = true
      schedule(flush, 20)
    }
  }
  return {
    /**
     * The app will install a lookup (features/savedMedia registers): until it does, every
     * address waits as a placeholder, so nothing reaches another site before it's asked about.
     */
    expect() {
      expected = true
    },
    /** Installed by the signed-in app (features/savedMedia); without one nothing is saved. */
    install(next: Lookup | null) {
      generation++
      lookup = next
      asking.clear()
      known.clear()
      queued.clear()
      bump()
    },
    answer(raw: string): SavedMediaAnswer {
      if (!lookup) return expected ? PENDING : MISSING
      const key = mediaKey(raw)
      if (key === null) return MISSING
      const answer = known.get(key)
      if (answer) return answer
      enqueue(key)
      return PENDING
    },
    /** Asks again about everything (after an approval, a retry or a site change). */
    forget() {
      generation++
      asking.clear()
      known.clear()
      bump()
    },
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

export const savedMedia = makeSavedMediaStore()
export const subscribeSavedMedia = savedMedia.subscribe
export const savedMediaRevision = savedMedia.revision
