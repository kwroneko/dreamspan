// "Export this chat" on a chat of the owner's shape (synthetic): a family of long, swipe-heavy
// branches imported from ST files, then exported, one branch and every branch, through the
// real route. Logs the time and the process's memory while the export streams; the body is
// counted, never held. CHAT_EXPORT_BRANCHES / CHAT_EXPORT_MESSAGES scale it up.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { client, post, serverLayer, serverPort, testConfig } from "./support/config.ts"
import { card, encode, writeStBranchFamily } from "./support/stFolder.ts"
import { jobEnded } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

/** Reads a response body to its end, counting bytes, and samples memory meanwhile. */
const drain = (response: Response, started: number) =>
  Effect.promise(async () => {
    let bytes = 0
    let peak = process.memoryUsage().rss
    const reader = response.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      peak = Math.max(peak, process.memoryUsage().rss)
    }
    return { bytes, seconds: (performance.now() - started) / 1000, peakRssMb: Math.round(peak / 1024 / 1024) }
  })

it.live(
  "exports a large family of swipe-heavy branches as it reads them",
  () => {
    const root = tempDir("chat-export-scale")
    const branches = Number(process.env.CHAT_EXPORT_BRANCHES ?? 40)
    const messages = Number(process.env.CHAT_EXPORT_MESSAGES ?? 2000)
    const family = writeStBranchFamily(root, { branches, messages })
    const put = (path: string, data: Uint8Array) => {
      mkdirSync(join(root, path, ".."), { recursive: true })
      writeFileSync(join(root, path), data)
    }
    put("settings.json", encode({ personas: {}, persona_descriptions: {} }))
    put("characters/Alice.png", card("Alice", "Hello."))
    return Effect.gen(function* () {
      const api = yield* client()
      const { importId } = yield* api.StartStPathImport({ path: root, prefix: "" })
      const imported = yield* jobEnded(api, importId, 900_000)
      assert.strictEqual(imported.job.status, "complete")
      const chat = (yield* api.ListChats({ limit: 10, before: null }))[0]!
      const baseline = Math.round(process.memoryUsage().rss / 1024 / 1024)
      const branchStarted = performance.now()
      const branch = yield* post("/library/chat-export", {
        chatId: chat.id,
        forkId: null,
        scope: "branch",
        format: "jsonl"
      })
      assert.strictEqual(branch.status, 200)
      const one = yield* drain(branch, branchStarted)
      const allStarted = performance.now()
      const all = yield* post("/library/chat-export", { chatId: chat.id, forkId: null, scope: "all", format: "jsonl" })
      assert.strictEqual(all.status, 200)
      assert.strictEqual(all.headers.get("x-export-files"), String(family.files.length))
      const every = yield* drain(all, allStarted)
      const wholeStarted = performance.now()
      const whole = yield* post("/library/archive", {})
      assert.strictEqual(whole.status, 200)
      const reading = yield* Effect.forkChild(drain(whole, wholeStarted))
      assert.strictEqual((yield* post("/library/archive", {})).status, 503)
      const fork = (yield* api.ListForks({ chatId: chat.id })).find((f) => f.current)!
      const sendStarted = performance.now()
      const sent = yield* api.SendMessage({
        chatId: chat.id,
        parentSlotId: fork.tipSlotId,
        branch: false,
        content: "Written during export.",
        reply: false
      })
      assert.strictEqual(sent._tag, "Posted")
      const sendMs = performance.now() - sendStarted
      const readStarted = performance.now()
      yield* api.ReadPath({ chatId: chat.id, forkId: fork.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      const readMs = performance.now() - readStarted
      const library = yield* Fiber.join(reading)
      // Native cancellation interrupts production even when the download is not consumed.
      const ticket = yield* post("/library/archive", {}, { "x-export-download": "native" })
      assert.strictEqual(ticket.status, 200)
      const { key } = yield* Effect.promise(async () => (await ticket.json()) as { key: string })
      const port = yield* serverPort
      const download = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/library/download?key=${key}`))
      const stoppedAt = performance.now()
      assert.strictEqual((yield* post(`/library/download-stop?key=${key}`, {})).status, 200)
      yield* Effect.promise(() => download.body!.cancel())
      let released = false
      for (let i = 0; i < 200; i++) {
        const retry = yield* post(
          "/library/chat-export",
          { chatId: chat.id, forkId: null, scope: "branch", format: "txt" },
          { "x-export-download": "native" }
        )
        if (retry.status === 200) {
          const next = yield* Effect.promise(async () => (await retry.json()) as { key: string })
          yield* post(`/library/download-stop?key=${next.key}`, {})
          released = true
          break
        }
        yield* Effect.sleep(25)
      }
      assert.isTrue(released)
      const cancelMs = performance.now() - stoppedAt
      const measurements = {
        branches: family.files.length,
        messages,
        sourceBytes: family.bytes,
        baselineRssMb: baseline,
        branch: one,
        all: every,
        library,
        concurrentSendMs: sendMs,
        concurrentReadMs: readMs,
        cancelMs
      }
      console.log("CHAT_EXPORT_TIMING", JSON.stringify(measurements))
      if (process.env.REVIEW_MEASUREMENTS)
        writeFileSync(process.env.REVIEW_MEASUREMENTS, JSON.stringify(measurements, null, 2))
      assert.isAbove(one.bytes, 0)
      assert.isAbove(every.bytes, 0)
    }).pipe(Effect.provide(serverLayer(testConfig())), Effect.scoped)
  },
  3_600_000
)
