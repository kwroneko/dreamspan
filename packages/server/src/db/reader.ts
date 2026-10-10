// Reader worker entry point. Each reader holds one read-only connection. Under WAL,
// readers never block the writer and the writer never blocks readers.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { readerConnection, toStorageError } from "./connection.ts"
import { ReadOps } from "./ops.ts"
import { timed } from "./timed.ts"
import { toUser, type UserRow } from "./rows.ts"

const Handlers = ReadOps.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return ReadOps.of({
      FindUserByHandle: ({ handle }) =>
        sql<UserRow>`SELECT * FROM users WHERE handle = ${handle}`.pipe(
          Effect.map(([row]) => (row ? toUser(row) : null)),
          Effect.mapError(toStorageError("FindUserByHandle")),
          timed("FindUserByHandle")
        ),
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

const { dbPath } = workerData as { readonly dbPath: string }

RpcServer.layer(ReadOps, { concurrency: 1 }).pipe(
  Layer.provide(Handlers),
  Layer.provide(readerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
