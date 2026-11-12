import type { NextContext } from "@rp/shared/inspectorApi.ts"
import { newChatNote } from "@rp/shared/editing.ts"
import { assert, layer } from "@effect/vitest"
import { type ForkId, NewVersion, type SlotId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import { foldState, type StateEventData } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, outcome, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc, docFor } from "./support/docs.ts"
import { eventually, generateReply } from "./support/generation.ts"
import { completionChunks, sse, startMockProvider } from "./support/mockProvider.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"

/** A chain of forks deeper than tests otherwise make: fork labels have no cap. */
const DEEP = 70

const config = testConfig()
const setup = Effect.gen(function* () {
  const api = yield* client()
  const writer = yield* Writer
  const reader = yield* Reader
  const userId = (yield* api.Whoami()).id as UserId
  const parent = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Mira",
    subtitle: "",
    doc: cardDoc("Mira", { description: "PARENT_DEFINITION" }),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  const card = yield* writer.ForkCard({
    userId,
    refId: parent.ref.id,
    name: "Mira progressed",
    nickname: "Mira",
    characterVersion: "2"
  })
  // Different definition, through a normal document revision (synthetic data only).
  yield* writer.EditRef({
    userId,
    refId: card.id,
    expectedRowVersion: card.rowVersion,
    doc: cardDoc("Mira progressed", { description: "FORK_DEFINITION" }),
    message: null,
    commitDraft: null
  })
  const chat = yield* writer.CreateChat({
    userId,
    kind: "rp",
    status: "active",
    title: "State forks",
    participants: [parent.entityId],
    greeting: null
  })
  const chatId = chat.id
  const main = chat.currentForkId as ForkId
  const version = (content: string, generating = false) =>
    new NewVersion({
      speakerEntityId: parent.entityId,
      writer: "model",
      content,
      status: generating ? "generating" : "complete",
      macroMode: "verbatim",
      origin: "generated"
    })
  const append = (forkId: ForkId, parentSlotId: SlotId | null, content: string) =>
    writer.AppendMessage({
      userId,
      chatId,
      forkId,
      parentSlotId,
      branch: false,
      version: version(content),
      commitDraft: null
    })
  const a = yield* append(main, null, "A")
  const b = yield* append(main, a.slotId, "B")
  const fork = (fromForkId: ForkId, atSlotId: SlotId | null) =>
    Effect.map(writer.CreateFork({ userId, chatId, fromForkId, atSlotId }), (result) => result.fork.id)
  const add = (
    forkId: ForkId,
    slotId: SlotId | null,
    data: StateEventData,
    versionId: typeof b.version.id | null = null
  ) => writer.AddStateEvent({ userId, chatId, forkId, slotId, versionId, scope: null, data })
  const state = (forkId: ForkId, slotId: SlotId | null = b.slotId) =>
    Effect.map(reader.StateEventsAt({ userId, chatId, forkId, slotId }), foldState)
  const swap = (forkId: ForkId) =>
    add(forkId, b.slotId, { key: "card.swap", value: { entity: card.entityId, replaces: parent.entityId } })
  return { api, writer, reader, userId, chatId, main, parent, card, a, b, fork, add, state, swap, append, version }
})

