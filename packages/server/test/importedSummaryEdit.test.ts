// Imported summaries edited through the same HTTP boundary as the chat's note editor.
import { expect, it } from "vitest"
import { Effect } from "effect"
import { NewVersion, type SlotId } from "@dreamspan/shared/chat.ts"
import { textField } from "@dreamspan/shared/editing.ts"
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

it.each([0, 1])(
  "an imported summary opened at older leaf %i is corrected at the latest message, the library import unchanged",
  async (index) => {
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
        const note = (yield* api.ListChatNotes({ chatId, slotId: leaf })).find(
          (n) => n.doc.kind === "imported_summary"
        )!
        const expected = index === 1 ? "EARLY SUMMARY" : ""
        expect(note.doc.content).toBe(expected)
        expect(note.doc.template).toBe("[{{summary}}]")
        expect(note.doc.placement).toEqual({ mode: "section", section: "after_main_prompt", role: "user" })
        const main = chat!.currentForkId!
        const tip = path.entries.at(-1)!.slotId
        const targetAt = (parentSlotId: SlotId, branch: boolean) =>
          writer.AppendMessage({
            userId,
            chatId,
            forkId: main,
            parentSlotId,
            branch,
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
        const assemble = (at: { readonly slotId: SlotId; readonly version: { readonly id: never } }) =>
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

        // Opened through the older message's position (only the API names one), the editor edits
        // the chat's current state (owner, 2026-11-02): the latest summary, corrected from there on.
        const chatNote = { chatId, forkId: main, slotId: leaf }
        const refId = note.ref.id
        const field = textField(["content"])
        const opened = yield* api.OpenEditor({ refId, chatNote })
        expect(opened.doc.content).toBe("LATE SUMMARY")
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
        const saved = yield* api.OpenEditor({ refId, chatNote })
        expect(saved.doc.content).toBe("CORRECTED SUMMARY")
        expect(saved.doc.template).toBe("[{{summary}}]")
        expect(saved.doc).not.toHaveProperty("source_slot_id")
        // The older message keeps what it had; the latest has the correction.
        const listed = (slotId: SlotId) =>
          Effect.map(
            api.ListChatNotes({ chatId, forkId: main, slotId }),
            (notes) => notes.find((n) => n.ref.id === refId)?.doc.content
          )
        expect(yield* listed(leaf)).toBe(expected)
        expect(yield* listed(tip)).toBe("CORRECTED SUMMARY")

        // A reply at the older message is assembled as it was; one after the latest takes the correction.
        const earlier = yield* assemble((yield* targetAt(leaf, true)) as never)
        expect(JSON.stringify(earlier.request)).not.toContain("CORRECTED")
        if (expected) expect(JSON.stringify(earlier.request)).toContain(expected)
        else expect(JSON.stringify(earlier.request)).not.toContain("SUMMARY")
        const assembled = yield* assemble((yield* targetAt(tip, false)) as never)
        expect(JSON.stringify(assembled.request)).toContain("[CORRECTED SUMMARY]")
        const rebuilt = yield* reader.RebuildContext({ userId, snapshot: JSON.stringify(assembled) })
        expect(rebuilt._tag).toBe("Rebuilt")
        if (rebuilt._tag === "Rebuilt") expect(JSON.parse(rebuilt.snapshot)).toEqual(assembled)
        // The library's import is unchanged.
        expect((yield* api.OpenEditor({ refId })).doc.content).toBe("LATE SUMMARY")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
    )
  }
)
