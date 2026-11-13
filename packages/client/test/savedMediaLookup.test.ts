import { expect, it, vi } from "vitest"
import { makeSavedMediaStore } from "../src/ui/html/savedMedia.ts"

it("asks in batches, answers saved, waiting and missing, and asks again about waiting files", async () => {
  vi.useFakeTimers()
  try {
    const store = makeSavedMediaStore()
    // Without a lookup nothing is saved; once one is expected, everything waits for it.
    expect(store.answer("https://cards.invalid/a.png").kind).toBe("missing")
    store.expect()
    expect(store.answer("https://cards.invalid/a.png").kind).toBe("pending")
    let downloaded = false
    const calls: string[][] = []
    store.install(async (urls) => {
      calls.push([...urls])
      return urls.flatMap((url) =>
        url.endsWith("/a.png")
          ? [{ url, mediaId: "a", waiting: false }]
          : url.endsWith("/b.png")
            ? [{ url, mediaId: downloaded ? "b" : null, waiting: !downloaded }]
            : []
      )
    })
    const changes = vi.fn()
    store.subscribe(changes)
    for (let i = 0; i < 600; i++) store.answer(`https://cards.invalid/${i}.gif`)
    expect(store.answer("https://cards.invalid/a.png#x").kind).toBe("pending")
    expect(store.answer("https://cards.invalid/b.png").kind).toBe("pending")
    // Macros and non-web addresses are never asked about.
    expect(store.answer("https://cards.invalid/{{user}}.png").kind).toBe("missing")
    expect(store.answer("/media/x").kind).toBe("missing")
    await vi.advanceTimersByTimeAsync(30)
    expect(calls.length).toBe(2)
    expect(calls.every((batch) => batch.length <= 500)).toBe(true)
    expect(store.answer("https://cards.invalid/a.png")).toEqual({ kind: "saved", path: "/media/saved/a" })
    expect(store.answer("https://cards.invalid/0.gif").kind).toBe("missing")
    expect(store.answer("https://cards.invalid/b.png").kind).toBe("pending")
    expect(changes).toHaveBeenCalled()
    downloaded = true
    await vi.advanceTimersByTimeAsync(3100)
    expect(store.answer("https://cards.invalid/b.png")).toEqual({ kind: "saved", path: "/media/saved/b" })
    // A failed lookup must not authorize contacting the remote site.
    store.install(async () => {
      throw new Error("offline")
    })
    store.answer("https://cards.invalid/c.png")
    await vi.advanceTimersByTimeAsync(30)
    expect(store.answer("https://cards.invalid/c.png").kind).toBe("pending")
  } finally {
    vi.useRealTimers()
  }
})

it("discards a previous account's in-flight lookup", async () => {
  vi.useFakeTimers()
  try {
    const store = makeSavedMediaStore()
    let reply!: (value: { url: string; mediaId: string; waiting: boolean }[]) => void
    store.install(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const url = "https://cards.invalid/private.png"
    store.answer(url)
    await vi.advanceTimersByTimeAsync(30)
    store.install(async () => [])
    reply([{ url, mediaId: "alice-only", waiting: false }])
    await Promise.resolve()
    expect(store.answer(url).kind).toBe("pending")
    await vi.advanceTimersByTimeAsync(30)
    expect(store.answer(url).kind).toBe("missing")
  } finally {
    vi.useRealTimers()
  }
})
