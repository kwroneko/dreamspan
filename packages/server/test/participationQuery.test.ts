import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Worker } from "node:worker_threads"
import { databaseFile } from "../src/db/connection.ts"
import { NewVersion } from "@rp/shared/chat.ts"
import * as Database from "../src/db/Database.ts"
import { shellSlotsQuery, shellTreeQuery } from "../src/db/shellQueries.ts"
import { testWorkers } from "./support/bundles.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { tempDir } from "./support/tempDir.ts"

it.live("shell evidence reads swipe identities without fetching each version record", () => {
  const dataDir = tempDir("participation-query")
  return Effect.gen(function* () {
    const writer = yield* Database.Writer
    const user = yield* writer.EnsureUser({ handle: "synthetic", displayName: "Synthetic" })
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const message = yield* writer.AppendMessage({
      userId: user.id,
      chatId: chat.id,
      parentSlotId: null,
      branch: false,
      commitDraft: null,
      version: new NewVersion({
        speakerEntityId: null,
        writer: "human",
        content: "Selected.",
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    })
    yield* fixtureSql(dataDir, [
      {
        sql: `INSERT INTO entities(id,owner_user_id,kind,created_at) VALUES('a',?,'card',1),('b',?,'card',1),('c',?,'card',1)`,
        params: [user.id, user.id, user.id]
      },
      {
        sql: `INSERT INTO version_records(id,slot_id,ordinal,status,writer,speaker_entity_id,content,macro_mode,origin,created_at,updated_at,purged_at,authoring_fork_id)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
        SELECT 'swipe-'||i,?,i,'complete',CASE WHEN i%10=0 THEN 'human' ELSE 'model' END,
          CASE WHEN i=50 THEN 'c' WHEN i%10=0 THEN 'a' ELSE 'b' END,'Synthetic alternative','verbatim',
          CASE WHEN i%20=0 THEN 'edited' ELSE 'generated' END,42,42,CASE WHEN i=50 THEN 43 END,? FROM n`,
        params: [message.slotId, chat.id]
      }
    ])
    const [schemaRows] = yield* fixtureSql(
      dataDir,
      [{ sql: "SELECT name, rootpage FROM sqlite_schema WHERE name IN ('versions','slots')" }],
      { readOnly: true }
    )
    for (const query of [shellTreeQuery, shellSlotsQuery]) {
      const [rows, instructions, plan] = yield* fixtureSql(
        dataDir,
        [
          { sql: query, params: [JSON.stringify([chat.id])] },
          { sql: `EXPLAIN ${query}`, params: [JSON.stringify([chat.id])] },
          { sql: `EXPLAIN QUERY PLAN ${query}`, params: [JSON.stringify([chat.id])] }
        ],
        { readOnly: true }
      )
      assert.lengthOf(rows!, 1)
      assert.isTrue(plan!.some((row) => /^SEARCH s USING COVERING INDEX/.test(String(row.detail))))
      const row = rows![0]!
      assert.deepStrictEqual(
        JSON.parse(String(row.participants)),
        ["b", "a"],
        "unselected swipes count; purged ones do not"
      )
      const authors = JSON.parse(String(row.human_authors)) as Array<{ entity: string; at: number }>
      assert.lengthOf(authors, 4)
      assert.deepStrictEqual(
        authors,
        [
          { entity: "a", at: 42 },
          { entity: "a", at: row.created_at },
          { entity: "a", at: 42 },
          { entity: "a", at: row.created_at }
        ],
        "authorship retains alternative order even when ids sort differently"
      )
      assert.lengthOf(
        authors.filter((author) => author.at === 42),
        2
      )
      assert.lengthOf(
        authors.filter((author) => author.at === row.created_at),
        2,
        "edits retain the slot's authoring time"
      )
      // Selected metadata and evidence must use only index pages,
      // independent of how many alternatives (or payload pages) that slot has.
      assert.lengthOf(
        instructions!.filter(
          (op) => op.opcode === "OpenRead" && op.p2 === schemaRows!.find((row) => row.name === "versions")!.rootpage
        ),
        0
      )
      if (query === shellTreeQuery)
        assert.lengthOf(
          instructions!.filter(
            (op) => op.opcode === "OpenRead" && op.p2 === schemaRows!.find((row) => row.name === "slots")!.rootpage
          ),
          0
        )
    }
    const outline = yield* Effect.promise(
      () =>
        new Promise<{ actual: unknown; expected: unknown; queries: string[] }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/outlineProbeWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(dataDir), userId: user.id, chatId: chat.id }
          })
          let result: { actual: unknown; expected: unknown; queries: string[] } | undefined
          worker.once("message", (value) => {
            result = value
          })
          worker.once("error", reject)
          worker.once("exit", (code) =>
            code === 0 && result ? resolve(result) : reject(new Error(`outline probe exited ${code}`))
          )
        })
    )
    assert.deepStrictEqual(outline.actual, outline.expected, "preview/split/thread bytes match the full projection")
    assert.isTrue(outline.queries.some((query) => query.includes("FROM segments g")))
    assert.isFalse(
      outline.queries.some((query) => query.includes("version_participants")),
      "split reads must not scan swipe participation"
    )
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})
