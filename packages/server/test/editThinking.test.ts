// A message's thinking edited, added and removed in its edit (thinkedit1; SillyTavern's reasoning
// block edit): an edit of a reply keeps, replaces or removes it on the new version; a user's
// own version changes in place with the earlier thinking in its history, which restores it;
// another branch keeps what it showed; the thinking field's draft is committed with the edit.
// Edited thinking is plain text: a reply whose run signed its thinking, edited, sends none of
// it later. Synthetic chats only.
import { assert, describe, it } from "@effect/vitest"
import { Type } from "@earendil-works/pi-ai"
import { NewVersion, type EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import type { ServerResponse } from "node:http"
import type { RolloutTool } from "../src/agent/tools.ts"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { ExecutionRegistry } from "../src/execution.ts"
import { stLine } from "../src/formats/stChatExport.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"
import { type AnthropicBody, enforcingAnthropic } from "./support/enforcingAnthropic.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { type Recorded, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

/** A chat whose one message is a model reply with thinking, as a provider's reply has it. */
const replyWithThinking = (api: Api) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const { entityId } = yield* writer.CreateEntity({
      userId,
      kind: "card",
      label: "Mira",
      subtitle: "",
      doc: cardDoc("Mira"),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const chat = yield* writer.CreateChat({
      userId,
      kind: "rp",
      status: "active",
      title: "Synthetic thinking",
      participants: [entityId as EntityId],
      greeting: new NewVersion({
        speakerEntityId: entityId as EntityId,
        writer: "model",
        content: "The lamp is lit.",
        reasoning: "Model plan: light the lamp.",
        status: "complete",
        macroMode: "verbatim",
        origin: "greeting"
      })
    })
    const slotId = chat.activeLeafSlotId!
    const entry = () =>
      api
        .ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
        .pipe(Effect.map((path) => path.entries.find((e) => e.slotId === slotId)!))
    return { chat, slotId, entry }
  })

describe("thinking in a message's edit", () => {
  it.live("an edit of a reply keeps, replaces or removes its thinking on the new version only", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { slotId, entry } = yield* replyWithThinking(api)
      const original = yield* entry()
      // Text only: the thinking goes with it (it used to be dropped).
      const kept = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: "The lamp is lit, brightly.",
        expectedRowVersion: original.rowVersion
      })
      assert.strictEqual(kept.version.reasoning, "Model plan: light the lamp.")
      assert.strictEqual(kept.version.writer, "human")
      // Changed: plain text on the edited version, which has no run to replay.
      const changed = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: original.version.content,
        reasoning: "My own plan.",
        expectedRowVersion: kept.rowVersion
      })
      assert.strictEqual(changed.version.reasoning, "My own plan.")
      assert.strictEqual(changed.version.context, null)
      // Removed.
      const removed = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: original.version.content,
        reasoning: "",
        expectedRowVersion: changed.rowVersion
      })
      assert.isUndefined(removed.version.reasoning)
      // The reply as it came is untouched, among the versions.
      const versions = yield* api.ListVersions({ slotId })
      assert.strictEqual(versions.find((v) => v.id === original.version.id)!.reasoning, "Model plan: light the lamp.")
      // The ST export carries the edited thinking as extra.reasoning.
      const line = JSON.parse(stLine(changed, [changed.version], { name: "Mira", user: false }, "Sam")) as {
        extra: { reasoning?: string }
      }
      assert.strictEqual(line.extra.reasoning, "My own plan.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the user's own version changes in place, its earlier thinking in its history, and restores", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, slotId, entry } = yield* replyWithThinking(api)
      const original = yield* entry()
      const edited = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: "The lamp is lit.",
        reasoning: "First plan.",
        expectedRowVersion: original.rowVersion
      })
      const versionId = edited.version.id
      // Thinking alone: an amendment, its row version counted up, the text the same.
      const amended = yield* api.AmendVersion({
        versionId,
        content: "The lamp is lit.",
        reasoning: "Second plan.",
        expectedRowVersion: edited.version.rowVersion
      })
      assert.strictEqual(amended.id, versionId)
      assert.strictEqual(amended.reasoning, "Second plan.")
      assert.strictEqual(amended.rowVersion, edited.version.rowVersion + 1)
      // Text alone keeps the thinking, and the history records what it had.
      const retexted = yield* api.AmendVersion({
        versionId,
        content: "The lamp is out.",
        expectedRowVersion: amended.rowVersion
      })
      assert.strictEqual(retexted.reasoning, "Second plan.")
      // Removed.
      const removed = yield* api.AmendVersion({
        versionId,
        content: "The lamp is out.",
        reasoning: "",
        expectedRowVersion: retexted.rowVersion
      })
      assert.isUndefined(removed.reasoning)
      const history = yield* api.VersionAmendments({ versionId })
      assert.deepStrictEqual(
        history.map((s) => [s.content, s.reasoning]),
        [
          ["The lamp is out.", "Second plan."],
          ["The lamp is lit.", "Second plan."],
          ["The lamp is lit.", "First plan."]
        ]
      )
      // Unchanged thinking sent again is no amendment.
      const same = yield* api.AmendVersion({
        versionId,
        content: "The lamp is out.",
        reasoning: "",
        expectedRowVersion: removed.rowVersion
      })
      assert.strictEqual(same.rowVersion, removed.rowVersion)
      // Restoring an earlier state brings its thinking back with its text.
      const restored = yield* api.RestoreVersionAmendment({
        versionId,
        amendmentId: history.at(-1)!.id,
        forkId: chat.currentForkId!,
        expectedRowVersion: removed.rowVersion
      })
      assert.strictEqual(restored.content, "The lamp is lit.")
      assert.strictEqual(restored.reasoning, "First plan.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("a thinking change in one branch leaves another branch's message as it was", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, slotId, entry } = yield* replyWithThinking(api)
      const original = yield* entry()
      const edited = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: "The lamp is lit.",
        reasoning: "Shared plan.",
        expectedRowVersion: original.rowVersion
      })
      const main = edited.shownForkId ?? chat.currentForkId!
      const other = (yield* api.CreateFork({ chatId: chat.id, fromForkId: main, atSlotId: slotId })).fork.id
      const amended = yield* api.AmendVersion({
        versionId: edited.version.id,
        forkId: main,
        content: "The lamp is lit.",
        reasoning: "This branch's plan.",
        expectedRowVersion: edited.version.rowVersion
      })
      assert.notStrictEqual(amended.id, edited.version.id, "a copy in this branch")
      assert.strictEqual(amended.reasoning, "This branch's plan.")
      const there = (yield* api.ListVersions({ slotId, forkId: other })).find((v) => v.id === edited.version.id)!
      assert.strictEqual(there.reasoning, "Shared plan.")
      const here = yield* api.ListVersions({ slotId, forkId: main })
      assert.isTrue(here.some((v) => v.reasoning === "This branch's plan."))
      assert.strictEqual((yield* api.VersionAmendments({ versionId: amended.id }))[0]!.reasoning, "Shared plan.")
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )

  it.live("the thinking field's draft starts from the version's thinking, lists while open, and commits", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const { chat, slotId, entry } = yield* replyWithThinking(api)
      const original = yield* entry()
      const target = { _tag: "EditThinking", versionId: original.version.id } as const
      const typed = yield* api.SaveMessageDraft({
        target,
        draftId: null,
        content: "",
        expectedRowVersion: null,
        expectedSession: null
      })
      // Emptied is removed, still to be saved: the editor opens again with it.
      const open = yield* api.MessageDrafts({ chatId: chat.id })
      assert.isTrue(open.some((d) => d.id === typed.id && d.key.field === "reasoning"))
      const states = yield* api.MessageDraftHistory({ target, limit: 10 })
      // Its first state is the version's thinking, which emptying it removed.
      assert.strictEqual(states.at(-1)!.length, "Model plan: light the lamp.".length)
      assert.include(states[0]!.removed, "Model plan")
      const text = yield* api.SaveMessageDraft({
        target: { _tag: "Edit", versionId: original.version.id },
        draftId: null,
        content: "The lamp is lit.",
        expectedRowVersion: null,
        expectedSession: null
      })
      // A text draft's id can't commit the thinking, nor the thinking's the text.
      const saved = yield* api.EditVersion({
        slotId,
        sourceVersionId: original.version.id,
        content: "The lamp is lit.",
        reasoning: "",
        expectedRowVersion: original.rowVersion,
        draft: { draftId: text.id, session: text.session },
        reasoningDraft: { draftId: typed.id, session: typed.session }
      })
      assert.isUndefined(saved.version.reasoning)
      assert.deepStrictEqual(yield* api.MessageDrafts({ chatId: chat.id }), [])
      // Its history went on with the version saved.
      const moved = yield* api.MessageDraftHistory({
        target: { _tag: "EditThinking", versionId: saved.version.id },
        limit: 10
      })
      assert.isAbove(moved.length, 0)
    }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))
  )
})

