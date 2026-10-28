// An imported ST summary is a plain note (DESIGN §8 [P]): "Summary (from ST)", on exactly when ST
// was sending it (ST 1.19: the Summarize extension enabled, and injected unless its position is
// None, or read by `{{summary}}` in the preset it used), and sent only by its switch. Enabling
// summaries switches it off in the same step, for both choices.
import { assert } from "@effect/vitest"
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { lcmHarness, lcmTest } from "./support/lcmHarness.ts"
import { BACKFILL_SUMMARY, backfillFolder } from "./support/stBackfill.ts"
import { encode } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const ROOT = "ST/data/default-user/"
const SENT = `[Story so far: ${BACKFILL_SUMMARY}]`

/** A small folder whose settings say how ST sent the summary, with a preset "Macro" whose main prompt reads it. */
const folder = (chats: ReadonlyArray<string>, how: "injected" | "macro" | "disabled") => {
  const files = new Map(backfillFolder(ROOT, chats, { hidden: 20, visible: 6 }))
  files.set(
    `${ROOT}settings.json`,
    encode({
      username: "Sam",
      extension_settings: {
        memory: { position: how === "macro" ? -1 : 1, depth: 3, role: 0, template: "[Story so far: {{summary}}]" },
        disabledExtensions: how === "disabled" ? ["memory"] : []
      },
      oai_settings: { preset_settings_openai: "Macro" }
    })
  )
  files.set(
    `${ROOT}OpenAI Settings/Macro.json`,
    encode({
      prompts: [
        {
          identifier: "main",
          name: "Main",
          role: "system",
          content: "Tell the story.\n{{summary}}",
          system_prompt: true
        },
        { identifier: "chatHistory", name: "Chat History", marker: true, system_prompt: true }
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "chatHistory", enabled: true }
          ]
        }
      ]
    })
  )
  return files
}

