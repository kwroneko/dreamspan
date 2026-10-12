import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { Worker } from "node:worker_threads"
import { type SlotId, type VersionId, NewVersion } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import type { ConnectionId } from "@rp/shared/providers.ts"
import { generationOf, type ContextSnapshot } from "../src/assembler/types.ts"
import * as Database from "../src/db/Database.ts"
import { databaseFile } from "../src/db/connection.ts"
import { tempDir } from "./support/tempDir.ts"

const worker = (file: string, userId: string, chatId: string) =>
  Effect.promise(
    () =>
      new Promise<Array<string>>((resolve, reject) => {
        const thread = new Worker(new URL("./support/historyPerfWorker.ts", import.meta.url), {
          workerData: { file, userId, chatId, seed: true }
        })
        let plan: Array<string>
        thread.once("message", (value: Array<string>) => {
          plan = value
        })
        thread.once("error", reject)
        thread.once("exit", (code) => (code === 0 ? resolve(plan) : reject(new Error(`worker exited ${code}`))))
      })
  )

it.live(
  "finds the prior history start through an index in a 100,000-message chat",
  () => {
    const dataDir = tempDir("history-perf")
    const layer = () => Database.layer({ dataDir, readers: 1, allowNetworkFs: false, workers: "source" })
    return Effect.gen(function* () {
      const setup = yield* Effect.gen(function* () {
        const writer = yield* Database.Writer
        const user = yield* writer.EnsureUser({ handle: "perf", displayName: "Perf" })
        const userId = user.id as UserId
        const chat = yield* writer.CreateChat({
          userId,
          kind: "rp",
          status: "active",
          title: "Synthetic",
          participants: [],
          greeting: null
        })
        const connectionId = uuidv7() as ConnectionId
        yield* writer.CreateConnection({
          userId,
          connectionId,
          kind: "openai-chat",
          api: "openai-completions",
          settings: {
            name: "Perf",
            baseUrl: null,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          },
          credential: { existing: null }
        })
        const model = yield* writer.AddUserModel({ userId, connectionId, key: "perf", overrides: {} })
        yield* writer.SetGenerationDefaults({
          userId,
          defaults: { model: { connection: connectionId, model: model.id }, preset: null }
        })
        return { userId, chatId: chat.id, connectionId, modelId: model.id }
      }).pipe(Effect.provide(layer()))
      const plan = yield* worker(databaseFile(dataDir), setup.userId, setup.chatId)
      assert.ok(
        plan.some((step) => step.includes("SEARCH r USING INDEX rollouts_history")),
        plan.join("\n")
      )
      assert.isFalse(
        plan.some((step) => /^SCAN (r|slots|rollouts)/.test(step)),
        plan.join("\n")
      )
      yield* Effect.gen(function* () {
        const reader = yield* Database.Reader
        const writer = yield* Database.Writer
        const { userId, chatId, connectionId, modelId } = setup
        const times: Array<number> = []
        let built!: { snapshot: string; generation: string }
        for (let i = 0; i < 5; i++) {
          const at = performance.now()
          built = yield* reader.AssembleContext({
            userId,
            chatId,
            slotId: "perf-s-100000" as SlotId,
            versionId: "perf-v-100000" as VersionId,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          times.push(performance.now() - at)
        }
        const first = JSON.parse(built.snapshot) as ContextSnapshot
        const gen = generationOf(first)
        yield* writer.StartRollout({
          userId,
          chatId,
          slotId: "perf-s-100000" as SlotId,
          versionId: "perf-v-100000" as VersionId,
          rolloutId: uuidv7(),
          leafSlotId: "perf-s-99999" as SlotId,
          connectionId,
          modelId,
          snapshot: built.snapshot,
          variables: gen.variables,
          frozenMessages: gen.frozenMessages.map((message) => ({
            ...message,
            versionId: message.versionId as VersionId
          })),
          issues: gen.issues
        })
        const next = yield* writer.AppendMessage({
          userId,
          chatId,
          parentSlotId: "perf-s-100000" as SlotId,
          branch: false,
          commitDraft: null,
          version: new NewVersion({
            writer: "model",
            speakerEntityId: null,
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          })
        })
        const withStart: Array<number> = []
        for (let i = 0; i < 5; i++) {
          const at = performance.now()
          const assembled = yield* reader.AssembleContext({
            userId,
            chatId,
            slotId: next.slotId,
            versionId: next.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          withStart.push(performance.now() - at)
          assert.deepStrictEqual(
            (JSON.parse(assembled.snapshot) as ContextSnapshot).sources!.historyStart,
            first.historyStart
          )
        }
        const median = (values: Array<number>) => [...values].sort((a, b) => a - b)[2]!
        console.log(
          `History assembly / 100,000 messages: no prior start ${median(times).toFixed(1)} ms, indexed prior start ${median(withStart).toFixed(1)} ms`
        )
        assert.isBelow(median(withStart), median(times) + 100)
        const rebuilt = yield* reader.RebuildContext({ userId, snapshot: built.snapshot })
        assert.ok(rebuilt._tag === "Rebuilt")
        assert.deepStrictEqual(JSON.parse(rebuilt.snapshot), first)
      }).pipe(Effect.provide(layer()))
    })
  },
  60000
)
