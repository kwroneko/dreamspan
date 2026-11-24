// GetPanelData (spec/HTML-MESSAGES.md §3.4 Tier B): what a panel's scripts may read is its own
// message and those before it on the path, the chat's variables there and the names; never a
// later message or a later variable (causal order).
import { assert, describe, it } from "@effect/vitest"
import type { SlotId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { PANEL_TEXT, type PanelMessage } from "@dreamspan/shared/panelDataApi.ts"
import { Effect } from "effect"
import { fitText } from "../src/api/panelData.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"

describe("GetPanelData", () => {
  it.live("reads the path up to the panel's message, its variables and names, nothing after", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const mira = (yield* api.CreateCard({ label: "Mira", name: "Mira" })).entityId
      const sam = (yield* api.CreateCard({ label: "Sam", name: "Sam" })).entityId
      const chat = yield* api.CreateChat({ title: "Panels" })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "Join", entityId: mira } })
      yield* api.ChangeCast({ chatId: chat.id, slotId: null, change: { _tag: "PlayedByMe", entityIds: [sam] } })
      const slots: Array<SlotId> = []
      let parent: SlotId | null = null
      for (const content of ["One.", "Two.", "Three."]) {
        const sent: Effect.Success<ReturnType<typeof api.SendMessage>> = yield* api.SendMessage({
          chatId: chat.id,
          parentSlotId: parent,
          branch: false,
          content
        })
        if (sent._tag !== "Posted") throw new Error("unexpected queue")
        parent = sent.entry.slotId
        slots.push(parent)
      }
      const [first, second, third] = slots as [SlotId, SlotId, SlotId]
      const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId
      const set = (slotId: SlotId, value: number) =>
        writer.AddStateEvent({
          userId,
          chatId: chat.id,
          forkId,
          slotId,
          versionId: null,
          scope: null,
          data: { key: "var.set", value: { name: "hp", value } }
        })
      yield* set(first, 12)
      yield* set(third, 3)

      const data = yield* api.GetPanelData({ chatId: chat.id, forkId: null, slotId: second })
      assert.strictEqual(data.messageId, 1)
      assert.deepStrictEqual(
        data.messages.map((m) => [m.messageId, m.message, m.role, m.name]),
        [
          [0, "One.", "user", "Sam"],
          [1, "Two.", "user", "Sam"]
        ]
      )
      // The variable as it stood at the panel's message: the later write isn't seen.
      assert.deepStrictEqual(data.chatVariables, { hp: 12 })
      assert.deepStrictEqual(data.names, { user: "Sam", char: "Mira" })

      const last = yield* api.GetPanelData({ chatId: chat.id, forkId: null, slotId: third })
      assert.strictEqual(last.messageId, 2)
      assert.lengthOf(last.messages, 3)
      assert.deepStrictEqual(last.chatVariables, { hp: 3 })

      // Another user's chat is NotFound: isolation.test.ts.
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it("keeps the newest messages that fit, and always the panel's own", () => {
    const message = (messageId: number, length: number): PanelMessage => ({
      messageId,
      name: "Mira",
      role: "assistant",
      hidden: false,
      message: "x".repeat(length)
    })
    const half = PANEL_TEXT / 2
    assert.deepStrictEqual(
      fitText([message(0, half), message(1, half), message(2, 10)]).map((m) => m.messageId),
      [1, 2]
    )
    assert.deepStrictEqual(
      fitText([message(0, 1), message(1, PANEL_TEXT * 2)]).map((m) => m.messageId),
      [1]
    )
  })

  it.live("reads a shared slot on either fork and refuses a slot exclusive to another fork", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Forked panels" })
      const send = (parentSlotId: SlotId | null, content: string) =>
        posted(api.SendMessage({ chatId: chat.id, parentSlotId, branch: false, content }))
      const root = (yield* send(null, "Root")).entry.slotId
      const first = (yield* send(root, "First")).entry.slotId
      const forkId = (yield* api.GetChat({ chatId: chat.id })).currentForkId!
      const { fork } = yield* api.CreateFork({ chatId: chat.id, fromForkId: forkId, atSlotId: root })
      const second = (yield* send(root, "Second")).entry.slotId
      const read = (forkId: typeof fork.id | null, slotId: SlotId) =>
        api.GetPanelData({ chatId: chat.id, forkId, slotId })
      assert.strictEqual((yield* read(forkId, first)).messages.at(-1)?.message, "First")
      assert.strictEqual((yield* read(fork.id, root)).messages.at(-1)?.message, "Root")
      assert.strictEqual((yield* read(null, second)).messages.at(-1)?.message, "Second")
      for (const rejected of [read(forkId, second), read(fork.id, first), read(null, first)]) {
        assert.strictEqual((yield* rejected.pipe(Effect.flip))._tag, "NotFound")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})