const setup = (
  server: Parameters<Parameters<typeof lcmTest>[1]>[0],
  chats: ReadonlyArray<string>,
  how: "injected" | "macro" | "disabled"
) =>
  Effect.gen(function* () {
    const h = yield* lcmHarness(server, { messages: 0 })
    yield* importStFolder(folder(chats, how))
    // The chat sends with the preset ST used (the harness had its own default, which an import keeps).
    const macro = (yield* h.api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Macro")!
    yield* h.api.ChangeGenerationDefaults({ change: { preset: macro.id } })
    const list = yield* h.api.ListChats({ limit: 50, before: null })
    const open = (name: string) =>
      Effect.gen(function* () {
        const chatId = list.find((c) => c.title === name)!.id as ChatId
        const leaf = (yield* h.api.GetChat({ chatId })).activeLeafSlotId as SlotId
        return { chatId, leaf }
      })
    const note = (chat: { chatId: ChatId; leaf: SlotId }) =>
      Effect.map(h.api.ListChatNotes({ chatId: chat.chatId, slotId: chat.leaf }), (notes) =>
        notes.find((n) => n.doc["kind"] === "imported_summary")!
      )
    const context = (chat: { chatId: ChatId; leaf: SlotId }) =>
      Effect.gen(function* () {
        const path = yield* h.reader.GetPath({ userId: h.userId, chatId: chat.chatId, leafSlotId: null, limit: 100 })
        const last = path.entries.at(-1)!
        const built = yield* h.reader.AssembleContext({
          userId: h.userId,
          chatId: chat.chatId,
          slotId: last.slotId,
          versionId: last.version.id,
          now: 1,
          timeZone: "UTC",
          frozen: null
        })
        return (JSON.parse(built.snapshot) as ContextSnapshot).request.messages.map((m) => m.content)
      })
    return { h, open, note, context }
  })

const count = (messages: ReadonlyArray<string>, text: string) =>
  messages.reduce((n, m) => n + m.split(text).length - 1, 0)

lcmTest("a summary ST injected is on and placed where ST put it", (server) =>
  Effect.gen(function* () {
    const { open, note, context } = yield* setup(server, ["Bob - injected"], "injected")
    const chat = yield* open("Bob - injected")
    const summary = yield* note(chat)
    assert.strictEqual(summary.doc["title"], "Summary (from ST)")
    assert.isTrue(summary.active)
    assert.deepStrictEqual(summary.doc["placement"], { mode: "depth", depth: 3, role: "system" })
    const messages = yield* context(chat)
    // Injected once; the preset's `{{summary}}` reads the same switched-on note.
    assert.strictEqual(count(messages, SENT), 1)
    assert.include(messages[0]!, `Tell the story.\n${BACKFILL_SUMMARY}`)
  })
)

lcmTest("a summary ST sent only through {{summary}} is on, not placed, and sent once by the macro", (server) =>
  Effect.gen(function* () {
    const { h, open, note, context } = yield* setup(server, ["Bob - macro"], "macro")
    const chat = yield* open("Bob - macro")
    const summary = yield* note(chat)
    assert.isTrue(summary.active)
    assert.deepStrictEqual(summary.doc["placement"], { mode: "none" })
    const messages = yield* context(chat)
    assert.strictEqual(count(messages, BACKFILL_SUMMARY), 1)
    assert.include(messages[0]!, `Tell the story.\n${BACKFILL_SUMMARY}`)
    // The preset context says what the macro fills in.
    const next = yield* h.api.GetNextContext({ chatId: chat.chatId, leafSlotId: chat.leaf })
    assert.deepStrictEqual(next.presetContext?.summary, {
      prompts: ["main"],
      kind: "notes",
      count: 1,
      tokens: Math.ceil(BACKFILL_SUMMARY.length / 4),
      titles: ["Summary (from ST)"]
    })
    // Switched off, it sends nothing anywhere: `{{summary}}` is empty. (Switched at the last message's
    // parent, so the context assembled for that message has it off.)
    const path = yield* h.reader.GetPath({ userId: h.userId, chatId: chat.chatId, leafSlotId: null, limit: 100 })
    yield* h.api.ChangeCast({
      chatId: chat.chatId,
      slotId: path.entries.at(-2)!.slotId,
      change: { _tag: "Note", entityId: summary.ref.entityId, active: false }
    })
    const off = yield* context(chat)
    assert.strictEqual(count(off, BACKFILL_SUMMARY), 0)
    assert.include(off[0]!, "Tell the story.")
    const after = yield* h.api.GetNextContext({ chatId: chat.chatId, leafSlotId: chat.leaf })
    assert.strictEqual(after.presetContext?.summary?.kind, "none")
  })
)

lcmTest("a summary ST didn't send (the extension disabled) is off and sent nowhere", (server) =>
  Effect.gen(function* () {
    const { open, note, context } = yield* setup(server, ["Bob - disabled"], "disabled")
    const chat = yield* open("Bob - disabled")
    const summary = yield* note(chat)
    assert.isFalse(summary.active)
    assert.deepStrictEqual(summary.doc["placement"], { mode: "none" })
    assert.strictEqual(count(yield* context(chat), BACKFILL_SUMMARY), 0)
  })
)

lcmTest("enabling summaries switches the imported note off for both choices; re-import keeps the settings", (server) =>
  Effect.gen(function* () {
    const { h, open, note } = yield* setup(server, ["Bob - adopt", "Bob - scratch"], "injected")
    for (const [name, choice] of [
      ["Bob - adopt", "adopt"],
      ["Bob - scratch", "scratch"]
    ] as const) {
      const chat = yield* open(name)
      // Imported chats copy the account default, off.
      const settings = yield* h.api.GetLcmSettings({ chatId: chat.chatId, leafSlotId: chat.leaf })
      assert.isFalse(settings.stored!.enabled)
      assert.strictEqual(settings.stored!.recentMax, 20_000)
      const offer = yield* h.api.GetLcmEnableOffer({ chatId: chat.chatId, leafSlotId: chat.leaf })
      assert.isTrue(offer.summaryNoteOn)
      yield* h.api.EnableLcm({
        chatId: chat.chatId,
        leafSlotId: chat.leaf,
        choice,
        approved: choice === "adopt" ? offer.adopted! : offer.fromScratch
      })
      assert.isFalse((yield* note(chat)).active, `${choice}: the note is off`)
      assert.isTrue((yield* h.api.GetLcmSettings({ chatId: chat.chatId, leafSlotId: chat.leaf })).resolved.enabled)
      // It's an ordinary switch: on again, it's sent too, beside the summaries.
      const again = yield* h.api.GetLcmEnableOffer({ chatId: chat.chatId, leafSlotId: chat.leaf })
      assert.isUndefined(again.summaryNoteOn)
    }
    // Importing into the existing chats keeps their settings.
    const adopt = yield* open("Bob - adopt")
    yield* h.api.ChangeLcmSettings({ chatId: adopt.chatId, change: { recentMax: 30_000 } })
    yield* importStFolder(folder(["Bob - adopt"], "injected"))
    const kept = yield* h.api.GetLcmSettings({ chatId: adopt.chatId, leafSlotId: null })
    assert.isTrue(kept.stored!.enabled)
    assert.strictEqual(kept.stored!.recentMax, 30_000)
  })
)
