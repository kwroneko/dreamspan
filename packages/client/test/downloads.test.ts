import { afterEach, expect, it, vi } from "vitest"
import { downloadLibraryArchive } from "../src/features/library/files.ts"

afterEach(() => vi.unstubAllGlobals())

it("lets the browser download arbitrarily large files without reading their bytes into the page", async () => {
  const clicked = vi.fn()
  const link = { href: "", download: "", click: clicked }
  vi.stubGlobal("document", { createElement: () => link })
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/library/archive") {
      expect(new Headers(init?.headers).get("x-export-download")).toBe("native")
      return Response.json({ key: "test-key" })
    }
    if (path === "/library/download-status?key=test-key")
      return Response.json({ bytes: 12 * 1024 ** 3, done: true, error: null })
    throw new Error("Unexpected request")
  })
  vi.stubGlobal("fetch", fetcher)
  const progress = vi.fn()
  expect(await downloadLibraryArchive(progress, new AbortController().signal)).toBeNull()
  expect(link.href).toBe("/library/download?key=test-key")
  expect(clicked).toHaveBeenCalledOnce()
  expect(progress).toHaveBeenCalledWith(12 * 1024 ** 3)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it("releases preparation when Stop arrives before the ticket", async () => {
  const controller = new AbortController()
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/library/archive") {
      controller.abort()
      return Response.json({ key: "late" })
    }
    expect(path).toBe("/library/download-stop?key=late")
    return Response.json({ stopped: true })
  })
  vi.stubGlobal("fetch", fetcher)
  expect(await downloadLibraryArchive(() => {}, controller.signal)).toBe("aborted")
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it("reports a server-side failure instead of calling a truncated archive successful", async () => {
  vi.stubGlobal("document", { createElement: () => ({ click: () => {} }) })
  vi.stubGlobal("fetch", async (path: string) =>
    path === "/library/archive"
      ? Response.json({ key: "failed" })
      : Response.json({ bytes: 100, done: true, error: "Export failed." })
  )
  expect(await downloadLibraryArchive(() => {}, new AbortController().signal)).toBe("Export failed.")
})
