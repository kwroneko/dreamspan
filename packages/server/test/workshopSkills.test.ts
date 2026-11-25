// Workshop skills in every loading mode (spec/TOOL-LOADING.md §5, spec/WORKSHOP-CONTEXT.md §4.2):
// load_skill is offered whether tools are deferred or not, the preset's Skills and Card skills
// markers list what it offers, and a card's own skill text reaches the model only once the user
// allows it. Requests keep one byte-identical prefix throughout.
import { assert, it } from "@effect/vitest"
import type { ChatEvent } from "@dreamspan/shared/chatApi.ts"
import { valueField } from "@dreamspan/shared/editing.ts"
import type { RefId } from "@dreamspan/shared/library.ts"
import { Effect, Stream } from "effect"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { anthropicSse, startMockProvider } from "./support/mockProvider.ts"

type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown }
type Body = {
  system?: unknown
  tools?: Array<{ name: string; description?: string; defer_loading?: boolean }>
  messages: Array<{ role: string; content: string | Array<Block> }>
}

const start = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [],
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 }
  }
}
const toolUse = (id: string, name: string, input: unknown) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
]
const text = (value: string) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  { type: "message_stop" }
]
const results = (body: Body) =>
  body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : []))

for (const mode of ["every", "auto", "dispatcher"] as const) {
  it.live(`${mode}: card skills are listed by name and sent only once allowed`, () => {
    const config = testConfig()
    return Effect.gen(function* () {
      const secret = "SYNTHETIC SKILL INSTRUCTIONS"
      const untrusted = "UNTRUSTED INDEX TEXT"
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((request, res) => {
            const body = request.body as unknown as Body
            if (!body?.tools?.length) return anthropicSse(res, text("Hello."))
            const done = results(body).length
            // Denied once, asked again and allowed, then the skill's built-in sibling, then done.
            anthropicSse(
              res,
              done === 0
                ? toolUse("ask_1", "load_skill", { name: "proofread" })
                : done === 1
                  ? toolUse("ask_2", "load_skill", { name: "proofread" })
                  : done === 2
                    ? toolUse("cards_1", "load_skill", { name: "cards" })
                    : text("Done.")
            )
          })
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      yield* generateReply(api, {
        connection: {
          kind: "anthropic",
          baseUrl: mock.url,
          apiKey: "synthetic-key",
          providerSettings: { toolLoading: mode }
        },
        modelKey: "claude-sonnet-4-5",
        model: {}
      })
      const chat = yield* api.CreateWorkshop({})
      const user = yield* api.Whoami()
      const { Writer } = yield* Effect.promise(() => import("../src/db/Database.ts"))
      const { newCardDoc } = yield* Effect.promise(() => import("@dreamspan/shared/editing.ts"))
      const helper = yield* (yield* Writer).CreateEntity({
        userId: user.id,
        kind: "card",
        label: "Synthetic helper",
        subtitle: "",
        schemaVersion: 1,
        origin: "import",
        sourcePath: null,
        doc: {
          ...newCardDoc("Synthetic helper"),
          extensions: {
            dreamspan: {
              skills: [
                { name: "proofread", description: untrusted, instructions: secret, tools: ["read_card"] },
                { use: "cards" }
              ]
            }
          }
        }
      })
      const assistant = (yield* api.ListLibrary({ kind: "card" })).find((r) => r.label === "Assistant")!
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "Join", entityId: helper.ref.entityId }
      })
      yield* api.ChangeCast({
        chatId: chat.id,
        slotId: chat.activeLeafSlotId,
        change: { _tag: "Leave", entityId: assistant.entityId }
      })
      // Turn the preset's two skill markers on (the seeded order has them off).
      const preset = (yield* api.ListLibrary({ kind: "preset" })).find((r) => r.label === "Workshop")!
      const refId = preset.id as RefId
      const opened = yield* api.OpenEditor({ refId })
      const order = (opened.doc as { order: Array<{ identifier: string; enabled: boolean }> }).order.map((e) =>
        e.identifier === "skillsIndex" || e.identifier === "cardSkills" ? { ...e, enabled: true } : e
      )
      const field = valueField(["order"])
      const draft = yield* api.SaveEditorDraft({
        refId,
        field,
        content: JSON.stringify(order),
        draftId: null,
        expectedRowVersion: null,
        expectedSession: null,
        baseRevisionId: opened.ref.headRevisionId
      })
      yield* api.CommitEditorDrafts({
        refId,
        expectedRowVersion: opened.ref.rowVersion,
        fields: [{ field, draftId: draft.id, expectedRowVersion: draft.rowVersion }],
        message: null
      })

      const events: Array<ChatEvent> = []
      yield* api.SubscribeChat({ chatId: chat.id }).pipe(
        Stream.runForEach((batch) => Effect.sync(() => events.push(...batch))),
        Effect.forkScoped
      )
      yield* eventually(() => events.length > 0)
      const from = mock.requests().length
      const sent = yield* posted(
        api.SendMessage({ chatId: chat.id, parentSlotId: chat.activeLeafSlotId, branch: false, content: "Proofread." })
      )
      const generated = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
      const waiting = (id: string) =>
        events
          .flatMap((e) => (e._tag === "Steps" && e.versionId === generated.entry.version.id ? e.steps : []))
          .findLast((s) => s.kind === "tool" && s.id === id && s.status === "waiting")
      const answer = (id: string, value: "allow" | "deny") =>
        Effect.gen(function* () {
          yield* eventually(() => waiting(id) !== undefined)
          const step = waiting(id)!
          if (step.kind !== "tool" || !step.approval) return yield* Effect.die(`Missing approval for ${id}`)
          assert.strictEqual(step.approval.capability, "skills.card")
          // The user sees the instructions they are asked about; the model hasn't.
          assert.include(JSON.stringify(step.approval.rows), secret)
          yield* api.AnswerToolApproval({
            rolloutId: step.approval.rolloutId,
            toolCallId: step.approval.toolCallId,
            digest: step.approval.digest,
            answer: value
          })
        })
      yield* answer("ask_1", "deny")
      yield* answer("ask_2", "allow")
      yield* eventually(() => finished(events, generated.entry.version.id) !== undefined)
      const version = finished(events, generated.entry.version.id)!
      assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
      assert.strictEqual(version.content, "Done.")

      const bodies = mock
        .requests()
        .slice(from)
        .map((r) => r.body as unknown as Body)
        .filter((b) => b?.tools?.length)
      assert.lengthOf(bodies, 4)
      const first = bodies[0]!
      // load_skill is offered directly in every mode, even with every tool sent from the start.
      const names = first.tools!.map((t) => t.name)
      assert.include(names, "load_skill")
      if (mode === "every") {
        // The SDK keeps one invisible deferred placeholder for native transcript updates.
        assert.deepStrictEqual(
          first.tools!.filter((t) => t.defer_loading).map((t) => t.name),
          ["__pi_deferred_placeholder__"]
        )
        assert.notInclude(names, "tool_search")
        assert.include(names, "read_card")
      }
      if (mode === "dispatcher") assert.include(names, "call_tool")
      const loader = first.tools!.find((t) => t.name === "load_skill")!.description ?? ""
      assert.include(loader, "- proofread: Card skill.")
      assert.include(loader, "- cards:")
      // The markers list the same skills; the card's skill goes by name only.
      // (Where the preset puts them: the system field, or the leading messages it's merged into.)
      const system = JSON.stringify(first.system ?? null)
      const strings = (value: unknown): Array<string> =>
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.flatMap(strings)
            : value && typeof value === "object"
              ? Object.values(value).flatMap(strings)
              : []
      const lines = strings([first.system, first.messages]).join("\n").split("\n")
      const block = (header: string) => {
        const start = lines.findIndex((l) => l.startsWith(header))
        assert.isAtLeast(start, 0, `${header} is sent`)
        const end = lines.findIndex((l, i) => i > start && !l.startsWith("- "))
        return lines.slice(start + 1, end === -1 ? undefined : end)
      }
      const installed = block("Skills you can load with load_skill")
      assert.isTrue(installed.some((l) => l.startsWith("- cards: ")))
      assert.isFalse(installed.some((l) => l.startsWith("- proofread")))
      assert.deepStrictEqual(block("Skills from the card you speak as"), ["- proofread"])
      // One prefix: the same tools and system bytes, each request extending the one before.
      for (const [i, body] of bodies.entries()) {
        assert.strictEqual(JSON.stringify(body.tools), JSON.stringify(first.tools), `tools of request ${i}`)
        assert.strictEqual(JSON.stringify(body.system ?? null), system, `system of request ${i}`)
        if (i > 0) {
          // The rolling cache breakpoint moves to the newest message; everything else is unchanged.
          const bytes = (value: unknown) => JSON.stringify(value, (k, v) => (k === "cache_control" ? undefined : v))
          const before = bytes(bodies[i - 1]!.messages)
          const now = bytes(body.messages.slice(0, bodies[i - 1]!.messages.length))
          let at = 0
          while (at < before.length && before[at] === now[at]) at++
          assert.strictEqual(
            now,
            before,
            `messages of request ${i} differ at ${at}: ${before.slice(at - 80, at + 200)} | ${now.slice(at - 80, at + 200)}`
          )
        }
      }
      // The card's own words: never its description, and its instructions only after the allow.
      for (const body of bodies) assert.notInclude(JSON.stringify(body), untrusted)
      assert.notInclude(JSON.stringify(bodies[0]), secret)
      assert.notInclude(JSON.stringify(bodies[1]), secret, "a denied load sends nothing of the skill")
      // (Native loading moves a load's text after the message's tool results.)
      assert.include(JSON.stringify(bodies[2]!.messages.at(-1)), secret)
      // The built-in skill the card names loads without asking.
      assert.notInclude(JSON.stringify(results(bodies[3]!).at(-1)), "isn't loaded")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
  })
}
