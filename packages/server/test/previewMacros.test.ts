// A list row's preview of a greeting shows its macros replaced, as the chat does: `{{user}}`
// is the persona the fork plays, `{{char}}` the speaker; a typed message stays as written.
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { previewText } from "../src/db/previewText.ts"
import { fixtureSql } from "./support/lcmFixtures.ts"
import { Writer } from "../src/db/Database.ts"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { cardDoc } from "./support/docs.ts"

const names = (id: string) => ({ persona: "Sam", greeter: "Ana" })[id]

it("previewText replaces a template's macros by the persona and the speaker", () => {
  const macro = { speaker: "greeter", user: "persona" }
  assert.strictEqual(previewText("Hi {{user}}, I am {{char}}.", macro, names), "Hi Sam, I am Ana.")
  assert.strictEqual(
    previewText("Hi {{user}}.", { speaker: null, user: null }, names),
    "Hi User.",
    "without a persona, as the chat does"
  )
})

it("previewText leaves a verbatim message as written, and drops a macro the start cut in two", () => {
  const macro = { speaker: "greeter", user: "persona" }
  assert.strictEqual(previewText("Say {{user}}.", null, names), "Say {{user}}.")
  assert.strictEqual(previewText("Hi {{user}}, then {{ch", macro, names), "Hi Sam, then ")
  assert.strictEqual(previewText("Hi {{user}}} {{user}", macro, names), "Hi Sam} ")
})

it("previewText keeps a greeting's dice cheap", () => {
  const macro = { speaker: null, user: null }
  const started = performance.now()
  for (let i = 0; i < 50; i++) previewText("{{roll:999999d6}} {{roll:99999999d999}}", macro, names)
  assert.isBelow(performance.now() - started, 250)
})

