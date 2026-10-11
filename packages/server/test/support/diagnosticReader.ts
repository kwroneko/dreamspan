// Worker entry for diagnostics.ts: a reader connection serving DiagnosticOps.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { readerConnection, toStorageError } from "../../src/db/connection.ts"
import { DiagnosticOps } from "./diagnostics.ts"

const { dbPath } = workerData as { readonly dbPath: string }

RpcServer.layer(DiagnosticOps, { concurrency: 1 }).pipe(
  Layer.provide(
    DiagnosticOps.toLayer(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return DiagnosticOps.of({
          CountTo: ({ n }) =>
            sql<{ n: number }>`
              WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n})
              SELECT count(*) AS n FROM c`.pipe(
              Effect.map(([row]) => row?.n ?? 0),
              Effect.mapError(toStorageError("CountTo"))
            )
        })
      })
    )
  ),
  Layer.provide(readerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
