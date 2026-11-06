// Opt-in study: VERSION_FLAGS_STUDY=/storage/... through a check slot. No production reshape.
import { mkdirSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { it, assert } from "@effect/vitest"
import { Effect } from "effect"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import { Reader } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const study = process.env.VERSION_FLAGS_STUDY
const worker = (data: Record<string, unknown>) =>
  Effect.promise(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const worker = new Worker(new URL("./support/versionFlagsWorker.ts", import.meta.url), { workerData: data })
        let result: unknown
        worker.once("message", (message) => {
          result = message
        })
        worker.once("error", reject)
        worker.once("exit", (code) => (code === 0 ? resolve(result) : reject(new Error(`study worker exited ${code}`))))
      })
  )

if (!study) it.skip("version flag read costs (set VERSION_FLAGS_STUDY)", () => {})
else
  it.live(
    "compares short and realistic text on paths, shell summaries and assembly",
    () =>
      Effect.gen(function* () {
        mkdirSync(study, { recursive: true })
        const results: unknown[] = []
        for (const [messages, swipes] of [
          [2000, 20],
          [5000, 50]
        ] as const)
          for (const realistic of [false, true]) {
            const label = `${messages}-${swipes}-${realistic ? "realistic" : "short"}`
            const dataDir = join(study, label)
            mkdirSync(dataDir, { recursive: true })
            const config = testConfig({ dataDir })
            const result = yield* Effect.gen(function* () {
              const api = yield* client()
              const reader = yield* Reader
              const mock = yield* Effect.acquireRelease(
                Effect.promise(() => startMockProvider((_req, res) => sse(res, completionChunks(["Synthetic."], {})))),
                (m) => Effect.promise(() => m.close())
              )
              const generated = yield* generateReply(api, {
                connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
                model: { context: 32768 },
                preset: { openai_max_context: 32768 }
              })
              const chatId = generated.chat.id
              const forkId = generated.chat.currentForkId!
              const userId = (yield* api.Whoami()).id
              yield* api.SetLcmEnabled({ chatId, forkId, enabled: false })
              const tip = generated.events.findLast((e) => e._tag === "Slot")
              assert.isTrue(tip?._tag === "Slot")
              const parent = tip?._tag === "Slot" ? tip.entry.slotId : ""
              const args = { file: databaseFile(dataDir), chatId, forkId, parent, messages, swipes, realistic }
              const counts = yield* worker({ ...args, probe: false })
              const timings: Record<string, unknown> = {}
              const measure = Effect.fnUntraced(function* (name: string, run: Effect.Effect<unknown, unknown>) {
                const samples: number[] = []
                for (let i = 0; i < 6; i++) {
                  const at = performance.now()
                  yield* run
                  samples.push(performance.now() - at)
                }
                timings[name] = { firstMs: samples[0], warmMs: samples.slice(1).sort((a, b) => a - b)[2], samples }
              })
              yield* measure("GetPath-200", reader.GetPath({ userId, chatId, forkId, leafSlotId: null, limit: 200 }))
              yield* measure("ChatSummaries", reader.ChatSummaries({ userId, chatIds: [chatId] }))
              yield* measure(
                "AssembleContext",
                reader.AssembleContext({
                  userId,
                  chatId,
                  slotId: `study-s${messages - 1}` as SlotId,
                  versionId: `study-s${messages - 1}-v${swipes - 1}` as VersionId,
                  now: Date.now(),
                  timeZone: "UTC",
                  frozen: null
                })
              )
              const probes = yield* worker({ ...args, probe: true })
              return {
                label,
                messages,
                swipes,
                realistic,
                counts,
                bytes: statSync(databaseFile(dataDir)).size,
                timings,
                probes
              }
            }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
            results.push(result)
            writeFileSync(join(study, "results.json"), JSON.stringify(results, null, 2))
            console.log(JSON.stringify(result))
          }
      }),
    60 * 60_000
  )
