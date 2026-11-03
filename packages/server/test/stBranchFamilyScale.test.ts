import { fixtureSql } from "./support/lcmFixtures.ts"
import { StImports } from "../src/importer/StImports.ts"
// A branch family's physical lines include hundreds of copies of its long, swipe-heavy
// prefixes. This budget covers the real folder import, not just the divergent suffixes.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BroadcastChannel } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { card, encode, largeChat, writeStBranchFamily } from "./support/stFolder.ts"
import { tempDir } from "./support/tempDir.ts"

it.live(
  "imports a medium family of long branches with many swipes",
  () => {
    const root = tempDir("st-branch-family")
    const big = process.env.ST_FAMILY_SIZE === "big" || process.env.ST_FAMILY_SIZE === "mix"
    const mix = process.env.ST_FAMILY_SIZE === "mix"
    const branches = Number(process.env.ST_FAMILY_BRANCHES ?? (big ? 300 : 100))
    const messages = Number(process.env.ST_FAMILY_MESSAGES ?? (big ? 3000 : 2000))
    const families = Array.from({ length: mix ? 3 : 1 }, (_, i) =>
      writeStBranchFamily(root, {
        branches,
        messages,
        name: i === 0 ? "Alice" : `Family ${i}`,
        seed: 12345 + i
      })
    )
    let bytes = families.reduce((n, f) => n + f.bytes, 0)
    let files = families.reduce((n, f) => n + f.files.length, 0)
    const put = (path: string, data: Uint8Array) => {
      mkdirSync(join(root, path, ".."), { recursive: true })
      writeFileSync(join(root, path), data)
      bytes += data.byteLength
      files++
    }
    put("settings.json", encode({ personas: {}, persona_descriptions: {} }))
    for (let i = 0; i < (mix ? 500 : 1); i++) {
      const name = i === 0 ? "Alice" : i < 3 && mix ? `Family ${i}` : `Card ${i}`
      put(`characters/${name}.png`, card(name, "Hello.", {}, { description: "A synthetic traveler. ".repeat(100) }))
    }
    if (mix) for (let i = 0; i < 100; i++) put(`chats/Alice/ordinary-${i}.jsonl`, largeChat(300))
    const fixture = {
      branches,
      messages,
      files,
      bytes,
      messageLines: families.reduce((n, f) => n + f.messageLines, 0) + (mix ? 30_000 : 0),
      uniqueMessages: families.reduce((n, f) => n + f.uniqueMessages, 0) + (mix ? 30_000 : 0),
      uniqueVersions: families.reduce((n, f) => n + f.uniqueVersions, 0) + (mix ? 40_000 : 0)
    }
    console.log("ST_FAMILY_FIXTURE", JSON.stringify(fixture))
    if (process.env.ST_FAMILY_OUT) writeFileSync(process.env.ST_FAMILY_OUT + ".fixture", JSON.stringify(fixture))
    const config = testConfig()
    const started = performance.now()
    return Effect.gen(function* () {
      const api = yield* client()
      const imports = yield* StImports
      const builtin = imports.handlers.get("chat")!
      const fileTimes: Array<{ path: string; ms: number }> = []
      let fileStarted = 0
      yield* imports.handlers.register({
        id: "chat",
        run: (call) =>
          Effect.gen(function* () {
            if (call.request.part === 0) fileStarted = performance.now()
            const result = yield* builtin.run(call)
            if (call.request.last) fileTimes.push({ path: call.path, ms: performance.now() - fileStarted })
            return result
          })
      })
      const { importId } = yield* api.StartStPathImport({ path: root, prefix: "" })
      for (;;) {
        const detail = yield* api.GetStImport({ importId })
        if (detail.job.status !== "running") {
          const result = {
            ...fixture,
            seconds: (performance.now() - started) / 1000,
            fileTimes,
            status: detail.job.status,
            report: detail.report
          }
          console.log("ST_FAMILY_TIMING", JSON.stringify(result))
          if (process.env.ST_FAMILY_OUT) writeFileSync(process.env.ST_FAMILY_OUT, JSON.stringify(result))
          if (process.env.IMPORT_PROFILE_DIR) {
            const channel = new BroadcastChannel("import-profile")
            channel.postMessage("stop")
            channel.close()
            yield* Effect.sleep(2000)
          }
          assert.strictEqual(detail.job.status, "complete")
          assert.strictEqual(detail.job.filesDone, files)
          assert.strictEqual(detail.report!.messages, fixture.messageLines)
          assert.strictEqual(detail.report!.counts.chat?.added, families.length + (mix ? 100 : 0))
          assert.strictEqual(detail.report!.counts.chat?.updated, families.length * branches)
          assert.strictEqual(detail.report!.counts.chat?.failed, 0)
          const [stored] = yield* fixtureSql(
            config.dataDir,
            [
              {
                sql: "SELECT (SELECT count(*) FROM slots) AS messages, (SELECT count(*) FROM versions) AS versions, (SELECT count(*) FROM forks) AS forks"
              }
            ],
            { readOnly: true }
          )
          assert.strictEqual(stored![0]!.messages, fixture.uniqueMessages)
          assert.strictEqual(stored![0]!.versions, fixture.uniqueVersions)
          assert.strictEqual(stored![0]!.forks, families.reduce((n, f) => n + f.files.length, 0) + (mix ? 100 : 0))
          const average = (times: ReadonlyArray<{ ms: number }>) => times.reduce((n, f) => n + f.ms, 0) / times.length
          for (const family of families) {
            const paths = new Set(family.files.slice(1).map((f) => f.path))
            const times = fileTimes.filter((f) => paths.has(f.path))
            const quarter = Math.max(1, Math.floor(times.length / 4))
            assert.isBelow(average(times.slice(-quarter)), average(times.slice(0, quarter)) * 2.5 + 100)
          }
          assert.isBelow(result.seconds, big ? 1800 * families.length : 360)
          return
        }
        yield* Effect.sleep(100)
      }
    }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
  },
  // Three big families already have a 90-minute import budget, plus fixture setup.
  process.env.ST_FAMILY_SIZE === "mix" ? 7_200_000 : 3_600_000
)
