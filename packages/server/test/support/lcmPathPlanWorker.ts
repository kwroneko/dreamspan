// Compile and execute the real LCM path reader against the complete synthetic schema.
// The performance contract is an indexed override lookup, not a wall-clock budget.
import { parentPort } from "node:worker_threads"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { UserId } from "@rp/shared/domain.ts"
import { writerConnection } from "../../src/db/connection.ts"
import { migrations } from "../../src/db/migrations.ts"
import { lcmPath } from "../../src/db/lcmPath.ts"

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES ('u','synthetic','Synthetic','admin',1)`
        yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,created_at) VALUES ('c','u','rp','active',1)`
        for (const [id, slot, ordinal, content] of [
          ["v0", "s0", 0, "Original."],
          ["v1", "s0", 1, "Chosen."],
          ["vi", "si", 0, "Inserted."]
        ] as const)
          yield* sql`INSERT INTO version_records(id,slot_id,ordinal,status,writer,content,macro_mode,origin,created_at,updated_at,authoring_fork_id)
            VALUES (${id},${slot},${ordinal},'complete','human',${content},'verbatim','user_written',1,1,'c')`
        yield* sql`INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,fork_id,created_at)
          VALUES ('s0','c',NULL,0,'v0','c',1)`
        yield* sql`INSERT INTO slots(id,chat_id,parent_slot_id,depth,selected_version_id,fork_id,inserted,created_at)
          VALUES ('si','c','s0',1,'vi','c',1,1)`
        yield* sql`UPDATE forks SET tip_slot_id='s0' WHERE id='c'`
        yield* sql`INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,value_id)
          VALUES ('pick','c','c',1,'select','s0','s0',0,'v1')`
        yield* sql`INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,slot_id,slot_depth,flag)
          VALUES ('insert','c','c',2,'insert','si','s0',0,1)`
      })
    )
    const plans: Array<ReadonlyArray<{ detail: string }>> = []
    const inspected = new Proxy(sql, {
      apply(target, self, args) {
        const statement = Reflect.apply(target, self, args) as ReturnType<typeof sql.unsafe>
        const [query, bindings] = statement.compile()
        if (!query.trimStart().startsWith("WITH ") || !query.includes(" AS versionId")) return statement
        return statement.pipe(
          Effect.tap(() =>
            sql
              .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, bindings)
              .pipe(Effect.tap((rows) => Effect.sync(() => plans.push(rows))))
          )
        )
      }
    })
    const rows = yield* lcmPath(inspected, "u" as UserId, "c", "si")
    return { rows, plans }
  }).pipe(Effect.provide(writerConnection(":memory:")), Effect.scoped)
)
parentPort!.postMessage(result)
