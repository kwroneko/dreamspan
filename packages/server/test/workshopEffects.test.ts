import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { Chat, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { newCardDoc, textField } from "@rp/shared/editing.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, login, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { validateToolArguments } from "@earendil-works/pi-ai"

type Api = Effect.Success<ReturnType<typeof client>>
const call = (name: string, args: unknown, id: string) => [
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
        },
        finish_reason: null
      }
    ]
  },
  {
    id: "cmpl-tool",
    object: "chat.completion.chunk",
    model: "mock",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]
const watch = (api: Api, chat: Chat) =>
  Effect.gen(function* () {
    const events: Array<ChatEvent> = []
    yield* api.SubscribeChat({ chatId: chat.id }).pipe(
      Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
      Effect.forkScoped
    )
    yield* eventually(() => events.length > 0)
    return events
  })
const edit = (api: Api, refId: RefId, content: string, key = "description") =>
  Effect.gen(function* () {
    const field = textField([key])
    const before = yield* api.OpenEditor({ refId })
    const draft = yield* api.SaveEditorDraft({
      refId,
      field,
      content,
      draftId: null,
      expectedRowVersion: null,
      expectedSession: null,
      baseRevisionId: before.ref.headRevisionId
    })
    return yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: before.ref.rowVersion,
      fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
      message: null
    })
  })
const fixture = (dataDir: string, api: Api) =>
  Effect.gen(function* () {
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `r-${chat.id}`
    yield* fixtureSql(dataDir, [
      {
        sql: "INSERT INTO rollouts(id,chat_id,kind,status,role,request_class,created_at,updated_at) VALUES (?,?,'workshop','running','assistant','interactive',1,1)",
        params: [rolloutId, chat.id]
      }
    ])
    const reader = yield* Reader
    const writer = yield* Writer
    const registry = yield* ExecutionRegistry
    const context: ToolContext = {
      userId: user.id,
      chatId: chat.id,
      forkId: chat.currentForkId,
      slotId: chat.activeLeafSlotId as SlotId,
      versionId: "unused" as VersionId,
      rolloutId,
      toolCallId: "create",
      leafSlotId: null,
      reader,
      writer,
      cache: new Map()
    }
    const run = (name: string, args: unknown, id = name) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never)
    return { context, run, writer, reader, user, chat, rolloutId }
  })

