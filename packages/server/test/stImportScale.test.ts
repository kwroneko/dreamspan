// A 50,000-message ST chat through the folder import (ARCHITECTURE.md §13), timed, with the
// server's memory and event loop watched. Opt-in (`ST_IMPORT_SCALE=1`): it takes minutes on
// the shared host, and makes its server (and its data directory) only when asked to. The
// writer logs each batch over 25 ms as a slow storage operation.
import { writeFileSync } from "node:fs"
import { assert, it as plain, layer } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { largeChat } from "./support/stFolder.ts"
import { sendStFile } from "./support/stUpload.ts"

const MESSAGES = 50_000

/** Imports the chat, then imports it again unchanged. */
const measure = () =>
  Effect.gen(function* () {
    const api = yield* client()
    const chat = largeChat(MESSAGES)
    // Sampled from here on, so making the file above isn't counted. The server's main
    // thread is this process's, so a late tick is the server's event loop held up.
    let peakRss = 0
    let peakHeap = 0
    let lateMs = 0
    let last = performance.now()
    const sample = setInterval(() => {
      const now = performance.now()
      lateMs = Math.max(lateMs, now - last - 10)
      last = now
      const memory = process.memoryUsage()
      peakRss = Math.max(peakRss, memory.rss)
      peakHeap = Math.max(peakHeap, memory.heapUsed)
    }, 10)
    const run = (path: string) =>
      Effect.gen(function* () {
        const { importId } = yield* api.StartStImport({ unsupported: [] })
        const started = performance.now()
        const answer = yield* sendStFile(importId, path, chat, { card: "none" })
        return { answer, seconds: (performance.now() - started) / 1000 }
      })
    const first = yield* run("chats/Alice/large.jsonl")
    const again = yield* run("chats/Alice/large.jsonl")
    clearInterval(sample)
    const measured = JSON.stringify({
      messages: MESSAGES,
      fileMiB: +(chat.byteLength / 1024 / 1024).toFixed(1),
      importSeconds: +first.seconds.toFixed(1),
      reimportSeconds: +again.seconds.toFixed(1),
      peakRssMiB: Math.round(peakRss / 1024 / 1024),
      peakMainHeapMiB: Math.round(peakHeap / 1024 / 1024),
      eventLoopMaxLateMs: Math.round(lateMs)
    })
    if (process.env.ST_IMPORT_SCALE_OUT) writeFileSync(process.env.ST_IMPORT_SCALE_OUT, measured)
    assert.strictEqual(first.answer.outcome, "added")
    assert.strictEqual(again.answer.outcome, "unchanged")
  })

if (process.env.ST_IMPORT_SCALE === "1") {
  layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "30 minutes" })("ST import at scale", (it) => {
    it.effect(`a ${MESSAGES}-message chat`, measure)
  })
} else {
  plain.skip(`a ${MESSAGES}-message ST chat (set ST_IMPORT_SCALE=1)`, () => {})
}
