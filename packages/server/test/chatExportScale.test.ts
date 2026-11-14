// "Export this chat" on a chat of the owner's shape (synthetic): a family of long, swipe-heavy
// branches imported from ST files, then exported, one branch and every branch, through the
// real route. Logs the time and the process's memory while the export streams; the body is
// counted, never held. CHAT_EXPORT_BRANCHES / CHAT_EXPORT_MESSAGES scale it up.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, post, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, writeStBranchFamily } from "./support/stFolder.ts"
import { importStPath } from "./support/stUpload.ts"
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
      const imported = yield* importStPath(api, root)
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
      console.log(
        "CHAT_EXPORT_TIMING",
        JSON.stringify({
          branches: family.files.length,
          messages,
          sourceBytes: family.bytes,
          baselineRssMb: baseline,
          branch: one,
          all: every
        })
      )
      assert.isAbove(one.bytes, 0)
      assert.isAbove(every.bytes, 0)
    }).pipe(Effect.provide(serverLayer(testConfig())), Effect.scoped)
  },
  3_600_000
)
