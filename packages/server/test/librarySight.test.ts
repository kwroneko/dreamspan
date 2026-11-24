// What a workshop's assistant may look at (spec/WORKSHOP-CARDS.md §2.1–§2.5, units C6 and C7):
// what's in view never asks; anything else asks its library class once per reply, with Allow (this
// reply), Allow in this chat, Allow always for the assistant card and Allow always; Off refuses;
// the standing grants are listed and removed; and an item in view changed by someone else is told
// on the next turn. Synthetic data and a scripted loopback provider only.
import type { ServerResponse } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import type { ApprovalPrompt } from "@dreamspan/shared/agent.ts"
import type { Chat, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { newCardDoc, textField } from "@dreamspan/shared/editing.ts"
import type { ApprovalAnswer } from "@dreamspan/shared/workshopApi.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { makeLibrarySight } from "../src/agent/librarySight.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { ALWAYS_GRANTS, CARD_GRANTS, settingsRegistry, USER_ONLY_SETTINGS } from "../src/db/settings.ts"

type Api = Effect.Success<ReturnType<typeof client>>
interface Body {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>
}

const TRIGGER = "Workshop task:"
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
type Step = readonly [name: string, args: unknown, id: string]

/** Each task's tool calls, by the task's text; then an answer. */
const scripted = (tasks: Record<string, ReadonlyArray<Step>>) => (request: Recorded, res: ServerResponse) => {
  const messages = (request.body as unknown as Body).messages
  const lastTask = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content).includes(TRIGGER))
  if (lastTask < 0) return sse(res, completionChunks(["Ready."], {}))
  const text = JSON.stringify(messages[lastTask]!.content)
  const steps = Object.entries(tasks).find(([name]) => text.includes(`[${name}]`))?.[1] ?? []
  const step = steps[messages.slice(lastTask).filter((m) => m.role === "tool").length]
  sse(res, step ? call(...step) : completionChunks(["Done."], {}))
}

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

const waitingFor = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) => {
  const steps = events.flatMap((e) => (e._tag === "Steps" && e.versionId === versionId ? [e.steps] : [])).at(-1) ?? []
  const step = steps.find((s) => s.kind === "tool" && s.id === toolCallId)
  return step?.kind === "tool" && step.status === "waiting" ? step.approval : undefined
}
const awaitApproval = (events: ReadonlyArray<ChatEvent>, versionId: string, toolCallId: string) =>
  Effect.gen(function* () {
    yield* eventually(() => waitingFor(events, versionId, toolCallId) !== undefined)
    return waitingFor(events, versionId, toolCallId)!
  })
const answer = (api: Api, prompt: ApprovalPrompt, reply: ApprovalAnswer, note?: string) =>
  api.AnswerToolApproval({
    rolloutId: prompt.rolloutId,
    toolCallId: prompt.toolCallId,
    digest: prompt.digest,
    answer: reply,
    ...(note ? { note } : {})
  })

