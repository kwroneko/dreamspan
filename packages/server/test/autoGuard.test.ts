// Auto replies' server guard (db/autoGuard.ts): an Auto turn presents the token its run's last
// turn handed back, and the server starts it only if nothing changed since that the run didn't
// cause. Each test plays the Auto tab as a client whose notifications never arrive: it only
// ever knows what its own calls returned. A refused turn makes no provider request.
import { assert, it } from "@effect/vitest"
import type { EntityId, SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { Effect, Layer, Stream, type Scope } from "effect"
import * as ProviderBuiltins from "../src/providers/builtins.ts"
import { ProviderRegistry } from "../src/providers/registry.ts"
import { Writer } from "../src/db/Database.ts"
import { importStPreset } from "../src/formats/preset.ts"
import { client, posted, serverLayer, testConfig } from "./support/config.ts"
import { eventually, finished, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const scene = Effect.gen(function* () {
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startMockProvider((_request, response) =>
        sse(response, completionChunks(["A synthetic reply."], { prompt_tokens: 80, completion_tokens: 3 }))
      )
    ),
    (mock) => Effect.promise(() => mock.close())
  )
  const api = yield* client()
  const made = yield* generateReply(api, {
    connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
    model: {},
    characters: ["Wren", "Pell"]
  })
  const requests = () => mock.requests().filter((request) => request.path === "/v1/chat/completions")
  const speakers = [made.characters[0]!.entityId as EntityId, made.mira.entityId as EntityId]
  let tip = made.version.slotId as SlotId
  let turns = 0
  /** One Auto turn at the tip the tab last saw, as `from` (another connection, say) sends it. */
  const ask = (token: string | null, from: Api = api) =>
    from.Generate({
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      parentSlotId: tip,
      branch: false,
      speakerEntityId: speakers[turns % 2]!,
      immediate: true,
      auto: { token }
    })
  /** A turn that starts: waits for its reply, and returns the token for the next. */
  const turn = (token: string | null, from: Api = api) =>
    Effect.gen(function* () {
      const before = requests().length
      const sent = yield* posted(ask(token, from))
      yield* eventually(() => finished(made.events, sent.entry.version.id) !== undefined)
      assert.strictEqual(finished(made.events, sent.entry.version.id)!.status, "complete")
      assert.strictEqual(requests().length, before + 1)
      tip = sent.entry.slotId
      turns++
      assert.isString(sent.auto?.token)
      return sent.auto!.token
    })
  /** A turn the server must refuse, with `reason`, before any request. */
  const refused = (token: string, reason: string, from: Api = api) =>
    Effect.gen(function* () {
      const before = requests().length
      const error = yield* Effect.flip(ask(token, from))
      assert.strictEqual(error._tag, "AutoRefused")
      assert.strictEqual((error as { reason?: string }).reason, reason)
      // Nothing is on its way either: an ordinary reply right after is the next request made.
      assert.strictEqual(requests().length, before)
    })
  /** A run's first turn, then `change` from another tab, then its next turn refused. */
  const ended = (label: string, change: Effect.Effect<unknown, unknown, Writer>, reason = "changed") =>
    Effect.gen(function* () {
      const token = yield* turn(null)
      yield* Effect.orDie(change)
      yield* refused(token, reason).pipe(
        Effect.catchDefect((defect) => Effect.die(new Error(`${label}: ${String(defect)}`)))
      )
    })
  return { api, made, requests, turn, refused, ended, ask, tip: () => tip }
})

const server = () => Layer.merge(serverLayer(testConfig()), ProviderBuiltins.layer)

const live = <E>(name: string, body: Effect.Effect<void, E, Layer.Success<ReturnType<typeof server>> | Scope.Scope>) =>
  it.live(name, () => body.pipe(Effect.scoped, Effect.provide(server())), 120_000)

live(
  "a delayed notification cannot permit another auto reply after an older edit",
  Effect.gen(function* () {
    // The reviewer's probe: the tab still shows the reply it started, and never heard of the edit.
    const { api, made, requests, turn, refused } = yield* scene
    const token = yield* turn(null)
    yield* api.AmendVersion({
      versionId: made.sent.version.id,
      content: "Edited by a user outside this auto run.",
      expectedRowVersion: made.sent.version.rowVersion
    })
    const before = requests().length
    yield* refused(token, "changed")
    // Asking again changes nothing: a broken run stays broken.
    yield* refused(token, "changed")
    assert.strictEqual(requests().length, before)
    assert.notInclude(JSON.stringify(requests()), "Edited by a user outside this auto run.")
    // The user's own click starts a run again, and that request carries the edit.
    yield* turn(null)
    assert.include(JSON.stringify(requests().at(-1)!.body), "Edited by a user outside this auto run.")
  })
)

