import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Chat, EntityId } from "@rp/shared/chat.ts"
import { CHAT_SORTS, type ChatBrowse } from "@rp/shared/chatBrowse.ts"
import { Generator } from "../src/chat/Generator.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

describe("Chats tab server browse", () => {
  it.live("filters and counts chats, sorts before paging with stable id ties, and reads the current path", () => {
    const config = testConfig({ dbWorkers: "bundle" })
    return Effect.gen(function* () {
      const api = yield* client()
      const aria = yield* api.CreateCard({ label: "Aria", name: "Aria" })
      const bryn = yield* api.CreateCard({ label: "Bryn", name: "Bryn" })
      const make = Effect.fnUntraced(function* (title: string, cards: ReadonlyArray<EntityId>, messages: number) {
        let chat = yield* api.CreateChat({ title })
        for (const entityId of cards)
          yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId } })
        for (let i = 0; i < messages; i++) {
          yield* posted(
            api.SendMessage({
              chatId: chat.id,
              parentSlotId: chat.activeLeafSlotId,
              branch: false,
              content: "Synthetic.",
              reply: false
            })
          )
          chat = yield* api.GetChat({ chatId: chat.id })
        }
        return chat
      })
      const a = yield* make("Zulu", [aria.entityId, bryn.entityId], 3)
      const b = yield* make("Alpha", [aria.entityId], 2)
      const c = yield* make("Alpha", [aria.entityId], 2)
      const d = yield* make("Empty", [], 0)
      // Pin the original, then make a shorter current branch: Messages must use this path.
      yield* api.SetChatPin({ chatId: a.id, forkId: a.currentForkId!, leaf: a.activeLeafSlotId, pinned: true })
      const path = yield* api.ReadPath({
        chatId: a.id,
        leafSlotId: a.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 10
      })
      const branch = yield* api.CreateFork({
        chatId: a.id,
        fromForkId: null,
        atSlotId: path.entries[0]!.slotId,
        name: "Short"
      })
      // Historical timestamps, with ties; an empty chat falls back to its start date.
      yield* fixtureSql(
        config.dataDir,
        [a, b, c, d].flatMap((chat, i) => [
          { sql: "UPDATE chats SET created_at = ? WHERE id = ?", params: [[100, 200, 200, 50][i]!, chat.id] },
          { sql: "UPDATE slots SET created_at = ? WHERE chat_id = ?", params: [[400, 300, 300, 50][i]!, chat.id] },
          {
            sql: "UPDATE forks SET last_chatted_at = ? WHERE chat_id = ?",
            params: [[400, 300, 300, null][i]!, chat.id]
          },
          {
            sql: "UPDATE versions SET created_at = ?, updated_at = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
            params: [[400, 300, 300, 50][i]!, [400, 300, 300, 50][i]!, chat.id]
          }
        ])
      )
      // Its current path ends earlier than the other chats; Recent still sees the original's later message.
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE slots SET created_at = 150 WHERE chat_id = ? AND depth = 0", params: [a.id] },
        {
          sql: "UPDATE versions SET created_at = 150, updated_at = 150 WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ? AND depth = 0)",
          params: [a.id]
        }
      ])
      const view = {
        entity: null,
        chat: null,
        search: "",
        sort: "recent" as const,
        sections: [{ id: "chats" as const, limit: 10 }]
      }
      const list = (browse: ChatBrowse, extra: Partial<typeof view> = {}) =>
        api.GetShellForks({ ...view, browse, ...extra })
      const ids = (chats: ReadonlyArray<Chat>) => chats.map((chat) => chat.id)
      const ties = [b, c].sort((x, y) => x.id.localeCompare(y.id))
      const expected: Record<ChatBrowse["sort"], ReadonlyArray<Chat>> = {
        recent: [a, ...ties, d],
        started: [...ties, a, d],
        name: [...ties, d, a],
        messages: [...ties, a, d],
        branches: [a, ...[b, c, d].sort((x, y) => x.id.localeCompare(y.id))]
      }
      for (const sort of CHAT_SORTS)
        for (const reversed of [false, true]) {
          // Reverse each metric group, keeping equal metrics in id order in both directions.
          const want = reversed
            ? sort === "branches"
              ? [...expected.branches.slice(1), a]
              : sort === "name"
                ? [a, d, ...ties]
                : sort === "started" || sort === "messages"
                  ? [d, a, ...ties]
                  : [d, ...ties, a]
            : expected[sort]
          const result = yield* list({ filter: "all", sort, reversed })
          assert.deepStrictEqual(
            result.sections[0]!.rows.map((f) => f.chat.id),
            ids(want),
            `${sort}, reversed=${reversed}`
          )
          const page = yield* list({ filter: "all", sort, reversed }, { sections: [{ id: "chats", limit: 1 }] })
          assert.strictEqual(page.sections[0]!.total, 4)
          assert.deepStrictEqual(
            page.sections[0]!.rows.map((f) => f.chat.id),
            ids(want.slice(0, 1))
          )
        }
      const filters = { all: [a, b, c, d], pinned: [a], groups: [a], solo: [b, c], branches: [a] } as const
      for (const filter of Object.keys(filters) as Array<ChatBrowse["filter"]>) {
        const result = yield* list({ filter, sort: "recent", reversed: false })
        assert.deepStrictEqual(result.sections[0]!.rows.map((f) => f.chat.id).sort(), ids(filters[filter]).sort())
        assert.deepStrictEqual(result.filterCounts, { all: 4, pinned: 1, groups: 1, solo: 2, branches: 1 })
      }
      const row = (yield* list({ filter: "branches", sort: "messages", reversed: false })).sections[0]!.rows[0]!
      assert.strictEqual(row.messages, 1)
      assert.strictEqual(row.forkId, branch.fork.id)
      const found = yield* list({ filter: "solo", sort: "name", reversed: false }, { search: "alpha" })
      assert.strictEqual(found.sections[0]!.total, 2)
      assert.strictEqual(found.filterCounts.all, 4)
      const pins = yield* api.GetShellForks({
        ...view,
        browse: { filter: "solo", sort: "name", reversed: true },
        sections: [{ id: "pinned", limit: 10 }]
      })
      assert.strictEqual(pins.sections[0]!.total, 0)
      // A write invalidates the kept reader state; the non-current branch's pin is counted once.
      yield* api.SetChatPin({ chatId: a.id, forkId: a.currentForkId!, leaf: a.activeLeafSlotId, pinned: false })
      assert.strictEqual((yield* list({ filter: "pinned", sort: "recent", reversed: false })).filterCounts.pinned, 0)
      const scoped = yield* api.GetShellForks({
        ...view,
        entity: aria.entityId,
        browse: { filter: "groups", sort: "started", reversed: false },
        sections: [
          { id: "with", limit: 10 },
          { id: "just", limit: 10 }
        ]
      })
      assert.strictEqual(scoped.filterCounts.all, 3)
      assert.deepStrictEqual(
        scoped.sections.flatMap((s) => s.rows.map((f) => f.chat.id)),
        [a.id]
      )
      // Keep the existing Recent behavior: Branch from here is activity even before a new message.
      const newest = yield* api.CreateFork({ chatId: b.id, fromForkId: null, atSlotId: b.activeLeafSlotId })
      const recent = (yield* list({ filter: "all", sort: "recent", reversed: false })).sections[0]!.rows
      assert.strictEqual(recent[0]!.chat.id, b.id)
      assert.strictEqual(recent[0]!.forkId, newest.fork.id)
      const oldest = (yield* list({ filter: "all", sort: "recent", reversed: true })).sections[0]!.rows
      assert.strictEqual(oldest.at(-1)!.chat.id, b.id)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})