const setup = (tasks: Record<string, ReadonlyArray<Step>>) =>
  Effect.gen(function* () {
    const mock = yield* Effect.acquireRelease(
      Effect.promise(() => startMockProvider(scripted(tasks))),
      (m) => Effect.promise(() => m.close())
    )
    const api = yield* client()
    yield* generateReply(api, { connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` }, model: {} })
    const user = yield* api.Whoami()
    // Someone else in the library: outside every workshop's view.
    yield* (yield* Writer).CreateEntity({
      userId: user.id,
      kind: "card",
      label: "Mara Quill",
      subtitle: "",
      doc: { ...newCardDoc("Mara Quill"), description: "Mara keeps the lighthouse." },
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const open = (grants?: ReadonlyArray<{ capability: string; mode: "off" | "ask" | "allow" }>) =>
      Effect.gen(function* () {
        const chat = yield* api.CreateWorkshop(grants ? { grants } : {})
        return { chat, events: yield* watch(api, chat) }
      })
    return { mock, api, open }
  })

/** Sends a task and asks for the reply; doesn't wait for it. */
const task = (api: Api, chat: Chat, content: string, at?: Pick<Chat, "currentForkId" | "activeLeafSlotId">) =>
  Effect.gen(function* () {
    const current = at ?? (yield* api.GetChat({ chatId: chat.id }))
    const sent = yield* posted(
      api.SendMessage({
        chatId: chat.id,
        parentSlotId: current.activeLeafSlotId,
        forkId: current.currentForkId,
        branch: false,
        content: `${TRIGGER} [${content}]`
      })
    )
    const generated = yield* posted(
      api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, forkId: current.currentForkId, branch: false })
    )
    return generated.entry.version.id as VersionId
  })

const done = (events: ReadonlyArray<ChatEvent>, versionId: VersionId) =>
  eventually(() => finished(events, versionId) !== undefined)

/** The reply's own last `count` tool results (its transcript carries the earlier replies' too). */
const results = (api: Api, versionId: VersionId, count: number) =>
  Effect.map(api.GetRunTranscript({ versionId }), (t) => t.entries.filter((e) => e.role === "toolResult").slice(-count))

const READ_OTHER: Step = ["read_card", { card: "Mara Quill" }, "other"]

describe("library sight", () => {
  it.live("a reply and its subagent share a class question and its decline", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateWorkshop({})
      const user = yield* api.Whoami()
      const parent = "sight-parent"
      const child = "sight-child"
      const next = "sight-next"
      const insert = `INSERT INTO rollouts
        (id,chat_id,kind,status,role,request_class,created_at,updated_at,spawned_by_rollout_id,spawned_by_call_id,agent_handle)
        VALUES (?,?,'workshop','running','assistant','interactive',1,1,?,?,?)`
      yield* fixtureSql(config.dataDir, [
        { sql: insert, params: [parent, chat.id, null, null, null] },
        { sql: insert, params: [child, chat.id, parent, "agent-call", "helper-1"] },
        { sql: insert, params: [next, chat.id, null, null, null] }
      ])
      const reader = yield* Reader
      const writer = yield* Writer
      const registries = yield* ExecutionRegistry
      const prompts: Array<ApprovalPrompt> = []
      const access = (rolloutId: string, toolCallId: string) =>
        makeLibrarySight({ reader, writer, registries, userId: user.id, chatId: chat.id, rolloutId })(
          {
            userId: user.id,
            chatId: chat.id,
            forkId: chat.currentForkId,
            slotId: chat.activeLeafSlotId as SlotId,
            versionId: "unused" as VersionId,
            rolloutId,
            toolCallId,
            leafSlotId: chat.activeLeafSlotId,
            reader,
            writer,
            viewers: null,
            cache: new Map()
          },
          (prompt) => {
            if (prompt) prompts.push(prompt)
          }
        ).gate("library.cards", "It wants to look through your cards.")

      const first = yield* access(parent, "first").pipe(Effect.forkScoped)
      const second = yield* access(child, "second").pipe(Effect.forkScoped)
      yield* eventually(() => prompts.length > 0)
      yield* answer(api, prompts[0]!, "deny", "Please attach one.")
      const denied = yield* Fiber.join(first)
      assert.isFalse(denied.ok)
      if (!denied.ok) assert.include(denied.text, "Please attach one.")
      assert.deepStrictEqual(yield* Fiber.join(second), denied)
      assert.deepStrictEqual(yield* access(parent, "third"), denied)
      assert.lengthOf(prompts, 1)

      const fresh = yield* access(next, "fresh").pipe(Effect.forkScoped)
      yield* eventually(() => prompts.length === 2)
      yield* answer(api, prompts[1]!, "allow")
      assert.deepStrictEqual(yield* Fiber.join(fresh), { ok: true })
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("the assistant's own card never asks; another card asks its class once for the reply", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, open } = yield* setup({
        own: [["read_card", { card: "Assistant" }, "own"]],
        look: [["list_library", { kind: "card", query: "Mara" }, "list"], READ_OTHER],
        again: [READ_OTHER]
      })
      const { chat, events } = yield* open()
      const own = yield* task(api, chat, "own")
      yield* done(events, own)
      const [mine] = yield* results(api, own, 1)
      assert.isFalse(mine!.isError, mine!.text)
      assert.include(mine!.text, "Assistant")

      const look = yield* task(api, chat, "look")
      const prompt = yield* awaitApproval(events, look, "list")
      assert.strictEqual(prompt.capability, "library.cards")
      assert.strictEqual(prompt.title, "Let the assistant look through your cards?")
      assert.strictEqual(
        prompt.scoped?.line,
        "It wants to search your characters and personas for “Mara”, and to read what it finds."
      )
      assert.strictEqual(prompt.scoped?.card?.name, "Assistant")
      yield* answer(api, prompt, "allow")
      // Allow covers the rest of the reply: reading the card it found doesn't ask again.
      yield* done(events, look)
      const read = yield* results(api, look, 2)
      assert.lengthOf(read, 2)
      assert.include(read[1]!.text, "Mara keeps the lighthouse.")
      // The next reply asks again.
      const again = yield* task(api, chat, "again")
      const asked = yield* awaitApproval(events, again, "other")
      assert.strictEqual(asked.scoped?.line, "It wants to open the card “Mara Quill”.")
      yield* answer(api, asked, "deny", "Only the ones I attach.")
      yield* done(events, again)
      const [declined] = yield* results(api, again, 1)
      assert.isTrue(declined!.isError)
      // The note is the user's words, so it comes quoted as data.
      assert.include(
        declined!.text,
        "The user declined letting you look through their cards. Ask them to attach the ones they want you to work on. Their note: Only the ones I attach."
      )
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Allow in this chat holds in the workshop; Off refuses outside view and keeps its own card", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, open } = yield* setup({
        first: [READ_OTHER],
        second: [READ_OTHER, ["read_card", { card: "Assistant" }, "own"]]
      })
      const { chat, events } = yield* open()
      const first = yield* task(api, chat, "first")
      yield* answer(api, yield* awaitApproval(events, first, "other"), "allow_chat")
      yield* done(events, first)
      const standing = (yield* api.ListWorkshopCapabilities({ chatId: chat.id })).find((c) => c.id === "library.cards")!
      assert.strictEqual(standing.mode, "allow")
      assert.isTrue(standing.chosen)
      const second = yield* task(api, chat, "second")
      yield* done(events, second)
      assert.isFalse((yield* results(api, second, 2))[0]!.isError)

      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.cards", mode: "off" })
      const off = yield* task(api, chat, "second")
      yield* done(events, off)
      const [refused, own] = yield* results(api, off, 2)
      assert.isTrue(refused!.isError)
      assert.include(refused!.text, "“Look through your cards” is turned off in this workshop")
      assert.isFalse(own!.isError, own!.text)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("turning Cards off during a write approval leaves the pinned card unchanged", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, open } = yield* setup({
        edit: [["edit_card", { card: "Mara Quill", changes: [{ field: "description", text: "New text." }] }, "edit"]]
      })
      const { chat, events } = yield* open([
        { capability: "library.cards", mode: "allow" },
        { capability: "library.write", mode: "ask" }
      ])
      const before = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Mara Quill")!
      const edit = yield* task(api, chat, "edit")
      const prompt = yield* awaitApproval(events, edit, "edit")
      assert.strictEqual(prompt.capability, "library.write")
      yield* api.SetWorkshopGrant({ chatId: chat.id, capability: "library.cards", mode: "off" })
      yield* answer(api, prompt, "allow")
      yield* done(events, edit)
      const [result] = yield* results(api, edit, 1)
      assert.isTrue(result!.isError)
      assert.include(result!.text, "turned off in this workshop")
      assert.strictEqual((yield* api.OpenEditor({ refId: before.id })).ref.headRevisionId, before.headRevisionId)
      assert.isEmpty(yield* api.ListRolloutEffects({ chatId: chat.id }))
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("Allow always and Allow always for the card hold in new workshops, are listed, and are removed", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, open } = yield* setup({
        cards: [READ_OTHER],
        presets: [["read_preset", { preset: "Workshop" }, "preset"]]
      })
      const first = yield* open()
      const cards = yield* task(api, first.chat, "cards")
      yield* answer(api, yield* awaitApproval(first.events, cards, "other"), "allow_card")
      yield* done(first.events, cards)
      const presets = yield* task(api, first.chat, "presets")
      const presetPrompt = yield* awaitApproval(first.events, presets, "preset")
      assert.strictEqual(presetPrompt.capability, "library.presets")
      yield* answer(api, presetPrompt, "allow_always")
      yield* done(first.events, presets)

      const grants = yield* api.ListLibraryGrants({})
      assert.deepStrictEqual(grants.always, ["library.presets"])
      assert.lengthOf(grants.cards, 1)
      assert.strictEqual(grants.cards[0]!.name, "Assistant")
      assert.deepStrictEqual(grants.cards[0]!.classes, ["library.cards"])

      // A new workshop with the same assistant doesn't ask for either, and its chip says why.
      const second = yield* open()
      const view = yield* api.ListWorkshopCapabilities({ chatId: second.chat.id })
      const cardsRow = view.find((c) => c.id === "library.cards")!
      assert.strictEqual(cardsRow.mode, "allow")
      assert.isFalse(cardsRow.chosen)
      assert.deepStrictEqual(cardsRow.standing, { from: "card", name: "Assistant" })
      assert.deepStrictEqual(view.find((c) => c.id === "library.presets")!.standing, { from: "always" })
      const quiet = yield* task(api, second.chat, "cards")
      yield* done(second.events, quiet)
      assert.isFalse((yield* results(api, quiet, 1))[0]!.isError)

      // Removed, the next workshop asks again.
      const after = yield* api.RemoveLibraryGrant({ capability: "library.cards", entityId: grants.cards[0]!.entityId })
      assert.isEmpty(after.cards)
      yield* api.RemoveLibraryGrant({ capability: "library.presets" })
      assert.isEmpty((yield* api.ListLibraryGrants({})).always)
      const third = yield* open()
      const asks = yield* task(api, third.chat, "cards")
      yield* awaitApproval(third.events, asks, "other")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })

  it.live("a card changed since the last reply on this branch is told once, even after a sibling replies", () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const { api, open, mock } = yield* setup({ hello: [] })
      const { chat, events } = yield* open()
      const first = yield* task(api, chat, "hello")
      yield* done(events, first)
      const original = yield* api.GetChat({ chatId: chat.id })
      // The user changes the assistant's card in its editor.
      const card = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      const field = textField(["description"])
      const before = yield* api.OpenEditor({ refId: card.id })
      const draft = yield* api.SaveEditorDraft({
        refId: card.id,
        field,
        content: "A patient editor of cards.",
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: before.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId: card.id,
        expectedRowVersion: before.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })
      const sibling = (yield* api.CreateFork({
        chatId: chat.id,
        fromForkId: original.currentForkId,
        atSlotId: chat.activeLeafSlotId
      })).fork
      const other = yield* task(api, chat, "hello", {
        currentForkId: sibling.id,
        activeLeafSlotId: sibling.tipSlotId
      })
      yield* done(events, other)
      const line = "Changed since you last saw it: Assistant (Description, by the user)."
      const sent = () =>
        JSON.stringify(
          mock
            .requests()
            .filter((r) => r.path === "/v1/chat/completions")
            .at(-1)!.body
        )
      const second = yield* task(api, chat, "hello", original)
      yield* done(events, second)
      assert.include(sent(), line)
      const current = (yield* api.ListForks({ chatId: chat.id })).find((fork) => fork.id === original.currentForkId)!
      const third = yield* task(api, chat, "hello", {
        currentForkId: current.id,
        activeLeafSlotId: current.tipSlotId
      })
      yield* done(events, third)
      // Said once: the turn after it is quiet (the earlier user message keeps its own tail).
      const last = (mock.requests().at(-1)!.body as unknown as Body).messages.at(-1)
      assert.notInclude(JSON.stringify(last), line)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
})

describe("library sight settings", () => {
  it("the standing grants are the user's alone: never an agent setting, whatever registers them", () => {
    for (const id of [CARD_GRANTS, ALWAYS_GRANTS]) {
      const entry = settingsRegistry.get(id)
      assert.strictEqual(entry?.scope, "user", id)
      assert.isUndefined(entry?.agent, id)
      // SetAgentSetting and the agent's settings list check this set too (workshopEffects.ts, operationPolicies.ts).
      assert.isTrue(USER_ONLY_SETTINGS.has(id), id)
    }
  })
})
