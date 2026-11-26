import { OPEN_LIBRARY } from "./support/libraryGrants.ts"
import { cardSourceExposures } from "../src/agent/exposures/cardSources.ts"
import { builtinOperationExposures } from "../src/agent/exposures/builtins.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { Chat, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { newCardDoc, textField } from "@dreamspan/shared/editing.ts"
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
/** The waiting step of a version, once its call asks the user first. */
const waitingStep = (events: ReadonlyArray<ChatEvent>, versionId: string) =>
  events
    .flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? e.steps : []))
    .findLast((step) => step.kind === "tool" && step.status === "waiting")
/** Waits for a version's call to ask, answers it, and returns what it asked. */
const answerWaiting = (
  api: Api,
  events: ReadonlyArray<ChatEvent>,
  versionId: string,
  answer: "allow" | "allow_chat" | "deny"
) =>
  Effect.gen(function* () {
    yield* eventually(() => waitingStep(events, versionId) !== undefined)
    const asked = waitingStep(events, versionId)
    if (asked?.kind !== "tool" || !asked.approval) return assert.fail("no approval")
    yield* api.AnswerToolApproval({
      rolloutId: asked.approval.rolloutId,
      toolCallId: asked.approval.toolCallId,
      digest: asked.approval.digest,
      answer
    })
    return asked.approval
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
    const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
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
      viewers: null,
      cache: new Map()
    }
    const run = (name: string, args: unknown, id = name) =>
      toolForKind(registry, "workshop", name)!.execute({ ...context, toolCallId: id }, args as never)
    return { context, run, writer, reader, user, chat, rolloutId }
  })

