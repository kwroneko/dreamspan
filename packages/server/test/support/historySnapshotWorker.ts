// Scale-only helper: time the real StartRollout transaction in a worker, excluding startup,
// message transfer and context preparation. The server writer is idle during these calls.
import { parentPort, workerData } from "node:worker_threads"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../../src/db/connection.ts"
import { makeGenerationWriteHandlers } from "../../src/db/generationWrites.ts"
import { installStorageKindValidation } from "../../src/db/storageKinds.ts"
import { trackSummaryTouches } from "../../src/db/summaryValidity.ts"

type Start = Parameters<Effect.Success<typeof makeGenerationWriteHandlers>["StartRollout"]>[0]
const { dbPath, input, snapshots } = workerData as {
  dbPath: string
  input: Start
  snapshots: ReadonlyArray<{ label: string; snapshot: string }>
}

Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const samples: Array<{ label: string; bytes: number; ms: number }> = []
    let hold = 0
    const measured = new Proxy(sql, {
      get: (target, key, receiver) =>
        key === "withTransaction"
          ? <A, E, R>(body: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                const start = performance.now()
                return sql.withTransaction(body).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      hold = performance.now() - start
                    })
                  )
                )
              })
          : Reflect.get(target, key, receiver)
    })
    yield* Effect.gen(function* () {
      yield* installStorageKindValidation
      yield* trackSummaryTouches(measured)
      const handlers = yield* makeGenerationWriteHandlers
      for (let n = 0; n < 5; n++)
        for (const { label, snapshot } of snapshots) {
          yield* handlers.StartRollout({ ...input, rolloutId: uuidv7(), snapshot })
          samples.push({ label, bytes: Buffer.byteLength(snapshot), ms: hold })
        }
    }).pipe(Effect.provideService(SqlClient.SqlClient, measured))
    return samples
  }).pipe(Effect.scoped, Effect.provide(writerConnection(dbPath)))
).then(
  (samples) => parentPort!.postMessage({ samples }),
  (error) => {
    throw error
  }
)