describe("workshop setup effects", () => {
  it.live("refuses to bin a created card after a user adds or changes an owned note", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const made = yield* f.run("create_card", { name: "With user work" }, "card")
      const refId = JSON.parse(made.text).id as RefId
      yield* api.CreateCardNote({ cardRefId: refId, title: "User's new note" })
      const effect = (yield* api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
      assert.strictEqual(yield* outcome(api.UndoRolloutEffect(effect)), "EffectUndoRefused")
      assert.strictEqual((yield* api.OpenEditor({ refId })).ref.label, "With user work")

      const cloned = yield* f.run("clone_card", { card: refId, name: "Copy with notes" }, "clone-notes")
      const effects = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).filter(
        (e) => e.toolCallId === "clone-notes"
      )
      const root = effects.find((e) => e.targetId === JSON.parse(cloned.text).entityId)!
      const note = effects.find((e) => e !== root)!
      yield* edit(api, note.undo!.refId as RefId, "A user's saved note.", "content")
      assert.strictEqual(yield* outcome(api.UndoRolloutEffect(root)), "EffectUndoRefused")
      const draftClone = yield* f.run("clone_card", { card: refId, name: "Copy with note draft" }, "clone-drafts")
      const draftEffects = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).filter(
        (e) => e.toolCallId === "clone-drafts"
      )
      const draftRoot = draftEffects.find((e) => e.targetId === JSON.parse(draftClone.text).entityId)!
      const draftNote = draftEffects.find((e) => e !== draftRoot)!
      const saved = yield* api.OpenEditor({ refId: draftNote.undo!.refId as RefId })
      yield* api.SaveEditorDraft({
        refId: saved.ref.id,
        field: textField(["content"]),
        content: "Still typing a note.",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: saved.ref.headRevisionId
      })
      assert.strictEqual(yield* outcome(api.UndoRolloutEffect(draftRoot)), "EffectUndoRefused")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("rejects unknown and oversized setup arguments before making changes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const registry = yield* ExecutionRegistry
      const invalid = [
        ["create_card", { name: "Keeper", permission: true }],
        ["create_card", { name: "Keeper", description: "x".repeat(65_537) }],
        ["create_card", { name: "Keeper", alternate_greetings: Array(33).fill("Hi") }],
        ["clone_card", { card: "Assistant", name: "Copy", moveDrafts: false }],
        ["start_chat", { cards: Array(17).fill("Assistant") }],
        ["start_chat", { cards: ["Assistant"], kind: "workshop" }],
        ["edit_card", { card: "Assistant", changes: [{ field: "description", text: "a", find: "b", replace: "c" }] }],
        ["edit_card", { card: "Assistant", changes: Array(33).fill({ field: "description", text: "a" }) }]
      ] as const
      for (const [name, args] of invalid) {
        const tool = toolForKind(registry, "workshop", name)!
        assert.throws(() =>
          validateToolArguments(
            { name, description: tool.description, parameters: tool.parameters },
            { type: "toolCall", name, id: "bad", arguments: args }
          )
        )
        assert.isTrue((yield* f.run(name, args, `bad-${name}`)).isError)
      }
      assert.isEmpty(yield* api.ListRolloutEffects({ chatId: f.chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("bounds persisted documents and the number of setup calls in one rollout", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const huge = "x".repeat(65_536)
      const oversized = yield* f.run(
        "create_card",
        { name: "Too large", description: huge, personality: huge, scenario: huge, first_message: huge },
        "huge"
      )
      assert.isTrue(oversized.isError)
      const source = yield* api.CreateCard({
        label: "Large source",
        name: "Large source",
        description: "é".repeat(131_073)
      })
      assert.isTrue((yield* f.run("clone_card", { card: source.id, name: "Too large a copy" }, "huge-clone")).isError)
      const greeting = yield* api.CreateCard({ label: "Many greetings", name: "Many greetings" })
      yield* f.writer.EditRef({
        userId: f.user.id,
        refId: greeting.id,
        expectedRowVersion: greeting.rowVersion,
        doc: { ...newCardDoc("Many greetings"), first_mes: "Hi", alternate_greetings: Array(33).fill("Hi again") },
        message: null,
        commitDraft: null
      })
      assert.isTrue((yield* f.run("start_chat", { cards: [greeting.id] }, "many-greetings")).isError)
      for (let i = 0; i < 32; i++)
        assert.isUndefined((yield* f.run("create_card", { name: `Bounded ${i}` }, `bounded-${i}`)).isError)
      const excess = yield* f.run("create_card", { name: "One too many" }, "excess")
      assert.isTrue(excess.isError)
      assert.lengthOf(yield* api.ListRolloutEffects({ chatId: f.chat.id, limit: 200 }), 32)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "makes the lighthouse keeper and starts her story through the provider, keeps changes across a resume, then undoes both",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const messages = request.body?.messages as Array<{
                role: string
                content: unknown
                tool_call_id?: string
              }>
              const text = JSON.stringify(messages)
              if (!text.includes("make a card for a lighthouse keeper"))
                return sse(res, completionChunks(["Ready."], {}))
              const toolResults = messages.filter((m) => m.role === "tool")
              const last = toolResults.at(-1)?.tool_call_id
              if (String(toolResults.at(-1)?.content).includes("may already have happened"))
                return sse(res, completionChunks(["That call needs checking first."], {}))
              sse(
                res,
                last === "start"
                  ? completionChunks(["Mara is in your library. The Skerry Light opens with her greeting."], {})
                  : last === "create"
                    ? call("start_chat", { cards: ["Mara Quill"], title: "The Skerry Light" }, "start")
                    : last === "lookup"
                      ? call(
                          "create_card",
                          {
                            name: "Mara Quill",
                            description: "A lighthouse keeper, 52.",
                            personality: "Watchful.",
                            scenario: "The Skerry Light.",
                            first_message: "The lamp's lit early tonight…"
                          },
                          "create"
                        )
                      : call("list_library", { kind: "card", query: "lighthouse" }, "lookup")
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
        const chat = yield* api.CreateWorkshop({})
        const initial = (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id)
        const events = yield* watch(api, chat)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "make a card for a lighthouse keeper and start a chat with her"
          })
        )
        const generated = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
        )
        yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
        assert.strictEqual(finished(events, generated.entry.version.id)!.status, "complete")
        const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
        assert.lengthOf(effects, 2)
        assert.sameMembers(
          effects.map((e) => e.kind),
          ["library.create", "chat.create"]
        )
        const steps = yield* api.GetRolloutSteps({ versionId: generated.entry.version.id })
        for (const [name, effectClass] of [
          ["create_card", "library"],
          ["start_chat", "setup"]
        ]) {
          const step = steps.find((entry) => entry.kind === "tool" && entry.tool === name)
          assert.isTrue(step?.kind === "tool")
          if (step?.kind === "tool") {
            assert.strictEqual(step.effect, "external")
            assert.strictEqual(step.effectClass, effectClass)
          }
        }
        const created = effects.find((e) => e.kind === "library.create")!
        const started = effects.find((e) => e.kind === "chat.create")!
        const mara = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.entityId === created.targetId)!
        const [revs, receipts, providerCalls] = yield* fixtureSql(
          config.dataDir,
          [
            { sql: "SELECT origin, origin_ref FROM entity_revisions WHERE entity_id = ?", params: [mara.entityId] },
            { sql: "SELECT tool_call_id FROM rollout_receipts WHERE rollout_id = ?", params: [created.rolloutId] },
            { sql: "SELECT id FROM llm_requests WHERE chat_id = ?", params: [started.targetId] }
          ],
          { readOnly: true }
        )
        assert.deepStrictEqual(revs, [{ origin: "agent", origin_ref: `${created.rolloutId}:create` }])
        assert.sameMembers(
          receipts!.map((r) => r.tool_call_id),
          ["create", "start"]
        )
        assert.isEmpty(providerCalls)
        const story = yield* api.GetChat({ chatId: started.targetId as Chat["id"] })
        assert.strictEqual(story.kind, "rp")
        const path = yield* api.ReadPath({
          chatId: story.id,
          leafSlotId: story.activeLeafSlotId,
          range: { _tag: "Bottom" },
          limit: 10
        })
        assert.deepStrictEqual(
          path.entries.map((e) => e.version.content),
          ["The lamp's lit early tonight…"]
        )
        const slot = yield* (yield* Reader).GetSlot({
          userId: (yield* api.Whoami()).id,
          slotId: generated.entry.slotId
        })
        const material = yield* (yield* Reader).RolloutMaterial({
          userId: (yield* api.Whoami()).id,
          versionId: generated.entry.version.id
        })
        const transcript = JSON.parse(material.transcript!) as Array<{ role: string; toolCallId?: string }>
        const beforeResult = transcript.findIndex((m) => m.role === "toolResult" && m.toolCallId === "start")
        yield* fixtureSql(config.dataDir, [
          {
            sql: "UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?",
            params: [JSON.stringify(transcript.slice(0, beforeResult)), material.rolloutId]
          },
          { sql: "UPDATE rollouts SET status = 'interrupted' WHERE id = ?", params: [material.rolloutId] },
          { sql: "UPDATE versions SET status = 'interrupted' WHERE id = ?", params: [generated.entry.version.id] }
        ])
        const resumed = yield* api.ResumeVersion({
          versionId: generated.entry.version.id,
          expectedRowVersion: slot.entry.rowVersion
        })
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.lengthOf(yield* api.ListRolloutEffects({ chatId: chat.id }), 2)
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Mara Quill"),
          1
        )
        const currentSlot = yield* (yield* Reader).GetSlot({
          userId: (yield* api.Whoami()).id,
          slotId: generated.entry.slotId
        })
        const uncertain = yield* api.ResumeFromStep({
          versionId: resumed.version.id,
          step: 2,
          edit: { kind: "arguments", arguments: { cards: ["Mara Quill"], title: "Should not run" } },
          expectedRowVersion: currentSlot.entry.rowVersion
        })
        yield* eventually(() => finished(events, uncertain.version.id) !== undefined)
        assert.isTrue(
          (yield* api.GetRunTranscript({ versionId: uncertain.version.id })).entries.some(
            (e) => e.role === "toolResult" && e.isError && e.text.includes("may already have happened")
          )
        )
        assert.lengthOf(yield* api.ListRolloutEffects({ chatId: chat.id }), 2)
        // Neither version selection nor resume undoes library work.
        assert.isNull(
          (yield* api.ListRolloutEffects({ chatId: chat.id })).find((e) => e.kind === "library.create")!.undoneAt
        )
        yield* api.UndoRolloutEffect(started)
        yield* api.UndoRolloutEffect(created)
        assert.sameMembers(
          (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id),
          initial
        )
        assert.strictEqual(yield* outcome(api.GetChat({ chatId: story.id })), "NotFound")
        const again = yield* api.UndoRolloutEffect(created)
        assert.isNotNull(again.undoneAt)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "records atomic creates and edits, replays receipts, retains drafts and permissions, and undoes revisions in reverse order",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const made = yield* f.run(
          "create_card",
          { name: "Mara", description: "Old lamp.", persona: true, tags: ["coast"] },
          "create"
        )
        assert.isUndefined(made.isError, made.text)
        assert.deepStrictEqual(yield* f.run("create_card", { name: "Duplicate" }, "create"), made)
        const id = JSON.parse(made.text).id as RefId
        const saved = yield* api.OpenEditor({ refId: id })
        const [tags] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT tag FROM entity_tags WHERE entity_id = ?", params: [saved.ref.entityId] }],
          { readOnly: true }
        )
        assert.include(
          tags!.map((r) => r.tag),
          "persona"
        )
        const draft = yield* api.SaveEditorDraft({
          refId: id,
          field: textField(["description"]),
          content: "Still typing.",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: saved.ref.headRevisionId
        })
        const first = yield* f.run(
          "edit_card",
          { card: id, changes: [{ field: "description", find: "Old", replace: "New" }] },
          "edit1"
        )
        assert.isUndefined(first.isError, first.text)
        assert.deepStrictEqual(
          yield* f.run(
            "edit_card",
            { card: id, changes: [{ field: "description", find: "gone", replace: "X" }] },
            "edit1"
          ),
          first,
          "Receipt must precede argument validation"
        )
        assert.strictEqual(
          (yield* api.OpenEditor({ refId: id })).drafts.find((d) => d.id === draft.id)?.content,
          "Still typing."
        )
        const after = yield* api.OpenEditor({ refId: id })
        const grant = yield* f.writer.AgentReviseEntity({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "edit2",
          refId: id,
          expectedRowVersion: after.ref.rowVersion,
          doc: {
            ...after.doc,
            description: "Bright lamp.",
            agent_editable_fields: ["description"],
            regex_approved: true,
            html_approved: true
          }
        })
        assert.isString(grant)
        const current = yield* api.OpenEditor({ refId: id })
        assert.notInclude(current.doc.agent_editable_fields ?? [], "description")
        assert.notStrictEqual(current.doc.regex_approved, true)
        assert.notStrictEqual(current.doc.html_approved, true)
        const error = yield* Effect.flip(
          f.writer.AgentReviseEntity({
            userId: f.user.id,
            rolloutId: f.rolloutId,
            toolCallId: "stale",
            refId: id,
            expectedRowVersion: saved.ref.rowVersion,
            doc: saved.doc
          })
        )
        assert.strictEqual(error._tag, "StaleWrite")
        const all = yield* api.ListRolloutEffects({ chatId: f.chat.id })
        for (const name of ["edit2", "edit1"]) yield* api.UndoRolloutEffect(all.find((e) => e.toolCallId === name)!)
        const restored = yield* api.OpenEditor({ refId: id })
        assert.deepStrictEqual(restored.doc, saved.doc)
        assert.notStrictEqual(restored.ref.headRevisionId, saved.ref.headRevisionId)
        assert.strictEqual(
          yield* f.reader.RolloutReceipt({ userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "stale" }),
          null
        )
        // Existing drafts count as user work, so a newly created card with one cannot be binned by undo.
        const refused = yield* Effect.flip(api.UndoRolloutEffect(all.find((e) => e.kind === "library.create")!))
        assert.strictEqual(refused._tag, "EffectUndoRefused")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("refuses undo after a user edit and isolates effect reads, writes and undo between two users", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      const owner = yield* local.Whoami()
      yield* local.SetPassword({ userId: owner.id, currentPassword: null, newPassword: "alice-password" })
      const alice = yield* client({ cookie: (yield* login(owner.handle, "alice-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const f = yield* fixture(config.dataDir, alice)
      const b = yield* fixture(config.dataDir, bob)
      const made = yield* f.run("create_card", { name: "Owned card", description: "Original." }, "create")
      const id = JSON.parse(made.text).id as RefId
      const created = (yield* alice.ListRolloutEffects({ chatId: f.chat.id }))[0]!
      assert.strictEqual(yield* outcome(bob.ListRolloutEffects({ chatId: f.chat.id })), "NotFound")
      assert.strictEqual(yield* outcome(bob.UndoRolloutEffect(created)), "NotFound")
      assert.isEmpty(yield* bob.ListRolloutEffects({ chatId: b.chat.id }))
      assert.isTrue(
        (yield* b.run("edit_card", { card: id, changes: [{ field: "description", text: "Stolen" }] })).isError
      )
      assert.strictEqual(
        (yield* Effect.flip(
          b.writer.AgentReviseEntity({
            userId: b.user.id,
            rolloutId: b.rolloutId,
            toolCallId: "foreign",
            refId: id,
            expectedRowVersion: 1,
            doc: newCardDoc("Stolen")
          })
        ))._tag,
        "NotFound"
      )
      yield* edit(alice, id, "The user changed it.")
      const refused = yield* Effect.flip(alice.UndoRolloutEffect(created))
      assert.strictEqual(refused._tag, "EffectUndoRefused")
      if (refused._tag === "EffectUndoRefused") assert.include(refused.message, "Changed since")
      assert.strictEqual((yield* alice.OpenEditor({ refId: id })).doc.description, "The user changed it.")
      assert.isNull((yield* alice.ListRolloutEffects({ chatId: f.chat.id }))[0]!.undoneAt)
      const changed = yield* f.run(
        "edit_card",
        { card: id, changes: [{ field: "description", text: "Agent text." }] },
        "edit"
      )
      assert.isUndefined(changed.isError)
      const effect = (yield* alice.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "edit")!
      yield* edit(alice, id, "The user's second edit.")
      assert.strictEqual(yield* outcome(alice.UndoRolloutEffect(effect)), "EffectUndoRefused")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "clones through ForkCard with notes and drafts, records every created entity, and restores source draft text when undone",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const source = yield* api.CreateCard({ label: "Original", name: "Original", description: "Saved text." })
        yield* api.CreateCardNote({ cardRefId: source.id, title: "A note" })
        const field = textField(["description"])
        const draft = yield* api.SaveEditorDraft({
          refId: source.id,
          field,
          content: "Unsaved text.",
          draftId: null,
          expectedRowVersion: null,
          expectedSession: null,
          baseRevisionId: source.headRevisionId
        })
        const result = yield* f.run("clone_card", { card: "Original", name: "Copy" }, "clone")
        assert.isUndefined(result.isError, result.text)
        const copy = JSON.parse(result.text).id as RefId
        const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
        assert.lengthOf(effects, 2)
        assert.strictEqual(
          (yield* api.OpenEditor({ refId: copy })).drafts.find((d) => d.key.field === field)?.content,
          "Unsaved text."
        )
        assert.strictEqual(
          (yield* api.OpenEditor({ refId: source.id })).drafts.find((d) => d.id === draft.id)?.content,
          "Saved text."
        )
        for (const effect of effects.toSorted((a, b) => b.seq - a.seq)) yield* api.UndoRolloutEffect(effect)
        assert.strictEqual(
          (yield* api.OpenEditor({ refId: source.id })).drafts.find((d) => d.id === draft.id)?.content,
          "Unsaved text."
        )
        assert.strictEqual(yield* outcome(api.OpenEditor({ refId: copy })), "NotFound")
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Original"),
          1
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "rolls back the user operation if its effect insert fails, and enforces ownership and receipt constraints in the baseline",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const before = (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id)
        yield* fixtureSql(config.dataDir, [
          {
            sql: "CREATE TRIGGER fail_effect BEFORE INSERT ON rollout_effects BEGIN SELECT RAISE(ABORT, 'synthetic effect failure'); END"
          }
        ])
        const result = yield* f.run("create_card", { name: "Must roll back" }, "fail")
        assert.isTrue(result.isError)
        assert.sameMembers(
          (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id),
          before
        )
        assert.isNull(yield* f.reader.RolloutReceipt({ userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "fail" }))
        yield* fixtureSql(config.dataDir, [{ sql: "DROP TRIGGER fail_effect" }])
        const made = yield* f.run("create_card", { name: "Valid" }, "valid")
        assert.isUndefined(made.isError)
        const created = (yield* api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
        for (const [seq, target, kind] of [
          [-1, created.targetId, "library.create"],
          [1, "missing", "library.create"],
          [2, created.targetId, "chat.create"]
        ] as const) {
          const failure = yield* Effect.exit(
            fixtureSql(config.dataDir, [
              {
                sql: "INSERT INTO rollout_effects(rollout_id,tool_call_id,seq,kind,target_kind,target_id,title,created_at) VALUES (?, 'valid', ?, ?, 'entity', ?, 'Invalid', 1)",
                params: [f.rolloutId, seq, kind, target]
              }
            ])
          )
          assert.strictEqual(failure._tag, "Failure")
        }
        const failure = yield* Effect.exit(
          fixtureSql(config.dataDir, [
            {
              sql: "INSERT INTO rollout_effects(rollout_id,tool_call_id,seq,kind,target_kind,target_id,title,created_at) VALUES (?, 'no-receipt', 0, 'library.create', 'entity', ?, 'Invalid', 1)",
              params: [f.rolloutId, created.targetId]
            }
          ])
        )
        assert.strictEqual(failure._tag, "Failure")
        const recordFailure = yield* Effect.flip(
          f.writer.RecordRolloutEffects({
            userId: f.user.id,
            rolloutId: f.rolloutId,
            toolCallId: "invalid-record",
            result: "Must not commit",
            effects: [
              { kind: "library.create", targetKind: "entity", targetId: "missing", title: "Invalid target", undo: null }
            ]
          })
        )
        assert.strictEqual(recordFailure._tag, "StorageError")
        assert.isNull(
          yield* f.reader.RolloutToolReceipt({
            userId: f.user.id,
            rolloutId: f.rolloutId,
            toolCallId: "invalid-record"
          })
        )
        assert.lengthOf(yield* api.ListRolloutEffects({ chatId: f.chat.id }), 1)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )
  it.live(
    "undoes two revisions and then their creation, rejects partial text edits, and reports a moved head to the model",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        const initial = (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id)
        const made = yield* f.run("create_card", { name: "Keeper", description: "Original." }, "create")
        const refId = JSON.parse(made.text).id as RefId
        for (const [id, text] of [
          ["one", "One."],
          ["two", "Two."]
        ] as const) {
          assert.isUndefined(
            (yield* f.run("edit_card", { card: refId, changes: [{ field: "description", text }] }, id)).isError
          )
        }
        const invalid = yield* f.run(
          "edit_card",
          {
            card: refId,
            changes: [
              { field: "description", text: "Partial" },
              { field: "personality", find: "missing", replace: "bad" }
            ]
          },
          "bad"
        )
        assert.isTrue(invalid.isError)
        assert.strictEqual((yield* api.OpenEditor({ refId })).doc.description, "Two.")
        const effects = yield* api.ListRolloutEffects({ chatId: f.chat.id })
        for (const id of ["two", "one", "create"])
          yield* api.UndoRolloutEffect(effects.find((e) => e.toolCallId === id)!)
        assert.sameMembers(
          (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id),
          initial
        )
        assert.deepStrictEqual(yield* f.run("create_card", { name: "Do not recreate" }, "create"), made)
        assert.sameMembers(
          (yield* api.ListLibrary({ kind: "card" })).map((r) => r.id),
          initial
        )

        const userCard = yield* api.CreateCard({ label: "Race", name: "Race", description: "Before." })
        const registry = yield* ExecutionRegistry
        const tool = toolForKind(registry, "workshop", "edit_card")!
        const raced = yield* tool.execute(
          {
            ...f.context,
            toolCallId: "race",
            reader: {
              ...f.reader,
              OpenEditor: ((input: Parameters<typeof f.reader.OpenEditor>[0]) =>
                f.reader.OpenEditor(input).pipe(
                  Effect.tap((saved) =>
                    f.writer
                      .EditRef({
                        userId: f.user.id,
                        refId: input.refId,
                        doc: { ...saved.doc, description: "A simultaneous user save." },
                        expectedRowVersion: saved.ref.rowVersion,
                        message: null,
                        commitDraft: null
                      })
                      .pipe(Effect.orDie)
                  )
                )) as typeof f.reader.OpenEditor
            }
          },
          { card: userCard.id, changes: [{ field: "description", text: "Should not win." }] } as never
        )
        assert.isTrue(raced.isError)
        assert.include(raced.text, "Read it again")
        assert.strictEqual((yield* api.OpenEditor({ refId: userCard.id })).doc.description, "A simultaneous user save.")
        assert.isFalse((yield* api.ListRolloutEffects({ chatId: f.chat.id })).some((e) => e.toolCallId === "race"))
        assert.strictEqual(toolForKind(registry, "rp", "edit_card")!.effect, "chat_state")
        assert.strictEqual(tool.effect, "library")
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registry.kindTools.disable("workshop:edit_card")
            assert.isUndefined(toolForKind(registry, "workshop", "edit_card"))
            assert.strictEqual(toolForKind(registry, "rp", "edit_card")!.effect, "chat_state")
          })
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "starts greeting-only chats with a preset, freezes greeting macros, and refuses undo after the user adds a message",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        yield* f.run(
          "create_card",
          {
            name: "Keeper",
            first_message: "Hello {{user}}. {{random::red::blue}}",
            alternate_greetings: ["Another greeting."]
          },
          "card"
        )
        const result = yield* f.run(
          "start_chat",
          { cards: ["Keeper"], preset: "Workshop", greeting: 0, title: "Light" },
          "start"
        )
        assert.isUndefined(result.isError, result.text)
        const chatId = JSON.parse(result.text).chatId as Chat["id"]
        const chat = yield* api.GetChat({ chatId })
        const cast = yield* api.GetCast({ chatId, slotId: chat.activeLeafSlotId })
        assert.isNotNull(cast.preset)
        const path = yield* api.ReadPath({
          chatId,
          leafSlotId: chat.activeLeafSlotId,
          range: { _tag: "Bottom" },
          limit: 10
        })
        assert.lengthOf(path.entries, 1)
        assert.isNotNull(path.entries[0]!.version.frozenMacros)
        assert.strictEqual(path.entries[0]!.versionCount, 2)
        const bad = yield* f.run(
          "start_chat",
          { cards: ["Keeper"], model: "missing-model", title: "Must roll back" },
          "bad-model"
        )
        assert.isTrue(bad.isError)
        const [chats] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT id FROM chats WHERE title = 'Must roll back'" }],
          { readOnly: true }
        )
        assert.isEmpty(chats)
        const effect = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "start")!
        yield* posted(
          api.SendMessage({ chatId, parentSlotId: chat.activeLeafSlotId, branch: false, content: "User work." })
        )
        assert.strictEqual(yield* outcome(api.UndoRolloutEffect(effect)), "EffectUndoRefused")
        yield* f.writer.RecordRolloutEffects({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "failed",
          result: "A recorded refusal.",
          isError: true
        })
        assert.deepStrictEqual(
          yield* f.reader.RolloutToolReceipt({ userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "failed" }),
          { text: "A recorded refusal.", isError: true }
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )
})
