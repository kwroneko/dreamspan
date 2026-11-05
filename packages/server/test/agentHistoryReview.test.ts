import { assert, it } from "@effect/vitest"
import { NewVersion } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { historyTools } from "../src/agent/tools/history.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import type { AppendResult } from "../src/db/ops.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { completeFixture } from "./support/lcmFixtures.ts"

it.live("expanding mixed-level condensation returns its actual children once, in path order", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer,
      reader = yield* Reader
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    const inputs: Array<{ slotId: ToolContext["slotId"]; versionId: ToolContext["versionId"]; amendCount: number }> = []
    for (let n = 0; n < 6; n++) {
      const entry: AppendResult = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: inputs.at(-1)?.slotId ?? null,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "human",
          content: `Message ${n + 1}`,
          status: "complete",
          macroMode: "verbatim",
          origin: "user_written"
        }),
        commitDraft: null
      })
      inputs.push({ slotId: entry.slotId, versionId: entry.version.id, amendCount: 0 })
    }
    const a = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(0, 2), [], " FIRST")
    const b = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(2, 4), [], " SECOND")
    const middle = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [a, b], " MIDDLE")
    const c = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(4, 6), [], " LAST")
    yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [middle, c], " TOP")
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: inputs.at(-1)!.slotId,
      versionId: inputs.at(-1)!.versionId,
      leafSlotId: inputs.at(-1)!.slotId,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader,
      writer
    }
    const tool = historyTools.find((t) => t.id === "expand_summary")!
    const result = yield* tool.execute(context, { messages: "1–6" } as never)
    assert.strictEqual(
      result.text,
      `<summary level="2" from="1" to="4">\n${middle.content}\n</summary>\n\n<summary level="1" from="5" to="6">\n${c.content}\n</summary>`
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("history tools include stopped and interrupted messages that remain in the story", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client(),
      user = yield* api.Whoami(),
      writer = yield* Writer,
      reader = yield* Reader
    const chat = yield* writer.CreateChat({
      userId: user.id,
      kind: "rp",
      status: "active",
      title: "Synthetic",
      participants: [],
      greeting: null
    })
    let leaf: ToolContext["leafSlotId"] = null
    let last: ToolContext["versionId"] | undefined
    for (const status of ["complete", "stopped", "interrupted"] as const) {
      const entry: AppendResult = yield* writer.AppendMessage({
        userId: user.id,
        chatId: chat.id,
        parentSlotId: leaf,
        branch: false,
        version: new NewVersion({
          speakerEntityId: null,
          writer: "model",
          content: `A ${status} lighthouse reply.`,
          status,
          macroMode: "verbatim",
          origin: "user_written"
        }),
        commitDraft: null
      })
      leaf = entry.slotId
      last = entry.version.id
    }
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: leaf!,
      versionId: last!,
      leafSlotId: leaf,
      rolloutId: "test",
      toolCallId: "test",
      cache: new Map(),
      reader,
      writer
    }
    const result = yield* historyTools
      .find((t) => t.id === "search_chat")!
      .execute(context, { query: "lighthouse" } as never)
    assert.include(result.text, "stopped lighthouse")
    assert.include(result.text, "interrupted lighthouse")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
