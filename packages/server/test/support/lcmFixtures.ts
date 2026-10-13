import { Worker } from "node:worker_threads"
import { Effect } from "effect"
import { uuidv7 } from "@rp/shared/id.ts"
import type { Summary } from "@rp/shared/lcm.ts"
import { databaseFile } from "../../src/db/connection.ts"
import type { Writer } from "../../src/db/Database.ts"

export const fixtureSql = (
  dataDir: string,
  statements: ReadonlyArray<{ sql: string; params?: ReadonlyArray<string | number | null> }>
) =>
  Effect.tryPromise(
    () =>
      new Promise<Array<Array<Record<string, unknown>>>>((resolve, reject) => {
        const worker = new Worker(new URL("./lcmFixtureWorker.ts", import.meta.url), {
          workerData: { dbPath: databaseFile(dataDir), statements }
        })
        worker.once("message", (result: { error?: string; results: Array<Array<Record<string, unknown>>> }) => {
          if (result.error) reject(new Error(result.error))
          else resolve(result.results)
        })
        worker.once("error", reject)
        worker.once("exit", (code) => {
          if (code !== 0) reject(new Error(`fixture worker exited ${code}`))
        })
      })
  )

export const summaryJob = (
  dataDir: string,
  chatId: string,
  firstSlotId: string,
  lastSlotId: string,
  children: ReadonlyArray<Summary> = []
) =>
  Effect.gen(function* () {
    const jobId = uuidv7(),
      rolloutId = uuidv7()
    const level = children.length ? Math.max(...children.map((s) => s.level)) + 1 : 1
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO summarization_jobs(id,chat_id,level,first_slot_id,last_slot_id,status,target_token_count,input_child_ids,created_at,updated_at) VALUES(?,?,?,?,?,'processing',600,?,1,1)",
        params: [
          jobId,
          chatId,
          level,
          firstSlotId,
          lastSlotId,
          children.length ? JSON.stringify(children.map((s) => s.id)) : null
        ]
      },
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES(?,?,?,'running','summarizer','background',1,1)",
        params: [rolloutId, chatId, level === 1 ? "summarize" : "condense"]
      }
    ])
    return { jobId, rolloutId }
  })

export const completeFixture = (
  dataDir: string,
  writer: Writer["Service"],
  userId: Parameters<Writer["Service"]["CompleteSummary"]>[0]["userId"],
  chatId: string,
  inputs: Summary["inputs"],
  children: ReadonlyArray<Summary> = []
) =>
  Effect.gen(function* () {
    const first = children[0]?.firstSlotId ?? inputs[0]!.slotId
    const last = children.at(-1)?.lastSlotId ?? inputs.at(-1)!.slotId
    const job = yield* summaryJob(dataDir, chatId, first, last, children)
    return yield* writer.CompleteSummary({
      userId,
      ...job,
      content: JSON.stringify(children.length ? children.map((s) => [s.id, s.revisionId]) : inputs),
      status: "complete",
      inputs,
      children: children.map((s) => ({ summaryId: s.id, revisionId: s.revisionId }))
    })
  })
