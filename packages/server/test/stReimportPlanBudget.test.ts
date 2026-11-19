import { assert, it } from "@effect/vitest"
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { User, UserId } from "@dreamspan/shared/domain.ts"
import { uuidv7 } from "@dreamspan/shared/id.ts"
import { emptyPlanCounts } from "@dreamspan/shared/stReimportPlan.ts"
import { Effect, Layer } from "effect"
import { Reader } from "../src/db/Database.ts"
import { Formats } from "../src/importer/Formats.ts"
import { StImportPlans } from "../src/importer/StImportPlans.ts"

it.effect("counts nested virtual swipe versions toward the preview memory budget", () => {
  const user = { id: uuidv7() as UserId } as User
  const chatId = uuidv7() as ChatId
  const written = JSON.stringify({
    slots: [
      {
        id: "virtual:budget",
        parent: null,
        depth: 0,
        hidden: false,
        selected: "v0",
        versions: Array.from({ length: 50_000 }, (_, ordinal) => ({
          id: `v${ordinal}`,
          hash: "synthetic",
          at: 0,
          writer: "model",
          ordinal
        }))
      }
    ],
    versions: [],
    selects: []
  })
  const planned = {
    chatId,
    chatTitle: "Budget",
    cursor: null,
    matching: false,
    counts: { ...emptyPlanCounts, newMessages: 4 },
    carry: { keepTip: false, branchDeleted: false, last: null },
    messages: [],
    changed: 4,
    digest: "",
    written
  }
  const reader = new Proxy({} as Reader["Service"], {
    get(_, key) {
      if (key === "StImportPlanStamp") return () => Effect.succeed({ [chatId]: "stamp" })
      if (key === "StImportSources")
        return () =>
          Effect.succeed({
            library: [],
            chats: [
              {
                source: "chats/Alice/Budget.jsonl",
                recordId: uuidv7(),
                forkId: uuidv7(),
                chatId,
                complete: true,
                binned: false,
                merged: false
              }
            ]
          })
      if (key === "StImportPlanBatch") return () => Effect.succeed(planned)
      return undefined
    }
  })
  const formats = {
    st: {
      chatPart: () =>
        Effect.succeed({ report: { issues: [] }, batches: [{ messagesJson: "[]" }], userTurns: 2, lastAt: null })
    }
  } as unknown as Formats["Service"]
  return Effect.gen(function* () {
    const plans = yield* StImportPlans
    const { plan } = yield* plans.start(user, { mode: "upload" }, [
      { path: "chats/Alice/Budget.jsonl", size: 1, modifiedMs: null, mainChat: null },
      { path: "chats/Alice/Budget side.jsonl", size: 1, modifiedMs: null, mainChat: "Budget" }
    ])
    yield* plans.file(user, plan.planId, "chats/Alice/Budget.jsonl", new Uint8Array([10]), 0, true)
    const after = yield* plans.get(user, plan.planId)
    assert.strictEqual(after.status, "failed", "top-level slot counts cannot bound nested version arrays")
    assert.include(after.error, "too many shared changes")
  }).pipe(
    Effect.provide(
      StImportPlans.layer.pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Reader)(reader), Layer.succeed(Formats)(formats)))
      )
    ),
    Effect.scoped
  )
})
