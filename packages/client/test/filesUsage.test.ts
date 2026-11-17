// The Files quota in the file manager: the usage line, the room check before an upload, and a
// batch the server refuses for lack of room. Synthetic files only.
import { describe, expect, it } from "vitest"
import { NoRoom } from "../src/features/files/source.ts"
import { batchSize, uploadAll, type UploadItem } from "../src/features/files/upload.ts"
import { freeBytes, roomProblem, usageLine } from "../src/features/files/usage.ts"

const MB = 1024 ** 2
const GB = 1024 ** 3
const usage = (usedBytes: number, quotaBytes: number, over = false, partial = false) => ({
  usedBytes,
  quotaBytes,
  over,
  partial
})
const file = (relative: string, bytes: number): UploadItem => ({
  kind: "file",
  relative,
  file: new File([new Uint8Array(bytes)], relative)
})

describe("files usage", () => {
  it("reads as used of quota, warning from 90%", () => {
    expect(usageLine(usage(1.2 * GB, 10 * GB))).toEqual({ text: "1.2 GB of 10 GB used", warn: false })
    expect(usageLine(usage(9 * GB, 10 * GB)).warn).toBe(true)
    expect(usageLine(usage(0, 10 * GB, true)).warn).toBe(true)
    expect(usageLine(usage(512, MB, false, true)).text).toBe("More than 512 B of 1 MB used")
  })

  it("lets a batch through only when it fits the room left", () => {
    expect(freeBytes(usage(11 * GB, 10 * GB))).toBe(0)
    expect(freeBytes(usage(GB, 2 * GB, true))).toBe(0)
    expect(roomProblem(GB, 2, usage(GB, 2 * GB))).toBeNull()
    expect(roomProblem(2.1 * GB, 2, usage(10 * GB - 800 * MB, 10 * GB))).toBe(
      "These files need 2.1 GB; 800 MB is free."
    )
    expect(roomProblem(2 * MB, 1, usage(MB, MB))).toBe("This file needs 2 MB; nothing is free.")
  })

  it("sizes a batch by its files, not its empty folders", () => {
    expect(batchSize([file("a", 3), { kind: "folder", relative: "b" }, file("c/d", 4)])).toEqual({ bytes: 7, files: 2 })
  })

  it("stops a batch at the server's 507 and says what was left", async () => {
    const written: Array<string> = []
    const report = await uploadAll(
      {
        upload: async (path) => {
          if (written.length === 1) throw new NoRoom("Full.")
          written.push(path)
          return { path, outcome: "written" as const }
        },
        createFolder: async (path) => ({ path })
      },
      "/files",
      [file("a", 1), file("b", 2), file("c", 3)],
      async () => null
    )
    expect(report.written).toEqual(["/files/a"])
    expect(report.failed).toEqual([])
    expect(report.noRoom).toEqual({ bytes: 5, files: 2 })
  })
})
