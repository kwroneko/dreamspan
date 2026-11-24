// Names the user gives (DESIGN §2.1, §3.2): a chat's title (RenameChat), a group's, which is
// all its chats' (RenameGroup), and a branch's (NameBranch, ListBranches); and a group's new
// chat greeted by each member in turn, as ST starts one (StartChat's `greeters`). Cross-user
// access is in the isolation matrix.
import { assert, describe, it } from "@effect/vitest"
import type { ChatId, SlotId } from "@dreamspan/shared/chat.ts"
import type { CardDoc } from "@dreamspan/shared/docs/card.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import { Effect } from "effect"
import { Generator } from "../src/chat/Generator.ts"
import { Writer } from "../src/db/Database.ts"
import { client, outcome, posted, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

type Api = Effect.Success<ReturnType<typeof client>>

const card = (api: Api, label: string, doc: Partial<CardDoc>, persona = false) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId } = yield* writer.CreateEntity({
      userId: me.id as UserId,
      kind: "card",
      label,
      subtitle: "",
      doc: cardDoc(label, doc),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    if (persona) yield* writer.SetEntityTags({ userId: me.id as UserId, entityId, tags: ["persona"] })
    return entityId
  })

const path = (api: Api, chatId: ChatId) =>
  Effect.map(
    api.ReadPath({ chatId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 100 }),
    (window) => window.entries
  )

const layer = serverLayer(testConfig(), Generator.none)

