// Regex scripts with neither flag rewrite text as it's written, through the server (ARCHITECTURE
// §12 "Rewrites"): a reply as it finishes, a continuation, the user's message as it's sent, an
// edit; the raw text is kept and can be restored; approval gates the preset's and card's lists.
// The mock provider stands in for the model. Synthetic text only.
import { assert, it } from "@effect/vitest"
import type { RegexScript } from "@rp/shared/docs/regexScript.ts"
import { Effect, Layer } from "effect"
import { regexToSt } from "../src/formats/preset.ts"
import * as Builtins from "../src/providers/builtins.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, type Recorded, sse, startMockProvider } from "./support/mockProvider.ts"

const script = (id: string, fields: Partial<RegexScript> = {}): RegexScript => ({
  id,
  name: id,
  find_regex: "/<cot>[\\s\\S]*?<\\/cot>\\s*/g",
  replace_string: "",
  trim_strings: [],
  placement: [2],
  disabled: false,
  markdown_only: false,
  prompt_only: false,
  run_on_edit: false,
  substitute_regex: "none",
  min_depth: null,
  max_depth: null,
  ...fields
})

/** A mock model that answers with each of `replies` in turn, recording what it was sent. */
const mockModel = (replies: Array<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => ({ requests: [] as Array<Recorded>, replies })).pipe(
      Effect.flatMap((state) =>
        Effect.promise(() =>
          startMockProvider((request, res) => {
            state.requests.push(request)
            sse(res, completionChunks([state.replies.shift() ?? "Plain."], { prompt_tokens: 10, completion_tokens: 2 }))
          })
        ).pipe(Effect.map((mock) => ({ ...state, mock })))
      )
    ),
    ({ mock }) => Effect.promise(() => mock.close())
  )

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(testConfig()), Builtins.layer))) as Effect.Effect<
    A,
    E,
    never
  >

const presetWith = (scripts: ReadonlyArray<RegexScript>) => ({ extensions: { regex_scripts: regexToSt(scripts) } })

it.live("a reply's chain of thought is stripped as it finishes; its raw text shows and restores", () =>
  run(
    Effect.gen(function* () {
      const model = yield* mockModel(["<cot>secret plan</cot>Hello there", "Fine."])
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: model.mock.url + "/v1" },
        model: {},
        preset: presetWith([script("strip")]),
        approveRegex: true
      })
      assert.equal(reply.version.content, "Hello there")
      assert.deepStrictEqual(reply.version.rewrite, {
        applied: [{ scope: "preset", id: "strip", name: "strip" }],
        failed: [],
        raw: true,
        rawReasoning: false,
        rawSections: false
      })
      assert.deepStrictEqual(yield* api.RawVersionText({ versionId: reply.version.id }), {
        content: "<cot>secret plan</cot>Hello there",
        reasoning: null,
        sections: null
      })
      // Later requests see the stored text, never the raw.
      const next = yield* posted(
        api.SendMessage({
          chatId: reply.chat.id,
          parentSlotId: reply.version.slotId,
          branch: false,
          content: "And then?"
        })
      )
      const { entry } = yield* posted(
        api.Generate({ chatId: reply.chat.id, parentSlotId: next.entry.slotId, branch: false })
      )
      yield* eventually(() => finished(reply.events, entry.version.id) !== undefined)
      const sent = JSON.stringify(model.requests.at(-1)!.body)
      assert.include(sent, "Hello there")
      assert.notInclude(sent, "secret plan")
      // Restoring brings the raw text back as a new version, which no script rewrites.
      const before = yield* api.ReadPath({
        chatId: reply.chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 50
      })
      const at = before.entries.find((e) => e.slotId === reply.version.slotId)!
      const restored = yield* api.RestoreRawText({
        slotId: reply.version.slotId,
        versionId: reply.version.id,
        expectedRowVersion: at.rowVersion
      })
      assert.equal(restored.version.content, "<cot>secret plan</cot>Hello there")
      assert.isUndefined(restored.version.rewrite)
      assert.equal(restored.version.sourceVersionId, reply.version.id)
    })
  )
)

