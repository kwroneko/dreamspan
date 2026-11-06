import { assert, it } from "@effect/vitest"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect } from "effect"

import { spawn } from "node:child_process"

import { Reader, Writer } from "../src/db/Database.ts"
import { Summarizer } from "../src/lcm/Summarizer.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { generateReply, eventually } from "./support/generation.ts"
import { startMockProvider, sse, completionChunks } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
// The config (and its data directory) is made inside the test: the test is tagged slow, so
// `npm test` loads this file without running it, and a directory made at load would outlive
// the file (tempDir removes its directories after the file's tests, and none run).
it.live(
  "lost claim acknowledgements recover after writer respawn without a second concurrent provider call",
  () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let summaries = 0,
        inFlight = 0,
        maxInFlight = 0
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((req, res) => {
            if (
              (req.body?.messages as Array<{ content: string }>)?.at(-1)?.content?.includes("Return only the summary")
            ) {
              summaries++
              inFlight++
              maxInFlight = Math.max(maxInFlight, inFlight)
              setTimeout(() => {
                inFlight--
                sse(res, completionChunks(["A clean synthetic summary."], {}))
              }, 750)
              return
            }
            sse(res, completionChunks(["A clean synthetic summary."], {}))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      let childOutput = ""
      const seeded = yield* Effect.scoped(
        Effect.gen(function* () {
          const api = yield* client(),
            user = yield* api.Whoami(),
            writer = yield* Writer,
            reader = yield* Reader
          const { chat } = yield* generateReply(api, {
            connection: { kind: "openai-chat", baseUrl: mock.url + "/v1", cacheTtlS: 1 },
            model: { context: 8192, maxOutput: 256 },
            preset: { openai_max_context: 8192, openai_max_tokens: 256 }
          })
          const path = yield* reader.GetPath({ userId: user.id, chatId: chat.id, leafSlotId: null, limit: 100 })
          const rows = path.entries.map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: 0 }))
          const jobs = yield* writer.EnqueueSummaries({
            userId: user.id,
            chatId: chat.id,
            leafSlotId: rows.at(-1)!.slotId,
            chunks: [{ inputs: rows, target: 100 }],
            requestClass: "idle"
          })
          yield* Effect.sleep(1600)
          const cold = yield* reader.CacheWarmth({ userId: user.id, chatId: chat.id })
          assert.isTrue(cold.warmth === null || (cold.warmth.expiresAt ?? 0) < Date.now() || cold.warmth.changed)
          const defaults = yield* api.GetGenerationDefaults()
          yield* api.SetGenerationDefaults({ defaults: { ...defaults, lcm: { spendAhead: false } } })
          // The chat copied "right after a reply" when it was made: it holds its own claims too.
          yield* api.ChangeLcmSettings({ chatId: chat.id, change: { when: "next-reply" } })
          return { chatId: chat.id, jobId: jobs[0]!.id, cold }
        }).pipe(Effect.provide(serverLayer(config, undefined, Summarizer.none)))
      )

      const start = () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const child = spawn(
              process.execPath,
              [
                "--no-wasm-code-gc",
                "--import",
                new URL("./support/claimFault.ts", import.meta.url).href,
                "packages/server/src/main.ts"
              ],
              {
                cwd: new URL("../../../", import.meta.url),
                env: {
                  ...process.env,
                  HOST: "127.0.0.1",
                  PORT: "0",
                  DATA_DIR: config.dataDir,
                  DB_READERS: "1",
                  DB_WORKERS: "source",
                  AUTH_MODE: "single",
                  CLIENT_DIST: config.clientDist
                },
                stdio: ["ignore", "pipe", "pipe"]
              }
            )
            for (const stream of [child.stdout, child.stderr])
              stream!.on("data", (b) => {
                childOutput += b.toString()
              })
            return child
          }),
          (child) =>
            Effect.promise(async () => {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM")
                await new Promise<void>((resolve) => child.once("exit", () => resolve()))
              }
            })
        )
      const inspect = () =>
        fixtureSql(config.dataDir, [
          {
            sql: "SELECT id,status,attempts,claim_epoch,rollout_id FROM summarization_jobs WHERE id=?",
            params: [seeded.jobId]
          },
          { sql: "SELECT id,status FROM summaries WHERE chat_id=?", params: [seeded.chatId] },
          {
            sql: "SELECT id,status,request_class FROM rollouts WHERE chat_id=? AND kind='summarize'",
            params: [seeded.chatId]
          }
        ])

      yield* Effect.scoped(
        Effect.gen(function* () {
          childOutput = ""
          const child = yield* start()
          yield* eventually(() => childOutput.includes("Listening on"), 60_000)
          yield* fixtureSql(config.dataDir, [
            { sql: "UPDATE settings SET value_json='{}' WHERE key='generation.lcm'" },
            {
              sql: `INSERT INTO state_events (id, chat_id, slot_id, version_id, seq, key, scope, value_json, origin, created_at)
                SELECT ?, ?, NULL, NULL, (SELECT max(seq) + 1 FROM state_events WHERE chat_id = ?2 AND slot_id IS NULL),
                  'lcm.settings', NULL, json_set(value_json, '$.when', 'after-reply'), 'user', 0
                FROM state_events WHERE chat_id = ?2 AND slot_id IS NULL AND key = 'lcm.settings' ORDER BY seq DESC LIMIT 1`,
              params: [uuidv7(), seeded.chatId]
            }
          ])
          let rows = yield* inspect()
          for (let i = 0; rows[0]![0]!.status !== "processing" && i < 200; i++) {
            yield* Effect.sleep(100)
            rows = yield* inspect()
          }
          assert.strictEqual(rows[0]![0]!.status, "processing")
          yield* Effect.sleep(6000)
          rows = yield* inspect()
          assert.strictEqual(child.exitCode, null)
          assert.strictEqual(child.signalCode, null)
          assert.include(childOutput, "database writer is back")
          assert.strictEqual(rows[0]![0]!.status, "complete")
          assert.lengthOf(rows[1]!, 1)
          assert.strictEqual(summaries, 1)
          assert.strictEqual(maxInFlight, 1)
          assert.strictEqual(rows[0]![0]!.attempts, 1)
          assert.strictEqual(rows[0]![0]!.claim_epoch, 2)
          assert.strictEqual(rows[2]![0]!.request_class, "background", "idle TTL is rechecked after restart")
        })
      )
    })
  },
  { timeout: 120_000, tags: ["slow"] }
)
