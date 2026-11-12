import { readFile, readdir } from "node:fs/promises"
import { expect, it, vi } from "vitest"
import type { NetworkShape } from "../src/net/Network.ts"
import { tempDir } from "./support/tempDir.ts"

let begin: () => void
let writes: Promise<void> = Promise.resolve()
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      if (args[1] === "wx") {
        const write = file.write.bind(file)
        file.write = (async (...parts: Parameters<typeof file.write>) => {
          begin?.()
          await writes
          return write(...parts)
        }) as typeof file.write
      }
      return file
    }
  }
})
const { makeExternalFetcher } = await import("../src/net/externalMedia.ts")
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64"
)
const network = (body: ReadableStream<Uint8Array>): Pick<NetworkShape, "fetchFor"> => ({
  fetchFor: (_override, _route, check) =>
    (async (input: string | URL) => {
      await check?.(new URL(input))
      return new Response(body, { headers: { "content-type": "image/png" } })
    }) as typeof fetch
})
it("waits for disk writes before pulling again and disposes its capped temporary file", async () => {
  const directory = tempDir("media-streaming")
  let release!: () => void
  writes = new Promise<void>((done) => {
    release = done
  })
  const writing = new Promise<void>((done) => {
    begin = done
  })
  let pulls = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(pixel)
        else if (pulls < 10) controller.enqueue(new Uint8Array(64 * 1024))
        else controller.close()
      }
    },
    { highWaterMark: 0 }
  )
  const pending = makeExternalFetcher(network(body), {
    resolve: async () => ["93.184.216.34"],
    temporaryDirectory: directory
  })("https://media.invalid/a", new AbortController().signal)
  await writing
  expect(pulls).toBe(1)
  release()
  const file = await pending
  expect((await readFile(file.path)).length).toBe(pixel.length + 8 * 64 * 1024)
  await file.dispose()
  expect(await readdir(directory)).toEqual([])
})
it("cancels oversized upstream bodies and removes partial files", async () => {
  const directory = tempDir("media-streaming-cap")
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(2048))
    },
    cancel() {
      cancelled = true
    }
  })
  await expect(
    makeExternalFetcher(network(body), {
      resolve: async () => ["93.184.216.34"],
      temporaryDirectory: directory,
      maxBytes: 1024
    })("https://media.invalid/a", new AbortController().signal)
  ).rejects.toThrow("too large")
  expect(cancelled).toBe(true)
  expect(await readdir(directory)).toEqual([])
})

it("cleans partial files even when the upstream stream and its cancel both reject", async () => {
  const directory = tempDir("media-streaming-error")
  let pulls = 0
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(pixel)
        else controller.error(new Error("Synthetic truncated socket"))
      }
    },
    { highWaterMark: 0 }
  )
  await expect(
    makeExternalFetcher(network(body), { resolve: async () => ["93.184.216.34"], temporaryDirectory: directory })(
      "https://media.invalid/a",
      new AbortController().signal
    )
  ).rejects.toThrow("Synthetic truncated socket")
  expect(await readdir(directory)).toEqual([])
})