live(
  "a run's own replies keep it going, and each token works once",
  Effect.gen(function* () {
    const { turn, refused, requests } = yield* scene
    const first = yield* turn(null)
    const second = yield* turn(first)
    const third = yield* turn(second)
    assert.notStrictEqual(first, second)
    // A lost acknowledgement: the tab never got `third`, and asks again with what it has.
    const before = requests().length
    yield* refused(second, "replayed")
    yield* refused(first, "replayed")
    assert.strictEqual(requests().length, before)
    // The turn that was acknowledged still goes on.
    yield* turn(third)
  })
)

live(
  "a reconnected tab goes on only with what the server still holds",
  Effect.gen(function* () {
    const { api, made, turn, refused } = yield* scene
    const token = yield* turn(null)
    // A new connection, nothing changed: the token is the run, whichever socket carries it.
    const again = yield* client()
    const next = yield* turn(token, again)
    // It was away while another tab hid a message: refused, on either connection.
    yield* api.SetMessageHidden({ slotId: made.sent.slotId, hidden: true })
    yield* refused(next, "changed", again)
    yield* refused(next, "changed")
    // A run the server never knew (it restarted, say) is over.
    yield* refused("018f0000-0000-7000-8000-000000000000.nothing", "expired", again)
  })
)

live(
  "another tab's change to the branch ends the run before the next request",
  Effect.gen(function* () {
    const { api, made, ended, requests } = yield* scene
    const fork = made.chat.currentForkId
    yield* ended("hide", api.SetMessageHidden({ slotId: made.sent.slotId, hidden: true }))
    yield* ended("unhide", api.SetMessageHidden({ slotId: made.sent.slotId, hidden: false }))
    yield* ended(
      "thinking hidden",
      api.SetThinkingHidden({ versionId: made.version.id, part: "reasoning", forkId: fork, hidden: true })
    )
    // A swipe of an earlier reply: its own request is the other tab's, the Auto turn after it isn't made.
    yield* ended(
      "swipe",
      Effect.gen(function* () {
        const swiped = yield* api.Regenerate({
          slotId: made.version.slotId,
          forkId: fork,
          expectedRowVersion: made.version.rowVersion
        })
        yield* eventually(() => finished(made.events, swiped.version.id) !== undefined)
      })
    )
    yield* ended(
      "swipe back",
      Effect.gen(function* () {
        const versions = yield* api.ListVersions({ slotId: made.version.slotId, forkId: fork })
        const shown = versions.at(-1)!
        yield* api.SelectVersion({
          slotId: made.version.slotId,
          versionId: made.version.id,
          forkId: fork,
          expectedVersionId: shown.id
        })
      })
    )
    yield* ended(
      "presence",
      api.ChangeCast({
        chatId: made.chat.id,
        forkId: fork,
        slotId: null,
        change: { _tag: "Away", entityId: made.characters[1]!.entityId as EntityId, away: true }
      })
    )
    // A note is a library entry that names its chat: new, it's read by the next request.
    yield* ended("note", api.CreateChatNote({ chatId: made.chat.id, forkId: fork, title: "A plan" }), "settings")
    // Deleted, then brought back from the bin (Undo is the same restore): each ends a run.
    let item = ""
    yield* ended(
      "delete",
      Effect.map(api.DeleteMessage({ slotId: made.sent.slotId, forkId: fork }), (deleted) => {
        item = deleted.id
      })
    )
    yield* ended(
      "restore",
      Effect.suspend(() => api.RestoreBinItem({ itemId: item }))
    )
    assert.isAbove(requests().length, 9)
  })
)

