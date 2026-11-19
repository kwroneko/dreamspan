// Kill the writer after a batch has actually been written inside the final transaction.
// The only instrumentation is a test-bundle pause; production handlers and SQLite are used.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { ST_UNPLANNED_CHAT_MESSAGE } from "@dreamspan/shared/stReimportPlan.ts"
import { build } from "rolldown"
import { databaseFile } from "../src/db/connection.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { stImportGraph } from "./support/stImportGraph.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"

// Matched in the transaction (batches without a reader's plan), or applied from the plans the
// reader made: the pause follows the batches' writes in either.
const paths = [
  {
    planned: false,
    afterCommit: false,
    needle: "stepWriteProgress(progress, written, finish.prevEnd, finish.hiddenRun, [])"
  },
  { planned: true, afterCommit: false, needle: "const ref = planTipRef(payload)" },
  { planned: true, afterCommit: true, needle: "" }
]

for (const { planned, needle, afterCommit } of paths)
  it.effect(
    !planned
      ? "an unplanned confirmed file is refused without any writes; restart clears its abandoned stages"
      : afterCommit
        ? "a crash after commit retains the whole file; restart recomputes stale sidebar summaries"
        : `a killed final writer rolls back every batch${planned ? " it applies from the reader's plans" : ""}; restart removes abandoned stages`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const config = testConfig()
          const path = "chats/Alice/Crash.jsonl"
          const bytes = jsonl([
            header({}),
            ...Array.from({ length: 6 }, (_, i) =>
              message({
                name: i % 2 ? "Sam" : "Alice",
                user: i % 2 === 1,
                mes: `m${i}`,
                minute: i
              })
            )
          ])
          const input = yield* Effect.scoped(
            Effect.gen(function* () {
              const { api } = yield* importStFolder(
                new Map([
                  ["characters/Alice.png", card("Alice", "m0")],
                  [path, bytes]
                ])
              )
              const userId = (yield* api.Whoami()).id
              const chatId = (yield* api.ListChats({ limit: 10, before: null }))[0]!.id
              const reader = yield* Reader
              const record = (yield* reader.StImportSources({ userId })).chats.find((c) => c.source === path)!
              const stamp = (yield* reader.StImportPlanStamp({ userId }))[chatId]!
              const { importId: lease } = yield* api.StartStImport({ unsupported: [] })
              const writer = yield* Writer
              let prepared = {
                parent: null as { id: string; depth: number } | null,
                carry: null as Parameters<typeof reader.StImportPlanBatch>[0]["carry"],
                matching: true,
                digest: "",
                index: 0
              }
              for (let seq = 0; seq < 3; seq++) {
                const messages = Array.from({ length: 100 }, (_, j) => ({
                  user: (seq * 100 + j) % 2 === 1,
                  hidden: false,
                  speaker: null,
                  selected: 0,
                  versions: [
                    { content: `m${seq * 100 + j}`, reasoning: null, at: Date.UTC(2025, 0, 1, 10, seq * 100 + j) }
                  ]
                }))
                const messagesJson = JSON.stringify(messages)
                let plan: unknown
                if (planned) {
                  const made = yield* reader.StImportPlanBatch({
                    userId,
                    recordId: record.recordId,
                    branch: false,
                    ...prepared,
                    strict: false,
                    messagesJson,
                    firstIndex: prepared.index,
                    detailLimit: 0,
                    overlayJson: null,
                    virtualPrefix: "virtual:prepare:",
                    track: false,
                    plan: true
                  })
                  assert.isDefined(made.planJson)
                  plan = JSON.parse(made.planJson!)
                  prepared = {
                    parent: { id: made.cursor!.id, depth: made.cursor!.depth },
                    carry: made.carry,
                    matching: made.matching,
                    digest: made.digest,
                    index: prepared.index + messages.length
                  }
                }
                yield* writer.StImportStage({
                  userId,
                  lease,
                  path,
                  seq,
                  batchJson: JSON.stringify({ messagesJson, speakers: {}, ...(planned ? { plan } : {}) })
                })
              }
              const input = {
                userId,
                lease,
                path,
                chatId,
                stamp,
                claim: { recordId: record.recordId },
                start: null,
                batches: 3,
                advanceLeaf: false,
                strict: false,
                matching: true,
                finish: {
                  isNew: false,
                  branch: false,
                  prevEnd: record.end,
                  resumeAt: null,
                  hiddenRun: 0,
                  events: [],
                  notes: [],
                  previousNotes: {},
                  removedNotes: [],
                  lastMessageAt: null,
                  sha256: "synthetic",
                  stateJson: "null",
                  prevStateJson: "null",
                  fork: null,
                  stCurrent: false
                },
                slotsAt: [],
                expect: null
              }
              if (!planned) {
                const error = yield* writer.StImportCommitChat(input).pipe(Effect.flip)
                assert.strictEqual(error._tag, "StImportPlanChanged")
                assert.strictEqual(error.message, ST_UNPLANNED_CHAT_MESSAGE)
              }
              return input
            }).pipe(Effect.provide(serverLayer(config)))
          )
          const before = yield* stImportGraph(config.dataDir, input.chatId)
          if (!planned) {
            assert.strictEqual(new Set(before.map((row) => row.id)).size, 6)
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* client()
                const [staged] = yield* fixtureSql(
                  config.dataDir,
                  [{ sql: "SELECT count(*) AS n FROM st_import_stage" }],
                  { readOnly: true }
                )
                assert.strictEqual(staged![0]!.n, 0)
                assert.deepStrictEqual(yield* stImportGraph(config.dataDir, input.chatId), before)
              }).pipe(Effect.provide(serverLayer(config)))
            )
            return
          }
          const dir = tempDir("st-crash-writer")
          const entry = join(dir, "entry.mjs")
          const root = new URL("../src/", import.meta.url)
          writeFileSync(
            entry,
            `import { workerData, parentPort } from 'node:worker_threads';
      import { Effect } from ${JSON.stringify(new URL("../../../node_modules/effect/dist/index.js", import.meta.url).pathname)};
      import { writerConnection } from ${JSON.stringify(new URL("db/connection.ts", root).pathname)};
      import { makeStImportWriteHandlers } from ${JSON.stringify(new URL("db/stImportWrites.ts", root).pathname)};
      import { makeStImportPrefix } from ${JSON.stringify(new URL("db/stImportPrefix.ts", root).pathname)};
      Effect.runPromise(Effect.gen(function* () {
        const handlers = yield* makeStImportWriteHandlers(makeStImportPrefix());
        yield* handlers.StImportCommitChat(workerData.input);
        ${afterCommit ? "parentPort.postMessage('written-in-transaction'); Atomics.wait(workerData.gate, 0, 0);" : ""}
        throw new Error('commit escaped its pause');
      }).pipe(Effect.provide(writerConnection(workerData.dbPath))));`
          )
          const bundle = join(dir, "writer.mjs")
          let instrumented = false
          yield* Effect.promise(() =>
            build({
              input: entry,
              platform: "node",
              output: { file: bundle, format: "esm" },
              logLevel: "warn",
              plugins: [
                {
                  name: "pause-after-first-write",
                  transform(code, id) {
                    if (!id.endsWith("/db/stImportWrites.ts")) return
                    if (afterCommit) {
                      instrumented = true
                      return
                    }
                    assert.include(code, needle)
                    instrumented = true
                    return (
                      `import { parentPort as crashPort, workerData as crashData } from 'node:worker_threads';\n` +
                      code.replace(
                        needle,
                        needle + `; crashPort.postMessage('written-in-transaction'); Atomics.wait(crashData.gate, 0, 0)`
                      )
                    )
                  }
                }
              ]
            })
          )
          assert.isTrue(instrumented)
          const worker = new Worker(bundle, {
            workerData: { dbPath: databaseFile(config.dataDir), input, gate: new Int32Array(new SharedArrayBuffer(4)) }
          })
          yield* Effect.addFinalizer(() => Effect.promise(() => worker.terminate()))
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                worker.once("message", (value) =>
                  value === "written-in-transaction" ? resolve() : reject(new Error(String(value)))
                )
                worker.once("error", reject)
                worker.once("exit", (code) => reject(new Error(`writer exited before its first write: ${code}`)))
              })
          )
          yield* Effect.promise(() => worker.terminate())
          const committed = yield* stImportGraph(config.dataDir, input.chatId)
          if (afterCommit) assert.strictEqual(new Set(committed.map((row) => row.id)).size, 300)
          else assert.deepStrictEqual(committed, before)
          const [staged, integrity, foreign] = yield* fixtureSql(
            config.dataDir,
            [
              { sql: "SELECT count(*) AS n FROM st_import_stage" },
              { sql: "PRAGMA integrity_check" },
              { sql: "PRAGMA foreign_key_check" }
            ],
            { readOnly: true }
          )
          assert.strictEqual(staged![0]!.n, afterCommit ? 0 : 3)
          assert.strictEqual(integrity![0]!.integrity_check, "ok")
          assert.deepStrictEqual(foreign, [])
          yield* Effect.scoped(
            Effect.gen(function* () {
              const api = yield* client()
              const [staged] = yield* fixtureSql(
                config.dataDir,
                [{ sql: "SELECT count(*) AS n FROM st_import_stage" }],
                {
                  readOnly: true
                }
              )
              assert.strictEqual(staged![0]!.n, 0)
              assert.deepStrictEqual(yield* stImportGraph(config.dataDir, input.chatId), committed)
              if (afterCommit) {
                yield* api.GetShellLibrary()
                const reader = yield* Reader
                const cached = yield* reader.ShellLibrary({ userId: input.userId })
                const rebuilt = yield* reader.ShellLibrary({ userId: input.userId, recompute: true })
                assert.deepStrictEqual({ ...cached, fresh: [] }, { ...rebuilt, fresh: [] })
              }
            }).pipe(Effect.provide(serverLayer(config)))
          )
        })
      ),
    { timeout: 180_000 }
  )
