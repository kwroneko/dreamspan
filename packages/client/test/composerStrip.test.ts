// The composer's next-reply strip (fcomposer): the cache chip's states, and controls whose
// placement follows the width, as a plugin's can.
import type { CacheWarmth } from "@dreamspan/shared/inspectorApi.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cacheNotes,
  cacheState,
  compactTokens,
  uncachedText,
  uncachedTotal
} from "../src/features/chat/CacheIndicator.tsx"
import {
  availableComposerControls,
  composerControls,
  type ComposerControlContext
} from "../src/features/chat/composerControls.tsx"
import { registerComposerControls } from "../src/features/chat/registerComposerControls.tsx"
import type { ChatSession } from "../src/features/chat/session.ts"

vi.hoisted(() => {
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1" })
})

const warmth = (over: Partial<CacheWarmth>): CacheWarmth => ({
  lastRequestAt: 1_000,
  ttlS: 300,
  expiresAt: 301_000,
  verified: true,
  prefixTokens: 2_926,
  changed: null,
  ...over
})

describe("the cache chip", () => {
  it("writes token counts compactly, and 0 for what isn't worth a chip", () => {
    expect([4, 340, 949, 950, 2_926, 9_949, 9_950, 96_906].map(compactTokens)).toEqual([
      "0",
      "340",
      "950",
      "1.0k",
      "2.9k",
      "9.9k",
      "10k",
      "97k"
    ])
  })

  it("shows a changed prefix whatever the TTL, warm while it lasts, then what expiry re-sends", () => {
    const changed = { reason: "Preset prompt “Main Prompt” reads differently.", tokens: 2_926 }
    // DESIGN §5.5: the rewrite warning shows without a known TTL.
    expect(cacheState(warmth({ ttlS: null, expiresAt: null, changed }), 0)).toEqual({
      kind: "uncached",
      tokens: 2_926,
      why: changed.reason
    })
    expect(cacheState(warmth({ changed }), 2_000)?.kind).toBe("uncached")
    expect(cacheState(warmth({}), 2_000)).toEqual({ kind: "warm", verified: true })
    expect(cacheState(warmth({}), 301_000)).toEqual({
      kind: "uncached",
      tokens: 2_926,
      why: "More than 5 minutes passed since the last request, so the provider's cache has expired."
    })
  })

  it("shows the uncached count out of the next request's total when it's known", () => {
    expect(uncachedText(7_046, 7_046)).toBe("↻ 7.0k of 7.0k uncached")
    expect(uncachedText(2_926, 96_906)).toBe("↻ 2.9k of 97k uncached")
    expect(uncachedText(2_926, undefined)).toBe("↻ 2.9k uncached")
  })

  it("takes the total from the estimate itself, and shows none rather than one below the uncached part", () => {
    const changed = { reason: "Message 2 was edited, or another of its versions chosen.", tokens: 2_926 }
    // The normal case: the estimate's own total, counted as its uncached part is.
    expect(uncachedTotal(2_926, warmth({ changed, requestTokens: 96_906 }))).toBe(96_906)
    expect(uncachedText(2_926, uncachedTotal(2_926, warmth({ changed, requestTokens: 2_926 })))).toBe(
      "↻ 2.9k of 2.9k uncached"
    )
    // A total below the uncached part (an expired cache counted on the last request) isn't raised to it.
    const lower = uncachedTotal(7_046, warmth({ prefixTokens: 7_046, requestTokens: 5_000 }))
    expect(lower).toBeUndefined()
    expect(uncachedText(7_046, lower)).toBe("↻ 7.0k uncached")
    // No total in the estimate: the chip reads as it did without one.
    const missing = uncachedTotal(2_926, warmth({ changed }))
    expect(missing).toBeUndefined()
    expect(uncachedText(2_926, missing)).toBe("↻ 2.9k uncached")
    expect(uncachedTotal(2_926, null)).toBeUndefined()
  })

  it("shows nothing when the estimate rounds to 0, or without a TTL and with nothing changed", () => {
    expect(cacheState(warmth({ changed: { reason: "The context's layout changed.", tokens: 4 } }), 0)).toBeNull()
    expect(cacheState(warmth({ prefixTokens: 3 }), 301_000)).toBeNull()
    expect(cacheState(warmth({ ttlS: null, expiresAt: null }), 0)).toBeNull()
    expect(cacheState(null, 0)).toBeNull()
  })

  it("keeps other parts' notes per chat, replaced or removed by key", () => {
    const session = {} as ChatSession
    const notes = cacheNotes(session)
    const seen = vi.fn()
    const unsubscribe = notes.subscribe(seen)
    notes.set("insert:a", { short: "re-reads 2 messages", text: "The model will re-read 2 messages." })
    const first = notes.snapshot()
    notes.set("insert:a", { short: "re-reads 2 messages", text: "The model will re-read 2 messages." })
    expect(notes.snapshot()).toBe(first)
    notes.set("insert:a", null)
    expect(notes.snapshot()).toEqual([])
    expect(seen).toHaveBeenCalledTimes(2)
    expect(cacheNotes(session)).toBe(notes)
    expect(cacheNotes({} as ChatSession)).not.toBe(notes)
    unsubscribe()
  })
})

describe("strip and box placements", () => {
  let dispose: Array<() => void>
  beforeEach(() => {
    dispose = registerComposerControls()
  })
  afterEach(() => {
    for (const close of dispose.reverse()) close()
  })
  const reply = { candidates: [], muted: [], next: null, picked: null, onPick: () => {} }
  const context = (compact: boolean, candidates: number) =>
    ({
      compact,
      reply: { ...reply, candidates: Array.from({ length: candidates }, (_, i) => `synthetic-${i}`) },
      guidance: false,
      leaf: undefined,
      leafGenerating: false
    }) as unknown as ComposerControlContext
  const ids = (placement: Parameters<typeof availableComposerControls>[0], c: ComposerControlContext) =>
    availableComposerControls(placement, c).map((entry) => entry.id)

  it("puts the next-reply chips in the strip, Next retaining its place without a choice", () => {
    expect(ids("strip", context(false, 1))).toEqual([
      "composer.model",
      "composer.preset",
      "composer.cache",
      "composer.next"
    ])
    expect(ids("strip", context(false, 3))).toEqual([
      "composer.model",
      "composer.preset",
      "composer.cache",
      "composer.next"
    ])
  })

  it("keeps earlier text and the guidance switch in the box at every width: the text has a row of its own", () => {
    for (const compact of [false, true]) {
      expect(ids("tools", context(compact, 1))).toEqual(["composer.history"])
      expect(ids("strip", context(compact, 1))).not.toContain("composer.history")
      expect(ids("actions", context(compact, 1))).toEqual(["composer.guidance", "composer.generate", "composer.send"])
    }
  })

  it("takes a plugin's control in a placement it names per context", () => {
    const close = composerControls.register({
      id: "synthetic.chip",
      order: 35,
      placement: ({ compact }) => (compact ? "tools" : "strip"),
      component: () => null
    })
    expect(ids("strip", context(false, 1))).toEqual([
      "composer.model",
      "composer.preset",
      "composer.cache",
      "synthetic.chip",
      "composer.next"
    ])
    expect(ids("tools", context(true, 1))).toEqual(["synthetic.chip", "composer.history"])
    close()
    expect(ids("strip", context(false, 1))).not.toContain("synthetic.chip")
  })
})