const lookup: RolloutTool<{ readonly topic: string }> = {
  id: "look_up",
  label: "Looked something up",
  effect: "read",
  description: "Looks up a detail of the story.",
  parameters: Type.Object({ topic: Type.String() }),
  execute: (_context, args) => Effect.succeed({ text: `${args.topic}: the keeper is Ansel.` })
}

const agent = Effect.gen(function* () {
  const registry = yield* ExecutionRegistry
  yield* registry.rolloutTools.register(lookup as RolloutTool<never>)
  yield* registry.orchestrationModes.register({
    ...registry.orchestrationModes.get("default")!,
    plan: () => ({ strategy: "agent", tools: [lookup.id], contract: "final_text", turnCap: 6 })
  })
})

const mockOf = (handler: (request: Recorded, res: ServerResponse) => void | Promise<void>) =>
  Effect.acquireRelease(
    Effect.promise(() => startMockProvider(handler)),
    (m) => Effect.promise(() => m.close())
  )

type Block = { readonly type: string } & Record<string, unknown>
const signedIn = (body: AnthropicBody) =>
  body.messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Block>) : []))
    .filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length

it.live("a reply whose run signed its thinking, edited, sends none of it in the next reply", () =>
  Effect.gen(function* () {
    yield* agent
    const fake = enforcingAnthropic({
      reply: (body) =>
        JSON.stringify(body.messages).includes("tool_result")
          ? { thinking: "Ansel keeps it.", text: "Ansel keeps the lamp." }
          : { thinking: "I should check the keeper.", call: { name: "look_up", input: { topic: "keeper" } } }
    })
    const mock = yield* mockOf(fake.handler)
    const api = yield* client()
    const { version, events, chat } = yield* generateReply(api, {
      connection: { kind: "anthropic", baseUrl: mock.url, apiKey: "sk-ant-made-up-for-tests-0000" },
      modelKey: "claude-test-model",
      model: {},
      state: [{ key: "agent.enabled" as const, value: { on: true } }]
    })
    assert.strictEqual(version.status, "complete", JSON.stringify(version.error))
    assert.isNotNull(version.context, "the reply has a run")
    const path = yield* api.ReadPath({ chatId: chat.id, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    const reply = path.entries.find((e) => e.version.id === version.id)!
    const edited = yield* api.EditVersion({
      slotId: reply.slotId,
      sourceVersionId: version.id,
      content: version.content,
      reasoning: "My own plan for the keeper.",
      expectedRowVersion: reply.rowVersion
    })
    assert.strictEqual(edited.version.reasoning, "My own plan for the keeper.")
    // Unsigned: the edited version has no run, so nothing of the signed one can be replayed through it.
    assert.strictEqual(edited.version.context, null)
    const before = fake.verdicts.length
    const sent = yield* posted(
      api.SendMessage({ chatId: chat.id, parentSlotId: reply.slotId, branch: false, content: "And then?" })
    )
    const next = yield* posted(api.Generate({ chatId: chat.id, parentSlotId: sent.entry.slotId, branch: false }))
    yield* eventually(() => finished(events, next.entry.version.id) !== undefined)
    assert.strictEqual(finished(events, next.entry.version.id)!.status, "complete")
    const first = fake.verdicts[before]!
    assert.isTrue(first.verdict.ok, JSON.stringify(first.verdict))
    assert.strictEqual(signedIn(first.body), 0, "no thinking block from the edited reply")
    const sentText = JSON.stringify(first.body)
    assert.notInclude(sentText, "My own plan for the keeper.")
    assert.notInclude(sentText, "I should check the keeper.")
    assert.include(sentText, "Ansel keeps the lamp.")
    assert.isTrue(
      fake.verdicts.slice(before).every((v) => v.verdict.ok),
      JSON.stringify(fake.verdicts.map((v) => v.verdict))
    )
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
