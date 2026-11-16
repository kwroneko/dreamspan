// What an import must leave at the tip of every chat file's fork: the file's own variables,
// lorebook, author's note and persona, whatever its ancestors had where it leaves them
// (stBranchStates.ts). Shared by stBranchInheritedState.test.ts and its scale run.
import { assert } from "@effect/vitest"
import type { EntityId } from "@rp/shared/chat.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { Reader } from "../../src/db/Database.ts"
import type { client } from "./config.ts"
import { INN, KAREN, KIM, RHEE } from "./stPersonaSwitches.ts"
import type { FileState } from "./stBranchStates.ts"

type Api = Effect.Success<ReturnType<typeof client>>

export const checkBranchStates = (api: Api, states: ReadonlyMap<string, FileState>) =>
  Effect.gen(function* () {
    const reader = yield* Reader
    const shell = yield* api.GetShellCards()
    const names = new Map<string, string>(
      [...shell.cards, ...shell.personas].map((c) => [c.card.entityId as string, c.card.name])
    )
    const idOf = (name: string) => [...names].find(([, n]) => n === name)![0] as EntityId
    const personaIds = new Set([idOf(KIM.name), idOf(RHEE.name)])
    const user = yield* api.Whoami()
    const sources = yield* reader.StImportSources({ userId: user.id })
    const books = new Map(
      sources.library.flatMap((entry) =>
        entry.kind === "lorebook" ? [[entry.refId as string, entry.sourcePath.split("/").at(-1)!.replace(/\.json$/, "")]] : []
      )
    )
    const records = new Map(sources.chats.map((r) => [r.source, r]))
    assert.strictEqual(records.size, states.size)
    for (const [path, expected] of states) {
      const record = records.get(path)
      assert.isDefined(record, path)
      const { chatId, forkId } = record
      const read = yield* api.ReadPath({ chatId, forkId, leafSlotId: null, range: { _tag: "Bottom" }, limit: 1 })
      const tip = read.entries.at(-1)!.slotId
      const state = foldState(yield* reader.StateEventsAt({ userId: user.id, chatId, slotId: tip, forkId }))
      const where = `${path} (${expected.parent === null ? "main" : `from ${expected.parent} at ${expected.forkAt}${expected.sharedPart ? ", in its shared part" : ""}`})`
      assert.deepStrictEqual(
        { mood: state.vars["mood"], file: state.vars["file"] },
        { mood: expected.vars["mood"], file: expected.vars["file"] },
        `${where}: variables`
      )
      assert.deepStrictEqual(
        state.lorebooks.map((ref) => books.get(ref)),
        expected.world === null ? [] : [expected.world],
        `${where}: lorebooks`
      )
      const notes = yield* api.ListChatNotes({ chatId, forkId, slotId: tip })
      assert.deepStrictEqual(
        notes.filter((n) => n.card === null && n.active).map((n) => n.doc["content"]),
        expected.note === null ? [] : [expected.note],
        `${where}: author's note`
      )
      const cast = yield* api.GetCast({ chatId, slotId: tip, forkId })
      assert.deepStrictEqual(cast.playedByMe, [idOf(expected.persona)], `${where}: persona`)
      const characters = cast.participants.filter((id) => !cast.playedByMe.includes(id))
      assert.sameMembers(
        characters.map((id) => names.get(id)),
        path.startsWith("chats/") ? [KAREN] : INN.members,
        `${where}: characters`
      )
      for (const id of characters) assert.isFalse(personaIds.has(id), `${where}: a persona is a character`)
    }
  })