describe("naming", () => {
  it.live("renames a chat, keeping an ST chat's start day; an empty name gives the automatic one back", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const made = yield* api.CreateChat({ title: "Ana & Mira" })
      const renamed = yield* api.RenameChat({ chatId: made.id, name: "  The long\nnight  " })
      assert.strictEqual(renamed.title, "The long night")
      assert.isAbove(renamed.rowVersion, made.rowVersion)
      assert.strictEqual((yield* api.GetChat({ chatId: made.id })).title, "The long night")

      const imported = yield* api.CreateChat({ title: "The Lantern Inn: 2026-4-3@19h02m11s123ms" })
      assert.strictEqual(
        (yield* api.RenameChat({ chatId: imported.id, name: "Winter at the inn" })).title,
        "Winter at the inn - 2026-4-3@19h02m11s123ms"
      )
      assert.strictEqual((yield* api.RenameChat({ chatId: imported.id, name: "" })).title, "2026-4-3@19h02m11s123ms")
      const deleted = yield* api.CreateChat({ title: "Gone" })
      yield* api.DeleteChat({ chatId: deleted.id })
      assert.strictEqual(yield* outcome(api.RenameChat({ chatId: deleted.id, name: "x" })), "NotFound")
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.live("a rename from a title the chat no longer has is refused, unless it has the name already (rev-dd4a #4)", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const made = yield* api.CreateChat({ title: "Workshop" })
      // Applied, its answer lost; the retry finds the name there and is done.
      yield* api.RenameChat({ chatId: made.id, name: "Alpha", from: "Workshop" })
      assert.strictEqual((yield* api.RenameChat({ chatId: made.id, name: "Alpha", from: "Workshop" })).title, "Alpha")
      // Another tab's rename came first: it stays, and the retry says it wasn't applied.
      yield* api.RenameChat({ chatId: made.id, name: "Beta" })
      assert.strictEqual(
        yield* outcome(api.RenameChat({ chatId: made.id, name: "Gamma", from: "Alpha" })),
        "EditRefused"
      )
      assert.strictEqual((yield* api.GetChat({ chatId: made.id })).title, "Beta")
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.live("renaming a group renames its chats; renaming one of them takes it out of the group", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana", { name: "Ana", first_mes: "Hi." })
      const mira = yield* card(api, "Mira", { name: "Mira", first_mes: "Hello." })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const start = () =>
        api.StartChat({
          cards: [ana, mira],
          persona: sam,
          greeting: null,
          title: "The Lantern Inn",
          first: { _tag: "Send", content: "Hello.", speakerEntityId: sam }
        })
      const first = yield* start()
      const second = yield* start()
      const third = yield* start()
      const { group, chats } = yield* api.RenameGroup({ chatId: first.chat.id, name: "Winter inn" })
      assert.strictEqual(group.name, "Winter inn")
      assert.strictEqual(group.chats, 3)
      assert.deepStrictEqual(
        chats.map((chat) => chat.title),
        ["Winter inn", "Winter inn", "Winter inn"]
      )
      assert.deepStrictEqual(
        (yield* api.ListChatGroups()).map((g) => [g.name, g.chats]),
        [["Winter inn", 3]]
      )

      yield* api.RenameChat({ chatId: third.chat.id, name: "A side story" })
      const groups = yield* api.ListChatGroups()
      assert.deepStrictEqual(groups.map((g) => [g.name, g.chats]).sort(), [
        ["A side story", 1],
        ["Winter inn", 2]
      ])
      assert.deepStrictEqual(
        (yield* api.ListGroupChats({ chatId: second.chat.id })).chats.map((chat) => chat.id).sort(),
        [first.chat.id, second.chat.id].sort()
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  // The Chats page's New chat (workshopstart2): made by its first message, with nobody in it.
  it.live("a chat with no characters starts from its first message, under the title typed or its date", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const titled = yield* api.StartChat({
        cards: [],
        persona: sam,
        greeting: null,
        title: "Notebook",
        first: { _tag: "Send", content: "A note.", speakerEntityId: sam }
      })
      assert.strictEqual(titled.chat.title, "Notebook")
      const entries = yield* path(api, titled.chat.id)
      assert.deepStrictEqual(
        entries.map((entry) => entry.version.content),
        ["A note."]
      )
      const cast = yield* api.GetCast({ chatId: titled.chat.id, slotId: null })
      assert.deepStrictEqual(cast.playedByMe, [sam])
      const untitled = yield* api.StartChat({
        cards: [],
        persona: null,
        greeting: null,
        first: { _tag: "Send", content: "Another.", speakerEntityId: null }
      })
      assert.match(untitled.chat.title ?? "", /^Chat, /)
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.live("a group's new chat starts with each member's greeting in turn, each with its alternates", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const ana = yield* card(api, "Ana", {
        name: "Ana",
        first_mes: "Ana: hi, {{user}}.",
        alternate_greetings: ["Ana nods."]
      })
      const quiet = yield* card(api, "Quiet", { name: "Quiet", first_mes: "" })
      const mira = yield* card(api, "Mira", {
        name: "Mira",
        first_mes: "Mira: hello.",
        alternate_greetings: ["Mira waves."]
      })
      const sam = yield* card(api, "Sam", { name: "Sam" }, true)
      const started = yield* api.StartChat({
        cards: [ana, quiet, mira],
        persona: sam,
        greeting: null,
        greeters: [
          { entityId: ana, greeting: 0 },
          { entityId: quiet, greeting: 0 },
          { entityId: mira, greeting: 1, frozen: {} }
        ],
        title: "Trio",
        first: { _tag: "Send", content: "Hello, both.", speakerEntityId: sam }
      })
      const entries = yield* path(api, started.chat.id)
      // A card without a greeting is skipped, as ST skips it.
      assert.deepStrictEqual(
        entries.map((e) => [e.depth, e.version.speakerEntityId, e.version.content, e.versionCount]),
        [
          [0, ana, "Ana: hi, {{user}}.", 2],
          [1, mira, "Mira waves.", 2],
          [2, sam, "Hello, both.", 1]
        ]
      )
      assert.strictEqual(entries[1]!.version.origin, "greeting")

      // Direct callers get every member too, even without the preview's choices.
      const automatic = yield* api.StartChat({
        cards: [ana, quiet, mira],
        persona: sam,
        greeting: null,
        first: { _tag: "Send", content: "Another beginning.", speakerEntityId: sam }
      })
      const autoPath = yield* path(api, automatic.chat.id)
      assert.deepStrictEqual(
        autoPath.map((e) => e.version.speakerEntityId),
        [ana, mira, sam]
      )
      assert.deepStrictEqual(
        autoPath.map((e) => e.versionCount),
        [2, 2, 1]
      )

      const pickedFirst = yield* api.StartChat({
        cards: [ana, quiet, mira],
        persona: sam,
        greeting: 1,
        first: { _tag: "Send", content: "With a chosen first greeting.", speakerEntityId: sam }
      })
      assert.strictEqual((yield* path(api, pickedFirst.chat.id))[0]!.version.content, "Ana nods.")

      const stranger = yield* card(api, "Tobin", { name: "Tobin", first_mes: "Hey." })
      assert.strictEqual(
        yield* outcome(
          api.StartChat({
            cards: [ana],
            persona: null,
            greeting: null,
            greeters: [{ entityId: stranger, greeting: 0 }],
            first: { _tag: "Send", content: "Hi.", speakerEntityId: null }
          })
        ),
        "NotFound"
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  )

  it.live("names a fork, lists the alternates with their names, and takes a name off", () =>
    Effect.gen(function* () {
      const api = yield* client()
      const chat = yield* api.CreateChat({ title: "Forks" })
      const send = (parentSlotId: SlotId | null, content: string, branch = false) =>
        Effect.map(posted(api.SendMessage({ chatId: chat.id, parentSlotId, branch, content })), (sent) => sent.entry)
      const root = yield* send(null, "root")
      const a = (yield* send(root.slotId, "the tavern")).slotId
      const road = yield* send(root.slotId, "the road", true)
      const b = road.slotId
      assert.isDefined(road.startsForkId)
      const named = yield* api.NameFork({ forkId: road.startsForkId!, name: "  Road\ttrip " })
      assert.strictEqual(named.name, "Road trip")
      const leaf = (yield* path(api, chat.id)).at(-1)!
      assert.strictEqual(leaf.slotId, b)
      assert.strictEqual(leaf.branchName, "Road trip")
      assert.isAbove(leaf.rowVersion, road.rowVersion)
      assert.deepStrictEqual(
        (yield* api.ListBranches({ slotId: a })).map((branch) => [
          branch.slotId,
          branch.index,
          branch.name,
          branch.preview
        ]),
        [
          [a, 0, null, "the tavern"],
          [b, 1, "Road trip", "the road"]
        ]
      )
      assert.include(
        (yield* api.ListForks({ chatId: chat.id })).map((fork) => fork.name),
        "Road trip"
      )
      const cleared = yield* api.NameFork({ forkId: road.startsForkId!, name: " " })
      assert.isNull(cleared.name)
      assert.isUndefined((yield* path(api, chat.id)).at(-1)!.branchName)
      // A deleted branch is no longer among them.
      const tavern = (yield* api.ListForks({ chatId: chat.id })).find((fork) => fork.tipSlotId === a)!
      yield* api.DeleteFork({ forkId: tavern.id })
      assert.deepStrictEqual(
        (yield* api.ListBranches({ slotId: b })).map((branch) => branch.slotId),
        [b]
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  )
})