describe("workshop setup effects", () => {
  it.live("rechecks the current Files grant before committing a previously authorized portrait", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const key = { userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "portrait" }
      const name = "Uncommitted portrait"
      yield* f.reader.AuthorizePluginTool({
        ...key,
        capability: "library.write",
        requireFiles: true,
        requireApproval: false
      })
      for (const mode of ["ask", "off"] as const) {
        yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "files", mode })
        const result = yield* Effect.flip(
          f.writer.AgentCreateEntity({
            ...key,
            kind: "card",
            label: name,
            doc: newCardDoc(name),
            tags: [],
            portrait: {
              sha256: "a".repeat(64),
              mime: "image/png",
              width: 80,
              height: 120,
              byteSize: 128,
              maxAddedBytes: 128
            }
          })
        )
        assert.strictEqual(result._tag, "EffectUndoRefused")
      }
      assert.isFalse((yield* api.ListLibrary({ kind: "card" })).some((card) => card.label === name))
      assert.isEmpty(yield* api.ListRolloutEffects({ chatId: f.chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the writer checks a positioned library item's grant before creating a revision", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const card = yield* api.CreateCard({ label: "Grant fixture", name: "Grant fixture" })
      const saved = yield* api.OpenEditor({ refId: card.id })
      const revise = (toolCallId: string, expectedRowVersion: number, description: string) =>
        f.writer.AgentReviseEntity({
          userId: f.user.id,
          rolloutId: f.rolloutId,
          toolCallId,
          refId: card.id,
          expectedRowVersion,
          doc: { ...saved.doc, description },
          librarySight: {
            refId: card.id,
            forkId: f.chat.currentForkId,
            leafSlotId: null,
            entities: [],
            refs: [],
            card: null
          }
        })
      yield* revise("view-allowed", card.rowVersion, "Allowed.")
      const current = yield* api.OpenEditor({ refId: card.id })
      assert.strictEqual(current.doc.description, "Allowed.")
      yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "library.cards", mode: "off" })
      const rejected = yield* Effect.flip(revise("view-revoked", current.ref.rowVersion, "Revoked."))
      assert.strictEqual(rejected._tag, "EffectUndoRefused")
      assert.strictEqual((yield* api.OpenEditor({ refId: card.id })).ref.headRevisionId, current.ref.headRevisionId)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("consumes an approval once, and refuses consumption after Off wins the transaction", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const key = { userId: f.user.id, rolloutId: f.rolloutId, toolCallId: "consume" }
      const prompt = {
        rolloutId: f.rolloutId,
        toolCallId: "consume",
        digest: "digest",
        capability: "library.write",
        capabilityLabel: "Create and edit library items",
        title: "Create a card",
        rows: [],
        uncertain: false
      }
      const request = { ...key, digest: "digest", capability: "library.write", prompt }
      yield* f.writer.RequestToolApproval(request)
      assert.strictEqual(yield* outcome(f.writer.RequestToolApproval(request)), "ApprovalRefused")
      yield* f.writer.AnswerToolApproval({ ...key, digest: "digest", answer: "allow", note: null })
      yield* f.writer.SetWorkshopGrant({
        userId: f.user.id,
        chatId: f.chat.id,
        capability: "library.write",
        mode: "off"
      })
      assert.isFalse(yield* f.writer.SettleToolApproval({ ...key, status: "used" }))
      const fresh = { ...key, toolCallId: "consume-fresh" }
      const freshRequest = { ...request, ...fresh, prompt: { ...prompt, toolCallId: fresh.toolCallId } }
      assert.strictEqual(yield* outcome(f.writer.RequestToolApproval(freshRequest)), "ApprovalRefused")
      yield* f.writer.SetWorkshopGrant({
        userId: f.user.id,
        chatId: f.chat.id,
        capability: "library.write",
        mode: "ask"
      })
      assert.isFalse(yield* f.writer.SettleToolApproval({ ...key, status: "used" }))
      yield* f.writer.RequestToolApproval(freshRequest)
      yield* f.writer.AnswerToolApproval({ ...fresh, digest: "digest", answer: "allow", note: null })
      assert.isTrue(yield* f.writer.SettleToolApproval({ ...fresh, status: "used" }))
      assert.isFalse(yield* f.writer.SettleToolApproval({ ...fresh, status: "used" }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  for (const mode of ["off", "ask"] as const)
    it.live(`the writer refuses a change when permission becomes ${mode} after the call was admitted`, () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const api = yield* client()
        const f = yield* fixture(config.dataDir, api)
        // Same tool/context, but a second tab changes permission before its write transaction.
        yield* api.SetWorkshopGrant({ chatId: f.chat.id, capability: "library.write", mode })
        const result = yield* f.run("create_card", { name: "Must not commit" }, "raced")
        assert.isTrue(result.isError)
        assert.isEmpty((yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Must not commit"))
        assert.isEmpty(yield* api.ListRolloutEffects({ chatId: f.chat.id }))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    })

  it.live("a described copy stays bound to its original target and refuses if that target changes", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const source = yield* api.CreateCard({ label: "Source", name: "Source", description: "Originally shown" })
      const registry = yield* ExecutionRegistry
      const tool = toolForKind(registry, "workshop", "clone_card")!
      const args = { card: "Source", name: "Approved copy" }
      yield* tool.describe!({ ...f.context, toolCallId: "copy" }, args as never)
      yield* edit(api, source.id, "Changed after approval")
      const result = yield* f.run("clone_card", args, "copy")
      assert.isTrue(result.isError)
      assert.isEmpty((yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Approved copy"))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("reads registered capabilities for the owned chat kind and its offered tools", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const capabilities = yield* api.ListWorkshopCapabilities({ chatId: f.chat.id })
      assert.deepStrictEqual(
        capabilities.map((c) => c.id),
        [
          "library.cards",
          "library.lorebooks",
          "library.presets",
          "library.notes",
          "chats.read",
          "library.write",
          "chats.setup",
          "chats.rewrite",
          "settings",
          "generate",
          // The card-source tools use the internet (cardextools1).
          "network",
          // The account's files and commands (sandbox1).
          "files",
          "commands",
          "commands.network",
          "plugins.write",
          "plugins.apply",
          // A subagent inside the reply (subagents1).
          "subagents",
          "skills.card"
        ]
      )
      assert.deepStrictEqual(
        capabilities.map((c) => c.mode),
        [
          // The four library classes, allowed by the fixture (OPEN_LIBRARY).
          "allow",
          "allow",
          "allow",
          "allow",
          "ask",
          "allow",
          "allow",
          "allow",
          "allow",
          "ask",
          "ask",
          "allow",
          "allow",
          "allow",
          "allow",
          "ask",
          // Owner [D] (spec/SUBAGENTS.md §13): the recommendation, not asked.
          "allow",
          "ask"
        ]
      )
      assert.deepStrictEqual(
        capabilities.map((c) => c.modes),
        [
          // The four library classes, then chats.read to network, then files and commands.
          ...Array.from({ length: 13 }, () => ["off", "ask", "allow"] as const),
          // Internet from commands: Off or On.
          ["off", "allow"],
          ["off", "ask", "allow"],
          ["off", "ask"],
          // Subagents: Off, Ask first or Allowed.
          ["off", "ask", "allow"],
          // A card's skills always ask; allowing one covers that skill's exact words only.
          ["off", "ask"]
        ]
      )
      const registry = yield* ExecutionRegistry
      yield* registry.workshopCapabilities.register({
        id: "library.write",
        order: 5,
        label: "Synthetic library changes",
        explanation: "A registered replacement."
      })
      assert.strictEqual(
        (yield* api.ListWorkshopCapabilities({ chatId: f.chat.id }))[0]!.label,
        "Synthetic library changes"
      )
      const workshop = registry.orchestrationModes.get("workshop")!
      yield* registry.orchestrationModes.register({
        ...workshop,
        plan: (input) => ({ ...workshop.plan(input), tools: ["list_library"] })
      })
      assert.deepStrictEqual(
        (yield* api.ListWorkshopCapabilities({ chatId: f.chat.id })).map((c) => c.id),
        ["library.cards", "library.lorebooks", "library.presets", "library.notes"]
      )
      const story = yield* api.CreateChat({ title: "Story" })
      assert.isEmpty(yield* api.ListWorkshopCapabilities({ chatId: story.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "resumes stopped setup work once, retains discarded library effects after a step edit, and can undo both",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        let paused = false
        let holdOnce = true
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const messages = request.body?.messages as Array<{ role: string; tool_call_id?: string }>
              if (!JSON.stringify(messages).includes("Build a synthetic keeper"))
                return sse(res, completionChunks(["Ready."], {}))
              if (
                String(JSON.stringify(messages.filter((m) => m.role === "tool").at(-1))).match(
                  /may already have happened|declined/
                )
              )
                return sse(res, completionChunks(["That call needs checking first."], {}))
              const last = messages.filter((m) => m.role === "tool").at(-1)?.tool_call_id
              if (last === "create" && holdOnce) {
                holdOnce = false
                paused = true
                res.writeHead(200, { "content-type": "text/event-stream" })
                return
              }
              sse(
                res,
                last === "create"
                  ? completionChunks(["The keeper is ready."], {})
                  : last === "lookup"
                    ? call("create_card", { name: "Synthetic keeper" }, "create")
                    : call("list_library", { kind: "card" }, "lookup")
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: {}
        })
        const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
        const events = yield* watch(api, chat)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "Build a synthetic keeper"
          })
        )
        const run = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
        yield* eventually(() => paused)
        yield* api.StopGeneration({ versionId: run.entry.version.id })
        yield* eventually(() => finished(events, run.entry.version.id) !== undefined)
        const original = (yield* api.ListRolloutEffects({ chatId: chat.id }))[0]!
        const user = yield* api.Whoami()
        const reader = yield* Reader
        const slot = yield* reader.GetSlot({ userId: user.id, slotId: run.entry.slotId })
        const resumed = yield* api.ResumeVersion({
          versionId: run.entry.version.id,
          expectedRowVersion: slot.entry.rowVersion
        })
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Synthetic keeper"),
          1
        )
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: resumed.version.id })
        assert.isNotNull(
          yield* reader.RolloutToolReceipt({ userId: user.id, rolloutId: material.rolloutId, toolCallId: "create" })
        )
        assert.deepStrictEqual(
          yield* api.ListRolloutEffects({ chatId: chat.id }),
          [original],
          "Kept library changes retain their canonical effect row"
        )
        const offered = (yield* api.GetRunTranscript({ versionId: resumed.version.id })).tools
        assert.sameMembers(
          offered.filter((t) => t.capability === "library.write" || t.capability === "chats.setup").map((t) => t.name),
          [
            "create_card",
            "edit_card",
            "edit_card_note",
            "edit_library_note",
            "edit_preset",
            "edit_lorebook",
            "clone_card",
            "revert_change",
            "start_chat",
            // A card attached as a file (spec/WORKSHOP-CARDS.md §4.5).
            "import_card_file",
            ...[...builtinOperationExposures, ...cardSourceExposures]
              .filter((e) => e.capability === "library.write" || e.capability === "chats.setup")
              .map((e) => e.id)
          ]
        )
        const steps = yield* api.GetRolloutSteps({ versionId: resumed.version.id })
        const createStep = steps.findIndex((s) => s.kind === "tool" && s.tool === "create_card")
        const beforeArguments = yield* reader.GetSlot({ userId: user.id, slotId: run.entry.slotId })
        assert.strictEqual(
          yield* outcome(
            api.ResumeFromStep({
              versionId: resumed.version.id,
              step: createStep,
              edit: { kind: "arguments", arguments: { name: "Invalid", permission: true } },
              expectedRowVersion: beforeArguments.entry.rowVersion
            })
          ),
          "NotResumable"
        )
        const argumentsEdit = yield* api.ResumeFromStep({
          versionId: resumed.version.id,
          step: createStep,
          edit: { kind: "arguments", arguments: { name: "Needs checking" } },
          expectedRowVersion: beforeArguments.entry.rowVersion
        })
        assert.isTrue((yield* answerWaiting(api, events, argumentsEdit.version.id, "deny")).uncertain)
        yield* eventually(() => finished(events, argumentsEdit.version.id) !== undefined)
        assert.isTrue(
          (yield* api.GetRunTranscript({ versionId: argumentsEdit.version.id })).entries.some(
            (e) => e.role === "toolResult" && e.isError && e.text.includes("declined")
          )
        )
        assert.deepStrictEqual(
          yield* api.ListRolloutEffects({ chatId: chat.id }),
          [original],
          "Editing setup arguments never replays the old change"
        )
        const lookup = steps.findIndex((s) => s.kind === "tool" && s.tool === "list_library")
        const latest = yield* reader.GetSlot({ userId: user.id, slotId: run.entry.slotId })
        const edited = yield* api.ResumeFromStep({
          versionId: resumed.version.id,
          step: lookup,
          edit: { kind: "result", text: "Edited lookup result before creating." },
          expectedRowVersion: latest.entry.rowVersion
        })
        yield* eventually(() => finished(events, edited.version.id) !== undefined)
        assert.strictEqual(finished(events, edited.version.id)!.status, "complete")
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Synthetic keeper"),
          2
        )
        const effects = yield* api.ListRolloutEffects({ chatId: chat.id })
        assert.lengthOf(effects, 2)
        assert.deepStrictEqual(
          effects.find((e) => e.rolloutId === original.rolloutId),
          original,
          "Discarding a call does not undo its independent library change"
        )
        for (const effect of effects) yield* api.UndoRolloutEffect(effect)
        assert.isEmpty((yield* api.ListLibrary({ kind: "card" })).filter((c) => c.label === "Synthetic keeper"))
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("preserves story snapshots and refusal rows when library reads are explicitly selected", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body?.messages as Array<{ role: string }>
            const count = messages.filter((m) => m.role === "tool").length
            sse(
              res,
              count === 0
                ? call("read_card", { card: "Mira" }, "read")
                : count === 1
                  ? call(
                      "edit_card",
                      { character: "Mira", field: "description", find: "anything", replace: "changed" },
                      "refused-edit"
                    )
                  : completionChunks(["The story continues."], {})
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const rp = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          { key: "agent.tools", value: { tools: ["read_card", "edit_card"] } }
        ]
      })
      const material = yield* (yield* Reader).RolloutMaterial({
        userId: (yield* api.Whoami()).id,
        versionId: rp.version.id
      })
      const snapshot = JSON.parse(material.snapshot) as {
        agent: { tools: Array<{ name: string; capability?: string }> }
      }
      const [receipts] = yield* fixtureSql(
        config.dataDir,
        [{ sql: "SELECT tool_call_id FROM rollout_receipts WHERE rollout_id = ?", params: [material.rolloutId] }],
        { readOnly: true }
      )
      assert.isEmpty(receipts, "A refused story edit did not write a receipt before W3")
      assert.isFalse(
        snapshot.agent.tools.some((tool) => "capability" in tool),
        "Workshop metadata must not change stored story snapshots"
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("cannot enable setup tools in a story through state or a crafted provider call", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const messages = request.body?.messages as Array<{ role: string }>
            sse(
              res,
              messages.some((m) => m.role === "tool")
                ? completionChunks(["No setup was performed."], {})
                : call("create_card", { name: "Must never exist" }, "forged-setup")
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const rp = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {},
        state: [
          { key: "agent.enabled", value: { on: true } },
          {
            key: "agent.tools",
            value: {
              tools: [
                "create_card",
                "edit_card",
                "edit_card_note",
                "clone_card",
                "start_chat",
                ...builtinOperationExposures
                  .filter((e) => e.capability === "library.write" || e.capability === "chats.setup")
                  .map((e) => e.id)
              ]
            }
          }
        ]
      })
      const transcript = yield* api.GetRunTranscript({ versionId: rp.version.id })
      assert.notInclude(
        transcript.tools.map((t) => t.name),
        "create_card"
      )
      assert.notInclude(
        transcript.tools.map((t) => t.name),
        "clone_card"
      )
      assert.notInclude(
        transcript.tools.map((t) => t.name),
        "start_chat"
      )
      assert.strictEqual(transcript.tools.find((t) => t.name === "edit_card")!.effect, "chat_state")
      assert.isTrue(transcript.entries.some((e) => e.role === "toolResult" && e.isError))
      assert.isEmpty((yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Must never exist"))
      assert.isEmpty(yield* api.ListRolloutEffects({ chatId: rp.chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live(
    "replays a committed create_card through Resume without creating another card, and retains effects across swipes and purge",
    () => {
      const config = testConfig()
      return Effect.gen(function* () {
        const mock = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMockProvider((request, res) => {
              const messages = request.body?.messages as Array<{ role: string }>
              sse(
                res,
                messages.some((m) => m.role === "tool")
                  ? completionChunks(["Created the card."], {})
                  : call("create_card", { name: "Resume keeper" }, "receipt-create")
              )
            })
          ),
          (m) => Effect.promise(() => m.close())
        )
        const api = yield* client()
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: {}
        })
        const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
        const events = yield* watch(api, chat)
        const sent = yield* posted(
          api.SendMessage({
            chatId: chat.id,
            parentSlotId: chat.activeLeafSlotId,
            branch: false,
            content: "Create a synthetic keeper."
          })
        )
        const generated = yield* posted(
          api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false })
        )
        yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
        const user = yield* api.Whoami()
        const reader = yield* Reader
        const material = yield* reader.RolloutMaterial({ userId: user.id, versionId: generated.entry.version.id })
        const transcript = JSON.parse(material.transcript!) as Array<{ role: string }>
        const resultAt = transcript.findIndex((m) => m.role === "toolResult")
        assert.isAbove(resultAt, 0)
        yield* fixtureSql(config.dataDir, [
          {
            sql: "UPDATE rollout_payloads SET transcript_json = ? WHERE rollout_id = ?",
            params: [JSON.stringify(transcript.slice(0, resultAt)), material.rolloutId]
          },
          { sql: "UPDATE rollouts SET status = 'interrupted' WHERE id = ?", params: [material.rolloutId] },
          { sql: "UPDATE versions SET status = 'interrupted' WHERE id = ?", params: [generated.entry.version.id] }
        ])
        const slot = yield* reader.GetSlot({ userId: user.id, slotId: generated.entry.slotId })
        const resumed = yield* api.ResumeVersion({
          versionId: generated.entry.version.id,
          expectedRowVersion: slot.entry.rowVersion
        })
        yield* eventually(() => finished(events, resumed.version.id) !== undefined)
        assert.strictEqual(finished(events, resumed.version.id)!.status, "complete")
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Resume keeper"),
          1
        )
        assert.isTrue(
          (yield* api.GetRunTranscript({ versionId: resumed.version.id })).entries.some(
            (e) => e.role === "toolResult" && e.tool === "create_card" && !e.isError
          )
        )
        const keeper = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Resume keeper")!
        const visible = yield* reader.LibraryAccess({
          userId: user.id,
          chatId: chat.id,
          forkId: chat.currentForkId,
          leafSlotId: generated.entry.slotId,
          rolloutId: "next-reply",
          entities: [],
          refs: [],
          card: null
        })
        assert.include(visible.inView, keeper.entityId)

        const current = yield* reader.GetSlot({ userId: user.id, slotId: generated.entry.slotId })
        const swipe = yield* api.Regenerate({
          slotId: generated.entry.slotId,
          expectedRowVersion: current.entry.rowVersion
        })
        yield* eventually(() => finished(events, swipe.version.id) !== undefined)
        assert.lengthOf(yield* api.ListRolloutEffects({ chatId: chat.id }), 2)
        const binnedVersion = yield* api.DeleteVersion({ versionId: resumed.version.id })
        yield* api.PurgeBinItem({ itemId: binnedVersion.id })
        assert.lengthOf(
          yield* api.ListRolloutEffects({ chatId: chat.id }),
          2,
          "A swipe's purge cannot undo or discard independent library effects"
        )
        const binnedChat = yield* api.DeleteChat({ chatId: chat.id })
        yield* api.PurgeBinItem({ itemId: binnedChat.id })
        const [rows] = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT count(*) AS n FROM rollout_effects e JOIN rollouts r ON r.id = e.rollout_id WHERE r.chat_id = ?",
              params: [chat.id]
            }
          ],
          { readOnly: true }
        )
        assert.strictEqual(rows![0]!.n, 0)
        assert.lengthOf(
          (yield* api.ListLibrary({ kind: "card" })).filter((r) => r.label === "Resume keeper"),
          2
        )
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }
  )

  it.live("serializes repeated undo and concurrent user saves without losing the user's text", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const f = yield* fixture(config.dataDir, api)
      const card = yield* api.CreateCard({ label: "Undo race", name: "Undo race", description: "Before" })
      yield* f.run("edit_card", { card: card.id, changes: [{ field: "description", text: "Agent" }] }, "edit")
      const effect = (yield* api.ListRolloutEffects({ chatId: f.chat.id }))[0]!
      const both = yield* Effect.all([api.UndoRolloutEffect(effect), api.UndoRolloutEffect(effect)], { concurrency: 2 })
      assert.deepStrictEqual(both[0], both[1])
      const restored = yield* api.OpenEditor({ refId: card.id })
      assert.strictEqual(restored.ref.rowVersion, card.rowVersion + 2)
      yield* f.run(
        "edit_card",
        { card: card.id, changes: [{ field: "description", text: "Agent again" }] },
        "edit-again"
      )
      const again = (yield* api.ListRolloutEffects({ chatId: f.chat.id })).find((e) => e.toolCallId === "edit-again")!
      const [saved] = yield* Effect.all(
        [outcome(edit(api, card.id, "Concurrent user text")), outcome(api.UndoRolloutEffect(again))],
        { concurrency: 2 }
      )
      const after = yield* api.OpenEditor({ refId: card.id })
      if (saved === "ok") assert.strictEqual(after.doc.description, "Concurrent user text")
      else
        assert.isTrue(
          after.drafts.some((d) => d.content === "Concurrent user text"),
          "A stale save must retain its draft"
        )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

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
              if (/may already have happened|declined/.test(String(toolResults.at(-1)?.content)))
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
        yield* generateReply(api, {
          connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1`, providerSettings: { toolLoading: "every" } },
          model: {}
        })
        const chat = yield* api.CreateWorkshop({ grants: OPEN_LIBRARY })
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
            assert.strictEqual(step.label, name === "create_card" ? "Created the card" : "Started the chat")
            assert.strictEqual(step.title, name === "create_card" ? "Mara Quill" : "The Skerry Light")
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
        // A call re-run without a receipt may already have happened: it asks first, with that
        // warning, even though chat setup is allowed.
        assert.isTrue((yield* answerWaiting(api, events, uncertain.version.id, "deny")).uncertain)
        yield* eventually(() => finished(events, uncertain.version.id) !== undefined)
        assert.isTrue(
          (yield* api.GetRunTranscript({ versionId: uncertain.version.id })).entries.some(
            (e) => e.role === "toolResult" && e.isError && e.text.includes("declined")
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
        assert.isString(grant.text)
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
      assert.isTrue((yield* b.run("clone_card", { card: id, name: "Stolen clone" }, "foreign-clone")).isError)
      assert.isTrue((yield* b.run("start_chat", { cards: [id] }, "foreign-chat")).isError)
      const privatePreset = (yield* alice.ListLibrary({ kind: "preset" }))[0]!
      assert.isTrue(
        (yield* b.run("start_chat", { cards: ["Assistant"], preset: privatePreset.id }, "foreign-preset")).isError
      )
      const privateConnection = yield* alice.CreateConnection({
        kind: "openai-chat",
        settings: {
          name: "Synthetic private",
          baseUrl: "http://127.0.0.1:9/v1",
          compat: {},
          cacheTtlS: null,
          maxConcurrent: null,
          presetOverrideRefId: null
        }
      })
      const privateModel = yield* alice.AddUserModel({
        connectionId: privateConnection.id,
        key: "private-model",
        overrides: {}
      })
      assert.isTrue(
        (yield* b.run("start_chat", { cards: ["Assistant"], model: privateModel.id }, "foreign-model")).isError
      )
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
