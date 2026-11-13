import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry, toolForKind } from "../src/execution.ts"
import type { ToolContext } from "../src/agent/tools.ts"
import { client, serverLayer, testConfig, outcome } from "./support/config.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { eventually } from "./support/generation.ts"

const fixture = (dataDir: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    const user = yield* api.Whoami()
    const chat = yield* api.CreateWorkshop({})
    const rolloutId = `op-${chat.id}`
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
      toolCallId: "unused",
      leafSlotId: null,
      viewers: null,
      reader,
      writer,
      cache: new Map()
    }
    const run = (name: string, args: unknown, id = name) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never)
    return { api, user, chat, rolloutId, reader, writer, registry, context, run }
  })

describe("operation tools", () => {
  it.live("uses the real RenameChat handler, emits its hub event, replays once and undoes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const story = f.chat
      yield* f.api.RenameChat({ chatId: story.id, name: "Original" })
      const events: ChatEvent[] = []
      yield* f.api.SubscribeChat({ chatId: story.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const args = { chat: story.id, name: "Renamed by tool" }
      const renamed = yield* f.run("rename_chat", args)
      assert.isUndefined(renamed.isError, renamed.text)
      assert.strictEqual((yield* f.api.GetChat({ chatId: story.id })).title, "Renamed by tool")
      yield* eventually(() => events.some((e) => e._tag === "Chat" && e.chat.title === "Renamed by tool"))
      const effects = yield* f.api.ListRolloutEffects({ chatId: f.chat.id })
      assert.lengthOf(effects, 1)
      assert.strictEqual(effects[0]!.kind, "chat.change")
      assert.isNotNull(effects[0]!.undo)
      assert.deepStrictEqual(yield* f.run("rename_chat", args), renamed)
      assert.lengthOf(yield* f.api.ListRolloutEffects({ chatId: f.chat.id }), 1)
      yield* f.api.UndoRolloutEffect(effects[0]!)
      assert.strictEqual((yield* f.api.GetChat({ chatId: story.id })).title, "Original")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("replays the exact rendered tool result rather than its raw writer result", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const result = yield* f.run("rename_chat", { chat: f.chat.id, name: "Receipt target" }, "rendered")
      assert.isUndefined(result.isError, result.text)
      const receipt = yield* f.reader.RolloutToolReceipt({
        userId: f.user.id,
        rolloutId: f.rolloutId,
        toolCallId: "rendered"
      })
      assert.strictEqual(receipt!.text, result.text)
      yield* f.writer.RecordRolloutEffects({
        userId: f.user.id,
        rolloutId: f.rolloutId,
        toolCallId: "rendered",
        result: "Must not replace the first result"
      })
      assert.strictEqual(
        (yield* f.reader.RolloutToolReceipt({ userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "rendered" }))!
          .text,
        result.text
      )
      const replayed = yield* f.run(
        "rename_chat",
        { chat: "No longer resolvable", name: "Must not execute" },
        "rendered"
      )
      assert.strictEqual(replayed.text, result.text)
      assert.strictEqual((yield* f.api.GetChat({ chatId: f.chat.id })).title, "Receipt target")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("recovers an operation committed before result delivery without executing it again", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      yield* f.writer.RunWorkshopOperation({
        userId: f.user.id,
        rolloutId: f.rolloutId,
        toolCallId: "crash-gap",
        capability: "chats.setup",
        expected: {},
        operation: "RenameChats",
        payload: { userId: f.user.id, chats: [{ chatId: f.chat.id, from: null }], name: "Committed once" }
      })
      const receipt = yield* f.reader.RolloutToolReceipt({
        userId: f.user.id,
        rolloutId: f.rolloutId,
        toolCallId: "crash-gap"
      })
      assert.include(receipt!.text, "already committed")
      const replayed = yield* f.run("rename_chat", { chat: "Unavailable now", name: "Must not execute" }, "crash-gap")
      assert.strictEqual(replayed.text, receipt!.text)
      assert.strictEqual((yield* f.api.GetChat({ chatId: f.chat.id })).title, "Committed once")
      assert.lengthOf(yield* f.api.ListRolloutEffects({ chatId: f.chat.id }), 1)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("creates presets and lorebooks through RPCs and bins them on Undo", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      for (const kind of ["preset", "lorebook"] as const) {
        const result = yield* f.run(`create_${kind}`, { label: `New ${kind}` })
        assert.isUndefined(result.isError, result.text)
        const ref = JSON.parse(result.text)
        assert.strictEqual((yield* f.api.OpenEditor({ refId: ref.id })).ref.label, `New ${kind}`)
        const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find(
          (e) => e.toolCallId === `create_${kind}`
        )!
        yield* f.api.UndoRolloutEffect(effect)
        assert.strictEqual(yield* outcome(f.api.OpenEditor({ refId: ref.id })), "NotFound")
      }
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("changes only opted-in settings, validates values, records undo and never reads secrets", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const settings = JSON.parse((yield* f.run("read_settings", {})).text) as Array<{ key: string }>
      assert.deepStrictEqual(
        settings.map((s) => s.key),
        ["display", "shell.pinsCollapsed"]
      )
      const change = yield* f.run("change_setting", { key: "shell.pinsCollapsed", value: true })
      assert.isUndefined(change.isError, change.text)
      const info = yield* f.reader.WorkshopOperationInfo({ userId: f.user.id })
      assert.strictEqual(info.settings.find((s) => s.key === "shell.pinsCollapsed")!.value, true)
      for (const key of ["network", "workshop.grants", "plugins.user", "token_counting", "unknown"]) {
        const result = yield* f.run("change_setting", { key, value: {} }, `bad-${key}`)
        assert.isTrue(result.isError, result.text)
        assert.include(result.text, "not agent-changeable")
      }
      const bad = yield* f.run("change_setting", { key: "shell.pinsCollapsed", value: "true" }, "wrong-type")
      assert.isTrue(bad.isError)
      const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
      yield* f.api.UndoRolloutEffect(effect)
      assert.strictEqual(
        (yield* f.reader.WorkshopOperationInfo({ userId: f.user.id })).settings.find(
          (s) => s.key === "shell.pinsCollapsed"
        )!.revision,
        0
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "undoes the first library and chat exposures, and refuses default tool selections before changing them",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const f = yield* fixture(config.dataDir)
        const first = yield* f.api.CreateCard({ label: "First", name: "First" })
        const second = yield* f.api.CreateCard({ label: "Second", name: "Second" })
        const variant = yield* f.api.ForkCard({
          refId: first.id,
          name: "First variant",
          nickname: "",
          characterVersion: ""
        })
        const preset = yield* f.api.CreatePreset({ label: "Story preset" })
        const lorebook = yield* f.api.CreateLorebook({ label: "Story lorebook" })
        const started = yield* f.run("start_chat", { cards: [first.id], title: "Editable story" })
        assert.isUndefined(started.isError, started.text)
        const story = yield* f.api.GetChat({ chatId: JSON.parse(started.text).chatId })
        const connection = yield* f.api.CreateConnection({
          kind: "openai-chat",
          settings: {
            name: "Named connection",
            baseUrl: "http://127.0.0.1:1/v1",
            compat: {},
            cacheTtlS: null,
            maxConcurrent: null,
            presetOverrideRefId: null
          }
        })
        yield* f.api.AddUserModel({
          connectionId: connection.id,
          key: "synthetic-model",
          overrides: { name: "Named model" }
        })
        const changes = [
          { _tag: "Model", connection: "Named connection", model: "Named model" },
          { _tag: "Persona", entityId: second.id },
          { _tag: "Preset", ref: preset.id },
          { _tag: "Lorebook", ref: lorebook.id, active: true },
          { _tag: "CardLorebook", entityId: first.id, on: false },
          { _tag: "AgentEnabled", on: true },
          { _tag: "CardsRotation", on: true },
          { _tag: "ReplyOrder", order: "natural" },
          { _tag: "Join", entityId: second.id },
          { _tag: "Leave", entityId: first.id },
          { _tag: "Swap", entityId: variant.id, replaces: first.id }
        ]
        for (const change of changes) {
          const id = `cast-${change._tag}`
          const before = yield* f.api.GetCast({
            chatId: story.id,
            slotId: story.activeLeafSlotId,
            forkId: story.currentForkId
          })
          const result = yield* f.run("change_chat", { chat: story.id, change }, id)
          assert.isUndefined(result.isError, `${id}: ${result.text}`)
          const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === id)!
          yield* f.api.UndoRolloutEffect(effect)
          const after = yield* f.api.GetCast({
            chatId: story.id,
            slotId: story.activeLeafSlotId,
            forkId: story.currentForkId
          })
          assert.deepStrictEqual(after.participants, before.participants, id)
          assert.deepStrictEqual(after.playedByMe, before.playedByMe, id)
          assert.deepStrictEqual(after.absent, before.absent, id)
          assert.deepStrictEqual(after.model, before.model, id)
          assert.strictEqual(after.preset, before.preset, id)
          assert.deepStrictEqual(after.lorebooks, before.lorebooks, id)
        }
        const noUndo = yield* f.run(
          "change_chat",
          { chat: story.id, change: { _tag: "AgentTools", tools: [] } },
          "tools-default"
        )
        assert.isTrue(noUndo.isError)
        assert.include(noUndo.text, "cannot yet be restored by Undo")
        yield* f.api.ChangeCast({
          chatId: story.id,
          slotId: story.activeLeafSlotId,
          forkId: story.currentForkId,
          change: { _tag: "AgentTools", tools: [] }
        })
        const tools = yield* f.run(
          "change_chat",
          { chat: story.id, change: { _tag: "AgentTools", tools: ["read_messages"] } },
          "tools-explicit"
        )
        assert.isUndefined(tools.isError, tools.text)
        yield* f.api.UndoRolloutEffect(
          (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "tools-explicit")!
        )
        assert.deepStrictEqual(
          (yield* f.api.GetCast({ chatId: story.id, slotId: story.activeLeafSlotId, forkId: story.currentForkId }))
            .agentTools,
          []
        )
        for (const [name, args] of [
          ["rename_ref", { kind: "preset", item: preset.id, label: "Renamed preset", subtitle: "copy" }],
          ["set_ref_archived", { kind: "lorebook", item: lorebook.id, archived: true }],
          ["set_card_favourite", { card: first.id, favourite: true }],
          ["set_chat_pin", { chat: story.id, pinned: true }],
          ["fork_variant", { kind: "preset", item: preset.id, label: "Copied preset", subtitle: "" }]
        ] as const) {
          const result = yield* f.run(name, args)
          assert.isUndefined(result.isError, `${name}: ${result.text}`)
          const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === name)!
          yield* f.api.UndoRolloutEffect(effect)
        }
        assert.strictEqual((yield* f.api.OpenEditor({ refId: preset.id })).ref.label, "Story preset")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live(
    "runs the bounded reads and history commands, restores revisions, and changes owned defaults with Undo",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const f = yield* fixture(config.dataDir)
        const card = yield* f.api.CreateCard({ label: "Revision card", name: "Revision card", description: "Original" })
        const saved = yield* f.api.OpenEditor({ refId: card.id })
        yield* f.writer.EditRef({
          userId: f.user.id,
          refId: card.id,
          expectedRowVersion: saved.ref.rowVersion,
          doc: { ...saved.doc, description: "New text" },
          commitDraft: null,
          message: "Synthetic edit"
        })
        const restored = yield* f.run("restore_revision", {
          kind: "card",
          item: card.id,
          revision: saved.ref.headRevisionId
        })
        assert.isUndefined(restored.isError, restored.text)
        assert.strictEqual((yield* f.api.OpenEditor({ refId: card.id })).doc.description, "Original")
        const target = yield* f.api.CreateChat({ title: "Command target" })
        yield* f.api.SendMessage({
          chatId: target.id,
          parentSlotId: null,
          branch: false,
          content: "What happens next?"
        })
        for (const [name, args] of [
          ["list_library", { kind: "card", query: "Revision", limit: 1 }],
          ["list_chats", { limit: 10 }],
          ["list_revisions", { kind: "card", item: card.id }],
          ["get_cast", { chat: target.id }]
        ] as const) {
          const result = yield* f.run(name, args)
          assert.isUndefined(result.isError, `${name}: ${result.text}`)
        }
        const search = {
          pairs: [{ find: "What", replace: "Which" }],
          regex: false,
          matchCase: true,
          wholeWord: false,
          preserveCase: false,
          messages: true,
          swipes: true,
          summaries: true
        }
        yield* f.writer.SetWorkshopGrant({
          userId: f.user.id,
          chatId: f.chat.id,
          capability: "chats.read",
          mode: "allow"
        })
        const searched = yield* f.run("history_search", { chatId: target.id, forkId: target.currentForkId, search })
        assert.isUndefined(searched.isError, searched.text)
        const renamed = yield* f.run("history_rename", {
          entityId: card.entityId,
          oldName: "What",
          newName: "Which",
          scope: "this",
          chatId: target.id,
          forkId: target.currentForkId
        })
        assert.isUndefined(renamed.isError, renamed.text)
        const preset = yield* f.api.CreatePreset({ label: "Default choice" })
        const defaults = yield* f.run("change_generation_defaults", { change: { preset: preset.id } })
        assert.isUndefined(defaults.isError, defaults.text)
        assert.strictEqual((yield* f.api.GetGenerationDefaults()).preset, preset.id)
        for (const name of ["change_generation_defaults", "history_rename", "restore_revision"]) {
          const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === name)!
          assert.isDefined(effect, name)
          yield* f.api.UndoRolloutEffect(effect)
        }
        assert.strictEqual((yield* f.api.OpenEditor({ refId: card.id })).doc.description, "New text")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("never resolves or changes another owner's targets, including crafted ids", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const other = yield* f.writer.EnsureUser({ handle: "other", displayName: "Other" })
      const foreign = yield* f.writer.CreateChat({
        userId: other.id,
        kind: "rp",
        status: "active",
        title: "Private chat",
        participants: [],
        greeting: null
      })
      for (const tool of ["rename_chat", "get_cast", "generate_reply"] as const) {
        const result = yield* f.run(tool, { chat: foreign.id, ...(tool === "rename_chat" ? { name: "Stolen" } : {}) })
        assert.isTrue(result.isError)
        assert.notInclude(result.text, "Private chat")
      }
      const crafted = yield* f.run("change_setting", { key: "shell.pinsCollapsed", value: true, userId: other.id })
      assert.isTrue(crafted.isError)
      const foreignWrite = yield* f.writer
        .RunWorkshopOperation({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "foreign-write",
          capability: "chats.setup",
          operation: "RenameChats",
          expected: {},
          payload: { userId: f.user.id, chats: [{ chatId: foreign.id, from: null }], name: "Stolen" }
        })
        .pipe(Effect.exit)
      assert.strictEqual(foreignWrite._tag, "Failure")
      assert.strictEqual((yield* f.reader.GetChat({ userId: other.id, chatId: foreign.id })).title, "Private chat")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refuses ambiguous names, crafted permissions, large arguments, and changed approval targets", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const a = yield* f.api.CreateChat({ title: "Duplicate" })
      const b = yield* f.api.CreateChat({ title: "Duplicate" })
      const ambiguous = yield* f.run("rename_chat", { chat: "Duplicate", name: "No" })
      assert.isTrue(ambiguous.isError)
      assert.include(ambiguous.text, a.id)
      assert.include(ambiguous.text, b.id)
      const craft = yield* f.run("change_chat", {
        chat: a.id,
        change: { _tag: "AgentPermission", target: { note: "other" }, on: true }
      })
      assert.isTrue(craft.isError)
      const huge = yield* f.run("rename_chat", { chat: a.id, name: "x".repeat(65_000) }, "huge")
      assert.isTrue(huge.isError)
      const tool = toolForKind(f.registry, "workshop", "rename_chat")!
      const args = { chat: a.id, name: "Approved name" }
      const ctx = { ...f.context, toolCallId: "pin" }
      yield* tool.describe!(ctx, args as never)
      yield* f.api.RenameChat({ chatId: a.id, name: "Changed while waiting" })
      const refused = yield* tool.execute({ ...ctx, approvalDigest: "approved" }, args as never)
      assert.isTrue(refused.isError)
      assert.include(refused.text, "changed while waiting")
      assert.strictEqual((yield* f.api.GetChat({ chatId: a.id })).title, "Changed while waiting")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("rechecks grants and live run in the writer, and refuses an operation without undo", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const f = yield* fixture(config.dataDir)
      const story = yield* f.api.CreateChat({ title: "Unchanged" })
      for (const mode of ["off", "ask"] as const) {
        yield* f.api.SetWorkshopGrant({ chatId: f.chat.id, capability: "chats.setup", mode })
        const refused = yield* f.run("rename_chat", { chat: story.id, name: "Bad" }, mode)
        assert.isTrue(refused.isError)
      }
      yield* f.api.SetWorkshopGrant({ chatId: f.chat.id, capability: "chats.setup", mode: "allow" })
      const unsupported = yield* f.writer
        .RunWorkshopOperation({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId: "purge",
          capability: "chats.setup",
          operation: "PurgeBin",
          payload: {},
          expected: {}
        })
        .pipe(Effect.flip)
      assert.strictEqual(unsupported._tag, "EffectUndoRefused")
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE rollouts SET status='stopped' WHERE id=?", params: [f.rolloutId] }
      ])
      const stopped = yield* f.run("rename_chat", { chat: story.id, name: "Stopped" }, "stopped")
      assert.isTrue(stopped.isError)
      assert.strictEqual((yield* f.api.GetChat({ chatId: story.id })).title, "Unchanged")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

it.live("generated-reply Undo refuses a later manual edit instead of binning the owner's work", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const card = yield* f.api.CreateCard({ label: "Undo speaker", name: "Undo speaker" })
    const created = yield* f.run("start_chat", { cards: [card.id], title: "Reply undo" })
    const story = yield* f.api.GetChat({ chatId: JSON.parse(created.text).chatId })
    yield* f.api.SetWorkshopGrant({ chatId: f.chat.id, capability: "generate", mode: "allow" })
    const started = (yield* f.writer.RunWorkshopOperation({
      userId: f.user.id,
      rolloutId: f.rolloutId,
      toolCallId: "reply-undo",
      capability: "generate",
      expected: {},
      operation: "SendOrQueue",
      payload: {
        userId: f.user.id,
        chatId: story.id,
        forkId: story.currentForkId,
        parentSlotId: story.activeLeafSlotId,
        branch: false,
        kind: "generate",
        content: "",
        speakerEntityId: card.entityId,
        replySpeakerEntityId: null,
        direction: null,
        commitDraft: null
      }
    })) as { _tag: string; result: { slotId: SlotId; version: { id: VersionId }; forkId: typeof story.currentForkId } }
    assert.strictEqual(started._tag, "Posted")
    yield* f.writer.FinishGeneration({
      userId: f.user.id,
      versionId: started.result.version.id,
      content: "Generated",
      status: "complete",
      error: null
    })
    const slot = yield* f.reader.GetSlot({
      userId: f.user.id,
      slotId: started.result.slotId,
      forkId: started.result.forkId
    })
    const edited = yield* f.api.EditVersion({
      slotId: started.result.slotId,
      forkId: started.result.forkId,
      sourceVersionId: started.result.version.id,
      expectedRowVersion: slot.entry.rowVersion,
      content: "Owner's saved edit"
    })
    const effect = (yield* f.api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "reply-undo")!
    assert.strictEqual(yield* outcome(f.api.UndoRolloutEffect(effect)), "EffectUndoRefused")
    assert.strictEqual(
      (yield* f.reader.GetSlot({ userId: f.user.id, slotId: started.result.slotId, forkId: started.result.forkId }))
        .entry.version.id,
      edited.version.id
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("budgets operation after-results before recording and returning them to the model", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const original = f.registry.operationTools.get("rename_chat")!
    yield* f.registry.operationTools.register({
      ...original,
      after: () => Effect.succeed({ text: "x".repeat(20_000) })
    })
    const result = yield* f.run("rename_chat", { chat: f.chat.id, name: "Budgeted" }, "after-budget")
    assert.isUndefined(result.isError, result.text)
    assert.include(result.text, "Result cut at 16000 characters")
    assert.isBelow(result.text.length, 16_200)
    assert.strictEqual(
      (yield* f.reader.RolloutToolReceipt({ userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "after-budget" }))!
        .text,
      result.text
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("history rename never expands approval to all chats", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const target = yield* f.api.CreateChat({ title: "Pinned story" })
    yield* f.api.SendMessage({ chatId: target.id, parentSlotId: null, branch: false, content: "What happens next?" })
    const tool = toolForKind(f.registry, "workshop", "history_rename")!
    const args = {
      entityId: "unused",
      oldName: "What",
      newName: "Which",
      scope: "all",
      chatId: target.id,
      forkId: target.currentForkId
    }
    const ctx = { ...f.context, toolCallId: "history-pin" }
    assert.strictEqual((yield* Effect.exit(tool.describe!(ctx, args as never)))._tag, "Failure")
    const added = yield* f.api.CreateChat({ title: "Added while waiting" })
    const result = yield* tool.execute(ctx, args as never)
    assert.isTrue(result.isError, result.text)
    assert.include(result.text, "current branch")
    for (const chat of [target, added])
      assert.isEmpty(yield* f.api.ListHistoryEdits({ chatId: chat.id, forkId: chat.currentForkId! }))
    assert.isEmpty(yield* f.api.ListRolloutEffects({ chatId: f.chat.id }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("refuses delegated generation before it can discard a saved round that Undo cannot restore", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const card = yield* f.api.CreateCard({ label: "Queued speaker", name: "Queued speaker" })
    const created = yield* f.run("start_chat", { cards: [card.id], title: "Saved round" })
    yield* f.api.SendMessage({
      chatId: JSON.parse(created.text).chatId,
      parentSlotId: null,
      branch: false,
      content: "Queued anchor"
    })
    const story = yield* f.api.GetChat({ chatId: JSON.parse(created.text).chatId })
    yield* f.api.SetWorkshopGrant({ chatId: f.chat.id, capability: "generate", mode: "allow" })
    yield* fixtureSql(config.dataDir, [
      {
        sql: "INSERT INTO queued_messages(id,chat_id,reply_slot_id,fork_id,seq,kind,content,round,held,created_at,updated_at) VALUES ('saved-round',?,?,?,0,'generate','',1,1,1,1)",
        params: [story.id, story.activeLeafSlotId, story.currentForkId]
      }
    ])
    const result = yield* Effect.exit(
      f.writer.RunWorkshopOperation({
        userId: f.user.id,
        rolloutId: f.rolloutId,
        toolCallId: "queued-reply",
        capability: "generate",
        expected: {},
        operation: "SendOrQueue",
        payload: {
          userId: f.user.id,
          chatId: story.id,
          forkId: story.currentForkId,
          parentSlotId: story.activeLeafSlotId,
          branch: false,
          kind: "generate",
          content: "",
          speakerEntityId: card.entityId,
          replySpeakerEntityId: null,
          direction: null,
          commitDraft: null
        }
      })
    )
    assert.strictEqual(result._tag, "Failure")
    const [rows] = yield* fixtureSql(
      config.dataDir,
      [{ sql: "SELECT id FROM queued_messages WHERE id='saved-round'" }],
      { readOnly: true }
    )
    assert.lengthOf(rows!, 1)
    assert.strictEqual((yield* f.api.GetChat({ chatId: story.id })).activeLeafSlotId, story.activeLeafSlotId)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("missing names refuse with bounded owner-scoped candidates", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const card = yield* f.api.CreateCard({ label: "Candidate card", name: "Candidate card" })
    const chat = yield* f.run("rename_chat", { chat: "Missing chat", name: "No change" })
    assert.isTrue(chat.isError)
    assert.include(chat.text, f.chat.id)
    const library = yield* f.run("rename_ref", { kind: "card", item: "Missing card", label: "No change", subtitle: "" })
    assert.isTrue(library.isError)
    assert.include(library.text, card.id)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("revision restores cannot remove a user's regex permission either", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const ref = yield* f.api.CreatePreset({ label: "User permission" })
    const before = yield* f.api.OpenEditor({ refId: ref.id })
    yield* f.api.SetRegexApproval({ refId: ref.id, approved: true, expectedRowVersion: before.ref.rowVersion })
    const result = yield* f.run("restore_revision", {
      kind: "preset",
      item: ref.id,
      revision: before.ref.headRevisionId
    })
    assert.isTrue(result.isError, result.text)
    assert.include(result.text, "permissions")
    assert.strictEqual((yield* f.api.OpenEditor({ refId: ref.id })).doc.regex_approved, true)
    assert.isEmpty(yield* f.api.ListRolloutEffects({ chatId: f.chat.id }))
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("revision restores cannot remove a user's agent-edit field permissions", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const f = yield* fixture(config.dataDir)
    const ref = yield* f.api.CreateCard({ label: "User edit permission", name: "User edit permission" })
    const before = yield* f.api.OpenEditor({ refId: ref.id })
    yield* f.writer.EditRef({
      userId: f.user.id,
      refId: ref.id,
      expectedRowVersion: before.ref.rowVersion,
      doc: { ...before.doc, agent_editable_fields: ["description"] },
      commitDraft: null,
      message: "Owner permission"
    })
    const result = yield* f.run("restore_revision", { kind: "card", item: ref.id, revision: before.ref.headRevisionId })
    assert.isTrue(result.isError, result.text)
    assert.include(result.text, "permissions")
    assert.deepStrictEqual((yield* f.api.OpenEditor({ refId: ref.id })).doc.agent_editable_fields, ["description"])
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})
