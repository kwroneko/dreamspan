import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { AppendResult } from "../src/db/ops.ts"
import type { LcmSlot } from "../src/db/lcmPath.ts"
import { databaseFile } from "../src/db/connection.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"

it.live("maintenance inputs preserve the path without reading message payloads", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    let leaf: SlotId | null = null
    for (const content of ["x".repeat(32_000), "", "Last message."]) {
      const message: AppendResult = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: leaf,
        branch: false,
        commitDraft: null,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        })
      })
      leaf = message.slotId
    }
    const result = yield* Effect.promise(
      () =>
        new Promise<{ full: LcmSlot[]; inputs: LcmSlot[]; queries: string[] }>((resolve, reject) => {
          const worker = new Worker(new URL("./support/lcmPathWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(config.dataDir), userId: user.id, chatId: chat.id, leaf }
          })
          worker.once("message", resolve)
          worker.once("error", reject)
        })
    )
    assert.lengthOf(result.full, 3)
    assert.strictEqual(result.full[0]!.content.length, 32_000)
    assert.deepStrictEqual(
      result.inputs,
      result.full.map((slot) => ({ ...slot, content: "" }))
    )
    assert.isTrue(result.queries.some((query) => /FROM path p/.test(query)))
    assert.isFalse(
      result.queries.some((query) => /\bversion_texts\b/.test(query)),
      "pinning input identities must not read the prose table"
    )
  }).pipe(Effect.provide(serverLayer(config)), Effect.scoped)
})
