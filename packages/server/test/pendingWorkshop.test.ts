// A new workshop is a pending chat like a new roleplay chat (spec/WORKSHOP-CARDS.md §3): made by
// OpenDraftChat with its assistant's greeting, listed nowhere and swept like one, and started by
// its first message under its own title.
import { assert, describe, it } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Reader, Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(serverLayer(testConfig(), Generator.none)))

const setup = Effect.gen(function* () {
  const api = yield* client()
  const userId = (yield* api.Whoami()).id as UserId
  const writer = yield* Writer
  const { entityId } = yield* writer.CreateEntity({
    userId,
    kind: "card",
    label: "Quill",
    subtitle: "",
    doc: cardDoc("Quill", { first_mes: "Quill uncaps a pen." }),
    schemaVersion: 1,
    origin: "user",
    sourcePath: null
  })
  return { api, userId, quill: entityId as EntityId }
})

describe("a new workshop's pending chat", () => {
  it.live("opens with its card's greeting, listed nowhere, and starts on its first message", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const draft = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none` })
        assert.strictEqual(draft.status, "pending")
        assert.strictEqual(draft.kind, "workshop")
        const read = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          read.entries.map((entry) => entry.version.content),
          ["Quill uncaps a pen."]
        )
        const state = foldState(
          yield* (yield* Reader).StateEventsAt({ userId, chatId: draft.id, slotId: draft.activeLeafSlotId })
        )
        assert.deepStrictEqual(state.participants, [quill])
        assert.deepStrictEqual(state.playedByMe, [])
        assert.notInclude(
          (yield* api.ListChats({ limit: 50, before: null })).map((chat) => chat.id),
          draft.id
        )
        // A reload reopens it as it is.
        assert.strictEqual(
          (yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none`, reopen: draft.id })).id,
          draft.id
        )

        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: draft.activeLeafSlotId!,
          branch: false,
          content: "Write me a lighthouse keeper."
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        assert.strictEqual(started.title, "Workshop")
        assert.include(
          (yield* api.ListChats({ limit: 50, before: null })).map((chat) => chat.id),
          draft.id
        )
      })
    )
  )

  it.live("a new workshop left behind is swept, and the next visit draws a fresh one", () =>
    run(
      Effect.gen(function* () {
        const { api, quill } = yield* setup
        const first = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
        yield* (yield* Writer).SweepPendingChat({ userId: (yield* api.Whoami()).id, chatId: first.id })
        const again = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
        assert.notStrictEqual(again.id, first.id)
        assert.strictEqual(
          yield* api.GetChat({ chatId: first.id }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag)
          ),
          "NotFound"
        )
      })
    )
  )

  it.live(
    "a workshop opened in a swept one's place carries on only the items its composer still held (rev-dd5 #2)",
    () =>
      run(
        Effect.gen(function* () {
          const { api, userId, quill } = yield* setup
          const kept = yield* api.CreateLorebook({ label: "Harbour charts" })
          const removed = yield* api.CreateLorebook({ label: "Harbour rules" })
          const first = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
          const composer = yield* api.OpenComposer({ chatId: first.id, forkId: null })
          const key = { chatId: first.id, draftId: composer.id }
          // Both handed over; another tab removes one; then the workshop is swept.
          yield* api.SetComposerLibrary({ ...key, add: [kept.id, removed.id], remove: [] })
          yield* api.SetComposerLibrary({ ...key, add: [], remove: [removed.id] })
          yield* (yield* Writer).SweepPendingChat({ userId, chatId: first.id })
          // The tab that handed both over carries them on to the workshop opened in its place.
          const again = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
          const next = yield* api.OpenComposer({ chatId: again.id, forkId: null })
          const carried = yield* api.SetComposerLibrary({
            chatId: again.id,
            draftId: next.id,
            add: [kept.id, removed.id],
            remove: [],
            carriedFrom: first.id
          })
          assert.deepStrictEqual(
            carried.map((item) => item.name),
            ["Harbour charts"]
          )
        })
      )
  )

  it.live("retrying a carry leaves an item removed from the replacement detached (rev-dd7 #2)", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const book = yield* api.CreateLorebook({ label: "Harbour ledger" })
        const first = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:` })
        const original = yield* api.OpenComposer({ chatId: first.id, forkId: null })
        yield* api.SetComposerLibrary({ chatId: first.id, draftId: original.id, add: [book.id], remove: [] })
        yield* (yield* Writer).SweepPendingChat({ userId, chatId: first.id })

        const replacement = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:`, reopen: first.id })
        const composer = yield* api.OpenComposer({ chatId: replacement.id, forkId: null })
        const key = { chatId: replacement.id, draftId: composer.id }
        const carry = { ...key, add: [book.id], remove: [], carriedFrom: first.id }
        const attached = yield* api.SetComposerLibrary(carry)
        assert.deepStrictEqual(
          attached.map((item) => item.refId),
          [book.id]
        )
        yield* api.SetComposerLibrary({ ...key, add: [], remove: [book.id] })

        assert.deepStrictEqual(yield* api.SetComposerLibrary(carry), [])
        assert.deepStrictEqual(yield* api.GetComposerLibrary(key), [])
        const denied = yield* api
          .SendMessage({
            chatId: replacement.id,
            parentSlotId: replacement.activeLeafSlotId,
            branch: false,
            content: "Review the ledger.",
            library: attached.map(({ kind, refId }) => ({ kind, refId })),
            composer: { draftId: composer.id, session: composer.session },
            reply: false
          })
          .pipe(Effect.flip)
        assert.strictEqual(denied._tag, "NotFound")
        // Adding it again by hand is a new action.
        assert.deepStrictEqual(
          (yield* api.SetComposerLibrary({ ...key, add: [book.id], remove: [] })).map((item) => item.refId),
          [book.id]
        )
      })
    )
  )

  it.live("a URL replay and a carry share the removal in their latest destination (rev-dd7 #1)", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const book = yield* api.CreateLorebook({ label: "Piers" })
        const removed = yield* api.CreateLorebook({ label: "Old piers" })
        const open = (reopen?: Parameters<typeof api.OpenDraftChat>[0]["reopen"]) =>
          Effect.gen(function* () {
            const chat = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:`, ...(reopen ? { reopen } : {}) })
            const composer = yield* api.OpenComposer({ chatId: chat.id, forkId: null })
            return { chatId: chat.id, draftId: composer.id }
          })
        const first = yield* open()
        const handover = { originChatId: first.chatId, operationId: "piers" }
        const add = { add: [book.id, removed.id], remove: [], handover }
        yield* api.SetComposerLibrary({ ...first, ...add })
        yield* api.SetComposerLibrary({ ...first, add: [], remove: [removed.id] })
        assert.deepStrictEqual(
          (yield* api.SetComposerLibrary({ ...first, ...add })).map((item) => item.refId),
          [book.id]
        )

        const writer = yield* Writer
        yield* writer.SweepPendingChat({ userId, chatId: first.chatId })
        const second = yield* open(first.chatId)
        assert.deepStrictEqual(
          (yield* api.SetComposerLibrary({ ...second, add: [book.id], remove: [], carriedFrom: first.chatId })).map(
            (item) => item.refId
          ),
          [book.id]
        )
        yield* api.SetComposerLibrary({ ...second, add: [], remove: [book.id] })
        assert.deepStrictEqual(yield* api.SetComposerLibrary({ ...second, ...add }), [])

        yield* writer.SweepPendingChat({ userId, chatId: second.chatId })
        const third = yield* open(second.chatId)
        // Tabs already open at the upgrade can still send a bare carry from the original sweep.
        assert.deepStrictEqual(
          yield* api.SetComposerLibrary({ ...third, add: [book.id], remove: [], carriedFrom: first.chatId }),
          []
        )
        assert.deepStrictEqual(yield* api.SetComposerLibrary({ ...third, ...add }), [])
      })
    )
  )

  it.live("ten new workshops opened and left make the seeds once, and nothing more in the library", () =>
    run(
      Effect.gen(function* () {
        const api = yield* client()
        const userId = (yield* api.Whoami()).id as UserId
        const counts = Effect.gen(function* () {
          const [cards, presets, lorebooks] = yield* Effect.all([
            api.ListLibrary({ kind: "card" }),
            api.ListLibrary({ kind: "preset" }),
            api.ListLibrary({ kind: "lorebook" })
          ])
          return { cards: cards.length, presets: presets.length, lorebooks: lorebooks.length }
        })
        const before = yield* counts
        const after: Array<{ cards: number; presets: number; lorebooks: number }> = []
        for (let visit = 0; visit < 10; visit++) {
          const draft = yield* api.OpenDraftChat({ draftFor: "workshop::" })
          yield* api.LeaveDraftChat({ chatId: draft.id })
          yield* (yield* Writer).SweepPendingChat({ userId, chatId: draft.id })
          after.push(yield* counts)
        }
        console.log("library before", before, "after each visit", after)
        // The first visit makes the workshop seeds (its assistant card, its persona and its
        // preset), as the first workshop always did; every later one reuses them.
        assert.deepStrictEqual(after[0], {
          cards: before.cards + 2,
          presets: before.presets + 1,
          lorebooks: before.lorebooks
        })
        for (const visit of after) assert.deepStrictEqual(visit, after[0])
        assert.deepStrictEqual(
          (yield* api.ListChats({ limit: 50, before: null })).filter((chat) => chat.kind === "workshop"),
          []
        )
      })
    )
  )

  it.live("an assistant swapped before the first send greets instead, and is the started workshop's", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const { entityId: wren } = yield* (yield* Writer).CreateEntity({
          userId,
          kind: "card",
          label: "Wren",
          subtitle: "",
          doc: cardDoc("Wren", { first_mes: "Wren opens a ledger." }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `workshop:${quill}:none` })
        // The Cast tab: the new assistant added, the old one removed.
        for (const change of [
          { _tag: "Join", entityId: wren as EntityId } as const,
          { _tag: "Leave", entityId: quill } as const
        ])
          yield* api.ChangeCast({ chatId: draft.id, slotId: null, forkId: draft.currentForkId!, pending: true, change })
        const greeting = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          greeting.entries.map((entry) => [entry.version.content, entry.version.speakerEntityId]),
          [["Wren opens a ledger.", wren]]
        )
        const pending = yield* api.GetChat({ chatId: draft.id })
        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: pending.activeLeafSlotId!,
          branch: false,
          content: "Tidy my lorebooks."
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        const state = foldState(
          yield* (yield* Reader).StateEventsAt({ userId, chatId: draft.id, slotId: started.activeLeafSlotId })
        )
        assert.deepStrictEqual(state.participants, [wren])
        const read = yield* api.ReadPath({
          chatId: draft.id,
          forkId: null,
          leafSlotId: null,
          range: { _tag: "Bottom" },
          limit: 5
        })
        assert.deepStrictEqual(
          read.entries.map((entry) => entry.version.content),
          ["Wren opens a ledger.", "Tidy my lorebooks."]
        )
      })
    )
  )

  it.live("a workshop beside a story is pending until its first message, and only then beside it", () =>
    run(
      Effect.gen(function* () {
        const api = yield* client()
        const story = yield* api.CreateChat({ title: "Harbor" })
        yield* api.SendMessage({ chatId: story.id, parentSlotId: null, branch: false, content: "The tide turns." })
        const fork = (yield* api.GetChat({ chatId: story.id })).currentForkId!
        const beside = () => api.ListAttachedWorkshops({ chatId: story.id, forkId: fork })
        const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.id}:${fork}` })
        assert.strictEqual(draft.status, "pending")
        assert.strictEqual(draft.kind, "workshop")
        assert.deepStrictEqual(yield* beside(), [])
        // A reload reopens it.
        assert.strictEqual(
          (yield* api.OpenDraftChat({ draftFor: `side:${story.id}:${fork}`, reopen: draft.id })).id,
          draft.id
        )
        yield* api.SendMessage({
          chatId: draft.id,
          parentSlotId: draft.activeLeafSlotId!,
          branch: false,
          content: "What happened at the harbor?"
        })
        const started = yield* api.GetChat({ chatId: draft.id })
        assert.strictEqual(started.status, "active")
        assert.strictEqual(started.title, "About Harbor")
        assert.deepStrictEqual(
          (yield* beside()).map((chat) => chat.id),
          [draft.id]
        )
      })
    )
  )

  /** A story on two branches, and the side workshop draft of its second with this typed, then cleared. */
  const storyWithSideDraft = Effect.gen(function* () {
    const api = yield* client()
    const userId = (yield* api.Whoami()).id as UserId
    const story = yield* api.CreateChat({ title: "Harbor" })
    yield* api.SendMessage({ chatId: story.id, parentSlotId: null, branch: false, content: "The tide turns." })
    const shown = yield* api.GetChat({ chatId: story.id })
    const main = shown.currentForkId!
    const { fork } = yield* api.CreateFork({ chatId: story.id, fromForkId: main, atSlotId: shown.activeLeafSlotId })
    const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.id}:${fork.id}` })
    const composer = yield* api.OpenComposer({ chatId: draft.id, forkId: null })
    const save = (rowVersion: number, session: number, content: string) =>
      api.SaveComposer({
        chatId: draft.id,
        draftId: composer.id,
        rowVersion,
        session,
        next: false,
        operationId: crypto.randomUUID(),
        content
      })
    const cleared = "Ask the keeper which boats came home before the storm broke."
    const typed = yield* save(composer.rowVersion, composer.session, cleared)
    // Select all and clear it: that text is only in the draft's history now.
    const empty = yield* save(typed.draft!.rowVersion, typed.draft!.session, "")
    const unsent = "And who rang the bell at midnight?"
    yield* save(empty.draft!.rowVersion, empty.draft!.session, unsent)
    const recovered = () =>
      Effect.map(api.ListRecoveredTexts({ limit: 50, before: null }), (texts) => texts.map((text) => text.content))
    return { api, userId, story, main, fork: fork.id, draft, cleared, unsent, recovered }
  })

  it.live("deleting the story branch a pending side workshop is beside files its typing, and its purge keeps it", () =>
    run(
      Effect.gen(function* () {
        const { api, fork, draft, cleared, unsent, recovered } = yield* storyWithSideDraft
        const item = yield* api.DeleteFork({ forkId: fork })
        yield* api.PurgeBinItem({ itemId: item.id })
        const texts = yield* recovered()
        assert.include(texts, cleared)
        assert.include(texts, unsent)
        // Filed once, as a sweep files it, and the pending workshop is gone, not in the bin.
        assert.strictEqual(texts.filter((text) => text === unsent).length, 1)
        assert.strictEqual(
          yield* api.GetChat({ chatId: draft.id }).pipe(
            Effect.flip,
            Effect.map((e) => e._tag)
          ),
          "NotFound"
        )
        assert.deepStrictEqual(
          (yield* api.ListBin({ limit: 50, before: null })).filter((binned) => binned.origin.chatId === draft.id),
          []
        )
      })
    )
  )

  it.live("deleting the story files a pending side workshop's typing, and its purge keeps it", () =>
    run(
      Effect.gen(function* () {
        const { api, story, cleared, unsent, recovered } = yield* storyWithSideDraft
        const item = yield* api.DeleteChat({ chatId: story.id })
        yield* api.PurgeBinItem({ itemId: item.id })
        const texts = yield* recovered()
        assert.include(texts, cleared)
        assert.strictEqual(texts.filter((text) => text === unsent).length, 1)
      })
    )
  )

  it.live("branching the story doesn't branch a pending side workshop", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, story, fork, draft } = yield* storyWithSideDraft
        yield* api.CreateFork({ chatId: story.id, fromForkId: fork, atSlotId: null })
        const branches = yield* (yield* Reader).WorkshopBranches({ userId, chatId: draft.id })
        assert.lengthOf(branches, 1)
      })
    )
  )

  it.live("a side workshop not started yet refuses a card of its story as your persona", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const story = yield* api.StartChat({
          cards: [quill],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Quill writes by the window.", speakerEntityId: null },
          title: "Window"
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.chat.id}:` })
        const refused = yield* api
          .ChangeCast({
            chatId: draft.id,
            slotId: null,
            forkId: draft.currentForkId!,
            pending: true,
            change: { _tag: "Persona", entityId: quill }
          })
          .pipe(Effect.flip)
        assert.strictEqual(refused._tag, "ServerError")
        const state = foldState(
          yield* (yield* Reader).StateEventsAt({ userId, chatId: draft.id, slotId: draft.activeLeafSlotId })
        )
        assert.notInclude(state.playedByMe, quill)
      })
    )
  )

  it.live("a side workshop's first send refuses a persona its story took meanwhile (rev-dfu1 #6)", () =>
    run(
      Effect.gen(function* () {
        const { api, userId, quill } = yield* setup
        const { entityId: wren } = yield* (yield* Writer).CreateEntity({
          userId,
          kind: "card",
          label: "Wren",
          subtitle: "",
          doc: cardDoc("Wren", { first_mes: "Wren sharpens a quill." }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const story = yield* api.StartChat({
          cards: [quill],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Quill writes by the window.", speakerEntityId: null },
          title: "Window"
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.chat.id}:` })
        // Wren isn't in the story yet: the workshop may play Wren.
        yield* api.ChangeCast({
          chatId: draft.id,
          slotId: null,
          forkId: draft.currentForkId!,
          pending: true,
          change: { _tag: "Persona", entityId: wren as EntityId }
        })
        // Another tab brings Wren into the story.
        const storyChat = yield* api.GetChat({ chatId: story.chat.id })
        yield* api.ChangeCast({
          chatId: story.chat.id,
          slotId: storyChat.activeLeafSlotId,
          forkId: storyChat.currentForkId!,
          change: { _tag: "Join", entityId: wren as EntityId }
        })
        const refused = yield* api
          .SendMessage({
            chatId: draft.id,
            parentSlotId: (yield* api.GetChat({ chatId: draft.id })).activeLeafSlotId!,
            branch: false,
            content: "Help me with the window scene."
          })
          .pipe(Effect.flip)
        assert.deepInclude(refused, { _tag: "NotFound", entity: "story-persona" })
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "pending")
      })
    )
  )

  it.live("a side workshop's first send refuses a persona its story swapped in meanwhile (rev-dd3 #4)", () =>
    run(
      Effect.gen(function* () {
        const { api, userId } = yield* setup
        const made = yield* (yield* Writer).CreateEntity({
          userId,
          kind: "card",
          label: "Ink",
          subtitle: "",
          doc: cardDoc("Ink", { first_mes: "Ink dries on the page." }),
          schemaVersion: 1,
          origin: "user",
          sourcePath: null
        })
        const quill = made.entityId as EntityId
        // Wren is a variant of the story's card, so the story can swap to it.
        const variant = yield* api.ForkCard({ refId: made.ref.id, name: "Wren", nickname: "", characterVersion: "" })
        const wren = variant.entityId
        const story = yield* api.StartChat({
          cards: [quill],
          persona: null,
          greeting: null,
          first: { _tag: "Send", content: "Quill writes by the window.", speakerEntityId: null },
          title: "Window"
        })
        const draft = yield* api.OpenDraftChat({ draftFor: `side:${story.chat.id}:` })
        // Wren isn't in the story yet: the workshop may play Wren.
        yield* api.ChangeCast({
          chatId: draft.id,
          slotId: null,
          forkId: draft.currentForkId!,
          pending: true,
          change: { _tag: "Persona", entityId: wren as EntityId }
        })
        // Another tab swaps Quill for Wren in the story.
        const storyChat = yield* api.GetChat({ chatId: story.chat.id })
        yield* api.ChangeCast({
          chatId: story.chat.id,
          slotId: storyChat.activeLeafSlotId,
          forkId: storyChat.currentForkId!,
          change: { _tag: "Swap", entityId: wren as EntityId, replaces: quill }
        })
        const refused = yield* api
          .SendMessage({
            chatId: draft.id,
            parentSlotId: (yield* api.GetChat({ chatId: draft.id })).activeLeafSlotId!,
            branch: false,
            content: "Help me with the window scene."
          })
          .pipe(Effect.flip)
        assert.deepInclude(refused, { _tag: "NotFound", entity: "story-persona" })
        assert.strictEqual((yield* api.GetChat({ chatId: draft.id })).status, "pending")
      })
    )
  )
})
