// Re-import is addressed to a file's fork, and must preserve that fork's local state.
import { assert, layer } from "@effect/vitest"
import { textField } from "@rp/shared/editing.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { serverLayer, testConfig } from "./support/config.ts"
import { card, header, jsonl, message } from "./support/stFolder.ts"
import { importStFolder } from "./support/stUpload.ts"

const lines = [
  message({ name: "Alice", mes: "Synthetic greeting", minute: 0 }),
  message({ name: "Sam", mes: "Synthetic reply", minute: 1, user: true })
]
const child = (note: string, scene: string, extend: boolean, history = lines) =>
  jsonl([
    header({ main_chat: "main", note_prompt: note, note_interval: 1, variables: { scene, untouched: scene } }),
    ...history,
    ...(extend ? [message({ name: "Alice", mes: "ST continuation", minute: 2 })] : [])
  ])
const setup = Effect.fnUntraced(function* (tag: string, count = 2) {
  const history = Array.from(
    { length: count },
    (_, i) =>
      lines[i] ??
      message({ name: i % 2 ? "Sam" : "Alice", user: i % 2 === 1, mes: `Synthetic message ${i}`, minute: i })
  )
  const source = `chats/${tag}/Branch.jsonl`
  const mainSource = `chats/${tag}/main.jsonl`
  const cardPath = `characters/${tag}.png`
  const cardBytes = card("Alice", "Synthetic greeting")
  const reimport = (note: string, scene: string) =>
    importStFolder(
      new Map([
        [cardPath, cardBytes],
        [source, child(note, scene, true, history)]
      ])
    )
  const { api } = yield* importStFolder(
    new Map([
      [cardPath, cardBytes],
      [mainSource, jsonl([header({}), ...history])],
      [source, child("Imported note", "old", false, history)]
    ])
  )
  const userId = (yield* api.Whoami()).id
  const reader = yield* Reader
  const records = (yield* reader.StImportSources({ userId })).chats
  const branch = records.find((r) => r.source === source)!
  const parent = records.find((r) => r.source === mainSource)!
  const read = Effect.fnUntraced(function* (forkId = branch.forkId) {
    const fork = (yield* api.ListForks({ chatId: branch.chatId })).find((f) => f.id === forkId)!
    return foldState(yield* reader.StateEventsAt({ userId, chatId: branch.chatId, forkId, slotId: fork.tipSlotId }))
  })
  const notes = Effect.fnUntraced(function* () {
    const fork = (yield* api.ListForks({ chatId: branch.chatId })).find((f) => f.id === branch.forkId)!
    return yield* api.ListChatNotes({ chatId: branch.chatId, forkId: branch.forkId, slotId: fork.tipSlotId })
  })
  return { api, userId, branch, parent, read, notes, reimport, source, cardPath, cardBytes, history }
})

