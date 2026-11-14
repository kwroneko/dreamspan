// A new branch's cast pin must preserve cached summaries of the other forks.
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { summaryValidSql } from "../src/db/forkSummaries.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder, sendStFile } from "./support/stUpload.ts"

const config = testConfig()
layer(serverLayer(config), { excludeTestServices: true })("ST branch summary validity", (it) => {
  it.effect(
    "retains older fork summaries when pinning a new branch, with identical cached and recomputed contents",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 120 }, (_, i) =>
          message({
            name: i % 2 ? "Sam" : "Alice",
            user: !!(i % 2),
            mes: `Synthetic ${i}`,
            minute: i
          })
        )
        const branch = (n: number) =>
          jsonl([
            header({ main_chat: "main" }),
            ...lines.slice(0, 100),
            message({ name: "Alice", mes: `Branch ${n}`, minute: 121 + n })
          ])
        const { api, importId } = yield* importStFolder(
          new Map([
            ["characters/Alice.png", card("Alice", "Hello.")],
            ["chats/Alice/main.jsonl", jsonl([header({}), ...lines])],
            ["chats/Alice/branch-1.jsonl", branch(1)]
          ])
        )
        const rows = () =>
          fixtureSql(
            config.dataDir,
            [
              {
                sql: `SELECT s.rowid AS row, s.fork_id, ${summaryValidSql("s", "c", "coalesce((SELECT stamp FROM shell_user_stamps WHERE user_id = c.owner_user_id), 0)")} AS valid
        FROM fork_summaries s JOIN chats c ON c.id = s.chat_id ORDER BY s.fork_id`
              }
            ],
            { readOnly: true }
          ).pipe(Effect.map(([r]) => r!))
        const before = yield* rows()
        assert.lengthOf(before, 2)
        assert.strictEqual((yield* sendStFile(importId, "chats/Alice/branch-2.jsonl", branch(2))).outcome, "updated")
        const after = yield* rows()
        assert.lengthOf(after, 3)
        for (const row of before) {
          assert.deepStrictEqual(
            after.find((r) => r.fork_id === row.fork_id),
            row
          )
          assert.strictEqual(row.valid, 1)
        }
        const reader = yield* Reader
        const userId = (yield* api.Whoami()).id
        const cached = yield* reader.ShellLibrary({ userId })
        const recomputed = yield* reader.ShellLibrary({ userId, recompute: true })
        assert.deepStrictEqual({ ...cached, fresh: [] }, { ...recomputed, fresh: [] })
      })
  )
})
