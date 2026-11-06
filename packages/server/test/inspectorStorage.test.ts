import { join } from "node:path"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import type { UserId } from "@rp/shared/domain.ts"
import type { VersionId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { writerConnection } from "../src/db/connection.ts"
import { migrations } from "../src/db/migrations.ts"
import { rolloutUsage } from "../src/db/inspectorReads.ts"
import { layer, Reader } from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { tempDir } from "./support/tempDir.ts"
import { testWorkers } from "./support/bundles.ts"

it.effect("the inspector query searches the rollout index before ordering its attempts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    const [text, params] = rolloutUsage(sql, "u" as UserId, "r").compile()
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params)
    assert.isTrue(
      plan.some((row) => row.detail.includes("llm_requests_rollout") && row.detail.includes("rollout_id=?")),
      JSON.stringify(plan)
    )
  }).pipe(Effect.provide(writerConnection(join(tempDir("inspector-plan"), "db.sqlite"))))
)

it.effect("a legacy version with a rollout but no snapshot has no Context link", () => {
  const dataDir = tempDir("inspector-legacy")
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
      yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('u','u','u','admin',1)`
      yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,created_at) VALUES('c','u','rp','active',1)`
      yield* sql`INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES('r','c','generation','completed','narrator','interactive',1,1)`
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,rollout_id,created_at,updated_at) VALUES('v','s',0,'complete','model','Synthetic reply','verbatim','generated',NULL,1,1)`
          yield* sql`INSERT INTO slots(id,chat_id,depth,selected_version_id,created_at) VALUES('s','c',0,'v',1)`
          yield* sql`UPDATE versions SET rollout_id = 'r' WHERE id = 'v'`
        })
      )
    }).pipe(Effect.provide(writerConnection(databaseFile(dataDir))))
    yield* Effect.gen(function* () {
      const reader = yield* Reader
      const version = yield* reader.GetVersion({ userId: "u" as UserId, versionId: "v" as VersionId })
      assert.isNull(version.context)
    }).pipe(Effect.provide(layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })))
  })
})
