// What an import of `personaSwitchFolder` must leave in every chat file's fork: the user plays
// every persona who spoke, only the last one selected, and none is ever a character (DESIGN
// §2.2). Shared by importedPersonas.test.ts and its scale run.
import { assert } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import { Effect } from "effect"
import { Reader } from "../../src/db/Database.ts"
import type { client } from "./config.ts"
import { INN, KAREN, KIM, RHEE, type personaSwitchFolder } from "./stPersonaSwitches.ts"

type Api = Effect.Success<ReturnType<typeof client>>
type Folder = ReturnType<typeof personaSwitchFolder>

export const checkImportedPersonas = (api: Api, folder: Folder) =>
  Effect.gen(function* () {
    const shell = yield* api.GetShellCards()
    const names = new Map<string, string>(
      [...shell.cards, ...shell.personas].map((c) => [c.card.entityId as string, c.card.name])
    )
    const idOf = (name: string) => [...names].find(([, n]) => n === name)![0] as EntityId
    const personaIds = new Set([idOf(KIM.name), idOf(RHEE.name)])
    const user = yield* api.Whoami()
    const sources = yield* (yield* Reader).StImportSources({ userId: user.id })
    const records = new Map(sources.chats.map((r) => [r.source, r]))
    assert.strictEqual(records.size, folder.lastPersona.size)
    for (const [path, last] of folder.lastPersona) {
      const record = records.get(path)
      assert.isDefined(record, path)
      const read = yield* api.ReadPath({
        chatId: record.chatId,
        forkId: record.forkId,
        leafSlotId: null,
        range: { _tag: "Bottom" },
        limit: 100
      })
      // The cast at the fork's tip, as its chat shows it.
      const tip = read.entries.at(-1)!.slotId
      const cast = yield* api.GetCast({ chatId: record.chatId, slotId: tip, forkId: record.forkId })
      // Only the last persona is selected, and the cast holds the file's characters and it.
      assert.deepStrictEqual(cast.playedByMe, [idOf(last)], path)
      const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
      assert.sameMembers(
        characters.map((id) => names.get(id)),
        path.startsWith("chats/") ? [KAREN] : INN.members,
        path
      )
      for (const id of characters) assert.isFalse(personaIds.has(id), `${path}: a persona is a character`)
      assert.strictEqual(cast.macroNames.user, last, path)
      assert.notInclude(cast.macroNames.char, KIM.name, path)
      assert.notInclude(cast.macroNames.char, RHEE.name, path)
      // Every persona who spoke keeps its name for its messages.
      for (const name of folder.spoke.get(path)!)
        assert.isDefined(
          cast.cards.find((c) => c.entityId === idOf(name)),
          `${path}: ${name} names its messages`
        )
      // Their messages keep their speakers.
      for (const entry of read.entries)
        if (entry.version.writer === "human")
          assert.strictEqual(
            names.get(entry.version.speakerEntityId!),
            entry.version.content.split(" (")[0],
            `${path}: ${entry.version.content}`
          )
    }
    // A new chat of a group takes its characters only ("Kim has no greeting").
    const groups = yield* api.ListChatGroups()
    const inn = groups.find((g) => g.members.some((m) => m.name === INN.members[0]))
    assert.isDefined(inn)
    assert.sameMembers(
      inn.members.map((m) => m.name),
      INN.members
    )
    for (const group of groups) for (const m of group.members) assert.isFalse(personaIds.has(m.entityId))
    // The shell lists no persona among a fork's characters; both still count as used.
    const library = yield* api.GetShellLibrary()
    for (const fork of library.forks) for (const id of fork.cast) assert.isFalse(personaIds.has(id))
    for (const persona of shell.personas) assert.isAbove(persona.card.chats, 0, persona.card.name)
    assert.sameMembers(
      shell.personas.map((p) => p.card.name),
      [KIM.name, RHEE.name]
    )
    return { names, records }
  })