it.live("shell rows, the branch list and the chats list show a greeting's macros replaced", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const { entityId: greeter } = yield* writer.CreateEntity({
      userId: me.id,
      kind: "card",
      label: "Ana",
      subtitle: "",
      doc: cardDoc("Ana", { first_mes: "Welcome, <user>. I am <BOT>, also <CHAR>." }),
      schemaVersion: 1,
      origin: "user",
      sourcePath: null
    })
    const persona = yield* api.CreateCard({ label: "Sam", name: "Sam" })
    yield* api.SetPersona({ entityId: persona.entityId, persona: true })
    const started = yield* api.StartChat({
      cards: [greeter],
      persona: persona.entityId,
      greeting: 0,
      first: { _tag: "Send", content: "Typed {{user}}.", speakerEntityId: persona.entityId }
    })
    const path = yield* api.ReadPath({
      chatId: started.chat.id,
      forkId: null,
      leafSlotId: null,
      range: { _tag: "Bottom" },
      limit: 10
    })
    assert.strictEqual(path.entries[0]!.version.content, "Welcome, <user>. I am <BOT>, also <CHAR>.")
    const welcome = "Welcome, Sam. I am Ana, also Ana."
    const at = { chatId: started.chat.id, fromForkId: null, atSlotId: path.entries[0]!.slotId }
    const { fork } = yield* api.CreateFork(at)
    assert.strictEqual(fork.tipExcerpt, welcome)
    // The fork that ends at the greeting: the shell's row, the fork list and the chat's row.
    const rows = yield* api.GetShellForks({
      entity: null,
      chat: null,
      search: "",
      sort: "recent",
      sections: [{ id: "chats", limit: 10 }]
    })
    const row = rows.sections.flatMap((section) => section.rows).find((r) => r.forkId === fork.id)!
    assert.strictEqual(row.preview, welcome)
    const listed = (yield* api.ListForks({ chatId: started.chat.id })).find((f) => f.id === fork.id)!
    assert.strictEqual(listed.tipExcerpt, welcome)
    const [summary] = yield* api.ListChatSummaries({ chatIds: [started.chat.id] })
    assert.strictEqual(summary!.last!.text, welcome)
    // The typed message on the first fork stays as written.
    const typed = (yield* api.ListForks({ chatId: started.chat.id })).find((f) => f.id !== fork.id)!
    assert.strictEqual(typed.tipExcerpt, "Typed {{user}}.")
    const branches = yield* api.ListBranches({ slotId: path.entries[0]!.slotId, forkId: null })
    assert.strictEqual(branches[0]!.preview, welcome)
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("a preview follows the cast before the message, names binned cards, and covers group chats", () => {
  const config = testConfig()
  return Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const make = (name: string, first_mes: string) =>
      writer.CreateEntity({
        userId: me.id,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name, { first_mes }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const { entityId: ana } = yield* make("Ana", "Hi {{user}}, I am {{char}}.")
    const sam = yield* api.CreateCard({ label: "Sam", name: "Sam" })
    const kit = yield* api.CreateCard({ label: "Kit", name: "Kit" })
    for (const persona of [sam, kit]) yield* api.SetPersona({ entityId: persona.entityId, persona: true })
    const started = yield* api.StartChat({
      cards: [ana],
      persona: sam.entityId,
      greeting: 0,
      first: { _tag: "Send", content: "Typed.", speakerEntityId: sam.entityId }
    })
    const chatId = started.chat.id
    const path = yield* api.ReadPath({ chatId, forkId: null, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    const greeting = path.entries[0]!.slotId
    const forkId = started.chat.currentForkId!
    // A persona switch recorded at the greeting's slot describes the next turn: the greeting still reads Sam.
    yield* api.ChangeCast({ chatId, slotId: greeting, forkId, change: { _tag: "Persona", entityId: kit.entityId } })
    const { fork } = yield* api.CreateFork({ chatId, fromForkId: null, atSlotId: greeting })
    const row = () =>
      Effect.map(
        api.GetShellForks({
          entity: null,
          chat: null,
          search: "",
          sort: "recent",
          sections: [{ id: "chats", limit: 10 }]
        }),
        (rows) => rows.sections.flatMap((section) => section.rows).find((r) => r.forkId === fork.id)!.preview
      )
    const tip = () => Effect.map(api.ListForks({ chatId }), (forks) => forks.find((f) => f.id === fork.id)!.tipExcerpt)
    const alternates = () =>
      Effect.map(api.ListBranches({ slotId: greeting, forkId: null }), (branches) => branches.map((b) => b.preview))
    assert.strictEqual(yield* row(), "Hi Sam, I am Ana.")
    assert.strictEqual(yield* tip(), "Hi Sam, I am Ana.")
    assert.deepStrictEqual(yield* alternates(), ["Hi Sam, I am Ana."])
    const [summary] = yield* api.ListChatSummaries({ chatIds: [chatId] })
    assert.strictEqual(summary!.last!.text, "Hi Sam, I am Ana.")
    // The greeting's own branch (a write returns it) reads the same.
    const named = yield* api.NameFork({ forkId: fork.id, name: "Here" })
    assert.strictEqual(named.tipExcerpt, "Hi Sam, I am Ana.")
    // The persona and the greeter go to the bin: the chat still names them, so the lists do.
    yield* fixtureSql(config.dataDir, [
      { sql: "UPDATE entities SET deleted_at = 5 WHERE id IN (?, ?)", params: [sam.entityId, ana] }
    ])
    assert.strictEqual(yield* row(), "Hi Sam, I am Ana.")
    assert.strictEqual(yield* tip(), "Hi Sam, I am Ana.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(config)))
})

it.live("a group chat's greetings each name their own speaker", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const writer = yield* Writer
    const me = yield* api.Whoami()
    const make = (name: string, first_mes: string) =>
      writer.CreateEntity({
        userId: me.id,
        kind: "card",
        label: name,
        subtitle: "",
        doc: cardDoc(name, { first_mes }),
        schemaVersion: 1,
        origin: "user",
        sourcePath: null
      })
    const { entityId: ana } = yield* make("Ana", "Ana: {{char}} greets {{user}}.")
    const { entityId: bo } = yield* make("Bo", "Bo: {{char}} greets {{user}}.")
    const sam = yield* api.CreateCard({ label: "Sam", name: "Sam" })
    yield* api.SetPersona({ entityId: sam.entityId, persona: true })
    const started = yield* api.StartChat({
      cards: [ana, bo],
      persona: sam.entityId,
      greeting: 0,
      greeters: [
        { entityId: ana, greeting: 0 },
        { entityId: bo, greeting: 0 }
      ],
      first: { _tag: "Send", content: "Typed.", speakerEntityId: sam.entityId }
    })
    const chatId = started.chat.id
    const path = yield* api.ReadPath({ chatId, forkId: null, leafSlotId: null, range: { _tag: "Bottom" }, limit: 10 })
    const { fork } = yield* api.CreateFork({ chatId, fromForkId: null, atSlotId: path.entries[1]!.slotId })
    const tip = (yield* api.ListForks({ chatId })).find((f) => f.id === fork.id)!.tipExcerpt
    assert.strictEqual(tip, "Bo: Bo greets Sam.")
    const alternates = yield* api.ListBranches({ slotId: path.entries[0]!.slotId, forkId: null })
    assert.strictEqual(alternates[0]!.preview, "Ana: Ana greets Sam.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)

it.live("an ordinary fork a write returns keeps its text, a typed macro included", () =>
  Effect.gen(function* () {
    const api = yield* client()
    const card = yield* api.CreateCard({ label: "Ana", name: "Ana" })
    const started = yield* api.StartChat({
      cards: [card.entityId],
      persona: null,
      greeting: null,
      first: { _tag: "Send", content: "Typed {{user}}.", speakerEntityId: null }
    })
    const named = yield* api.NameFork({ forkId: started.chat.currentForkId!, name: "Plain" })
    assert.strictEqual(named.tipExcerpt, "Typed {{user}}.")
    const pinned = yield* api.PinFork({ forkId: named.id, pinned: true })
    assert.strictEqual(pinned.tipExcerpt, "Typed {{user}}.")
  }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig())))
)
