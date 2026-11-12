import { assert, it } from "@effect/vitest"
import { NewVersion } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { historyTools } from "../src/agent/tools/history.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import type { AppendResult } from "../src/db/ops.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { completeFixture, fixtureSql } from "./support/lcmFixtures.ts"

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
      viewers: null,
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
      viewers: null,
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

it.live("a separate context's viewer opens and searches only summaries of what it was present for", () => {
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
    const wren = (yield* writer.CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Wren",
      subtitle: "",
      doc: cardDoc("Wren"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })).entityId as string
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
    // Wren is the cast throughout, away for message 3.
    yield* fixtureSql(config.dataDir, [
      {
        sql: "UPDATE version_records SET cast_json = ? WHERE slot_id IN (SELECT id FROM slots WHERE chat_id = ?)",
        params: [JSON.stringify([wren]), chat.id]
      },
      {
        sql: "UPDATE version_records SET presence_json = ? WHERE id = ?",
        params: [JSON.stringify({ away: [wren] }), inputs[2]!.versionId]
      }
    ])
    const a = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(0, 2), [], " FIRST")
    const b = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(2, 4), [], " SECOND")
    const middle = yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [a, b], " MIDDLE")
    const c = yield* completeFixture(config.dataDir, writer, user.id, chat.id, inputs.slice(4, 6), [], " LAST")
    yield* completeFixture(config.dataDir, writer, user.id, chat.id, [], [middle, c], " TOP")
    const run = (viewer: string | null, id: string, args: object) =>
      historyTools
        .find((t) => t.id === id)!
        .execute(
          {
            userId: user.id,
            chatId: chat.id,
            forkId: chat.currentForkId,
            slotId: inputs.at(-1)!.slotId,
            versionId: inputs.at(-1)!.versionId,
            leafSlotId: inputs.at(-1)!.slotId,
            viewers: viewer === null ? null : [viewer],
            rolloutId: "test",
            toolCallId: "test",
            cache: new Map(),
            reader,
            writer
          },
          args as never
        )
    for (const covering of ["1–6", "1–4", "3–4"]) {
      const opened = yield* run(wren, "expand_summary", { messages: covering })
      assert.isTrue(opened.isError, `${covering} covers message 3`)
    }
    assert.include((yield* run(wren, "expand_summary", { messages: "1–2" })).text, "Message 2")
    // Summaries kept per view (unit C7): the shared summaries are Wren's only before her first
    // missed message; after it she has her own (none written here), since a shared request
    // there may have carried what she missed.
    assert.isTrue((yield* run(wren, "expand_summary", { messages: "5–6" })).isError)
    assert.include((yield* run(wren, "search_summaries", { query: "SECOND" })).text, "No summaries match")
    assert.include((yield* run(wren, "search_summaries", { query: "LAST" })).text, "No summaries match")
    assert.include((yield* run(null, "search_summaries", { query: "LAST" })).text, "Messages 5–6")
    assert.include((yield* run(null, "search_summaries", { query: "SECOND" })).text, "Messages 3–4")
    assert.isUndefined((yield* run(null, "expand_summary", { messages: "1–6" })).isError)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
