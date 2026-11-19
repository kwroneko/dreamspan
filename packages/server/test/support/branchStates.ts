// What an import must leave at the tip of every chat file's fork: the file's own variables,
// lorebook, author's note and persona, whatever its ancestors had where it leaves them
// (stBranchStates.ts), after a first import or a confirmed re-import that brings branch files
// new since. Shared by stBranchInheritedState.test.ts and its scale run.
import { assert } from "@effect/vitest"
import type { EntityId } from "@dreamspan/shared/chat.ts"
import { foldState } from "@dreamspan/shared/state.ts"
import { Effect } from "effect"
import { Reader } from "../../src/db/Database.ts"
import { client } from "./config.ts"
import { INN, KAREN, KIM, RHEE } from "./stPersonaSwitches.ts"
import type { FileState } from "./stBranchStates.ts"
import { importStFolder } from "./stUpload.ts"

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
        entry.kind === "lorebook"
          ? [
              [
                entry.refId as string,
                entry.sourcePath
                  .split("/")
                  .at(-1)!
                  .replace(/\.json$/, "")
              ]
            ]
          : []
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

/**
 * The folder without its nested leaf branch files (branches of branches no file branches
 * from), as a first import found it before ST gained them; `later`: those left out.
 */
const withoutNestedLeaves = (files: ReadonlyMap<string, Uint8Array>, states: ReadonlyMap<string, FileState>) => {
  const parents = new Set([...states.values()].flatMap((s) => (s.parent === null ? [] : [s.parent])))
  const later = new Set(
    [...states].flatMap(([path, s]) =>
      s.parent !== null && states.get(s.parent)?.parent != null && !parents.has(path) ? [path] : []
    )
  )
  return { first: new Map([...files].filter(([path]) => !later.has(path))), later: [...later] }
}

/**
 * Imports the folder without its nested leaf branch files, then the whole folder as a confirmed
 * re-import (checked first, then imported held to the check), and checks every file's state.
 */
export const checkReimportedBranchStates = (folder: {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly states: ReadonlyMap<string, FileState>
}) =>
  Effect.gen(function* () {
    const { first, later } = withoutNestedLeaves(folder.files, folder.states)
    const leaving = later.map((path) => folder.states.get(path)!)
    assert.isAbove(leaving.filter((s) => s.sharedPart).length, 0, "some new files leave in a shared part")
    assert.isAbove(leaving.filter((s) => !s.sharedPart).length, 0, "some in their parent's own part")
    const before = yield* importStFolder(first)
    assert.isFalse([...before.answers.values()].some((r) => r.outcome === "failed"))
    const { answers } = yield* importStFolder(folder.files, { checked: true })
    for (const path of later) assert.include(["added", "updated"], answers.get(path)?.outcome, path)
    assert.isFalse([...answers.values()].some((r) => r.outcome === "failed" || r.outcome === "skipped"))
    yield* checkBranchStates(yield* client(), folder.states)
    return leaving
  })
