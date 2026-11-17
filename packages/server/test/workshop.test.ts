import { rewriteTools } from "../src/agent/tools/rewrite.ts"
import { builtinOperationExposures } from "../src/agent/exposures/builtins.ts"
import { parityTools } from "../src/agent/exposures/parity.ts"
import { cardSourceExposures } from "../src/agent/exposures/cardSources.ts"
import { PLUGIN_TOOLS } from "../src/agent/tools/plugins.ts"
import { WORKSHOP_HISTORY_TOOLS } from "../src/agent/tools/runs.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { mainPrompt } from "@rp/shared/presetOrder.ts"
import { textField } from "@rp/shared/editing.ts"
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import type { Chat, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { ChatEvent } from "@rp/shared/chatApi.ts"
import type { RefId } from "@rp/shared/library.ts"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { libraryTools } from "../src/agent/tools/library.ts"
import { frozenTool, type RolloutTool, type ToolContext } from "../src/agent/tools.ts"
import type { ContextSnapshot } from "../src/assembler/types.ts"
import { foldState } from "@rp/shared/state.ts"
import { client, login, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

const call = (name: string, args: unknown, id = "call_1") => [
  {
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "mock-model",
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
    id: "cmpl-t",
    object: "chat.completion.chunk",
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
  }
]

type Api = Effect.Success<ReturnType<typeof client>>
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
const answer = (api: Api, chat: Chat, events: ReadonlyArray<ChatEvent>) =>
  Effect.gen(function* () {
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: chat.activeLeafSlotId,
        branch: false,
        content: "Read the Assistant card."
      })
    )
    const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
    return finished(events, generated.entry.version.id)!
  })
const edit = (api: Api, refId: RefId, name: string, content: string) =>
  Effect.gen(function* () {
    const field = textField(name === "main" ? ["prompts", "identifier=main", "content"] : [name])
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
    yield* api.CommitEditorDrafts({
      refId,
      expectedRowVersion: before.ref.rowVersion,
      fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
      message: null
    })
  })

const outside: RolloutTool<Record<string, never>> = {
  id: "outside_test",
  label: "Read a test source",
  effect: "external",
  capability: "network",
  description: "A synthetic outside tool.",
  parameters: Type.Object({}),
  execute: () => Effect.succeed({ text: "Outside result." })
}