live(
  "another tab's change to the configuration ends the run before the next request",
  Effect.gen(function* () {
    const { api, made, ended } = yield* scene
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const preset = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "preset",
      label: "Other preset",
      subtitle: "",
      doc: importStPreset(JSON.stringify({ frequency_penalty: 0, temperature: 0.3 })).document as never,
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const model = { connection: made.connection.id, model: made.model.id }
    yield* ended("preset", api.SetGenerationDefaults({ defaults: { model, preset: preset.ref.id } }), "settings")
    const other = yield* api.AddUserModel({ connectionId: made.connection.id, key: "mock-other", overrides: {} })
    yield* ended(
      "model",
      api.SetGenerationDefaults({
        defaults: { model: { connection: made.connection.id, model: other.id }, preset: preset.ref.id }
      }),
      "settings"
    )
    yield* ended(
      "chat model",
      api.ChangeCast({
        chatId: made.chat.id,
        forkId: made.chat.currentForkId!,
        slotId: null,
        change: { _tag: "Model", connection: made.connection.id, model: made.model.id }
      })
    )
    yield* ended(
      "connection",
      api.UpdateConnection({
        connectionId: made.connection.id,
        settings: {
          name: "Mock",
          baseUrl: made.connection.baseUrl,
          compat: {},
          cacheTtlS: 300,
          maxConcurrent: null,
          presetOverrideRefId: null
        },
        expectedRowVersion: made.connection.rowVersion
      }),
      "settings"
    )
  })
)

live(
  "a change on a sibling branch leaves the run going",
  Effect.gen(function* () {
    const { api, made, turn, requests } = yield* scene
    const sibling = (yield* api.CreateFork({
      chatId: made.chat.id,
      fromForkId: made.chat.currentForkId!,
      atSlotId: made.sent.slotId
    })).fork
    const first = yield* turn(null)
    // Another tab chats in the sibling: a message, a reply to it, an edit of a message both
    // branches share, a hidden message. None of it is in this branch's request.
    const line = yield* posted(
      api.SendMessage({
        chatId: made.chat.id,
        forkId: sibling.id,
        parentSlotId: made.sent.slotId,
        branch: false,
        content: "A line only the sibling branch has."
      })
    )
    const reply = yield* posted(
      api.Generate({ chatId: made.chat.id, forkId: sibling.id, parentSlotId: line.entry.slotId, branch: false })
    )
    yield* eventually(() => finished(made.events, reply.entry.version.id) !== undefined)
    yield* api.AmendVersion({
      versionId: made.sent.version.id,
      forkId: sibling.id,
      content: "The sibling branch's wording of a shared message.",
      expectedRowVersion: made.sent.version.rowVersion
    })
    yield* api.SetMessageHidden({ slotId: line.entry.slotId, forkId: sibling.id, hidden: true })
    const second = yield* turn(first)
    const sent = JSON.stringify(requests().at(-1)!.body)
    assert.notInclude(sent, "A line only the sibling branch has.")
    assert.notInclude(sent, "The sibling branch's wording of a shared message.")
    assert.include(sent, "The road flooded.")
    yield* turn(second)
  })
)

live(
  "a change after a turn was admitted stops its request too",
  Effect.gen(function* () {
    // The turn's context is read after it's admitted. A change that lands in between is in what
    // was read, so the request record is refused and nothing is sent.
    const { api, made, tip } = yield* scene
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const admitted = yield* writer.SendOrQueue({
      userId,
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      parentSlotId: tip(),
      branch: false,
      kind: "generate",
      content: "",
      speakerEntityId: made.mira.entityId as EntityId,
      replySpeakerEntityId: null,
      direction: null,
      commitDraft: null,
      immediate: true,
      auto: { token: null }
    })
    if (admitted._tag !== "Posted") return assert.fail("the turn should have been admitted")
    yield* api.AmendVersion({
      versionId: made.sent.version.id,
      content: "Edited between the admission and the request.",
      expectedRowVersion: made.sent.version.rowVersion
    })
    const error = yield* Effect.flip(
      writer.StartRollout({
        userId,
        chatId: made.chat.id,
        slotId: admitted.result.slotId,
        versionId: admitted.result.version.id,
        rolloutId: "018f0000-0000-7000-8000-00000000aaaa",
        leafSlotId: tip(),
        forkId: made.chat.currentForkId!,
        connectionId: made.connection.id,
        modelId: made.model.id,
        snapshot: "{}",
        issues: [],
        variables: [],
        frozenMessages: []
      })
    )
    assert.strictEqual(error._tag, "AutoRefused")
  })
)

