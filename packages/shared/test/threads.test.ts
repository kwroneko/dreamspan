import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChatThreadsApi, StartThreadsInput } from "../src/threadsApi.ts"

const thread = { name: null, cast: ["mira"], writesAs: null }
const start = { chatId: "chat", forkId: "fork", slotId: "slot", expectedRowVersion: 1 }

describe("thread input bounds", () => {
  it("bounds the work in one start transaction", () => {
    const accepts = Schema.is(StartThreadsInput)
    expect(accepts({ ...start, threads: Array.from({ length: 32 }, () => thread) })).toBe(true)
    expect(accepts({ ...start, threads: Array.from({ length: 33 }, () => thread) })).toBe(false)
  })

  it("bounds names at start and rename, while allowing an empty name", () => {
    const accepts = Schema.is(StartThreadsInput)
    const rename = Schema.is(ChatThreadsApi.requests.get("RenameThread")!.payloadSchema)
    for (const length of [0, 200, 201]) {
      const name = "x".repeat(length)
      expect(accepts({ ...start, threads: [{ ...thread, name }, thread] })).toBe(length <= 200)
      expect(rename({ chatId: "chat", splitId: "split", ordinal: 0, rowVersion: 1, name })).toBe(length <= 200)
    }
  })
})
