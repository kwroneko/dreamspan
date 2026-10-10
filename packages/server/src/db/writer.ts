// Writer worker entry point. Holds the only read-write connection to the database
// and serves WriteOps one at a time, each as one synchronous transaction.
import { workerData } from "node:worker_threads"
import { NodeRuntime, NodeWorkerRunner } from "@effect/platform-node"
import { uuidv7 } from "@rp/shared/id.ts"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/rpc"
import { SqlClient } from "effect/sql"
import { toStorageError, writerConnection } from "./connection.ts"
import { Migrations } from "./migrations.ts"
import { WriteOps } from "./ops.ts"
import { toUser, type UserRow } from "./rows.ts"
import { timed } from "./timed.ts"

const Handlers = WriteOps.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return WriteOps.of({
      Ready: () => Effect.void,
      EnsureUser: ({ handle, displayName }) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const [existing] = yield* sql<UserRow>`SELECT * FROM users WHERE handle = ${handle}`
              if (existing) return toUser(existing)
              // The first user of an instance administers it.
              const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM users`
              const [row] = yield* sql<UserRow>`INSERT INTO users ${sql.insert({
                id: uuidv7(),
                handle,
                display_name: displayName,
                role: count?.n === 0 ? "admin" : "user",
                created_at: Date.now()
              })} RETURNING *`
              return toUser(row!)
            })
          )
          .pipe(Effect.mapError(toStorageError("EnsureUser")), timed("EnsureUser"))
    })
  })
)

const { dbPath } = workerData as { readonly dbPath: string }

RpcServer.layer(WriteOps, { concurrency: 1 }).pipe(
  Layer.provide(Handlers),
  Layer.provide(Migrations),
  Layer.provide(writerConnection(dbPath)),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
  Layer.launch,
  NodeRuntime.runMain
)