layer(serverLayer(config), { excludeTestServices: true, timeout: "120 seconds" })("fork-scoped state", (it) => {
  it.effect("away and narrator changes address the original identity through card replacements", () =>
    Effect.gen(function* () {
      const t = yield* setup
      yield* t.add(t.main, t.a.slotId, { key: "away.set", value: { entity: t.parent.entityId, away: true } })
      yield* t.add(t.main, t.a.slotId, { key: "cast.role", value: { entity: t.parent.entityId, role: "narrator" } })
      yield* t.swap(t.main)
      yield* t.add(t.main, t.b.slotId, { key: "away.set", value: { entity: t.card.entityId, away: false } })
      yield* t.add(t.main, t.b.slotId, { key: "cast.role", value: { entity: t.card.entityId, role: null } })
      const state = yield* t.state(t.main)
      assert.notInclude(state.away, t.card.entityId)
      assert.notProperty(state.roles, t.card.entityId)
      yield* t.add(t.main, t.b.slotId, {
        key: "card.swap",
        value: { entity: t.parent.entityId, replaces: t.card.entityId }
      })
      assert.notInclude((yield* t.state(t.main)).away, t.parent.entityId)
    })
  )

  it.effect(
    "events at a shared tip and initial position are local; later forks inherit only their bounded history",
    () =>
      Effect.gen(function* () {
        const { main, b, a, fork, add, state, writer, reader, userId, chatId } = yield* setup
        const old = yield* fork(main, b.slotId)
        yield* add(main, b.slotId, { key: "var.set", value: { name: "tip", value: 1 } })
        yield* add(main, null, { key: "macro.binding", value: { name: "initial", value: "main" } })
        yield* writer.ChangeLcmSettings({ userId, chatId, change: { enabled: false, withNotes: true } })
        // ChangeLcmSettings writes the current fork (old), not main.
        assert.deepStrictEqual((yield* state(old)).vars, {})
        assert.deepStrictEqual((yield* state(old)).macroBindings, {})
        assert.strictEqual((yield* state(old)).lcm?.withNotes, true)
        assert.strictEqual((yield* state(main)).lcm?.withNotes, false)
        assert.isTrue((yield* reader.GetLcmState({ userId, chatId, leafSlotId: b.slotId, forkId: main })).enabled)
        assert.isFalse((yield* reader.GetLcmState({ userId, chatId, leafSlotId: b.slotId, forkId: old })).enabled)
        const later = yield* fork(main, b.slotId)
        yield* add(main, b.slotId, { key: "var.set", value: { name: "tip", value: 2 } })
        assert.strictEqual((yield* state(later)).vars.tip, 1)
        assert.strictEqual((yield* state(main)).vars.tip, 2)
        const early = yield* fork(main, a.slotId)
        assert.isUndefined((yield* state(early, a.slotId)).vars.tip)
        assert.strictEqual((yield* state(early, a.slotId)).macroBindings.initial, "main")
      })
  )

  it.effect(
    "a swap applies at earlier positions and later forks from any point; existing forks and message attribution stay intact",
    () =>
      Effect.gen(function* () {
        const { api, main, parent, card, a, b, fork, state, writer, reader, userId, chatId, append } = yield* setup
        const old = yield* fork(main, b.slotId)
        const oldTip = yield* append(old, b.slotId, "Existing sibling")
        const changed = yield* api.ChangeCast({
          chatId,
          forkId: main,
          slotId: b.slotId,
          change: { _tag: "Swap", entityId: card.entityId, replaces: parent.entityId }
        })
        assert.deepStrictEqual(changed.participants, [card.entityId])
        assert.deepStrictEqual((yield* state(main, null)).participants, [card.entityId])
        assert.deepStrictEqual((yield* state(main, a.slotId)).participants, [card.entityId])
        assert.deepStrictEqual((yield* api.GetCast({ chatId, forkId: old, slotId: b.slotId })).participants, [
          parent.entityId
        ])
        const early = yield* fork(main, a.slotId)
        const empty = yield* fork(main, null)
        assert.deepStrictEqual((yield* state(early, a.slotId)).participants, [card.entityId])
        assert.deepStrictEqual((yield* state(empty, null)).participants, [card.entityId])
        const fromViewedLeaf = foldState(
          yield* reader.StateEventsAt({ userId, chatId, slotId: a.slotId, leafSlotId: oldTip.slotId })
        )
        assert.deepStrictEqual(fromViewedLeaf.participants, [parent.entityId])
        const generating = yield* writer.AddVersion({
          userId,
          slotId: b.slotId,
          forkId: main,
          version: new NewVersion({
            speakerEntityId: parent.entityId,
            writer: "model",
            content: "",
            status: "generating",
            macroMode: "verbatim",
            origin: "generated"
          }),
          select: false,
          commitDraft: null
        })
        const assembled = yield* reader.AssembleContext({
          userId,
          chatId,
          slotId: b.slotId,
          versionId: generating.id,
          forkId: main,
          now: 1700000000000,
          timeZone: "UTC",
          frozen: null
        })
        assert.include(assembled.snapshot, "FORK_DEFINITION")
        assert.notInclude(assembled.snapshot, "PARENT_DEFINITION")
        const entry = yield* reader.GetSlot({ userId, slotId: a.slotId, forkId: main })
        assert.strictEqual(entry.entry.version.speakerEntityId, parent.entityId)
        for (const entityId of [parent.entityId, card.entityId])
          assert.include(
            (yield* reader.ListChats({ userId, entityId, limit: 100, before: null })).map((c) => c.id),
            chatId
          )
        const events = yield* fixtureSql(
          config.dataDir,
          [
            {
              sql: "SELECT slot_id, fork_id FROM state_events WHERE chat_id = ? AND key = 'card.swap'",
              params: [chatId]
            }
          ],
          { readOnly: true }
        )
        assert.deepStrictEqual(events[0], [{ slot_id: null, fork_id: main }])
      })
  )

  it.effect("regenerating before a later swap sends the swapped definition and writes as that card", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, completionChunks(["A response."], { prompt_tokens: 10, completion_tokens: 2 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const writer = yield* Writer
      const reader = yield* Reader
      const { chat, version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const userId = (yield* api.Whoami()).id as UserId
      const parentId = (yield* reader.GetSlot({ userId, slotId: chat.activeLeafSlotId!, forkId: chat.currentForkId }))
        .entry.version.speakerEntityId!
      const parent = (yield* reader.CardUsage({ userId })).find((card) => card.entityId === parentId)!
      const card = yield* writer.ForkCard({
        userId,
        refId: parent.refId,
        name: "Mira new",
        nickname: "Mira",
        characterVersion: "swapped"
      })
      yield* writer.EditRef({
        userId,
        refId: card.id,
        expectedRowVersion: card.rowVersion,
        doc: cardDoc("Mira new", { description: "SWAPPED_DEFINITION" }),
        message: null,
        commitDraft: null
      })
      const main = chat.currentForkId!
      const old = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: version.slotId }))
        .fork.id
      yield* api.ChangeCast({
        chatId: chat.id,
        forkId: main,
        slotId: version.slotId,
        change: { _tag: "Swap", entityId: card.entityId, replaces: parentId }
      })
      const greeting = (yield* reader.GetSlot({ userId, slotId: chat.activeLeafSlotId!, forkId: main })).entry
      const before = mock.requests().length
      const swipe = yield* api.Regenerate({
        slotId: greeting.slotId,
        forkId: main,
        expectedRowVersion: greeting.rowVersion
      })
      assert.strictEqual(swipe.version.speakerEntityId, card.entityId)
      yield* eventually(() => mock.requests().length > before)
      assert.include(JSON.stringify(mock.requests().at(-1)!.body), "SWAPPED_DEFINITION")
      assert.notInclude(JSON.stringify(mock.requests().at(-1)!.body), "keeps the ledger")
      assert.strictEqual(
        (yield* reader.GetVersion({ userId, versionId: greeting.version.id })).speakerEntityId,
        parentId
      )
      assert.include(
        (yield* api.GetCast({ chatId: chat.id, forkId: old, slotId: version.slotId })).participants,
        parentId
      )
    }).pipe(Effect.scoped)
  )

  it.effect("deleting and restoring the former leaf keeps a swap without copies", () =>
    Effect.gen(function* () {
      const { main, b, a, swap, writer, reader, userId, card, state, chatId } = yield* setup
      yield* swap(main)
      const bin = yield* writer.DeleteMessage({ userId, slotId: b.slotId, forkId: main })
      assert.deepStrictEqual((yield* state(main, a.slotId)).participants, [card.entityId])
      yield* writer.RestoreBinItem({ userId, itemId: bin.id })
      assert.deepStrictEqual((yield* state(main)).participants, [card.entityId])
      const events = yield* reader.StateEventsAt({ userId, chatId, slotId: b.slotId, forkId: main })
      assert.strictEqual(events.filter((e) => e.data.key === "card.swap").length, 1)
    })
  )

  it.effect("a swap may replace a binned family member but the incoming card must be live", () =>
    Effect.gen(function* () {
      const { main, b, writer, userId, parent, card, add, state } = yield* setup
      yield* writer.DeleteEntity({ userId, entityId: parent.entityId })
      yield* add(main, b.slotId, { key: "card.swap", value: { entity: card.entityId, replaces: parent.entityId } })
      assert.deepStrictEqual((yield* state(main)).participants, [card.entityId])
      assert.strictEqual(
        yield* outcome(
          add(main, b.slotId, { key: "card.swap", value: { entity: parent.entityId, replaces: card.entityId } })
        ),
        "NotFound"
      )
    })
  )

  it.effect("version-attached events follow each fork's selection and reject foreign forks and unrelated cards", () =>
    Effect.gen(function* () {
      const { main, b, fork, add, state, writer, userId, version, chatId, parent, reader } = yield* setup
      yield* add(main, b.slotId, { key: "var.set", value: { name: "selected", value: "one" } }, b.version.id)
      const other = yield* fork(main, b.slotId)
      const two = yield* writer.AddVersion({
        userId,
        slotId: b.slotId,
        forkId: main,
        version: version("two"),
        select: true,
        commitDraft: null
      })
      yield* add(main, b.slotId, { key: "var.set", value: { name: "selected", value: "two" } }, two.id)
      assert.strictEqual((yield* state(main)).vars.selected, "two")
      assert.strictEqual((yield* state(other)).vars.selected, "one")
      const unrelated = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Other",
        subtitle: "",
        doc: cardDoc("Other"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      assert.strictEqual(
        yield* outcome(
          add(main, b.slotId, { key: "card.swap", value: { entity: unrelated.entityId, replaces: parent.entityId } })
        ),
        "NotFound"
      )
      const foreignUser = (yield* writer.EnsureUser({ handle: "other-events", displayName: "Other" })).id
      const foreign = yield* writer.CreateChat({
        userId: foreignUser,
        kind: "rp",
        status: "active",
        title: "Foreign",
        participants: [],
        greeting: null
      })
      assert.strictEqual(
        yield* outcome(add(foreign.currentForkId!, b.slotId, { key: "var.set", value: { name: "bad", value: 1 } })),
        "NotFound"
      )
      assert.strictEqual(
        yield* outcome(reader.StateEventsAt({ userId: foreignUser, chatId, forkId: main, slotId: b.slotId })),
        "NotFound"
      )
    })
  )

  it.effect("suppression is per fork, inherited, and works for branch-owned events", () =>
    Effect.gen(function* () {
      const { main, b, swap, fork, state, parent, card, chatId } = yield* setup
      const event = yield* swap(main)
      const old = yield* fork(main, b.slotId)
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE chats SET state_seq = state_seq + 1 WHERE id = ?", params: [chatId] },
        {
          sql: "INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,flag) SELECT 'suppress-' || ?,id,?,state_seq,'suppress_event',?,1 FROM chats WHERE id = ?",
          params: [event.id, main, event.id, chatId]
        }
      ])
      assert.deepStrictEqual((yield* state(main)).participants, [parent.entityId])
      assert.deepStrictEqual((yield* state(old)).participants, [card.entityId])
      const later = yield* fork(main, b.slotId)
      assert.deepStrictEqual((yield* state(later)).participants, [parent.entityId])
    })
  )

  it.effect("a deep chain of forks keeps event identities, bounded visibility and suppression", () =>
    Effect.gen(function* () {
      const { main, b, a, swap, fork, state, add, card, parent, chatId } = yield* setup
      const event = yield* swap(main)
      let current = main
      // Each generation writes once, keeping every lineage bound nonzero.
      for (let i = 0; i <= DEEP; i++) {
        yield* add(current, null, { key: "macro.binding", value: { name: "generation", value: String(i) } })
        current = yield* fork(current, a.slotId)
      }
      assert.deepStrictEqual((yield* state(current, a.slotId)).participants, [card.entityId])
      assert.strictEqual((yield* state(current, a.slotId)).macroBindings.generation, String(DEEP))
      yield* add(main, b.slotId, { key: "card.swap", value: { entity: parent.entityId, replaces: card.entityId } })
      assert.deepStrictEqual((yield* state(current, a.slotId)).participants, [card.entityId])
      // The original event is the one suppressed at the end of the chain: nothing was copied.
      yield* fixtureSql(config.dataDir, [
        { sql: "UPDATE chats SET state_seq = state_seq + 1 WHERE id = ?", params: [chatId] },
        {
          sql: "INSERT INTO fork_overrides(id,chat_id,fork_id,seq,kind,target_id,flag) SELECT 'compact-' || ?,id,?,state_seq,'suppress_event',?,1 FROM chats WHERE id = ?",
          params: [event.id, current, event.id, chatId]
        }
      ])
      assert.deepStrictEqual((yield* state(current, a.slotId)).participants, [parent.entityId])
    })
  )
  it.effect("cast changes after a swap address the card the fork now uses", () =>
    Effect.gen(function* () {
      const { api, main, b, parent, card, add, swap, state, fork, chatId } = yield* setup
      const sibling = yield* fork(main, b.slotId)
      yield* add(main, b.slotId, { key: "presence.set", value: { entity: parent.entityId, present: false } })
      yield* add(main, b.slotId, { key: "lorebook.embedded", value: { entity: parent.entityId, on: false } })
      yield* swap(main)
      yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "Presence", entityId: card.entityId, present: true }
      })
      assert.notInclude((yield* state(main)).absent, card.entityId)
      yield* add(main, b.slotId, { key: "lorebook.embedded", value: { entity: card.entityId, on: true } })
      assert.strictEqual((yield* state(main)).embeddedLorebooks[card.entityId], true)
      yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "PlayedByMe", entityIds: [card.entityId] }
      })
      assert.deepStrictEqual((yield* state(main)).playedByMe, [card.entityId])
      yield* api.ChangeCast({ chatId, forkId: main, slotId: b.slotId, change: { _tag: "PlayedByMe", entityIds: [] } })
      assert.deepStrictEqual((yield* state(main)).playedByMe, [])
      yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "Leave", entityId: card.entityId }
      })
      assert.deepStrictEqual((yield* state(main)).participants, [])
      yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "Join", entityId: card.entityId }
      })
      assert.deepStrictEqual((yield* state(main)).participants, [card.entityId])
      yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "Swap", entityId: parent.entityId, replaces: card.entityId }
      })
      assert.deepStrictEqual((yield* state(main)).participants, [parent.entityId])
      assert.deepStrictEqual((yield* state(sibling)).participants, [parent.entityId])
    })
  )

  it.effect("a lorebook switched off stays listed in its fork until it's removed, and a sibling keeps its own", () =>
    Effect.gen(function* () {
      const { api, main, b, fork, writer, userId, chatId } = yield* setup
      const book = (label: string) =>
        writer.CreateEntity({
          userId,
          kind: "lorebook",
          label,
          subtitle: "",
          doc: docFor("lorebook", label),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
      const one = (yield* book("One")).ref.id
      const two = (yield* book("Two")).ref.id
      const change = (forkId: ForkId, cast: Parameters<typeof api.ChangeCast>[0]["change"]) =>
        api.ChangeCast({ chatId, forkId, slotId: b.slotId, change: cast })
      yield* change(main, { _tag: "Lorebook", ref: one, active: true })
      yield* change(main, { _tag: "Lorebook", ref: two, active: true })
      const sibling = yield* fork(main, b.slotId)
      yield* change(main, { _tag: "Lorebook", ref: one, active: false })
      const cast = (forkId: ForkId) => api.GetCast({ chatId, forkId, slotId: b.slotId })
      const off = yield* cast(main)
      assert.deepStrictEqual(off.listedLorebooks, [
        { ref: one, on: false },
        { ref: two, on: true }
      ])
      assert.deepStrictEqual(off.lorebooks, [two])
      yield* change(main, { _tag: "Lorebook", ref: one, active: true })
      assert.deepStrictEqual((yield* cast(main)).lorebooks, [one, two])
      yield* change(main, { _tag: "RemoveLorebook", ref: one })
      assert.deepStrictEqual((yield* cast(main)).listedLorebooks, [{ ref: two, on: true }])
      // The fork made before these changes still lists both, on.
      assert.deepStrictEqual((yield* cast(sibling)).lorebooks, [one, two])
    })
  )

  it.effect("purging a replaced card keeps the independent replacement in the cast", () =>
    Effect.gen(function* () {
      const { api, main, parent, card, swap, state, writer, userId } = yield* setup
      yield* swap(main)
      const item = yield* writer.DeleteEntity({ userId, entityId: parent.entityId })
      yield* api.PurgeBinItem({ itemId: item.id })
      assert.deepStrictEqual((yield* state(main)).participants, [card.entityId])
    })
  )

  it.effect("purged intermediates route to live cards and purged incoming swaps stay ignored", () =>
    Effect.gen(function* () {
      const { api, main, b, parent, card, swap, state, writer, userId, add, fork } = yield* setup
      const next = yield* writer.ForkCard({
        userId,
        refId: card.id,
        name: "Third card",
        nickname: "Mira",
        characterVersion: "3"
      })
      yield* add(main, b.slotId, { key: "presence.set", value: { entity: parent.entityId, present: false } })
      yield* swap(main)
      yield* add(main, b.slotId, { key: "card.swap", value: { entity: next.entityId, replaces: card.entityId } })
      const later = yield* fork(main, b.slotId)
      // This fork goes back to the original, which will be purged.
      yield* add(later, b.slotId, { key: "card.swap", value: { entity: parent.entityId, replaces: next.entityId } })
      for (const entityId of [parent.entityId, card.entityId]) {
        const item = yield* writer.DeleteEntity({ userId, entityId })
        yield* api.PurgeBinItem({ itemId: item.id })
      }
      assert.deepStrictEqual((yield* state(main)).participants, [next.entityId])
      assert.deepStrictEqual((yield* state(later)).participants, [next.entityId])
      yield* add(later, b.slotId, { key: "presence.set", value: { entity: next.entityId, present: true } })
      assert.notInclude((yield* state(later)).absent, next.entityId)
      assert.include((yield* state(main)).absent, next.entityId)
    })
  )

  it.effect("batched group and shell reads retain live replacements after purging originals", () =>
    Effect.gen(function* () {
      const { api, main, b, parent, card, swap, writer, reader, userId, add, chatId } = yield* setup
      const steady = yield* writer.CreateEntity({
        userId,
        kind: "card",
        label: "Tomas",
        subtitle: "",
        doc: cardDoc("Tomas"),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* add(main, b.slotId, { key: "participant.join", value: { entity: steady.entityId } })
      yield* swap(main)
      const other = yield* writer.CreateChat({
        userId,
        kind: "rp",
        status: "active",
        title: "Other routing",
        participants: [parent.entityId, steady.entityId],
        greeting: null
      })
      for (const value of [
        { entity: card.entityId, replaces: parent.entityId },
        { entity: parent.entityId, replaces: card.entityId }
      ])
        yield* writer.AddStateEvent({
          userId,
          chatId: other.id,
          forkId: other.currentForkId,
          slotId: null,
          versionId: null,
          scope: null,
          data: { key: "card.swap", value }
        })
      const item = yield* writer.DeleteEntity({ userId, entityId: parent.entityId })
      yield* api.PurgeBinItem({ itemId: item.id })
      const group = (yield* reader.ChatGroups({ userId })).find((g) => g.latestChatId === chatId)
      assert.isDefined(group)
      assert.sameMembers(
        group!.members.map((m) => m.entityId),
        [card.entityId, steady.entityId]
      )
      const shell = yield* reader.ShellLibrary({ userId })
      assert.sameMembers([...shell.forks.find((f) => f.chat.id === chatId)!.cast], [card.entityId, steady.entityId])
      assert.sameMembers([...shell.forks.find((f) => f.chat.id === other.id)!.cast], [card.entityId, steady.entityId])
    })
  )

  it.effect("a cast change on an inserted message applies after its anchor and before the next, in its fork only", () =>
    Effect.gen(function* () {
      const { main, a, b, card, parent, add, state, fork, writer, reader, userId, chatId } = yield* setup
      const before = yield* fork(main, b.slotId)
      const anchor = yield* reader.GetSlot({ userId, slotId: a.slotId, forkId: main })
      const x = yield* writer.InsertMessage({
        userId,
        chatId,
        forkId: main,
        anchorSlotId: a.slotId,
        expectedRowVersion: anchor.entry.rowVersion,
        body: { _tag: "Write", speaker: parent.entityId, content: "X" }
      })
      // B's leave is written first: by depth (X's equals B's) and seq the two would tie, by
      // position X's join comes first.
      yield* add(main, b.slotId, { key: "participant.leave", value: { entity: card.entityId } })
      yield* add(main, x.slotId, { key: "participant.join", value: { entity: card.entityId } })
      yield* add(main, x.slotId, { key: "var.set", value: { name: "at", value: "x" } })
      yield* add(main, b.slotId, { key: "var.set", value: { name: "at", value: "b" } })
      yield* add(main, x.slotId, { key: "var.set", value: { name: "fromX", value: 1 } })
      assert.notInclude((yield* state(main, a.slotId)).participants, card.entityId)
      assert.include((yield* state(main, x.slotId)).participants, card.entityId)
      assert.strictEqual((yield* state(main, x.slotId)).vars.at, "x")
      assert.notInclude((yield* state(main, b.slotId)).participants, card.entityId)
      assert.strictEqual((yield* state(main, b.slotId)).vars.at, "b")
      assert.strictEqual((yield* state(main, b.slotId)).vars.fromX, 1)
      assert.isUndefined((yield* state(main, a.slotId)).vars.fromX)
      // A fork made before the insertion never sees X or its events.
      assert.deepStrictEqual((yield* state(before, b.slotId)).participants, [parent.entityId])
      assert.isUndefined((yield* state(before, b.slotId)).vars.at)
      // A fork made afterwards at X inherits X and its events up to there.
      const later = yield* fork(main, x.slotId)
      assert.include((yield* state(later, x.slotId)).participants, card.entityId)
      // Without B's leave, the join holds at B: X's events fold before B's.
      const joined = yield* fork(main, a.slotId)
      const y = yield* writer.InsertMessage({
        userId,
        chatId,
        forkId: joined,
        anchorSlotId: a.slotId,
        expectedRowVersion: (yield* reader.GetSlot({ userId, slotId: a.slotId, forkId: joined })).entry.rowVersion,
        body: { _tag: "Write", speaker: parent.entityId, content: "Y" }
      })
      yield* add(joined, y.slotId, { key: "participant.join", value: { entity: card.entityId } })
      assert.include((yield* state(joined, y.slotId)).participants, card.entityId)
      assert.notInclude((yield* state(joined, a.slotId)).participants, card.entityId)
      // An event on a message the fork doesn't show is refused there.
      const refused = yield* add(before, x.slotId, { key: "var.set", value: { name: "no", value: 1 } }).pipe(
        Effect.flip
      )
      assert.strictEqual(refused._tag, "NotFound")
    })
  )

  it.effect("the composer reads the display end while StateEventsAt keeps the precise tip", () =>
    Effect.gen(function* () {
      const { api, main, b, writer, reader, userId, chatId, card, add, state, fork } = yield* setup
      const old = yield* fork(main, b.slotId)
      const x = yield* writer.InsertMessage({
        userId,
        chatId,
        forkId: main,
        anchorSlotId: b.slotId,
        expectedRowVersion: (yield* reader.GetSlot({ userId, slotId: b.slotId, forkId: main })).entry.rowVersion,
        body: { _tag: "Write", speaker: null, content: "After the tip" }
      })
      yield* add(main, x.slotId, { key: "participant.join", value: { entity: card.entityId } })
      assert.notInclude((yield* state(main, b.slotId)).participants, card.entityId)
      assert.include((yield* state(main, x.slotId)).participants, card.entityId)
      const cast = yield* api.GetCast({ chatId, forkId: main, slotId: b.slotId })
      assert.include(cast.participants, card.entityId)
      const elsewhere = yield* api.GetCast({ chatId, forkId: old, slotId: b.slotId })
      assert.notInclude(elsewhere.participants, card.entityId)
      const changed = yield* api.ChangeCast({
        chatId,
        forkId: main,
        slotId: b.slotId,
        change: { _tag: "Leave", entityId: card.entityId }
      })
      assert.notInclude(changed.participants, card.entityId)
      assert.notInclude((yield* state(main, x.slotId)).participants, card.entityId)
      yield* writer.AddStateEvents({
        userId,
        chatId,
        forkId: main,
        slotId: b.slotId,
        displayEnd: true,
        data: [{ key: "var.set", value: { name: "composer", value: "at end" } }]
      })
      assert.strictEqual((yield* state(main, x.slotId)).vars.composer, "at end")
      assert.isUndefined((yield* state(main, b.slotId)).vars.composer)
      assert.isUndefined((yield* state(old, b.slotId)).vars.composer)
    })
  )

  it.effect("the next-context preview reads the viewed fork at a shared tip", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startMockProvider((_request, res) =>
            sse(res, completionChunks(["Reply."], { prompt_tokens: 10, completion_tokens: 2 }))
          )
        ),
        (m) => Effect.promise(() => m.close())
      )
      const api = yield* client()
      const writer = yield* Writer
      const userId = (yield* api.Whoami()).id as UserId
      const { chat, version } = yield* generateReply(api, {
        connection: { kind: "openai-chat", baseUrl: `${mock.url}/v1` },
        model: {}
      })
      const main = chat.currentForkId!
      const other = (yield* writer.CreateFork({ userId, chatId: chat.id, fromForkId: main, atSlotId: version.slotId }))
        .fork.id
      const note = yield* writer.CreateEntity({
        userId,
        kind: "note",
        label: "Fork note",
        subtitle: "",
        doc: { ...newChatNote(chat.id, "Fork note"), content: "Only in this fork." },
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
      yield* writer.AddStateEvent({
        userId,
        chatId: chat.id,
        forkId: main,
        slotId: version.slotId,
        versionId: null,
        scope: null,
        data: { key: "note.activate", value: { note: note.entityId } }
      })
      const params = { chatId: chat.id, forkId: main, leafSlotId: version.slotId }
      const names = (next: NextContext) => next.presetContext?.notes.map((n) => n.title) ?? []
      assert.include(names(yield* api.GetNextContext(params)), "Fork note")
      assert.notInclude(names(yield* api.GetNextContext({ ...params, forkId: other })), "Fork note")
    }).pipe(Effect.scoped)
  )

  it.effect("an enable run cannot unhide one fork and enable another after current changes", () =>
    Effect.gen(function* () {
      const { main, b, writer, reader, userId, chatId, fork } = yield* setup
      yield* writer.ChangeLcmSettings({ userId, chatId, forkId: main, change: { enabled: false } })
      const params = {
        userId,
        chatId,
        leafSlotId: b.slotId,
        choice: "scratch" as const,
        approved: { jobs: 0, tokens: 0, cost: null, currency: null },
        imported: null
      }
      const run = yield* writer.StageLcmEnable(params)
      const other = yield* fork(main, b.slotId)
      assert.strictEqual(yield* outcome(writer.EnableLcm({ ...params, runId: run.runId })), "StorageError:constraint")
      assert.isFalse((yield* reader.GetLcmState({ userId, chatId, forkId: other, leafSlotId: b.slotId })).enabled)
      assert.isFalse((yield* reader.GetLcmState({ userId, chatId, forkId: main, leafSlotId: b.slotId })).enabled)
    })
  )
})