describe("workshop", () => {
  it.live("creates ordinary seeds once per user, preserving edits and replacing deleted seeds individually", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const user = yield* api.Whoami()
      const persona = yield* api.CreateCard({ label: "Tobin", name: "Tobin", persona: true })
      yield* api.ChangeGenerationDefaults({ change: { persona: persona.entityId, lcm: { enabled: false } } })
      const first = yield* api.CreateWorkshop({ title: "My workshop" })
      assert.strictEqual(first.kind, "workshop")
      assert.strictEqual(first.title, "My workshop")
      const cards = yield* api.ListLibrary({ kind: "card" })
      const card = cards.find((r) => r.label === "Assistant")!
      const preset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Workshop")!
      const reader = yield* Reader
      const state = foldState(
        yield* reader.StateEventsAt({ userId: user.id, chatId: first.id, slotId: first.activeLeafSlotId })
      )
      // The story default persona is not the workshop's: a workshop persona is made once instead.
      const workshopPersona = (yield* api.GetWorkshopDefaults({})).persona!
      assert.notStrictEqual(workshopPersona, persona.entityId)
      assert.deepStrictEqual(state.playedByMe, [workshopPersona])
      assert.deepStrictEqual(state.participants, [card.entityId, workshopPersona])
      assert.strictEqual(state.presetBindings[""]?.ref, preset.id)
      // Workshop summaries start on with their own sizing; RP keeps the account default.
      const story = yield* api.CreateChat({ title: "Synthetic story" })
      const storyState = foldState(
        yield* reader.StateEventsAt({ userId: user.id, chatId: story.id, slotId: story.activeLeafSlotId })
      )
      assert.strictEqual(state.lcm?.enabled, true)
      assert.strictEqual(state.lcm?.withPreset, "raw")
      assert.strictEqual(storyState.lcm?.enabled, false)
      assert.notStrictEqual(state.lcm?.recentMax, storyState.lcm?.recentMax)
      yield* edit(api, card.id, "first_mes", "An edited greeting.")
      yield* edit(api, preset.id, "main", "Edited workshop prompt.")
      const second = yield* api.CreateWorkshop({})
      assert.lengthOf(
        (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Assistant"),
        1
      )
      assert.lengthOf(
        (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.entityId === workshopPersona),
        1
      )
      assert.lengthOf(yield* api.ListLibrary({ kind: "preset" }), 1)
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).doc.first_mes, "An edited greeting.")
      const path = yield* api.ReadPath({
        chatId: second.id,
        leafSlotId: second.activeLeafSlotId,
        range: { _tag: "Bottom" },
        limit: 10
      })
      assert.strictEqual(path.entries[0]?.version.content, "An edited greeting.")
      assert.strictEqual(
        ((yield* api.OpenEditor({ refId: preset.id })).doc.prompts as Array<{ content: string }>)[0]?.content,
        "Edited workshop prompt."
      )
      yield* (yield* Writer).DeleteEntity({ userId: user.id, entityId: card.entityId })
      const third = yield* api.CreateWorkshop({})
      assert.strictEqual(third.kind, "workshop")
      const replacement = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      assert.notStrictEqual(replacement.entityId, card.entityId)
      assert.deepStrictEqual(
        (yield* api.ListLibrary({ kind: "preset" })).map((r) => r.id),
        [preset.id]
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "reads a library card through a scripted provider, freezes ordered pieces and tools, and keeps turns out of Activity",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const messages = request.body?.messages as Array<{ role: string }>
              sse(
                res,
                messages.at(-1)?.role === "tool"
                  ? completionChunks(["The Assistant is practical and brief."], {})
                  : call("read_card", { card: "Assistant" })
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        // Existing fixture provisions a model; the workshop itself is created by its RPC.
        const setup = yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
          model: {}
        })
        const chat = yield* api.CreateWorkshop({})
        // Story-only settings can still arrive through RPC or imported state. Hiding their
        // controls must not let them replace the tools the workshop's chip promises.
        yield* api.ChangeCast({
          chatId: chat.id,
          slotId: chat.activeLeafSlotId,
          change: { _tag: "AgentTools", tools: ["write_note"] }
        })
        const events = yield* watch(api, chat)
        const before = mock.requests().length
        const version = yield* answer(api, chat, events)
        assert.strictEqual(version.status, "complete")
        assert.strictEqual(version.content, "The Assistant is practical and brief.")
        const bodies = mock
          .requests()
          .slice(before)
          .filter((r) => r.path === "/v1/chat/completions")
          .map((r) => r.body!)
        assert.lengthOf(bodies, 2)
        const first = bodies[0]!
        const messages = first.messages as Array<{ role: string; content: string }>
        const text = messages.map((m) => m.content).join("\n")
        const main = text.indexOf("You are the workshop assistant")
        const definition = text.indexOf("Practical and brief.")
        const greeting = text.indexOf("What would you like to work on")
        const user = text.indexOf("Read the Assistant card.")
        const instructions = text.indexOf("Use the tools to look things up")
        assert.isTrue(
          0 <= main && main < definition && definition < greeting && greeting < user && user < instructions,
          text
        )
        assert.notInclude(text, "{{user}}")
        const names = (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
        assert.deepStrictEqual(names, [
          "list_library",
          "read_card",
          "read_preset",
          "read_lorebook",
          "create_card",
          "edit_card",
          "edit_card_note",
          "edit_preset",
          "edit_lorebook",
          "clone_card",
          "start_chat",
          "agent",
          ...WORKSHOP_HISTORY_TOOLS,
          ...PLUGIN_TOOLS,
          ...rewriteTools.map((tool) => tool.id),
          ...builtinOperationExposures.filter((e) => e.id !== "list_library").map((e) => e.id),
          ...cardSourceExposures.map((e) => e.id),
          ...parityTools,
          // Every tool from the start still offers the skills' instructions (spec/TOOL-LOADING.md §5).
          "load_skill",
          "send_message"
        ])
        assert.deepStrictEqual(bodies[1]!.tools, first.tools)
        assert.deepStrictEqual((bodies[1]!.messages as Array<unknown>).slice(0, messages.length), messages)
        const transcript = yield* api.GetRunTranscript({ versionId: version.id })
        assert.include(transcript.entries.find((e) => e.role === "toolResult")?.text, "Practical and brief.")
        assert.isEmpty((yield* api.ListActivity({ chatId: chat.id })).rows)
        const ledger = yield* api.ListLlmRequests({ before: null, limit: 100 })
        assert.deepStrictEqual(
          ledger.filter((r) => r.chatId === chat.id).map((r) => r.purpose),
          ["workshop", "workshop"]
        )
        const reader = yield* Reader
        const me = yield* api.Whoami()
        const material = yield* reader.RolloutMaterial({ userId: me.id, versionId: version.id })
        const snapshot = JSON.parse(material.snapshot) as ContextSnapshot & {
          agent: { contract: string; turnCap: number; tools: Array<{ name: string }> }
        }
        assert.strictEqual(material.mode, "workshop")
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [{ sql: "SELECT kind FROM rollouts WHERE id = ?", params: [material.rolloutId] }],
          { readOnly: true }
        )
        assert.strictEqual(rows?.[0]?.kind, "workshop")
        assert.lengthOf(yield* api.GetVersionMetrics({ versionIds: [version.id] }), 1)
        assert.include(
          (yield* api.ListModelUse()).map((use) => use.modelId),
          setup.model.id
        )
        assert.strictEqual(snapshot.agent.contract, "several")
        assert.strictEqual(snapshot.agent.turnCap, 40)
        assert.deepStrictEqual(
          snapshot.agent.tools.map((t) => t.name),
          names
        )
        assert.isTrue(
          snapshot.pieces.some((p) => p.source.kind === "assembler" && p.source.what === "Workshop instructions")
        )
        // Live edits and scoped tool replacements cannot change the recorded/rebuilt request.
        const card = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
        yield* edit(api, card.id, "description", "Changed after the request.")
        const registry = yield* ExecutionRegistry
        yield* registry.rolloutTools.disable("read_card")
        const rebuilt = yield* reader.RebuildContext({ userId: me.id, snapshot: material.snapshot })
        assert.strictEqual(rebuilt._tag, "Rebuilt")
        if (rebuilt._tag === "Rebuilt") assert.deepStrictEqual(JSON.parse(rebuilt.snapshot).request, snapshot.request)
        assert.strictEqual(
          (yield* reader.RolloutMaterial({ userId: me.id, versionId: version.id })).snapshot,
          material.snapshot
        )
        assert.notStrictEqual(setup.chat.id, chat.id)
        const seedPreset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Workshop")!
        const doc = (yield* api.OpenEditor({ refId: seedPreset.id })).doc
        const custom = yield* (yield* Writer).CreateEntity({
          userId: me.id,
          kind: "preset",
          label: "Custom workshop",
          subtitle: "",
          schemaVersion: 1,
          origin: "user",
          sourcePath: null,
          doc: {
            ...doc,
            prompts: [
              ...(doc.prompts as Array<object>),
              {
                ...mainPrompt,
                identifier: "workshopTurn",
                name: "Workshop turn",
                content: "Custom workshop instructions for {{user}}."
              }
            ],
            order: [...(doc.order as Array<object>), { identifier: "workshopTurn", enabled: true }]
          }
        })
        const customChat = yield* api.CreateWorkshop({})
        yield* api.ChangeCast({
          chatId: customChat.id,
          slotId: customChat.activeLeafSlotId,
          change: { _tag: "Preset", ref: custom.ref.id }
        })
        const customEvents = yield* watch(api, customChat)
        const customVersion = yield* answer(api, customChat, customEvents)
        const customMaterial = yield* reader.RolloutMaterial({ userId: me.id, versionId: customVersion.id })
        const customSnapshot = JSON.parse(customMaterial.snapshot) as ContextSnapshot
        const customText = customSnapshot.request.messages.map((m) => m.content).join("\n")
        assert.strictEqual(customText.split("Custom workshop instructions for").length - 1, 1)
        assert.notInclude(customText, "Use the tools to look things up")
        assert.notInclude(customText, "{{user}}")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("offers an outside tool in workshops and refuses it in RP", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      let ran = 0
      const registry = yield* ExecutionRegistry
      yield* registry.rolloutTools.register({
        ...outside,
        execute: () =>
          Effect.sync(() => {
            ran++
            return { text: "Outside result." }
          })
      })
      for (const id of ["default", "workshop"]) {
        const original = registry.orchestrationModes.get(id)!
        yield* registry.orchestrationModes.register({
          ...original,
          plan: (input) => ({ ...original.plan(input), strategy: "agent", tools: [outside.id] })
        })
      }
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body?.messages as Array<{ role: string }>
            sse(res, messages.at(-1)?.role === "tool" ? completionChunks(["Done."], {}) : call(outside.id, {}))
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      // A plugin could accidentally pass an executor after planning filtered its definition.
      // Preserve the offered wire definitions while injecting that executor: the hook must refuse it.
      const strategy = registry.replyStrategies.get("agent")!
      yield* registry.replyStrategies.register({
        ...strategy,
        run: (input) =>
          strategy.run(
            input.agent?.mode === "default"
              ? {
                  ...input,
                  agent: {
                    ...input.agent,
                    offered: input.agent.tools.map(frozenTool),
                    tools: [
                      ...input.agent.tools,
                      {
                        ...outside,
                        execute: () =>
                          Effect.sync(() => {
                            ran++
                            return { text: "Unexpected effect." }
                          })
                      }
                    ]
                  }
                }
              : input
          )
      })
      const api = yield* client()
      const rp = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [{ key: "agent.enabled", value: { on: true } }]
      })
      assert.strictEqual(ran, 0)
      const rpBody = mock.requests().find((r) => r.path === "/v1/chat/completions")!.body!
      assert.notInclude(
        (rpBody.tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
        outside.id
      )
      assert.isTrue(
        (yield* api.GetRunTranscript({ versionId: rp.version.id })).entries.some(
          (e) => e.role === "toolResult" && e.isError && e.text.includes("does not allow tools with outside effects")
        )
      )
      const user = yield* api.Whoami()
      const slot = yield* (yield* Reader).GetSlot({ userId: user.id, slotId: rp.version.slotId })
      const requestsBefore = mock.requests().length
      const refused = yield* Effect.flip(
        api.ResumeFromStep({
          versionId: rp.version.id,
          step: 0,
          edit: { kind: "arguments", arguments: {} },
          expectedRowVersion: slot.entry.rowVersion
        })
      )
      assert.strictEqual(refused._tag, "NotResumable")
      if (refused._tag === "NotResumable")
        assert.strictEqual(refused.message, "That tool wasn't offered to this reply.")
      assert.strictEqual(mock.requests().length, requestsBefore)
      assert.strictEqual(ran, 0, "An unoffered outside call must be refused before a resumed version is created.")
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      // Its registered capability asks first; the class only marks it as outside the reply.
      const replying = yield* Effect.forkScoped(answer(api, chat, events))
      yield* eventually(() =>
        events.some((e) => e._tag === "Steps" && e.steps.some((s) => s.kind === "tool" && s.status === "waiting"))
      )
      assert.strictEqual(ran, 0)
      const asked = events
        .flatMap((e) => (e._tag === "Steps" ? e.steps : []))
        .find((s) => s.kind === "tool" && s.status === "waiting")
      if (asked?.kind === "tool" && asked.approval)
        yield* api.AnswerToolApproval({
          rolloutId: asked.approval.rolloutId,
          toolCallId: asked.approval.toolCallId,
          digest: asked.approval.digest,
          answer: "allow"
        })
      const version = yield* Fiber.join(replying)
      assert.strictEqual(version.content, "Done.")
      assert.strictEqual(ran, 1)
      assert.include(
        (yield* api.GetRunTranscript({ versionId: version.id })).tools.map((t) => t.name),
        outside.id
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("resumes a workshop stopped mid-tool and edits its step using the original frozen tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      const reader = yield* Reader
      const started = yield* Deferred.make<VersionId>()
      const original = registry.rolloutTools.get("read_card")!
      let runs = 0
      yield* registry.rolloutTools.register({
        ...original,
        execute: (context, args) =>
          ++runs === 1
            ? Deferred.succeed(started, context.versionId).pipe(Effect.andThen(Effect.never))
            : original.execute(context, args)
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body as {
              tools?: Array<{ function: { name: string } }>
              messages: Array<{ role: string }>
            }
            const hasTools = body.tools?.some((tool) => tool.function.name === "read_card")
            sse(
              res,
              hasTools && body.messages.at(-1)?.role !== "tool"
                ? call("read_card", { card: "Assistant", fields: ["description"] })
                : completionChunks(["Read the library."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
      const user = yield* api.Whoami()
      const chat = yield* api.CreateWorkshop({})
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "AgentTools", tools: ["search_chat"] }
      })
      const events = yield* watch(api, chat)
      yield* Deferred.await(started).pipe(
        Effect.andThen((versionId) => api.StopGeneration({ versionId })),
        Effect.ignore,
        Effect.forkScoped
      )
      const before = mock.requests().length
      const stopped = yield* answer(api, chat, events)
      assert.strictEqual(stopped.status, "stopped")
      const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: stopped.id })
      const frozen = (yield* api.GetRunTranscript({ versionId: stopped.id })).tools
      assert.deepStrictEqual(
        frozen.map((tool) => tool.name),
        [
          "list_library",
          "read_card",
          "read_preset",
          "read_lorebook",
          "create_card",
          "edit_card",
          "edit_card_note",
          "edit_preset",
          "edit_lorebook",
          "clone_card",
          "start_chat",
          "agent",
          ...WORKSHOP_HISTORY_TOOLS,
          ...PLUGIN_TOOLS,
          ...rewriteTools.map((tool) => tool.id),
          ...builtinOperationExposures.filter((e) => e.id !== "list_library").map((e) => e.id),
          ...cardSourceExposures.map((e) => e.id),
          ...parityTools,
          // Every tool from the start still offers the skills' instructions (spec/TOOL-LOADING.md §5).
          "load_skill",
          "send_message"
        ]
      )
      // The snapshot holds the definitions; the read adds each one's size in tokens.
      assert.deepStrictEqual(
        (JSON.parse(material.snapshot) as { agent: { tools: unknown } }).agent.tools,
        frozen.map(({ tokens: _tokens, ...tool }) => tool)
      )

      // Neither today's planner nor today's tool descriptions may change this run's offer.
      const planner = registry.orchestrationModes.get("workshop")!
      yield* registry.orchestrationModes.register({
        ...planner,
        plan: (input) => ({ ...planner.plan(input), tools: ["list_library"] })
      })
      yield* registry.rolloutTools.register({
        ...registry.rolloutTools.get("read_card")!,
        description: "A changed description for future runs."
      })
      const slot = yield* reader.GetSlot({ userId: user.id, slotId: stopped.slotId })
      const resumed = yield* api.ResumeVersion({ versionId: stopped.id, expectedRowVersion: slot.entry.rowVersion })
      yield* eventually(() => finished(events, resumed.version.id) !== undefined)
      assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
      assert.strictEqual(runs, 2)
      const inspected = yield* api.GetRunContext({ versionId: resumed.version.id })
      assert.strictEqual(inspected.capture, "captured")
      assert.isTrue(
        inspected.messages.some((message) => message.sources.some((source) => source.label === "Workshop instructions"))
      )
      assert.strictEqual(
        (yield* reader.RolloutMaterial({ userId: user.id, versionId: resumed.version.id })).snapshot,
        material.snapshot
      )
      const requests = () =>
        mock
          .requests()
          .slice(before)
          .filter((request) => request.path === "/v1/chat/completions")
          .map((request) => request.body!)
      assert.deepStrictEqual(requests()[1]!.tools, requests()[0]!.tools)
      assert.include(JSON.stringify(requests()[1]!.messages), "Practical and brief.")

      const current = yield* reader.GetSlot({ userId: user.id, slotId: stopped.slotId })
      const edited = yield* api.ResumeFromStep({
        versionId: resumed.version.id,
        step: 0,
        edit: { kind: "arguments", arguments: { card: "Assistant", fields: ["name"] } },
        expectedRowVersion: current.entry.rowVersion
      })
      yield* eventually(() => finished(events, edited.version.id) !== undefined)
      assert.strictEqual(finished(events, edited.version.id)!.status, "complete")
      assert.strictEqual(runs, 3)
      assert.deepStrictEqual(requests()[2]!.tools, requests()[0]!.tools)
      const editedCalls = (
        requests()[2]!.messages as Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>
      ).flatMap((message) => message.tool_calls ?? [])
      assert.deepStrictEqual(JSON.parse(editedCalls.at(-1)!.function.arguments), {
        card: "Assistant",
        fields: ["name"]
      })
      assert.strictEqual(
        (yield* reader.RolloutMaterial({ userId: user.id, versionId: edited.version.id })).snapshot,
        material.snapshot
      )
      assert.strictEqual((yield* reader.GetVersion({ userId: user.id, versionId: stopped.id })).status, "stopped")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("refuses a workshop step's unoffered tool even when its current planner offers it", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const registry = yield* ExecutionRegistry
      let ran = 0
      yield* registry.rolloutTools.register({
        ...outside,
        execute: () =>
          Effect.sync(() => {
            ran++
            return { text: "Unexpected." }
          })
      })
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body as { tools?: Array<unknown>; messages: Array<{ role: string }> }
            sse(
              res,
              body.tools && body.messages.at(-1)?.role !== "tool"
                ? call(outside.id, {})
                : completionChunks(["Done."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
      const chat = yield* api.CreateWorkshop({})
      const events = yield* watch(api, chat)
      const version = yield* answer(api, chat, events)
      assert.notInclude(
        (yield* api.GetRunTranscript({ versionId: version.id })).tools.map((tool) => tool.name),
        outside.id
      )
      const planner = registry.orchestrationModes.get("workshop")!
      yield* registry.orchestrationModes.register({
        ...planner,
        plan: (input) => ({ ...planner.plan(input), tools: [outside.id] })
      })
      const user = yield* api.Whoami()
      const reader = yield* Reader
      const slot = yield* reader.GetSlot({ userId: user.id, slotId: version.slotId })
      const before = mock.requests().length
      const refused = yield* Effect.flip(
        api.ResumeFromStep({
          versionId: version.id,
          step: 0,
          edit: { kind: "arguments", arguments: {} },
          expectedRowVersion: slot.entry.rowVersion
        })
      )
      assert.strictEqual(refused._tag, "NotResumable")
      if (refused._tag === "NotResumable")
        assert.strictEqual(refused.message, "That tool wasn't offered to this reply.")
      assert.strictEqual(
        (yield* reader.GetSlot({ userId: user.id, slotId: version.slotId })).entry.rowVersion,
        slot.entry.rowVersion
      )
      assert.strictEqual(mock.requests().length, before)
      assert.strictEqual(ran, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("every library read uses the owner, resolves duplicate names, and respects field and list limits", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const local = yield* client()
      const admin = yield* local.Whoami()
      yield* local.SetPassword({ userId: admin.id, currentPassword: null, newPassword: "alice-password" })
      const alice = yield* client({ cookie: (yield* login(admin.handle, "alice-password")).cookie })
      yield* alice.CreateUser({ handle: "bob", displayName: "Bob", role: "user", password: "bob-password" })
      const bob = yield* client({ cookie: (yield* login("bob", "bob-password")).cookie })
      const reader = yield* Reader
      const writer = yield* Writer
      const a = yield* alice.Whoami()
      const b = yield* bob.Whoami()
      const aChat = yield* alice.CreateWorkshop({})
      const bChat = yield* bob.CreateWorkshop({})
      for (const kind of ["card", "preset"] as const)
        assert.notStrictEqual((yield* alice.ListLibrary({ kind }))[0]?.id, (yield* bob.ListLibrary({ kind }))[0]?.id)
      const context = (userId: typeof a.id, chat: Chat): ToolContext => ({
        userId,
        chatId: chat.id,
        forkId: chat.currentForkId,
        slotId: chat.activeLeafSlotId as SlotId,
        versionId: "unused" as VersionId,
        rolloutId: "unused",
        toolCallId: "unused",
        leafSlotId: null,
        reader,
        writer,
        viewers: null,
        cache: new Map()
      })
      const run = (name: string, ctx: ToolContext, args: unknown) =>
        libraryTools.find((t) => t.id === name)!.execute(ctx, args as never)
      const ctx = context(a.id, aChat)
      for (const kind of ["card", "preset", "lorebook"] as const) {
        if (kind === "lorebook") {
          yield* alice.CreateLorebook({ label: "Alice lore" })
          yield* bob.CreateLorebook({ label: "Bob lore" })
        }
        const other = (yield* bob.ListLibrary({ kind }))[0]!
        const list = JSON.parse((yield* run("list_library", ctx, { kind })).text)
        assert.notInclude(
          list.entries.map((entry: { id: string }) => entry.id),
          other.id
        )
        for (const id of [other.id, other.entityId]) {
          const refused = yield* run(`read_${kind}`, ctx, { [kind]: id })
          assert.isTrue(refused.isError)
          assert.notInclude(refused.text, "Practical and brief")
        }
        const own = (yield* alice.ListLibrary({ kind }))[0]!
        const result = yield* run(`read_${kind}`, ctx, { [kind]: own.id })
        assert.isUndefined(result.isError)
        assert.strictEqual(JSON.parse(result.text).id, own.id)
        assert.strictEqual(yield* outcome(bob.OpenEditor({ refId: own.id })), "NotFound")
      }
      const own = (yield* alice.ListLibrary({ kind: "card" }))[0]!
      const saved = yield* alice.OpenEditor({ refId: own.id })
      yield* alice.SaveEditorDraft({
        refId: own.id,
        field: textField(["description"]),
        content: "Unsaved draft content.",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: own.headRevisionId
      })
      assert.strictEqual(
        JSON.parse((yield* run("read_card", ctx, { card: own.id })).text).doc.description,
        saved.doc.description
      )
      yield* alice.CreateCard({ label: "Assistant", name: "Assistant" })
      assert.isTrue((yield* run("read_card", ctx, { card: "Assistant" })).isError)
      const filtered = JSON.parse((yield* run("read_card", ctx, { card: own.id, fields: ["description"] })).text)
      assert.property(filtered.doc, "description")
      assert.notProperty(filtered.doc, "personality")
      const listed = JSON.parse((yield* run("list_library", ctx, { kind: "card", query: "assistant", limit: 1 })).text)
      assert.lengthOf(listed.entries, 1)
      assert.strictEqual(listed.remaining, 1)
      assert.isEmpty(
        JSON.parse((yield* run("list_library", context(b.id, bChat), { kind: "card", query: "not-there" })).text)
          .entries
      )
      assert.strictEqual(yield* outcome(bob.GetChat({ chatId: aChat.id })), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})