live(
  "a reply that isn't an Auto turn is sent as before",
  Effect.gen(function* () {
    const { api, made, turn, requests, tip } = yield* scene
    yield* turn(null)
    yield* api.SetMessageHidden({ slotId: made.sent.slotId, hidden: true })
    const before = requests().length
    // ▶ Reply now carries no token and asks for none.
    const sent = yield* posted(
      api.Generate({ chatId: made.chat.id, forkId: made.chat.currentForkId!, parentSlotId: tip(), branch: false })
    )
    yield* eventually(() => finished(made.events, sent.entry.version.id) !== undefined)
    assert.strictEqual(requests().length, before + 1)
    assert.isUndefined(sent.auto)
  })
)

live(
  "hiding thinking on the run's own last reply from another tab ends the run",
  Effect.gen(function* () {
    const { api, made, turn, refused, tip } = yield* scene
    const token = yield* turn(null)
    const versions = yield* api.ListVersions({ slotId: tip(), forkId: made.chat.currentForkId })
    const last = versions.at(-1)!
    yield* api.SetThinkingHidden({
      versionId: last.id,
      forkId: made.chat.currentForkId!,
      part: "reasoning",
      hidden: true
    })
    yield* refused(token, "changed")
  })
)

live(
  "a change after StartRollout and before transport dispatch sends nothing",
  Effect.gen(function* () {
    const { api, made, turn, ask, requests } = yield* scene
    const registry = yield* ProviderRegistry
    const original = registry.kinds.get("openai-chat")!
    let armed = false
    yield* registry.kinds.register({
      ...original,
      transport: (fetch) => async (input, init) => {
        if (armed) {
          armed = false
          await Effect.runPromise(api.SetMessageHidden({ slotId: made.sent.slotId, hidden: true }))
        }
        return fetch(input, init)
      }
    })
    const token = yield* turn(null)
    armed = true
    const before = requests().length
    const sent = yield* posted(ask(token))
    yield* eventually(() => finished(made.events, sent.entry.version.id) !== undefined)
    assert.strictEqual(requests().length, before)
    assert.strictEqual(finished(made.events, sent.entry.version.id)!.status, "failed")
  })
)

live(
  "UndoHistoryEdit ends an Auto run",
  Effect.gen(function* () {
    const { api, made, turn, refused } = yield* scene
    const applied = yield* api.ApplyHistoryEdits({
      title: "Synthetic rename",
      applications: [
        {
          chatId: made.chat.id,
          forkId: made.chat.currentForkId!,
          edits: [
            {
              kind: "version_replace",
              targetId: made.sent.version.id,
              beforeId: made.sent.version.id,
              before: made.sent.version.content,
              after: "The synthetic road is dry."
            }
          ]
        }
      ]
    })
    const token = yield* turn(null)
    yield* api.UndoHistoryEdit({
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      changesetId: applied.changesetIds[0]!
    })
    yield* refused(token, "changed")
  })
)

live(
  "merging a sibling into the run's branch ends it",
  Effect.gen(function* () {
    const { api, made, turn, refused } = yield* scene
    const sibling = (yield* api.CreateFork({
      chatId: made.chat.id,
      fromForkId: made.chat.currentForkId!,
      atSlotId: made.sent.slotId
    })).fork
    yield* posted(
      api.SendMessage({
        chatId: made.chat.id,
        forkId: sibling.id,
        parentSlotId: made.sent.slotId,
        branch: false,
        content: "A synthetic detour."
      })
    )
    const token = yield* turn(null)
    const request = {
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      at: null,
      source: { chatId: made.chat.id, forkId: sibling.id },
      includeLeftOut: false
    }
    const preview = yield* api.PreviewChatMerge(request)
    yield* api.MergeChat({ ...request, title: preview.sourceTitle, framing: null, digest: preview.digest })
    yield* refused(token, "changed")
  })
)

live(
  "a message queued by another tab ends the run before it drains",
  Effect.gen(function* () {
    const { api, made, tip, refused } = yield* scene
    const writer = yield* Writer
    const userId = (yield* api.Whoami()).id as UserId
    const admitted = yield* writer.SendOrQueue({
      userId,
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      parentSlotId: tip(),
      branch: false,
      kind: "generate",
      content: "",
      speakerEntityId: made.mira.entityId as EntityId,
      replySpeakerEntityId: null,
      direction: null,
      commitDraft: null,
      immediate: true,
      auto: { token: null }
    })
    if (admitted._tag !== "Posted") return assert.fail("expected an admitted reply")
    const queued = yield* api.SendMessage({
      chatId: made.chat.id,
      forkId: made.chat.currentForkId!,
      parentSlotId: admitted.result.slotId,
      branch: false,
      content: "A queued external message."
    })
    assert.strictEqual(queued._tag, "Queued")
    yield* refused(admitted.auto!.token, "changed")
  })
)

