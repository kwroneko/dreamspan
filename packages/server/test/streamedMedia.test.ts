import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { streamToMedia } from "../src/importer/mediaFiles.ts"
import { tempDir } from "./support/tempDir.ts"

const first = Buffer.from("First chunk. ")
const last = Buffer.from("Final chunk.")
let finishWrite = true

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (String(args[0]).includes("/stream-")) {
        const sink: { write: (chunk: Uint8Array) => Promise<{ bytesWritten: number; buffer: Uint8Array }> } = handle
        const write = handle.write.bind(handle)
        const fault = vi
          .spyOn(sink, "write")
          .mockImplementationOnce((chunk) => write(chunk))
          .mockImplementationOnce((chunk) => write(chunk.subarray(0, -1)))
        if (!finishWrite) fault.mockImplementationOnce((chunk) => write(chunk.subarray(0, 0)))
      }
      return handle
    }
  }
})

async function* chunks() {
  yield first
  yield last
}

it("finishes a short final write before acknowledging the full hash and length", async () => {
  finishWrite = true
  const dataDir = tempDir("short-media-write")
  const expected = Buffer.concat([first, last])
  const copied = await streamToMedia(dataDir, chunks())
  expect(copied.size).toBe(expected.length)
  expect(copied.sha256).toBe(createHash("sha256").update(expected).digest("hex"))
  expect(await readFile(copied.temporary)).toEqual(expected)
})

it("rejects a short final write that cannot make progress and removes the temporary file", async () => {
  finishWrite = false
  const dataDir = tempDir("stalled-media-write")
  await expect(streamToMedia(dataDir, chunks())).rejects.toThrow()
  expect(await readdir(join(dataDir, "media", "00"))).toEqual([])
})
