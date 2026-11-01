// Imported summaries edited through the same HTTP boundary as the chat's note editor.
import { expect, it } from "vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@rp/shared/chat.ts"
import { textField } from "@rp/shared/editing.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { sendStFile } from "./support/stUpload.ts"
import { stFolder } from "./support/stFolder.ts"

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const jsonl = (...lines: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(lines.map((line) => JSON.stringify(line)).join("\n"))
const line = (name: string, mes: string, minute: number, extra = {}) => ({
  name,
  mes,
  is_user: name === "Sam",
  send_date: new Date(Date.UTC(2025, 0, 1, 0, minute)).toISOString(),
  extra
})

it.each([0, 1])("corrects an imported summary at older leaf %i without changing the library import", async (index) => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* client()
      const reader = yield* Reader
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id
      const { importId } = yield* api.StartStImport({ unsupported: [] })
      yield* sendStFile(
        importId,
        "settings.json",
        encode({
          extension_settings: {
            memory: { position: 0, role: 1, depth: 2, template: "[{{summary}}]" },
            disabledExtensions: []
          }
        })
      )
      yield* sendStFile(
        importId,
        "characters/Mira_new.png",
        stFolder("ST/data/default-user/").get("ST/data/default-user/characters/Mira_new.png")!
      )
      const imported = yield* sendStFile(
        importId,
        "chats/Mira_new/review.jsonl",
        jsonl(
          { user_name: "Sam", character_name: "Mira", chat_metadata: {} },
          line("Mira", "Greeting", 0),
          line("Sam", "Earlier summary point", 1, { memory: "EARLY SUMMARY" }),
          line("Mira", "Later summary point", 2, { memory: "LATE SUMMARY" }),
          line("Sam", "End", 3)
        )
      )
      expect(imported.outcome).toBe("added")
      const [chat] = yield* api.ListChats({ limit: 10, before: null })
      const chatId = chat!.id
      const path = yield* api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 20 })
      const leaf = path.entries[index]!.slotId
      const note = (yield* api.ListChatNotes({ chatId, slotId: leaf })).find((n) => n.doc.kind === "imported_summary")!
      const expected = index === 1 ? "EARLY SUMMARY" : ""
      expect(note.doc.content).toBe(expected)
      expect(note.doc.template).toBe("[{{summary}}]")
      expect(note.doc.placement).toEqual({ mode: "section", section: "after_main_prompt", role: "user" })
      const targetAt = (parentSlotId: SlotId) =>
        writer.AppendMessage({
          userId,
          chatId,
          parentSlotId,
          branch: true,
          version: new NewVersion({
            speakerEntityId: null,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          }),
          commitDraft: null
        })
      const target = yield* targetAt(leaf)
      const assemble = (at: typeof target) =>
        reader
          .AssembleContext({
            userId,
            chatId,
            slotId: at.slotId,
            versionId: at.version.id,
            now: 0,
            timeZone: "UTC",
            frozen: null
          })
          .pipe(Effect.map(({ snapshot }) => JSON.parse(snapshot) as ContextSnapshot))
      const prior = yield* assemble(target)
      expect(JSON.stringify(prior.request)).not.toContain("LATE SUMMARY")
      if (expected) expect(JSON.stringify(prior.request)).toContain(expected)
      else expect(JSON.stringify(prior.request)).not.toContain("SUMMARY")

      const chatNote = { chatId, slotId: leaf }
      const refId = note.ref.id
      const field = textField(["content"])
      const opened = yield* api.OpenEditor({ refId, chatNote })
      expect(opened.doc.content).toBe(expected)
      expect(opened.doc.template).toBe("[{{summary}}]")
      const draft = yield* api.SaveEditorDraft({
        refId,
        field,
        scope: opened.chatNote!.scope,
        draftId: null,
        content: "CORRECTED SUMMARY",
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId,
        chatNote,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      const assembled = yield* assemble(target)
      expect(JSON.stringify(assembled.request)).toContain("[CORRECTED SUMMARY]")
      const saved = yield* api.OpenEditor({ refId, chatNote })
      expect(saved.doc.content).toBe("CORRECTED SUMMARY")
      expect(saved.doc.template).toBe("[{{summary}}]")
      expect((yield* api.ListChatNotes({ chatId, slotId: leaf })).find((n) => n.ref.id === refId)?.doc.content).toBe(
        "CORRECTED SUMMARY"
      )
      expect(saved.doc).not.toHaveProperty("source_slot_id")
      const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(assembled) })
      expect(rebuilt._tag).toBe("Rebuilt")
      if (rebuilt._tag === "Rebuilt") expect(JSON.parse(rebuilt.snapshot)).toEqual(assembled)
      if (index === 1) {
        // The ancestor is outside the edit's binding.
        expect(
          (yield* api.OpenEditor({ refId, chatNote: { chatId, slotId: path.entries[0]!.slotId } })).doc.content
        ).toBe("")
      }
      expect((yield* api.OpenEditor({ refId })).doc.content).toBe("LATE SUMMARY")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
  )
})
