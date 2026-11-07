import { newCardDoc } from "@rp/shared/editing.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Reader } from "../src/db/Database.ts"
import { archiveCandidatesSql } from "../src/db/cardArchive.ts"
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
            params: [userId, userId, userId, userId]
          }
        ],
        { readOnly: true }
      )
      assert.isTrue(plan!.some((row) => /SEARCH er USING COVERING INDEX/.test(String(row.detail))))
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
              sql: "INSERT INTO version_records(id,slot_id,ordinal,status,writer,macro_mode,origin,content,cast_json,created_at,updated_at) VALUES(?,?,0,'complete',?,'verbatim',?,?,?, ?,?)",
              params: [
                `usage-v-${i}`,
                `usage-s-${i}`,
                i === 1 ? "human" : "model",
                i === 0 ? "greeting" : i === 4 ? "imported" : i === 1 ? "user_written" : "generated",
                i === 3 ? "" : "Synthetic message",
                JSON.stringify([card.entityId]),
                old + 1,
                old + 1
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
      }).pipe(Effect.scoped, withServer(config))
    },
    60_000
  )
})
