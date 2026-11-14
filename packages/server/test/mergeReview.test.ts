import { assert, describe, it } from "@effect/vitest"
import { NewVersion, type SlotId, type VersionId } from "@rp/shared/chat.ts"
import { generationOf } from "../src/assembler/types.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { historyTools } from "../src/agent/tools/history.ts"
import { listNotes } from "../src/agent/tools/notes.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { loreBook, loreEntry } from "./support/loreFixtures.ts"
import { Effect, Exit } from "effect"
import type { LibraryRef } from "@rp/shared/library.ts"
import { textField, valueField } from "@rp/shared/editing.ts"
import { runMergeStory, sentText } from "./support/mergeOrigin.ts"

// Real reader/assembler request proofs; all documents and model output are synthetic.
describe("merge review boundaries", () => {
  it.live("refuses a changed note beyond its preview excerpt", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "DOCKS-PAST")
        const note = yield* t.writer.CreateEntity({
          userId: t.userId,
          kind: "note",
          label: "Tide",
          subtitle: "",
          doc: {
            schema_version: 1,
            title: "Tide",
            content: "Long tide. ".repeat(30) + "OLD-TAIL",
            owner: { chat: source.chatId },
            placement: { mode: "section", section: "tail_end" },
            exportable: true
          },
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        yield* t.mark(source, { key: "note.activate", value: { note: note.entityId } })
        const seen = yield* t.preview(t.ledger, source, "separate")
        const opened = yield* t.api.OpenEditor({ refId: note.ref.id, chatNote: { ...source, slotId: null } })
        const draft = yield* t.api.SaveEditorDraft({
          refId: note.ref.id,
          scope: opened.chatNote!.scope,
          field: textField(["content"]),
          content: "Long tide. ".repeat(30) + "NEW-TAIL",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: opened.ref.headRevisionId
        })
        yield* t.api.CommitEditorDrafts({
          refId: note.ref.id,
          chatNote: { ...source, slotId: null },
          expectedRowVersion: opened.ref.rowVersion,
          fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
          message: null
        })
        const result = yield* Effect.exit(
          t.api.MergeChat({
            chatId: t.ledger.chatId,
            forkId: t.ledger.forkId,
            at: null,
            source,
            includeLeftOut: true,
            timelines: "separate",
            title: "Docks",
            framing: null,
            digest: seen.digest,
            notes: [note.entityId]
          })
        )
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "NEW-TAIL")
        assert.isTrue(Exit.isFailure(result), "an outdated note preview must be refused")
        assert.include(JSON.stringify(result), "MergeChanged")
      })
    )
  )

  it.live("brings the source's pinned card-note text and audience instead of its library head", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "DOCKS-PAST")
        const note = yield* t.writer.CreateEntity({
          userId: t.userId,
          kind: "note",
          label: "Pinned",
          subtitle: "",
          doc: {
            schema_version: 1,
            title: "Pinned",
            content: "PINNED-PRIVATE",
            owner: { card: kai },
            condition: { when: "own_turn" },
            placement: { mode: "section", section: "tail_end" },
            exportable: true
          },
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        yield* t.mark(source, {
          key: "note.binding",
          value: { note: note.entityId, revision: note.ref.headRevisionId }
        })
        yield* t.mark(source, { key: "note.activate", value: { note: note.entityId } })
        const save = (ref: LibraryRef, field: string, content: string) =>
          Effect.gen(function* () {
            const opened = yield* t.api.OpenEditor({ refId: ref.id })
            const draft = yield* t.api.SaveEditorDraft({
              refId: ref.id,
              field,
              content,
              draftId: null,
              expectedRowVersion: null,
              expectedSession: null,
              baseRevisionId: opened.ref.headRevisionId
            })
            return yield* t.api.CommitEditorDrafts({
              refId: ref.id,
              expectedRowVersion: opened.ref.rowVersion,
              fields: [{ field: draft.key.field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
              message: null
            })
          })
        yield* save(note.ref, textField(["content"]), "LIBRARY-PUBLIC")
        yield* save(note.ref, valueField(["condition"]), JSON.stringify({ when: "always" }))
        const before = sentText(yield* t.requestFor(source, kai))
        assert.include(before, "PINNED-PRIVATE")
        assert.notInclude(before, "LIBRARY-PUBLIC")
        const seen = yield* t.preview(t.ledger, source, "separate")
        const row = seen.notes!.find((n) => n.id === note.entityId)!
        yield* t.api.MergeChat({
          chatId: t.ledger.chatId,
          forkId: t.ledger.forkId,
          at: null,
          source,
          includeLeftOut: true,
          timelines: "separate",
          title: "Docks",
          framing: null,
          digest: seen.digest,
          notes: [row.id]
        })
        assert.include(sentText(yield* t.requestFor(t.ledger, kai)), "PINNED-PRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "PINNED-PRIVATE")
        assert.notInclude(sentText(yield* t.requestFor(t.ledger, t.mira)), "LIBRARY-PUBLIC")
        assert.strictEqual(row.when, "own_turn", "the row describes the revision the source reads")
        assert.include(row.excerpt, "PINNED-PRIVATE")
      })
    )
  )

  it.live("does not treat a cast join without an authored message as having read this chat", () =>
    runMergeStory((t) =>
      Effect.gen(function* () {
        const kai = yield* t.card("Kai")
        const source = yield* t.chat("Docks", [kai])
        yield* t.say(source, kai, "DOCKS-PAST")
        yield* t.say(t.ledger, t.mira, "HOME-PRIVATE")
        yield* t.mark(t.ledger, { key: "participant.join", value: { entity: kai } })
        yield* t.merge(t.ledger, source, "separate")
        const request = sentText(yield* t.requestFor(t.ledger, kai))
        assert.include(request, "DOCKS-PAST")
        assert.notInclude(request, "HOME-PRIVATE")
        assert.include(sentText(yield* t.requestFor(t.ledger, t.mira)), "HOME-PRIVATE")
      })
    )
  )

  it.live(
    "keeps replies, history tools, lore and earlier regenerations inside each character's history",
    () =>
      runMergeStory((t) =>
        Effect.gen(function* () {
          const kai = yield* t.card("Kai")
          const source = yield* t.chat("Docks", [kai])
          yield* t.say(source, kai, "DOCKSSECRET")
          yield* t.say(t.ledger, t.mira, "HOMESECRET")
          const earlier = yield* t.say(t.ledger, t.mira, "REGEN-TARGET")
          yield* t.say(t.ledger, t.mira, "HOMEFUTURE")
          const book = yield* t.writer.CreateEntity({
            userId: t.userId,
            kind: "lorebook",
            label: "Boundary lore",
            subtitle: "",
            doc: loreBook([
              loreEntry({ keys: ["DOCKSSECRET"], content: "DOCKS-LORE", scan_depth: 100 }, 1),
              loreEntry({ keys: ["HOMESECRET"], content: "HOME-LORE", scan_depth: 100 }, 2)
            ]).document,
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
          yield* t.mark(t.ledger, { key: "lorebook.attach", value: { ref: book.ref.id } })
          yield* t.ownTurnNote(kai, "KAI-NOTE-PRIVATE")
          const joined = yield* t.merge(t.ledger, source, "separate")
          yield* t.say(t.ledger, t.mira, "SHAREDAFTER")
          for (const [speaker, known, unknown] of [
            [t.mira, "HOME", "DOCKS"],
            [kai, "DOCKS", "HOME"]
          ] as const) {
            const snapshot = yield* t.requestFor(t.ledger, speaker)
            const text = sentText(snapshot)
            assert.include(text, known + "SECRET")
            assert.include(text, known + "-LORE")
            assert.notInclude(text, unknown + "SECRET")
            assert.notInclude(text, unknown + "-LORE")
            assert.include(text, "SHAREDAFTER")
            const context: ToolContext = {
              userId: t.userId,
              chatId: t.ledger.chatId,
              forkId: t.ledger.forkId,
              slotId: snapshot.inputs.slotId as SlotId,
              versionId: snapshot.inputs.versionId as VersionId,
              leafSlotId: snapshot.inputs.leafSlotId as SlotId,
              viewers: generationOf(snapshot).viewers,
              speaker,
              rolloutId: "review",
              toolCallId: "review",
              cache: new Map(),
              reader: t.reader,
              writer: t.writer
            }
            for (const [id, args] of [
              ["search_chat", { query: unknown + "SECRET" }],
              ["read_messages", { from: 1, count: 30 }],
              ["search_summaries", { query: unknown + "SECRET" }],
              ["expand_summary", { messages: "1–5" }]
            ] as const) {
              const out = yield* historyTools.find((tool) => tool.id === id)!.execute(context, args as never)
              if (id === "search_chat" || id === "search_summaries")
                assert.match(
                  out.text,
                  /^No .*match|^History tools are unavailable|^This chat has no summaries\.$/,
                  id + " returns no matches"
                )
              else assert.notInclude(out.text, unknown + "SECRET", id + " keeps the same audience")
              if (id === "read_messages") assert.include(out.text, known + "SECRET")
            }
            const notes = yield* listNotes.execute(context, {})
            if (speaker === kai) assert.include(notes.text, "KAI-NOTE-PRIVATE")
            else assert.notInclude(notes.text, "KAI-NOTE-PRIVATE")
          }
          const previous = yield* t.reader.GetSlot({ userId: t.userId, slotId: earlier, forkId: t.ledger.forkId })
          const regen = yield* t.writer.AddSelectedVersion({
            userId: t.userId,
            slotId: earlier,
            forkId: t.ledger.forkId,
            expectedRowVersion: previous.entry.rowVersion,
            version: new NewVersion({
              speakerEntityId: t.mira,
              writer: "model",
              content: "",
              status: "generating",
              macroMode: "verbatim",
              origin: "generated"
            })
          })
          const built = yield* t.reader.AssembleContext({
            userId: t.userId,
            chatId: t.ledger.chatId,
            forkId: regen.forkId,
            slotId: earlier,
            versionId: regen.version.id,
            now: 1,
            timeZone: "UTC",
            frozen: null
          })
          const premerge = JSON.parse(built.snapshot)
          assert.include(sentText(premerge), "HOMESECRET")
          assert.notInclude(sentText(premerge), "HOMEFUTURE")
          assert.notInclude(sentText(premerge), "DOCKSSECRET")
          assert.notInclude(sentText(premerge), "SHAREDAFTER")
          assert.notInclude(premerge.inputs.stretchViewers ?? [], kai)
          void joined
        })
      ),
    { timeout: 120_000 }
  )

  it.live(
    "Undo restores the branch's request while an inheriting fork keeps its brought note",
    () =>
      runMergeStory((t) =>
        Effect.gen(function* () {
          const kai = yield* t.card("Kai")
          const source = yield* t.chat("Docks", [kai])
          yield* t.say(source, kai, "DOCKS-UNDO")
          const note = yield* t.api.CreateChatNote({
            ...source,
            title: "Tide",
            content: "BROUGHT-UNDO {{char}} {{group}}"
          })
          yield* t.mark(source, { key: "note.activate", value: { note: note.entityId } })
          const before = yield* t.requestFor(t.ledger, t.mira)
          const seen = yield* t.preview(t.ledger, source, "separate")
          const merged = yield* t.api.MergeChat({
            chatId: t.ledger.chatId,
            forkId: t.ledger.forkId,
            at: null,
            source,
            includeLeftOut: true,
            timelines: "separate",
            title: "Docks",
            framing: null,
            digest: seen.digest,
            notes: [note.entityId]
          })
          const child = yield* t.writer.CreateFork({
            userId: t.userId,
            chatId: t.ledger.chatId,
            fromForkId: t.ledger.forkId,
            atSlotId: merged.entry.slotId
          })
          const childAt = { chatId: t.ledger.chatId, forkId: child.fork.id }
          assert.include(sentText(yield* t.requestFor(childAt, t.mira)), "BROUGHT-UNDO Mira")
          yield* t.writer.DeleteMessage({ userId: t.userId, slotId: merged.entry.slotId, forkId: t.ledger.forkId })
          assert.deepStrictEqual((yield* t.requestFor(t.ledger, t.mira)).request, before.request)
          assert.include(sentText(yield* t.requestFor(childAt, kai)), "BROUGHT-UNDO Mira, Wren, Nara, Kai")
          assert.include(sentText(yield* t.requestFor(source, kai)), "BROUGHT-UNDO Kai")
        })
      ),
    { timeout: 120_000 }
  )

  it.live(
    "an older separate merge's saved parallel-span boundary cannot disclose this chat's prefix",
    () =>
      runMergeStory((t) =>
        Effect.gen(function* () {
          const kai = yield* t.card("Kai")
          const source = yield* t.chat("Docks", [kai])
          yield* t.say(source, kai, "DOCKS-LEGACY")
          const before = (yield* t.tip(t.ledger))!
          yield* t.say(t.ledger, t.mira, "HOME-LEGACY-LATE")
          const joined = yield* t.merge(t.ledger, source, "separate")
          // Recreate the stored boundary written by master's API, without changing the baseline.
          const trigger = yield* fixtureSql(
            t.dataDir,
            [{ sql: "SELECT sql FROM sqlite_schema WHERE name = 'chat_merges_frozen'" }],
            { readOnly: true }
          )
          yield* fixtureSql(t.dataDir, [
            { sql: "DROP TRIGGER chat_merges_frozen" },
            {
              sql: "UPDATE chat_merges SET stretch_before_slot_id = ? WHERE slot_id = ?",
              params: [before, joined.slotId]
            },
            { sql: String(trigger[0]![0]!.sql) }
          ])
          const text = sentText(yield* t.requestFor(t.ledger, kai))
          assert.include(text, "DOCKS-LEGACY")
          assert.notInclude(text, "HOME-LEGACY-LATE")
          assert.notInclude(text, "Late again")
          assert.notInclude(text, "The road flooded")
        })
      ),
    { timeout: 120_000 }
  )

  it.live(
    "refuses bringing a card field replacement already claimed by a destination chat note",
    () =>
      runMergeStory((t) =>
        Effect.gen(function* () {
          const kai = yield* t.card("Kai")
          const source = yield* t.chat("Docks", [kai])
          yield* t.say(source, kai, "DOCKS-CLASH")
          yield* t.api.CreateChatNote({
            chatId: t.ledger.chatId,
            forkId: t.ledger.forkId,
            title: "Reserved description",
            content: "DESTINATION-CLAIM",
            replaces: { kind: "card_field", card: kai, field: "description" }
          })
          const note = yield* t.writer.CreateEntity({
            userId: t.userId,
            kind: "note",
            label: "Source description",
            subtitle: "",
            doc: {
              schema_version: 1,
              title: "Source description",
              content: "SOURCE-CLAIM",
              owner: { card: kai },
              replaces: { kind: "card_field", field: "description" },
              placement: { mode: "section", section: "card" },
              exportable: true
            },
            schemaVersion: 1,
            origin: "user",
            sourcePath: null
          })
          yield* t.mark(source, { key: "note.activate", value: { note: note.entityId } })
          const before = yield* t.requestFor(t.ledger, t.mira)
          const seen = yield* t.preview(t.ledger, source, "separate")
          const result = yield* Effect.exit(
            t.api.MergeChat({
              chatId: t.ledger.chatId,
              forkId: t.ledger.forkId,
              at: null,
              source,
              includeLeftOut: true,
              timelines: "separate",
              title: "Docks",
              framing: null,
              digest: seen.digest,
              notes: [note.entityId]
            })
          )
          const after = yield* t.requestFor(t.ledger, t.mira)
          assert.deepStrictEqual(
            after.request,
            before.request,
            "a refused clashing note must leave the request unchanged"
          )
          assert.isTrue(Exit.isFailure(result))
          assert.include(
            seen.notes!.find((n) => n.id === note.entityId)!.conflict!,
            "Only one note can replace this target"
          )
        })
      ),
    { timeout: 120_000 }
  )
})