it.live("nothing is rewritten until the preset's scripts are allowed; global scripts need no approval", () =>
  run(
    Effect.gen(function* () {
      const model = yield* mockModel(["<cot>a</cot>Hi"])
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: model.mock.url + "/v1" },
        model: {},
        preset: presetWith([script("strip")])
      })
      assert.equal(reply.version.content, "<cot>a</cot>Hi")
      assert.isUndefined(reply.version.rewrite)
      assert.deepStrictEqual(yield* api.RawVersionText({ versionId: reply.version.id }), {
        content: null,
        reasoning: null,
        sections: null
      })
      // The account's own list runs without approval, on the next text written.
      const read = yield* api.GetGlobalRegex()
      const saved = yield* api.SetGlobalRegex({
        scripts: [script("mine", { find_regex: "/flood/g", replace_string: "storm", placement: [1] })],
        expectedRevision: read.revision
      })
      assert.equal(saved.revision, read.revision + 1)
      const stale = yield* Effect.flip(api.SetGlobalRegex({ scripts: [], expectedRevision: read.revision }))
      assert.equal(stale._tag, "StaleWrite")
      const sent = yield* posted(
        api.SendMessage({
          chatId: reply.chat.id,
          parentSlotId: reply.version.slotId,
          branch: false,
          content: "A flood."
        })
      )
      assert.equal(sent.entry.version.content, "A storm.")
      assert.deepStrictEqual(sent.entry.version.rewrite?.applied, [{ scope: "global", id: "mine", name: "mine" }])
    })
  )
)

it.live("the user's message is rewritten as it's sent, an edit only by run-on-edit scripts", () =>
  run(
    Effect.gen(function* () {
      const model = yield* mockModel(["Reply."])
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: model.mock.url + "/v1" },
        model: {},
        content: "The road flooded.",
        preset: presetWith([
          script("send", { find_regex: "/road/g", replace_string: "path", placement: [1] }),
          script("edit", { find_regex: "/river/g", replace_string: "creek", placement: [1], run_on_edit: true })
        ]),
        approveRegex: true
      })
      assert.equal(reply.sent.version.content, "The path flooded.")
      assert.deepStrictEqual(yield* api.RawVersionText({ versionId: reply.sent.version.id }), {
        content: "The road flooded.",
        reasoning: null,
        sections: null
      })
      const amended = yield* api.AmendVersion({
        versionId: reply.sent.version.id,
        content: "The road and the river.",
        expectedRowVersion: reply.sent.version.rowVersion
      })
      // Only the run-on-edit script ran: "road" stays.
      assert.equal(amended.content, "The road and the creek.")
      assert.deepStrictEqual(amended.rewrite?.applied, [{ scope: "preset", id: "edit", name: "edit" }])
      assert.deepStrictEqual(yield* api.RawVersionText({ versionId: amended.id }), {
        content: "The road and the river.",
        reasoning: null,
        sections: null
      })
    })
  )
)

it.live("a continuation is rewritten with the text it continues; a card's scripts run once allowed", () =>
  run(
    Effect.gen(function* () {
      const model = yield* mockModel(["Start.", "<cot>more</cot> And more."])
      const api = yield* client()
      const reply = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: model.mock.url + "/v1" },
        // Continue sends the reply as a prefill.
        model: { prefill: "assistant" },
        mira: { regex: [script("card-strip")] }
      })
      assert.equal(reply.version.content, "Start.")
      // Not allowed yet: the card's own scripts don't run.
      const card = yield* api.SetRegexApproval({
        refId: reply.mira.ref.id,
        approved: true,
        expectedRowVersion: reply.mira.ref.rowVersion
      })
      assert.isDefined(card)
      const path = yield* api.ReadPath({
        chatId: reply.chat.id,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 50
      })
      const at = path.entries.find((e) => e.slotId === reply.version.slotId)!
      const continued = yield* api.ContinueVersion({
        versionId: reply.version.id,
        expectedRowVersion: at.rowVersion
      })
      yield* eventually(() => finished(reply.events, continued.version.id) !== undefined)
      const done = finished(reply.events, continued.version.id)!
      assert.equal(done.status, "complete", JSON.stringify(done.error))
      // The pattern takes the whitespace after the block too.
      assert.equal(done.content, "Start.And more.")
      assert.deepStrictEqual(done.rewrite?.applied, [{ scope: "character", id: "card-strip", name: "card-strip" }])
      assert.deepStrictEqual(yield* api.RawVersionText({ versionId: done.id }), {
        content: "Start.<cot>more</cot> And more.",
        reasoning: null,
        sections: null
      })
    })
  )
)