layer(serverLayer(testConfig()), { excludeTestServices: true, timeout: "180 seconds" })(
  "ST re-import preserves local fork state",
  (it) => {
    it.effect("a changed card file merges only into its imported card, leaving its fork alone", () =>
      Effect.gen(function* () {
        const { api, userId, cardPath } = yield* setup("card-fork-reimport")
        const reader = yield* Reader
        const writer = yield* Writer
        const original = (yield* reader.StImportSources({ userId })).library.find((r) => r.sourcePath === cardPath)!
        const before = yield* api.OpenEditor({ refId: original.refId })
        const fork = yield* api.ForkCard({
          refId: original.refId,
          name: "Independent Alice",
          nickname: "",
          characterVersion: "fork",
          moveDrafts: false
        })
        const forkBefore = yield* api.OpenEditor({ refId: fork.id })
        yield* writer.EditRef({
          userId,
          refId: original.refId,
          doc: { ...before.doc, personality: "Local choice" },
          expectedRowVersion: before.ref.rowVersion,
          message: null,
          commitDraft: null
        })
        yield* importStFolder(
          new Map([[cardPath, card("Alice", "Synthetic greeting", {}, { description: "Changed file definition" })]])
        )
        const after = yield* api.OpenEditor({ refId: original.refId })
        assert.strictEqual(after.doc.description, "Changed file definition")
        assert.strictEqual(after.doc.personality, "Local choice")
        assert.strictEqual(after.ref.followsRefId, null)
        assert.isFalse(after.ref.updateAvailable)
        assert.deepStrictEqual(yield* api.OpenEditor({ refId: fork.id }), forkBefore)
        const matched = (yield* reader.StImportSources({ userId })).library.filter((r) => r.sourcePath === cardPath)
        assert.deepStrictEqual(
          matched.map((r) => r.refId),
          [original.refId]
        )
      })
    )

    for (const localInChild of [true, false])
      it.effect(`local variable choice in ${localInChild ? "file" : "other"} fork`, () =>
        Effect.gen(function* () {
          const { userId, branch, parent, read, reimport } = yield* setup(`variable-${localInChild}`)
          const forkId = localInChild ? branch.forkId : parent.forkId
          yield* (yield* Writer).AddStateEvent({
            userId,
            chatId: branch.chatId,
            forkId,
            slotId: branch.end,
            versionId: null,
            scope: null,
            data: { key: "var.set", value: { name: "scene", value: "Local choice" } }
          })
          yield* reimport("Imported note", "new")
          assert.strictEqual((yield* read()).vars.scene, localInChild ? "Local choice" : "new")
          assert.strictEqual((yield* read()).vars.untouched, "new")
          if (!localInChild) assert.strictEqual((yield* read(parent.forkId)).vars.scene, "Local choice")
        })
      )

    for (const count of [2, 205])
      it.effect(`a writer change in ST retains a local suffix edit across ${count} messages`, () =>
        Effect.gen(function* () {
          const { api, branch, parent, source, cardPath, cardBytes, history } = yield* setup(
            `writer-change-local-edit-${count}`,
            count
          )
          const path = yield* api.ReadPath({
            chatId: branch.chatId,
            forkId: branch.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          const slot = path.entries.at(-1)!
          yield* api.EditVersion({
            forkId: branch.forkId,
            slotId: slot.slotId,
            sourceVersionId: slot.version.id,
            expectedRowVersion: slot.rowVersion,
            content: "Local suffix text"
          })
          const before = (yield* api.ListForks({ chatId: branch.chatId })).find((f) => f.id === branch.forkId)!
          const changed = jsonl([
            header({ main_chat: "main" }),
            { ...history[0]!, is_user: true },
            ...history.slice(1),
            message({ name: "Alice", mes: "New ST tail", minute: count })
          ])
          yield* importStFolder(
            new Map([
              [cardPath, cardBytes],
              [source, changed]
            ])
          )
          const after = yield* api.ReadPath({
            chatId: branch.chatId,
            forkId: branch.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          assert.strictEqual(after.entries.at(-1)!.version.content, "Local suffix text")
          assert.strictEqual(
            (yield* api.ListForks({ chatId: branch.chatId })).find((f) => f.id === branch.forkId)!.tipSlotId,
            before.tipSlotId
          )
          const parentPath = yield* api.ReadPath({
            chatId: branch.chatId,
            forkId: parent.forkId,
            leafSlotId: null,
            range: { _tag: "Bottom" },
            limit: 100
          })
          assert.strictEqual(parentPath.entries.at(-1)!.version.content, history.at(-1)!.mes)
        })
      )

    it.effect("editing a shared-tip note addresses the viewed fork while its parent is current", () =>
      Effect.gen(function* () {
        const { api, branch, parent, notes, read } = yield* setup("shared-tip-editor")
        const note = (yield* notes()).find((n) => n.doc.title === "Author's Note")!
        const chatNote = { chatId: branch.chatId, forkId: branch.forkId, slotId: branch.end }
        const opened = yield* api.OpenEditor({ refId: note.ref.id, chatNote })
        const field = textField(["content"])
        const draft = yield* api.SaveEditorDraft({
          refId: note.ref.id,
          field,
          // A chat's own note's drafts are its branch's.
          scope: opened.chatNote!.scope,
          draftId: null,
          content: "Only this fork's note",
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        yield* api.CommitEditorDrafts({
          refId: note.ref.id,
          chatNote,
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        assert.isUndefined((yield* read(parent.forkId)).noteRevisions[note.ref.entityId])
        assert.isDefined((yield* read()).noteRevisions[note.ref.entityId])
        assert.strictEqual((yield* notes()).find((n) => n.ref.id === note.ref.id)!.doc.content, "Only this fork's note")
        assert.strictEqual(
          (yield* api.OpenEditor({ refId: note.ref.id, chatNote })).doc.content,
          "Only this fork's note"
        )
        const foreign = yield* setup("foreign-editor-fork")
        assert.strictEqual(
          (yield* Effect.flip(
            api.OpenEditor({ refId: note.ref.id, chatNote: { ...chatNote, forkId: foreign.branch.forkId } })
          ))._tag,
          "NotFound"
        )
      })
    )

    for (const change of ["off", "edit", "delete", "other fork"] as const)
      it.effect(`preserves a locally ${change} imported note when ST changes its text`, () =>
        Effect.gen(function* () {
          const { api, branch, parent, notes, reimport } = yield* setup(`note-${change}`)
          const note = (yield* notes()).find((n) => n.doc.title === "Author's Note")!
          if (change === "off" || change === "other fork")
            yield* api.ChangeCast({
              chatId: branch.chatId,
              forkId: change === "other fork" ? parent.forkId : branch.forkId,
              slotId: branch.end,
              change: { _tag: "Note", entityId: note.ref.entityId, active: false }
            })
          else if (change === "delete") yield* api.DeleteNote({ noteRefId: note.ref.id })
          else {
            const chatNote = { chatId: branch.chatId, forkId: branch.forkId, slotId: branch.end }
            const opened = yield* api.OpenEditor({ refId: note.ref.id, chatNote })
            const field = textField(["content"])
            const draft = yield* api.SaveEditorDraft({
              refId: note.ref.id,
              field,
              scope: opened.chatNote!.scope,
              draftId: null,
              content: "Local note text",
              expectedRowVersion: null,
              expectedSession: null,
              baseRevisionId: opened.ref.headRevisionId
            })
            yield* api.CommitEditorDrafts({
              refId: note.ref.id,
              chatNote,
              expectedRowVersion: opened.ref.rowVersion,
              fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
              message: null
            })
          }
          yield* reimport("Changed in ST", "new")
          const after = yield* notes()
          if (change === "other fork") {
            assert.isTrue(after.some((n) => n.active && n.doc.content === "Changed in ST"))
            return
          }
          assert.isFalse(after.some((n) => n.active && n.doc.content === "Changed in ST"))
          if (change !== "delete") {
            const retained = after.find((n) => n.ref.entityId === note.ref.entityId)!
            assert.strictEqual(retained.active, change === "edit")
            assert.strictEqual(retained.doc.content, change === "edit" ? "Local note text" : "Imported note")
          }
        })
      )
  }
)
