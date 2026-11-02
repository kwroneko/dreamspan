// Whole-folder timing through the real server, format workers and database workers.
import { mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, largeChat, encode } from "./support/stFolder.ts"
import { tempDir } from "./support/tempDir.ts"

it.live(
  "imports 2,000 synthetic files with 400 long chats",
  () => {
    const root = tempDir("st-folder-timing")
    let totalBytes = 0
    const put = (path: string, bytes: Uint8Array) => {
      totalBytes += bytes.byteLength
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, bytes)
    }
    put("settings.json", encode({ personas: {}, persona_descriptions: {} }))
    const description = "A synthetic character at the harbor. ".repeat(100)
    for (let i = 0; i < 1599; i++) {
      const name = i === 0 ? "Alice" : `Synthetic ${i}`
      put(`characters/${name}.png`, card(name, "Hello.", {}, { description }))
    }
    const chat = largeChat(300)
    for (let i = 0; i < 400; i++) put(`chats/Alice/synthetic-${String(i).padStart(4, "0")}.jsonl`, chat)
    const config = testConfig()
    const cpuStart = process.cpuUsage()
    const started = performance.now()
    return Effect.gen(function* () {
      const api = yield* client()
      const connected = performance.now()
      const { importId } = yield* api.StartStPathImport({ path: root, prefix: "" })
      let prior = performance.now()
      const phases: Record<string, number> = { startup: connected - started, scan: prior - connected }
      let phase = "library"
      for (;;) {
        const detail = yield* api.GetStImport({ importId })
        const now = performance.now()
        phases[phase] = (phases[phase] ?? 0) + now - prior
        prior = now
        const file = detail.job.currentFile ?? ""
        if (file) phase = file.startsWith("chats/") ? "chats" : "library"
        if (detail.job.status !== "running") {
          assert.strictEqual(detail.job.status, "complete")
          assert.strictEqual(detail.job.filesDone, 2000)
          assert.strictEqual(detail.report!.counts.card?.added, 1599)
          assert.strictEqual(detail.report!.counts.chat?.added, 400)
          assert.strictEqual(detail.report!.messages, 120000)
          const cpu = process.cpuUsage(cpuStart)
          const result = {
            seconds: (now - started) / 1000,
            fileMiB: totalBytes / 1024 / 1024,
            cpuSeconds: (cpu.user + cpu.system) / 1e6,
            phases,
            report: detail.report
          }
          console.log("IMPORT_TIMING", JSON.stringify(result))
          if (process.env.ST_FOLDER_TIMING_OUT) writeFileSync(process.env.ST_FOLDER_TIMING_OUT, JSON.stringify(result))
          assert.isBelow(now - started, 180_000)
          return
        }
        yield* Effect.sleep(100)
      }
    }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
  },
  600_000
)
