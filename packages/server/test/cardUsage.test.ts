// The home grid's read (DESIGN §2.1): every character card with the chats it joined, group
// chats included, the last message among them and the latest of them; personas, cards in the
// bin and chats in the bin left out; and a card's own chats through ListChats, those with a
// message first, and chats found by title or card name, page by page. It's one
// query for the whole grid, checked at 1,000 cards and 5,000 chats. Cross-user access is in
// the isolation matrix.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { type Chat, NewVersion } from "@rp/shared/chat.ts"
import { chatCursor } from "@rp/shared/chatApi.ts"
import type { CardDoc } from "@rp/shared/docs/card.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { writeRealisticStFolder } from "./support/stRealistic.ts"
import { importStFolder } from "./support/stUpload.ts"
import { tempDir } from "./support/tempDir.ts"
import { slowIt } from "./support/slow.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (api: Api, label: string, doc: Partial<CardDoc>, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label,
      subtitle: persona ? "" : "harbor",
      doc: cardDoc(label, { character_version: persona ? "" : "harbor", ...doc }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    if (persona) yield* writer.SetEntityTags({ userId: me.id as UserId, entityId, tags: ["persona"] })
    return entityId
  })

describe("card usage", () => {
  it.live("counts each card's chats, group chats included, and leaves out personas and the bin", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mira = yield* card(api, "Mira (harbor)", { nickname: "Mira", first_mes: "Hello." })
      const ana = yield* card(api, "Ana", { name: "Ana", first_mes: "Hi." })
      const ghost = yield* card(api, "Ghost", { name: "Ghost", first_mes: "Boo." })
      const fresh = yield* card(api, "Fresh", { nickname: "", first_mes: "New here." })
      const binned = yield* card(api, "Binned", { name: "Binned", first_mes: "Gone." })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const start = (cards: ReadonlyArray<typeof mira>) =>
        api.StartChat({
          cards,
          persona: sam,
          greeting: null,
          first: { _tag: "Send", content: "Hello.", speakerEntityId: sam }
        })

      const single = yield* start([mira])
      yield* Effect.sleep("5 millis")
      const group = yield* start([ana, mira])
      const gone = yield* start([ghost])
      yield* api.DeleteChat({ chatId: gone.chat.id })
      const me = yield* api.Whoami()
      yield* (yield* Writer).DeleteEntity({ userId: me.id as UserId, entityId: binned })

      const usage = yield* api.ListCardUsage()
      const by = new Map(usage.map((row) => [row.entityId as string, row]))
      assert.deepStrictEqual(
        usage.map((row) => row.label),
        ["Ana", "Fresh", "Ghost", "Mira (harbor)"]
      )
      assert.isFalse(by.has(sam), "personas aren't characters")
      assert.isFalse(by.has(binned), "cards in the bin aren't listed")

      const miraRow = by.get(mira)!
      assert.strictEqual(miraRow.chats, 2)
      assert.strictEqual(miraRow.latestChatId, group.chat.id)
      assert.strictEqual(miraRow.lastMessageAt, group.chat.lastMessageAt)
      assert.strictEqual(miraRow.name, "Mira (harbor)")
      assert.strictEqual(miraRow.modelName, "Mira")
      assert.strictEqual(miraRow.subtitle, "harbor")
      assert.strictEqual(by.get(ana)!.chats, 1)
      assert.strictEqual(by.get(ana)!.latestChatId, group.chat.id)
      // A chat in the bin doesn't count.
      assert.strictEqual(by.get(ghost)!.chats, 0)
      assert.isNull(by.get(ghost)!.latestChatId)
      assert.isNull(by.get(ghost)!.lastMessageAt)
      // An empty nickname falls back to the display name.
      assert.strictEqual(by.get(fresh)!.name, "Fresh")
      assert.strictEqual(by.get(fresh)!.chats, 0)

      // The card editor opens from the ref the grid names, at the head it names.
      const editor = yield* api.OpenEditor({ refId: miraRow.refId })
      assert.strictEqual(editor.ref.entityId, mira)
      assert.strictEqual(editor.ref.headRevisionId, miraRow.headRevisionId)

      // A card's chats, latest first.
      const page = { limit: 50, before: null }
      assert.deepStrictEqual(
        (yield* api.ListChats({ ...page, entityId: mira })).map((chat) => chat.id),
        [group.chat.id, single.chat.id]
      )
      assert.lengthOf(yield* api.ListChats({ ...page, entityId: ghost }), 0)
      assert.lengthOf(yield* api.ListChats(page), 2)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("continues a used chat and excludes casts with no authored version", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hi." })
      const used = yield* api.StartChat({
        cards: [mira],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "A conversation.", speakerEntityId: null }
      })
      yield* Effect.sleep("20 millis")
      const empty = yield* api.CreateChat({ title: "Empty, newly opened" })
      yield* api.ChangeCast({ chatId: empty.id, slotId: null, change: { _tag: "Join", entityId: mira } })
      const row = (yield* api.ListCardUsage()).find((c) => c.entityId === mira)!
      assert.strictEqual(row.lastMessageAt, used.chat.lastMessageAt)
      assert.strictEqual(row.latestChatId, used.chat.id)
      // The card's list agrees: chats with messages first, page by page.
      const first = yield* api.ListChats({ limit: 1, before: null, entityId: mira })
      assert.deepStrictEqual(
        first.map((chat) => chat.id),
        [used.chat.id]
      )
      const second = yield* api.ListChats({ limit: 1, before: chatCursor(first[0]!), entityId: mira })
      assert.lengthOf(second, 0)
      // The whole list stays by last message, else creation: the new chat first.
      assert.strictEqual((yield* api.ListChats({ limit: 1, before: null }))[0]!.id, empty.id)

      // Cast configuration alone establishes no historical connection.
      const ana = yield* card(api, "Ana", { name: "Ana", first_mes: "Hi." })
      const older = yield* api.CreateChat({ title: "Older" })
      yield* Effect.sleep("5 millis")
      const newer = yield* api.CreateChat({ title: "Newer" })
      for (const chat of [older, newer]) {
        yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: ana } })
      }
      const unused = (yield* api.ListCardUsage()).find((c) => c.entityId === ana)!
      assert.strictEqual(unused.chats, 0)
      assert.isNull(unused.latestChatId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("finds chats beyond the first page by title or by a card's name, page by page", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const mira = yield* card(api, "Mira (harbor)", { nickname: "Mirabel", first_mes: "Hi." })
      const made: Array<Chat["id"]> = []
      for (let i = 0; i < 5; i++) {
        made.push((yield* api.CreateChat({ title: `Night 100%_${i}` })).id)
        yield* Effect.sleep("2 millis")
      }
      const plain = yield* api.CreateChat({ title: "Unrelated" })
      yield* api.ChangeCast({ chatId: made[0]!, slotId: null, change: { _tag: "Join", entityId: mira } })
      yield* (yield* Writer).AppendMessage({
        userId: (yield* api.Whoami()).id as UserId,
        chatId: made[0]!,
        parentSlotId: null,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: "A turn.",
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      // By title, with LIKE's wildcards taken as text, in pages of two.
      const found: Array<Chat["id"]> = []
      let before: ReturnType<typeof chatCursor> | null = null
      for (;;) {
        const page: ReadonlyArray<Chat> = yield* api.ListChats({ limit: 2, before, search: "100%_" })
        found.push(...page.map((chat) => chat.id))
        if (page.length < 2) break
        before = chatCursor(page.at(-1)!)
      }
      assert.deepStrictEqual(found, [made[0], ...made.slice(1).reverse()])
      assert.lengthOf(yield* api.ListChats({ limit: 50, before: null, search: "100x" }), 0)
      // By the label or the in-chat name of a card in it, any case.
      for (const search of ["HARBOR", "mirabel"]) {
        assert.deepStrictEqual(
          (yield* api.ListChats({ limit: 50, before: null, search })).map((chat) => chat.id),
          [made[0]]
        )
      }
      assert.notInclude(
        (yield* api.ListChats({ limit: 50, before: null, search: "Night" })).map((chat) => chat.id),
        plain.id
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live(
    "counts a realistic ST folder's chats per character, group chats included",
    () =>
      Effect.gen(function* () {
        const root = tempDir("st-realistic")
        writeRealisticStFolder(root)
        const files = new Map(
          readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => {
              const path = join(entry.parentPath, entry.name)
              return [relative(root, path), new Uint8Array(readFileSync(path))] as const
            })
        )
        yield* importStFolder(files)
        const usage = yield* (yield* client()).ListCardUsage()
        const by = new Map(usage.map((card) => [card.name, card]))
        // Twelve characters; the three personas aren't among them.
        assert.lengthOf(usage, 12)
        assert.isFalse(by.has("Sam") || by.has("Kim") || by.has("Captain Rhee"))
        // Five chats of her own (a branch file is a branch of its chat, not a chat).
        assert.strictEqual(by.get("Karen Holt")!.chats, 5)
        // Three of her own, three at the Lantern Inn, one at the masquerade.
        assert.strictEqual(by.get("Aria Vance")!.chats, 7)
        assert.strictEqual(by.get("Fen")!.chats, 0)
        const chats = yield* (yield* client()).ListChats({
          limit: 50,
          before: null,
          entityId: by.get("Aria Vance")!.entityId
        })
        assert.lengthOf(chats, 7)
        assert.strictEqual(chats[0]!.id, by.get("Aria Vance")!.latestChatId)
        assert.strictEqual(chats[0]!.lastMessageAt, by.get("Aria Vance")!.lastMessageAt)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none))),
    120_000
  )

  slowIt.live("reads 1,000 cards and 5,000 chats in one query", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const me = yield* api.Whoami()
      const now = Date.now()
      // Written straight into the file: 5,000 chats through the RPCs would take minutes.
      const series = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${n - 1})`
      const doc = `json_object('name', 'Card ' || i, 'description', printf('%.4000c', 'x'), 'first_mes', 'Hello.')`
      yield* fixtureSql(config.dataDir, [
        {
          sql: `INSERT INTO entities (id, owner_user_id, kind, created_at) ${series(1000)}
            SELECT printf('e-%04d', i), ?, 'card', ? FROM n`,
          params: [me.id, now]
        },
        {
          sql: `INSERT INTO entity_revisions (id, entity_id, doc_json, doc_hash, schema_version, origin, created_at)
            ${series(1000)} SELECT printf('v-%04d', i), printf('e-%04d', i), ${doc}, 'h' || i, 1, 'import', ? FROM n`,
          params: [now]
        },
        {
          sql: `INSERT INTO entity_refs (id, entity_id, ref_kind, head_revision_id, label, created_at, updated_at)
            ${series(1000)} SELECT printf('r-%04d', i), printf('e-%04d', i), 'upstream', printf('v-%04d', i),
              'Card ' || i, ?, ? FROM n`,
          params: [now, now]
        },
        {
          sql: `INSERT INTO chats (id, owner_user_id, kind, status, title, created_at, last_message_at) ${series(5000)}
            SELECT printf('c-%05d', i), ?, 'rp', 'active', 'Chat ' || i, ?, ? + i FROM n`,
          params: [me.id, now, now]
        },
        // Two cards a chat, every third chat a group of three, and other settings around them.
        {
          sql: `INSERT INTO state_events (id, chat_id, seq, key, value_json, origin, created_at) ${series(5000)}
            SELECT printf('s-%05d-%d', i, k.k), printf('c-%05d', i), k.k,
              CASE WHEN k.k < 3 THEN 'participant.join' ELSE 'model.binding' END,
              CASE WHEN k.k < 3 THEN json_object('entity', printf('e-%04d', (i * (k.k + 1) * 7) % 800))
                ELSE json_object('connection', 'x', 'model', 'y') END,
              'import', ?
            FROM n JOIN (SELECT 0 AS k UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) k
            WHERE k.k <> 2 OR i % 3 = 0`,
          params: [now]
        },
        {
          sql: `INSERT INTO lanes (id, chat_id, name, created_at)
            SELECT 'lane-' || id, id, 'main', ? FROM chats`,
          params: [now]
        },
        {
          sql: `INSERT INTO versions (id, slot_id, ordinal, status, writer, macro_mode, origin, cast_json, created_at, updated_at)
            SELECT 'version-' || c.id, 'slot-' || c.id, 0, 'complete', 'human', 'verbatim', 'imported',
              (SELECT json_group_array(DISTINCT json_extract(e.value_json, '$.entity')) FROM state_events e
                WHERE e.chat_id = c.id AND e.key = 'participant.join'), ?, ? FROM chats c`,
          params: [now, now]
        },
        {
          sql: `INSERT INTO slots (id, chat_id, lane_id, depth, selected_version_id, created_at)
            SELECT 'slot-' || id, id, 'lane-' || id, 0, 'version-' || id, ? FROM chats`,
          params: [now]
        }
      ])
      // Warm the reader once (statement cache, page cache), then time it.
      const coldStart = performance.now()
      yield* api.ListCardUsage()
      const coldTook = performance.now() - coldStart
      assert.isBelow(coldTook, 2000, "the cold query must also seek participants before chats")
      const started = performance.now()
      const usage = yield* api.ListCardUsage()
      const took = performance.now() - started
      assert.lengthOf(usage, 1000)
      const used = usage.filter((row) => row.chats > 0)
      assert.lengthOf(used, 800)
      // Every chat named two or three cards: the counts add up to the joins.
      assert.strictEqual(
        used.reduce((sum, row) => sum + row.chats, 0),
        [...Array(5000).keys()].reduce((sum, i) => sum + distinctCards(i), 0)
      )
      console.log(`ListCardUsage: 1,000 cards, 5,000 chats in ${took.toFixed(0)} ms`)
      // Generous for a loaded shared host; one query takes tens of milliseconds.
      assert.isBelow(took, 2000)

      // The groups (two or three characters a chat, each chat titled apart): one read too.
      yield* api.ListChatGroups()
      const groupsStarted = performance.now()
      const groups = yield* api.ListChatGroups()
      const groupsTook = performance.now() - groupsStarted
      assert.strictEqual(
        groups.reduce((sum, group) => sum + group.chats, 0),
        [...Array(5000).keys()].filter((i) => distinctCards(i) >= 2).length
      )
      console.log(`ListChatGroups: 5,000 chats in ${groupsTook.toFixed(0)} ms`)
      assert.isBelow(groupsTook, 2000)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config, Generator.none)))
  })
})

/** The cards fixture chat `i` names, each once (the read counts distinct chats). */
const distinctCards = (i: number) =>
  new Set([0, 1, ...(i % 3 === 0 ? [2] : [])].map((k) => (i * (k + 1) * 7) % 800)).size
