// ST re-import and forks: a fork that ended where an ST file ended follows the file when a
// re-import appends to it, though another fork is current, so the new messages are on its
// path: switching to that branch shows them, as the switcher did before forks by opening
// the branch on its newest replies.
import { DatabaseSync } from "node:sqlite"
import { assert, layer } from "@effect/vitest"
import type { ChatId, ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { databaseFile } from "../src/db/connection.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"

const config = testConfig()
const jsonl = (...lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))
const message = (mes: string, n: number) => ({
  name: n % 2 ? "User" : "Bot",
  is_user: n % 2 === 1,
  mes,
  send_date: 1_730_000_000_000 + n
})
const query = (sql: string, ...args: Array<string | number>) => {
  const db = new DatabaseSync(databaseFile(config.dataDir), { readOnly: true })
  try {
    return db.prepare(sql).all(...args)
  } finally {
    db.close()
  }
}
const slotOf = (text: string) =>
  query(
    `SELECT s.id, s.chat_id FROM slots s JOIN versions v ON v.slot_id = s.id WHERE v.content = ? AND v.ordinal = 0`,
    text
  )[0] as { id: SlotId; chat_id: ChatId }

const DATE = "2026-3-14@09h26m53s589ms"
const importRun = (files: ReadonlyArray<readonly [string, Uint8Array]>) =>
  Effect.gen(function* () {
    const api = yield* client()
    const { importId } = yield* api.StartStImport({ unsupported: [] })
    for (const [path, bytes] of files) yield* sendStFile(importId, path, bytes, { card: "none" })
    return yield* api.GetStImportReport({ importId })
  })
const files = (extra: number) => {
  const parent = `Bot - ${DATE}`
  const lines = [message("greeting", 0), message("hello", 1), message("main", 2)]
  const own = [message("own", 2), message("own reply", 3)]
  for (let i = 0; i < extra; i++) own.push(message(`later ${i}`, 4 + i))
  return [
    [`chats/Bot/${parent}.jsonl`, jsonl({ chat_metadata: {} }, ...lines)],
    [
      `chats/Bot/Side road - ${DATE}.jsonl`,
      jsonl({ chat_metadata: { main_chat: parent } }, ...lines.slice(0, 2), ...own)
    ]
  ] as const
}

layer(serverLayer(config), { excludeTestServices: true, timeout: "180 seconds" })("fork re-import", (it) => {
  it.effect("a re-import that continues a branch shows its new messages on that branch", () =>
    Effect.gen(function* () {
      yield* importRun(files(0))
      const api = yield* client()
      const own = slotOf("own")
      const chatId = own.chat_id
      const last = (forkId: ForkId) =>
        Effect.map(
          api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 50 }),
          (w) => w.entries.at(-1)!.version.content
        )
      const branches = yield* api.ListBranches({ slotId: own.id })
      const index = branches.findIndex((b) => b.slotId === own.id)
      const opened = (yield* api.GetChat({ chatId })).currentForkId
      const side = (yield* api.SwitchBranch({ chatId, slotId: own.id, index })).fork.id
      assert.strictEqual(yield* last(side), "own reply")
      // Looking at a branch doesn't make it the one the chat opens on.
      assert.strictEqual((yield* api.GetChat({ chatId })).currentForkId, opened)

      yield* importRun(files(2))
      const again = (yield* api.SwitchBranch({ chatId, slotId: own.id, index })).fork.id
      assert.strictEqual(yield* last(again), "later 1")
    })
  )
})
