// An image taken out of the context in one fork (`image_exclude`, keyed by its message's
// original version) is left out of that fork's LCM reads: the path's image metadata, which
// planning estimates image tokens from, and the summary request. Another fork still has it.
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert } from "@effect/vitest"
import type { ForkId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { databaseFile } from "../src/db/connection.ts"
import { inFork } from "../src/db/forkState.ts"
import { lcmPath } from "../src/db/lcmPath.ts"
import { serverPort } from "./support/config.ts"
import { lcmHarness, lcmTest, requestsTo } from "./support/lcmHarness.ts"
import { png, textChunk } from "./formats/support.ts"

const base64 = (tag: string) => Buffer.from(png(textChunk("fixture", tag))).toString("base64")

lcmTest("an image excluded in a fork is left out of its LCM path and summary request only", (server) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 3 })
    const model = (yield* h.api.ListModels({ connectionId: h.connection.id, includeHidden: true })).find(
      (m) => m.id === h.primary.model
    )!
    yield* h.api.EditModel({
      modelId: model.id,
      expectedRowVersion: model.rowVersion,
      overrides: { ...model.overrides, vision: true, maxImages: 4 }
    })
    const port = yield* serverPort
    const upload = (tag: string) =>
      Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/chat/image`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: png(textChunk("fixture", tag))
        })
        assert.strictEqual(response.status, 200)
        return (await response.json()) as { mediaId: string }
      })
    const kept = yield* upload("kept"),
      hidden = yield* upload("hidden")
    const row = h.rows[1]!
    const edited = yield* h.api.EditVersion({
      slotId: row.slotId,
      sourceVersionId: row.version.id,
      expectedRowVersion: 1,
      content: "Two drawings.",
      images: [kept, hidden]
    })
    const main = h.chat.currentForkId! as ForkId
    const other = (yield* h.writer.CreateFork({
      userId: h.userId,
      chatId: h.chat.id,
      fromForkId: main,
      atSlotId: h.rows.at(-1)!.slotId
    })).fork.id as ForkId
    yield* h.api.SetImageExcluded({
      versionId: edited.version.id,
      mediaId: hidden.mediaId,
      forkId: main,
      excluded: true
    })

    // The LCM path's image metadata, read in each fork on a read-only connection.
    const imagesIn = (forkId: ForkId) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const path = yield* lcmPath(sql, h.userId, h.chat.id, h.rows.at(-1)!.slotId).pipe(
          inFork(sql, h.chat.id, forkId, null)
        )
        return path.find((slot) => slot.id === (row.slotId as SlotId))!.images!.map((image) => image.mediaId)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: databaseFile(h.dataDir), readonly: true })))
    assert.deepStrictEqual(yield* imagesIn(main), [kept.mediaId])
    assert.deepStrictEqual(yield* imagesIn(other), [kept.mediaId, hidden.mediaId])

    // The summary request over the message, in each fork. The first fork's summary, written
    // without the image, doesn't cover the other fork, which sends it (lcmSummaryImages.test.ts).
    for (const forkId of [main, other]) {
      const path = yield* h.reader.GetPath({ userId: h.userId, chatId: h.chat.id, forkId, leafSlotId: null, limit: 10 })
      const [job] = yield* h.writer.EnqueueSummaries({
        userId: h.userId,
        chatId: h.chat.id,
        forkId,
        leafSlotId: h.rows.at(-1)!.slotId,
        requestClass: "interactive",
        chunks: [
          {
            target: 100,
            inputs: path.entries
              .slice(0, 2)
              .map((e) => ({ slotId: e.slotId, versionId: e.version.id, amendCount: e.version.rowVersion - 1 }))
          }
        ]
      })
      assert.isDefined(job, forkId === main ? "main" : "other")
      assert.strictEqual((yield* h.runNext)?.id, job!.id)
      const body = JSON.stringify(requestsTo(h.mock, "primary-model").at(-1)!.body)
      assert.include(body, base64("kept"))
      if (forkId === main) assert.notInclude(body, base64("hidden"))
      else assert.include(body, base64("hidden"))
    }
  }).pipe(Effect.scoped)
)
