// Migration 0053 and composers: before forks, "Branch from here" opened a composer keyed by
// the message it branched at, which needn't be a leaf. No fork ends there after the
// migration, so the composer's text goes to the recovered texts rather than staying keyed
// by a slot no screen opens.
import { DatabaseSync } from "node:sqlite"
import { SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { databaseFile, writerConnection } from "../src/db/connection.ts"
import * as Database from "../src/db/Database.ts"
import { migrations } from "../src/db/migrations.ts"
import { client, serverLayer, testConfig, typeInto } from "./support/config.ts"
import { tempDir } from "./support/tempDir.ts"
import { unmigrateForks } from "./support/unmigrateForks.ts"

const say = (content: string) =>
  new NewVersion({
    speakerEntityId: null,
    writer: "human",
    content,
    status: "complete",
    macroMode: "verbatim",
    origin: "user_written"
  })

describe("0053_forks composers", () => {
  it.live("keeps the text of a composer typed at a message no line ends at", () => {
    const dataDir = tempDir("forks-drafts")
    return Effect.gen(function* () {
      const built = yield* Effect.gen(function* () {
        const api = yield* client()
        const writer = yield* Database.Writer
        const userId = (yield* api.Whoami()).id as UserId
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Drafts",
          participants: [],
          greeting: null
        })
        const slots: Array<SlotId> = []
        for (let i = 0; i < 4; i++)
          slots.push(
            (yield* writer.AppendMessage({
              userId,
              chatId: chat.id,
              parentSlotId: slots.at(-1) ?? null,
              branch: false,
              version: say(`m${i}`),
              commitDraft: null
            })).slotId
          )
        // A composer at m1, as "Branch from here" left one before forks.
        const at = yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: null, atSlotId: slots[1]! })
        const draft = yield* typeInto(api, chat.id, at.fork.id, "Typed where I meant to branch")
        // The user went back to the main line and wrote on.
        yield* writer.AppendMessage({
          userId,
          chatId: chat.id,
          forkId: chat.currentForkId!,
          parentSlotId: slots.at(-1)!,
          branch: false,
          version: say("m4"),
          commitDraft: null
        })
        return { draftId: draft.id, chatId: chat.id, at: slots[1]! }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig({ dataDir }), Generator.none)))

      const db = new DatabaseSync(databaseFile(dataDir))
      unmigrateForks(db)
      assert.strictEqual(
        (db.prepare("SELECT field FROM drafts WHERE id = ?").get(built.draftId) as { field: string }).field,
        built.at
      )
      db.close()
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
        Effect.provide(writerConnection(databaseFile(dataDir)))
      )
      const after = new DatabaseSync(databaseFile(dataDir), { readOnly: true })
      try {
        const draft = after.prepare("SELECT field, content FROM drafts WHERE id = ?").get(built.draftId) as
          { field: string; content: string } | undefined
        const fork = draft && after.prepare("SELECT id FROM forks WHERE id = ?").get(draft.field)
        const recovered = after
          .prepare("SELECT content FROM recovered_texts WHERE content = ?")
          .all("Typed where I meant to branch")
        // No fork shows a composer there, so its text is among the recovered texts.
        assert.isUndefined(fork)
        assert.lengthOf(recovered, 1, "the typed text is reachable")
      } finally {
        after.close()
      }
    })
  })
})