it.live(
  "a real writer restart loses its TEMP authorization and refuses the old token",
  () =>
    Effect.gen(function* () {
      const config = testConfig()
      const previous = yield* Effect.gen(function* () {
        const f = yield* scene
        const token = yield* f.turn(null)
        return { token, chatId: f.made.chat.id, forkId: f.made.chat.currentForkId!, parentSlotId: f.tip() }
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
      yield* Effect.gen(function* () {
        const api = yield* client()
        const error = yield* Effect.flip(
          api.Generate({
            chatId: previous.chatId,
            forkId: previous.forkId,
            parentSlotId: previous.parentSlotId,
            branch: false,
            immediate: true,
            auto: { token: previous.token }
          })
        )
        assert.strictEqual(error._tag, "AutoRefused")
        assert.strictEqual((error as { reason?: string }).reason, "expired")
      }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
    }),
  120_000
)

live(
  "registry parts changed before plugin pins commit cannot bill another Auto turn",
  Effect.gen(function* () {
    const { made, turn, ask, requests } = yield* scene
    const token = yield* turn(null)
    const registry = yield* ProviderRegistry
    const before = requests().length
    // Host.enable activates parts before its GetPluginPins/SetPluginPins awaits; suspend
    // restores parts before those awaits. No database write has happened in this window.
    yield* registry.transforms.register({
      id: "synthetic.activation-window",
      appliesTo: () => true,
      transform: (payload) => ({ ...payload, temperature: 0.17 })
    })
    const result = yield* ask(token).pipe(Effect.catch((error) => Effect.succeed(error)))
    if (result._tag === "Posted") {
      yield* eventually(() => finished(made.events, result.entry.version.id) !== undefined)
      assert.strictEqual(requests().length, before, "a changed request registry must not bill")
      assert.strictEqual(finished(made.events, result.entry.version.id)!.status, "failed")
    } else {
      assert.strictEqual(result._tag, "AutoRefused")
      assert.strictEqual((result as { reason?: string }).reason, "settings")
    }
  })
)

live(
  "restoring a request registry does not revive an old Auto authorization",
  Effect.gen(function* () {
    const { turn, refused } = yield* scene
    const token = yield* turn(null)
    const registry = yield* ProviderRegistry
    yield* Effect.scoped(
      registry.transforms.register({
        id: "synthetic.temporary",
        appliesTo: () => true,
        transform: (payload) => ({ ...payload, temperature: 0.19 })
      })
    )
    yield* refused(token, "settings")
    yield* refused(token, "settings")
  })
)

live(
  "multi-delete and summary-model choices end Auto; composer writes keep it going",
  Effect.gen(function* () {
    const { api, made, turn, refused, ended } = yield* scene
    const forkId = made.chat.currentForkId!
    const draft = yield* api.OpenComposer({ chatId: made.chat.id, forkId })
    const first = yield* turn(null)
    yield* api.SaveComposer({
      chatId: made.chat.id,
      draftId: draft.id,
      rowVersion: draft.rowVersion,
      session: draft.session,
      next: false,
      operationId: "stack-draft",
      content: "Unsent text"
    })
    yield* turn(first)
    yield* ended(
      "summary model",
      api.ChangeCast({
        chatId: made.chat.id,
        forkId,
        slotId: null,
        change: { _tag: "SummaryModel", model: { connection: made.connection.id, model: made.model.id } }
      })
    )
    yield* ended(
      "account summary model",
      api.ChangeGenerationDefaults({
        change: { summarizer: { connection: made.connection.id, model: made.model.id } }
      }),
      "settings"
    )
    const token = yield* turn(null)
    const items = yield* api.DeleteMessages({ forkId, slotIds: [made.sent.slotId, made.version.slotId] })
    yield* refused(token, "changed")
    const restoreToken = yield* turn(null)
    yield* api.RestoreBinItems({ itemIds: items.map((i) => i.id) })
    yield* refused(restoreToken, "changed")
  })
)
