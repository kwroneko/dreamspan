import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import type { BinItem } from "@rp/shared/bin.ts"
import type { PathWindow } from "@rp/shared/chatApi.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { Reader } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

// Re-importing a shared-prefix selection keeps the existing suffix and its bin items.

type Api = Effect.Success<ReturnType<typeof importStFolder>>["api"]

const scenario = (dataDir: string, remove: (api: Api, child: PathWindow) => Effect.Effect<BinItem, unknown>) =>
  Effect.gen(function* () {
    const main = Array.from({ length: 10 }, (_, i) =>
      message({
        name: i % 2 ? "Sam" : "Alice",
        user: !!(i % 2),
        mes: `parent ${i}`,
        minute: i,
        ...(!(i % 2) ? { swipes: [`parent ${i}`] } : {})
      })
    )
    const child = main.map((m, i) =>
      i < 5 ? m : { ...m, mes: `child ${i}`, ...(m.swipes ? { swipes: [`child ${i}`, `other ${i}`] } : {}) }
    )
    const files = new Map([
      ["characters/Alice.png", card("Alice", "Synthetic greeting")],
      ["chats/Alice/main.jsonl", jsonl([header({}), ...main])],
      ["chats/Alice/child.jsonl", jsonl([header({ main_chat: "main" }), ...child])]
    ])
    const { api } = yield* importStFolder(files)
    const chat = (yield* api.ListChats({ limit: 100, before: null }))[0]!
    const user = yield* api.Whoami()
    const reader = yield* Reader
    const record = () =>
      reader
        .StImportSources({ userId: user.id })
        .pipe(Effect.map((s) => s.chats.find((r) => r.source === "chats/Alice/child.jsonl")!))
    const childPath = (end: string) =>
      Effect.flatMap(record(), (r) =>
        api.ReadPath({
          chatId: chat.id,
          forkId: r.forkId,
          leafSlotId: end as never,
          range: { _tag: "Bottom" },
          limit: 100
        })
      )
    const before = yield* childPath((yield* record()).end!)
    const item = yield* remove(api, before)
    // ST selects a new swipe on a message the two files share: only the child's selection changes.
    const m = child[4]!
    const at = "2025-01-02T10:04:00.000Z"
    child[4] = {
      ...m,
      mes: "Only the child chose this",
      send_date: at,
      swipe_id: 1,
      swipes: [...m.swipes!, "Only the child chose this"],
      swipe_info: [...m.swipe_info!, { send_date: at, extra: {} }]
    }
    yield* importStFolder(
      new Map([
        ["characters/Alice.png", files.get("characters/Alice.png")!],
        ["chats/Alice/child.jsonl", jsonl([header({ main_chat: "main" }), ...child])]
      ])
    )
    const rows = (sql: string) => fixtureSql(dataDir, [{ sql, params: [item.id] }], { readOnly: true })
    return { api, item, before, record, childPath, rows }
  })

// Purging keeps slots and versions as placeholders with their bin item ids.
const modelText = `SELECT v.slot_id, v.content, v.purged_at FROM version_records v JOIN slots s ON s.id = v.slot_id
  WHERE (s.bin_item_id = ?1 OR v.bin_item_id = ?1) AND v.writer = 'model'`

/**
 * The child file's line goes as a fork: an import doesn't make forks yet (unit 9 of
 * spec/FORK-INDEPENDENCE-DELTA.md), so opening the line through its first own message makes one, and
 * deleting it deletes the messages of it that no other fork shows.
 */
const deleteChildFork = (api: Api, child: PathWindow) =>
  Effect.gen(function* () {
    const chat = (yield* api.ListChats({ limit: 100, before: null }))[0]!
    const own = child.entries[5]!
    const opened = yield* api.SwitchBranch({ chatId: chat.id, slotId: own.slotId, index: own.branchIndex })
    return yield* api.DeleteFork({ forkId: opened.fork.id })
  })

const deleteForGood = (name: string, remove: Parameters<typeof scenario>[1]) => {
  const config = testConfig()
  layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(name, (it) => {
    it.effect("deleting it for good empties the retained versions without making copies", () =>
      Effect.gen(function* () {
        const { api, item, rows } = yield* scenario(config.dataDir, remove)
        const [copies] = yield* rows(modelText)
        assert.strictEqual(new Set(copies!.map((row) => row.slot_id)).size, 1)
        yield* api.PurgeBinItem({ itemId: item.id })
        const [after] = yield* rows(modelText)
        assert.strictEqual(after!.length, copies!.length)
        for (const row of after!) {
          assert.strictEqual(row.content, "")
          assert.isNotNull(row.purged_at)
        }
      })
    )
  })
}

deleteForGood("ST fork copies a deleted model message", (api, child) =>
  api.DeleteMessage({ slotId: child.entries[6]!.slotId })
)

deleteForGood("ST fork copies a deleted model swipe", (api, child) =>
  api
    .ListVersions({ slotId: child.entries[8]!.slotId })
    .pipe(
      Effect.flatMap((versions) => api.DeleteVersion({ versionId: versions.find((v) => v.content === "other 8")!.id }))
    )
)

const config = testConfig()
layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST fork copies a deleted branch",
  (it) => {
    it.effect("restoring it brings back the retained path", () =>
      Effect.gen(function* () {
        const { api, item, record, childPath, rows } = yield* scenario(config.dataDir, deleteChildFork)
        const [roots] = yield* rows(`SELECT id FROM slots WHERE bin_item_id = ? AND branch_deleted = 1`)
        assert.strictEqual(roots!.length, 1)
        yield* api.RestoreBinItem({ itemId: item.id })
        const [marked] = yield* fixtureSql(
          config.dataDir,
          [{ sql: `SELECT count(*) AS n FROM slots WHERE branch_deleted = 1 OR deleted_at IS NOT NULL`, params: [] }],
          { readOnly: true }
        )
        assert.strictEqual(marked![0]!.n, 0)
        const after = yield* childPath((yield* record()).end!)
        assert.deepStrictEqual(
          after.entries.map((e) => e.version.content),
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (i < 5 ? `parent ${i}` : `child ${i}`))
        )
      })
    )
  }
)
