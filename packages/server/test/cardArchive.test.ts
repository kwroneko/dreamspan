import { newCardDoc } from "@rp/shared/editing.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { archiveCandidatesParams, archiveCandidatesSql } from "../src/db/cardArchive.ts"
import { client, testConfig, withServer } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

describe("card archive", () => {
  it.live("reads revision activity through a covering index without visiting card documents", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const userId = (yield* api.Whoami()).id
      const [plan] = yield* fixtureSql(
        config.dataDir,
        [
          {
            sql: `EXPLAIN QUERY PLAN ${archiveCandidatesSql}`,
            params: archiveCandidatesParams(userId)
          }
        ],
        { readOnly: true }
      )
      const details = plan!.map((row) => String(row.detail))
      assert.isTrue(details.some((detail) => /SEARCH er USING COVERING INDEX/.test(detail)))
      // "Only tried": the card's origin by its key, its participation by the card's.
      assert.isTrue(details.some((detail) => /SEARCH o USING INDEX sqlite_autoindex_card_origins_1/.test(detail)))
      assert.isFalse(
        details.some((detail) => /SCAN (o|p|v|s|c)\b/.test(detail)),
        details.join("\n")
      )
    }).pipe(Effect.scoped, withServer(config))
  })
  it.live("retains fork activity after the child is unlinked", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const parent = yield* api.CreateCard({ label: "Original explorer", name: "Original explorer" })
      const child = yield* api.ForkCard({
        refId: parent.id,
        name: "Independent explorer",
        nickname: "",
        characterVersion: ""
      })
      const old = Date.now() - 400 * 86400000
      yield* fixtureSql(config.dataDir, [{ sql: "UPDATE entity_refs SET created_at=?", params: [old] }])
      assert.lengthOf(yield* api.ListArchiveCandidates({ criteria: { never: 30 } }), 0)
      yield* api.SetCardParent({ entityId: child.entityId, parentEntityId: null })
      assert.lengthOf(yield* api.ListArchiveCandidates({ criteria: { never: 30 } }), 0)
      assert.lengthOf(yield* api.ListArchiveCandidates({ criteria: { inactive: 6 } }), 0)
    }).pipe(Effect.scoped, withServer(config))
  })
  it.live("counts messages, replies, saved edits and both sides of a fork, but not greetings or cast joins", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const cards: LibraryRef[] = []
      for (const name of [
        "Greeting",
        "Sent",
        "Reply",
        "Empty reply",
        "Imported greeting",
        "Edited",
        "Forked",
        "Joined",
        "Drafted"
      ]) {
        cards.push(yield* api.CreateCard({ label: name, name }))
      }
      const userId = (yield* api.Whoami()).id
      const old = Date.now() - 400 * 86400000
      const chat = yield* api.CreateChat({ title: "Synthetic usage evidence" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: cards[7]!.entityId } })
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE entity_refs SET created_at=?", params: [old] },
        {
          sql: "INSERT INTO drafts(id,user_id,target_kind,target_id,field,content,updated_at) VALUES('archive-draft',?,'entity_field',?,'description','Synthetic unsaved edit',?)",
          params: [userId, cards[8]!.id, Date.now()]
        },
        ...cards.slice(0, 5).flatMap((card, i) =>
          [
            {
              sql: "INSERT INTO slots(id,chat_id,depth,selected_version_id,created_at) VALUES(?,?,0,?,?)",
              params: [`usage-s-${i}`, chat.id, `usage-v-${i}`, old]
            },
            {
              sql: "INSERT INTO version_records(id,slot_id,ordinal,status,writer,macro_mode,origin,content,cast_json,created_at,updated_at, authoring_fork_id) VALUES(?,?,0,'complete',?,'verbatim',?,?,?, ?,?, ? )",
              params: [
                `usage-v-${i}`,
                `usage-s-${i}`,
                i === 1 ? "human" : "model",
                i === 0 ? "greeting" : i === 4 ? "imported" : i === 1 ? "user_written" : "generated",
                i === 3 ? "" : "Synthetic message",
                JSON.stringify([card.entityId]),
                old + 1,
                old + 1,
                chat.currentForkId!
              ]
            }
          ].reverse()
        )
      ])
      yield* api.RenameRef({
        refId: cards[5]!.id,
        label: "Edited recently",
        subtitle: "",
        expectedRowVersion: cards[5]!.rowVersion
      })
      const fork = yield* api.ForkCard({
        refId: cards[6]!.id,
        name: "Fork child",
        nickname: "Child",
        characterVersion: ""
      })
      const unused = yield* api.ListArchiveCandidates({ criteria: { never: 30 } })
      assert.deepStrictEqual(
        new Set(unused.map((c) => c.entityId)),
        new Set([cards[0]!, cards[3]!, cards[4]!, cards[7]!].map((c) => c.entityId))
      )
      const inactive = yield* api.ListArchiveCandidates({ criteria: { inactive: 6 } })
      assert.deepStrictEqual(
        new Set(inactive.map((c) => c.entityId)),
        new Set([cards[1]!.entityId, cards[2]!.entityId])
      )
      const all = yield* api.ListArchiveCandidates({ criteria: { never: 30, inactive: 1 } })
      assert.isFalse(all.some((c) => c.entityId === fork.entityId))
      assert.isFalse(all.some((c) => c.entityId === cards[6]!.entityId))
    }).pipe(Effect.scoped, withServer(config))
  })
  it.live("reuses archive state, excludes every discovery read and retains favourites and existing casts", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const card = yield* api.CreateCard({ label: "Hidden pilot", name: "Hidden pilot" })
      yield* api.SetCardFavourite({ entityId: card.entityId, favourite: true })
      const chat = yield* api.CreateChat({ title: "Existing crew" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: card.entityId } })
      const archived = yield* api.SetRefArchived({ refId: card.id, archived: true })
      assert.isNumber(archived.archivedAt)
      assert.strictEqual(
        (yield* api.SetRefArchived({ refId: card.id, archived: true })).archivedAt,
        archived.archivedAt
      )
      assert.isFalse((yield* api.ListCards()).some((c) => c.entityId === card.entityId))
      assert.isFalse((yield* api.ListCardUsage()).some((c) => c.entityId === card.entityId))
      assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((c) => c.id === card.id))
      const shell = yield* api.GetShellCards()
      assert.lengthOf(shell.cards, 0)
      assert.lengthOf(shell.personas, 0)
      assert.isTrue(shell.archived[0]!.favourite)
      assert.strictEqual(shell.archived[0]!.card.entityId, card.entityId)
      assert.isTrue(
        (yield* api.GetCast({ chatId: chat.id, slotId: null })).cards.some((c) => c.entityId === card.entityId)
      )
      yield* api.SetRefArchived({ refId: card.id, archived: false })
      assert.isTrue((yield* api.GetShellCards()).cards[0]!.favourite)
    }).pipe(Effect.scoped, withServer(testConfig()))
  )

  it.live(
    "queries 5,000 cards, rechecks favourites and edits, archives once and undoes only its own changes",
    () => {
      const config = testConfig({ authMode: "proxy" })
      return Effect.gen(function* () {
        const api = yield* client({ "Remote-User": "alice" })
        const bob = yield* client({ "Remote-User": "bob" })
        const userId = (yield* api.Whoami()).id
        const reader = yield* Reader
        const old = Date.now() - 100 * 86400000
        yield* fixtureSql(config.dataDir, [
          {
            sql: "INSERT INTO entities(id, owner_user_id, kind, created_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000) SELECT 'archive-e-'||i, ?, 'card', ? FROM n",
            params: [userId, old]
          },
          {
            sql: "INSERT INTO entity_revisions(id, entity_id, doc_json, doc_hash, schema_version, origin, created_at) SELECT 'archive-v-'||id, id, json_set(?, '$.name', id, '$.avatar_media_id', CASE WHEN id='archive-e-1' THEN 'portrait-'||id END), id, 1, 'import', ? FROM entities WHERE owner_user_id = ?",
            params: [JSON.stringify(newCardDoc("Synthetic")), old, userId]
          },
          {
            sql: "INSERT INTO entity_refs(id, entity_id, head_revision_id, label, created_at, updated_at) SELECT 'archive-r-'||id, id, 'archive-v-'||id, id, ?, ? FROM entities WHERE owner_user_id = ?",
            params: [old, old, userId]
          }
        ])
        const start = performance.now()
        const candidates = yield* reader.ListArchiveCandidates({ userId, criteria: { never: 30 } })
        console.log(`Archive candidates, 5,000 cards: ${Math.round(performance.now() - start)} ms`)
        assert.lengthOf(candidates, 5000)
        assert.strictEqual(candidates[0]!.avatarMediaId, `portrait-${candidates[0]!.entityId}`)
        assert.isTrue(candidates.every((c) => c.lastUsedAt === null))
        assert.lengthOf(yield* bob.ListArchiveCandidates({ criteria: { never: 30 } }), 0)
        const [starred, edited, plain, newerArchive] = candidates
        yield* api.SetCardFavourite({ entityId: starred!.entityId, favourite: true })
        const editor = yield* api.OpenEditor({ refId: edited!.refId })
        yield* api.RenameRef({
          refId: edited!.refId,
          label: "Edited pilot",
          subtitle: "",
          expectedRowVersion: editor.ref.rowVersion
        })
        const after = yield* api.ListArchiveCandidates({ criteria: { never: 30 } })
        assert.lengthOf(after, 4998)
        assert.lengthOf(yield* api.ListArchiveCandidates({ criteria: { inactive: 6 } }), 0)
        const ids = [starred!, edited!, plain!, newerArchive!].map((c) => c.entityId)
        const foreign = yield* bob.ArchiveUnusedCards({ criteria: { never: 30 }, entityIds: ids })
        assert.lengthOf(foreign.entityIds, 0)
        const receipt = yield* api.ArchiveUnusedCards({ criteria: { never: 30 }, entityIds: ids })
        assert.deepStrictEqual(new Set(receipt.entityIds), new Set([plain!.entityId, newerArchive!.entityId]))
        assert.lengthOf((yield* api.ArchiveUnusedCards({ criteria: { never: 30 }, entityIds: ids })).entityIds, 0)
        assert.strictEqual(yield* bob.UndoCardArchive(receipt), 0)
        yield* api.SetRefArchived({ refId: newerArchive!.refId, archived: false })
        yield* Effect.sleep(2)
        yield* api.SetRefArchived({ refId: newerArchive!.refId, archived: true })
        assert.strictEqual(yield* api.UndoCardArchive(receipt), 1)
        assert.strictEqual(yield* api.UndoCardArchive(receipt), 0)
        assert.lengthOf(yield* api.ListLibrary({ kind: "card", archived: true }), 1)
        // "Only tried" (spec/CARD-SOURCES.md §9 D3): every even card was added from cardex; one has
        // two of the user's messages in a chat, one has one, one has a reply only.
        const chat = yield* api.CreateChat({ title: "Synthetic tries" })
        const message = (n: number, entityId: string, writer: "human" | "model") =>
          [
            {
              sql: "INSERT INTO slots(id,chat_id,depth,selected_version_id,created_at) VALUES(?,?,0,?,?)",
              params: [`tried-s-${n}`, chat.id, `tried-v-${n}`, old]
            },
            {
              sql: "INSERT INTO version_records(id,slot_id,ordinal,status,writer,macro_mode,origin,content,cast_json,created_at,updated_at, authoring_fork_id) VALUES(?,?,0,'complete',?,'verbatim',?,'Synthetic try',?,?,?, ? )",
              params: [
                `tried-v-${n}`,
                `tried-s-${n}`,
                writer,
                writer === "human" ? "user_written" : "generated",
                JSON.stringify([entityId]),
                old + 1,
                old + 1,
                chat.currentForkId!
              ]
            }
          ].reverse() // the version first: a slot can only select a version that exists
        yield* fixtureSql(config.dataDir, [
          {
            sql: "INSERT INTO card_origins(entity_id, owner_user_id, source_id, remote_id, remote_version, remote_sha256, recognized_by, created_at) SELECT id, owner_user_id, 'cardex', 'remote-'||id, 'v1', 'sha', 'adopted', ? FROM entities WHERE owner_user_id = ? AND CAST(substr(id, 11) AS INTEGER) % 2 = 0",
            params: [old, userId]
          },
          ...message(0, "archive-e-2", "human"),
          ...message(1, "archive-e-2", "human"),
          ...message(2, "archive-e-4", "human"),
          ...message(3, "archive-e-6", "model")
        ])
        const triedStart = performance.now()
        const tried = yield* reader.ListArchiveCandidates({ userId, criteria: { tried: 1 } })
        console.log(`Only tried, 5,000 cards: ${Math.round(performance.now() - triedStart)} ms`)
        // 2,500 from cardex, less the archived e-1000 and e-2 with two messages.
        assert.lengthOf(tried, 2498)
        const byId = new Map(tried.map((c) => [c.entityId as string, c]))
        assert.isFalse(byId.has("archive-e-2"))
        assert.deepStrictEqual(
          [byId.get("archive-e-4")?.fromSource, byId.get("archive-e-4")?.userMessages],
          ["cardex", 1]
        )
        assert.strictEqual(byId.get("archive-e-6")?.userMessages, 0)
        assert.isFalse(tried.some((c) => Number(c.entityId.slice(10)) % 2 === 1))
        assert.lengthOf(yield* reader.ListArchiveCandidates({ userId, criteria: { tried: 2 } }), 2499)
        assert.lengthOf(yield* bob.ListArchiveCandidates({ criteria: { tried: 36000 } }), 0)
        // The writer checks again: e-2 isn't archived as tried, e-4 is.
        const triedReceipt = yield* api.ArchiveUnusedCards({
          criteria: { tried: 1 },
          entityIds: ["archive-e-2", "archive-e-4"] as never
        })
        assert.deepStrictEqual(triedReceipt.entityIds.map(String), ["archive-e-4"])
      }).pipe(Effect.scoped, withServer(config))
    },
    60_000
  )
})
