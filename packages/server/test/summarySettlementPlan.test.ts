import { Worker } from "node:worker_threads"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { NewVersion } from "@dreamspan/shared/chat.ts"
import * as Database from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { testWorkers } from "./support/bundles.ts"
import { tempDir } from "./support/tempDir.ts"

it.live("summary settlement starts from sparse touches even when a version index covers the join", () => {
  const dataDir = tempDir("settlement-plan")
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
        content: "Synthetic",
        status: "complete",
        macroMode: "verbatim",
        origin: "user_written"
      })
    })
    const plan = yield* Effect.promise(
      () =>
        new Promise<string[]>((resolve, reject) => {
          const worker = new Worker(new URL("./support/settlementProbeWorker.ts", import.meta.url), {
            workerData: { file: databaseFile(dataDir), chatId: chat.id, versionId: message.version.id }
          })
          let result: string[] | undefined
          worker.once("message", (value) => {
            result = value
          })
          worker.once("error", reject)
          worker.once("exit", (code) =>
            code === 0 && result ? resolve(result) : reject(new Error(`settlement probe exited ${code}`))
          )
        })
    )
    assert.isAbove(plan.length, 0)
    assert.isFalse(
      plan.some((detail) => /^SCAN v(?:\s|$)/.test(detail)),
      plan.join("\n")
    )
    assert.isTrue(plan.some((detail) => /^SEARCH v .*\(id=\?\)/.test(detail)))
    // Children of touched forks are found from the touches, never by scanning every fork.
    assert.isFalse(
      plan.some((detail) => /^SCAN f(?:\s|$)/.test(detail)),
      plan.join("\n")
    )
  }).pipe(Effect.provide(Database.layer({ dataDir, readers: 1, allowNetworkFs: false, ...testWorkers })), Effect.scoped)
})
