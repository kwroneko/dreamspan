import { expect, it, vi } from "vitest"
import { makeMediaQueue, mapCssMedia, mapMediaAttribute } from "../src/ui/html/mediaQueue.ts"

it("queues image-heavy reloads, waits for Retry-After and drops blobs on revocation", async () => {
  vi.useFakeTimers()
  try {
    let active = 0
    let peak = 0
    let attempts = 0
    const revoke = vi.fn()
    const queue = makeMediaQueue(
      (async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        attempts++
        return attempts <= 4
          ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
          : new Response("pixel")
      }) as typeof fetch,
      { create: () => "blob:synthetic", revoke }
    )
    const releases = Array.from({ length: 80 }, (_, i) => queue.retain(`/media/external?url=${i}`, () => {}))
    await vi.advanceTimersByTimeAsync(0)
    expect(peak).toBeLessThanOrEqual(4)
    expect(attempts).toBe(80)
    expect(queue.read("/media/external?url=0")).toBeNull()
    await vi.advanceTimersByTimeAsync(1999)
    expect(attempts).toBe(80)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts).toBe(84)
    expect(queue.read("/media/external?url=0")).toBe("blob:synthetic")
    releases.forEach((release) => release())
    expect(revoke).toHaveBeenCalledTimes(80)
    expect(queue.read("/media/external?url=0")).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
it("cancels delayed retries when the last view disappears", async () => {
  vi.useFakeTimers()
  try {
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "1" } }))
    const queue = makeMediaQueue(fetcher as typeof fetch)
    const release = queue.retain("/media/external?url=x", () => {})
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})

it("holds stylesheet resources for the loaded window and releases them on consent or detach", async () => {
  const { MessageStyles } = await import("../src/ui/html/messageHtml.ts")
  const fetcher = vi.fn(async () => new Response("pixel"))
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sheet")
  vi.stubGlobal("fetch", fetcher)
  class Sheet {
    css = ""
    replaceSync(value: string) {
      this.css = value
    }
  }
  vi.stubGlobal("CSSStyleSheet", Sheet)
  const document = { adoptedStyleSheets: [] as Sheet[] }
  vi.stubGlobal("document", document)
  const styles = new MessageStyles("test")
  const detach = styles.attach()
  try {
    styles.setLoaded([{ key: "greeting", text: "" }])
    styles.report("greeting", '.message-html .custom-tile{background:url("/media/external?chat=s&url=a")}', [
      "/media/external?chat=s&url=a"
    ])
    await vi.waitFor(() => expect(document.adoptedStyleSheets[0]!.css).toContain("blob:sheet"))
    // No component retains this CSS resource: the sheet owns it while the row is offscreen.
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(revoke).not.toHaveBeenCalled()
    styles.clearReports()
    await vi.waitFor(() => expect(document.adoptedStyleSheets[0]!.css).not.toContain("blob:sheet"))
    expect(revoke).toHaveBeenCalledWith("blob:sheet")
    styles.setLoaded([])
  } finally {
    detach()
    vi.unstubAllGlobals()
    revoke.mockRestore()
    create.mockRestore()
  }
})

it("does not turn inert CSS strings, selector text or data-URI text into resource prefetches", () => {
  const replace = vi.fn(() => "blob:loaded")
  for (const css of [
    `.a{content:'url("/media/external?url=inert")'}`,
    `.a{--address:"/media/external?url=inert"}`,
    `[data-x="/media/external?url=inert"]{color:red}`,
    `/* url("/media/external?url=inert") */ .a{color:red}`
  ])
    expect(mapCssMedia(css, replace)).toBe(css)
  for (const address of [
    "data:image/svg+xml,/media/external?url=inert",
    "prefix /media/external?url=inert",
    "data:image/png,a,/media/external?url=inert"
  ])
    for (const srcset of [true, false]) expect(mapMediaAttribute(address, srcset, replace)).toBe(address)
  expect(replace).not.toHaveBeenCalled()
  expect(mapCssMedia('.a{background:url("/media/external?url=actual")}', replace)).toContain('url("blob:loaded")')
  expect(mapMediaAttribute("/media/external?url=actual", false, replace)).toBe("blob:loaded")
  expect(mapMediaAttribute("/media/external?url=a 1x, /media/external?url=b 2x", true, replace)).toBe(
    "blob:loaded 1x, blob:loaded 2x"
  )
})
