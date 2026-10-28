// 0051: chats that never changed the summarization sizes they copied take the new built-ins;
// sizes the user set, in the chat or in the account default, stay (DESIGN §8). Synthetic chats.
import { assert, it } from "@effect/vitest"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { LCM_BUILTIN, LCM_OLD_BUILTIN_SIZES } from "@rp/shared/lcmSettings.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { writerConnection } from "../src/db/connection.ts"
import { lcmDefaultsMigration } from "../src/db/lcmDefaultsMigration.ts"
import { migrations } from "../src/db/migrations.ts"
import { tempDir } from "./support/tempDir.ts"

const copy = { enabled: true, withPreset: true, when: "after-reply", leafTarget: 600, ...LCM_OLD_BUILTIN_SIZES }

it.effect("0051 moves never-changed copies to the new sizes and keeps the user's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const previous = Object.fromEntries(Object.entries(migrations).filter(([key]) => key < "0051"))
    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previous) })
    for (const user of ["u", "v"])
      yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES(${user},${user},${user},'admin',1)`
    // v's account default sets the recent target; v's chat copied it from there.
    yield* sql`INSERT INTO user_settings(user_id,key,value_json) VALUES('v','generation.lcm','{"recentTarget":16000}')`
    let seq = 0
    const chat = (id: string, owner: string, ...history: ReadonlyArray<Record<string, unknown>>) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO chats(id,owner_user_id,kind,status,title,created_at) VALUES(${id},${owner},'rp','active',${id},1)`
        for (const value of history)
          yield* sql`INSERT INTO state_events(id,chat_id,seq,key,value_json,origin,created_at)
            VALUES(${`e${seq++}`},${id},${seq},'lcm.settings',${JSON.stringify(value)},'user',1)`
      })
    yield* chat("untouched", "u", copy)
    // Switched off later: still never changed a size.
    yield* chat("toggled", "u", copy, { ...copy, enabled: false })
    // The user set the recent maximum, and once set the summaries' target away and back.
    yield* chat(
      "changed",
      "u",
      copy,
      { ...copy, recentMax: 30_000 },
      { ...copy, recentMax: 30_000, layerTarget: 9000 },
      {
        ...copy,
        recentMax: 30_000
      }
    )
    // The user raised the recent target to 22,000 with the old maximum: the new maximum would be below it.
    yield* chat("tight", "u", copy, { ...copy, recentTarget: 22_000 })
    yield* chat("account", "v", copy)
    // Both of a pair set by the user stay; the other pair, never changed, follows.
    yield* chat("both", "u", copy, { ...copy, recentTarget: 10_000, recentMax: 15_000 })
    // The summaries' maximum set below the new target: the pair stays whole.
    yield* chat("squeezed", "u", copy, { ...copy, layerMax: 9000 })
    // An account default that sets both summary sizes: the chat's copies of them stay.
    yield* sql`INSERT INTO users(id,handle,display_name,role,created_at) VALUES('w','w','w','admin',1)`
    yield* sql`INSERT INTO user_settings(user_id,key,value_json) VALUES('w','generation.lcm','{"layerTarget":8000,"layerMax":12000}')`
    yield* chat("accountPair", "w", copy)
    yield* chat("old", "u", { enabled: true })

    yield* lcmDefaultsMigration
    const latest = (id: string) =>
      sql<{
        value_json: string
      }>`SELECT value_json FROM state_events WHERE chat_id = ${id} ORDER BY seq DESC LIMIT 1`.pipe(
        Effect.map(([row]) => JSON.parse(row!.value_json) as Record<string, unknown>)
      )
    const sizes = (s: Record<string, unknown>) => [s["recentTarget"], s["recentMax"], s["layerTarget"], s["layerMax"]]
    const builtin = [LCM_BUILTIN.recentTarget, LCM_BUILTIN.recentMax, LCM_BUILTIN.layerTarget, LCM_BUILTIN.layerMax]
    assert.deepStrictEqual(sizes(yield* latest("untouched")), builtin)
    assert.deepStrictEqual(yield* latest("toggled"), { ...copy, enabled: false, ...sizesOf(builtin) })
    assert.deepStrictEqual(sizes(yield* latest("changed")), [12_000, 30_000, 8000, 18_000])
    assert.deepStrictEqual(sizes(yield* latest("tight")), [22_000, 24_000, 14_000, 18_000])
    assert.deepStrictEqual(sizes(yield* latest("account")), [16_000, 20_000, 14_000, 18_000])
    assert.deepStrictEqual(sizes(yield* latest("both")), [10_000, 15_000, 14_000, 18_000])
    assert.deepStrictEqual(sizes(yield* latest("squeezed")), [12_000, 20_000, 8000, 9000])
    assert.deepStrictEqual(sizes(yield* latest("accountPair")), [12_000, 20_000, 8000, 12_000])
    assert.deepStrictEqual(yield* latest("old"), { enabled: true })

    // Run again, it changes nothing.
    const [count] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM state_events`
    yield* lcmDefaultsMigration
    assert.deepStrictEqual(yield* sql`SELECT count(*) AS n FROM state_events`, [{ n: count!.n }])
  }).pipe(Effect.provide(writerConnection(join(tempDir("lcm-defaults-migration"), "db.sqlite"))))
)

const sizesOf = ([recentTarget, recentMax, layerTarget, layerMax]: ReadonlyArray<number>) => ({
  recentTarget,
  recentMax,
  layerTarget,
  layerMax
})
