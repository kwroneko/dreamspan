// A branch file's first import compares its state with what it inherits where it leaves its
// parent, not with the parent's state at the parent's end. A branch of a branch can leave in
// the part its parent shares with its own parent, where the parent's own state doesn't apply,
// and a parent can switch persona, lorebook, variables or note after the point a branch leaves
// it. Before, such a branch kept the grandparent's lorebook, variables and note when its own
// matched its parent's, and a persona the parent switched to later stayed in its cast as a
// character. Owner-shaped synthetic data at scale: stBranchInheritedStateScale.test.ts.
//
// A confirmed re-import (the check first, then the import held to it) that brings a branch
// file new since the first import does the same: its state is diffed where it leaves its
// parent, though the transaction that writes it computes the state before placing messages.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { checkBranchStates, checkReimportedBranchStates } from "./support/branchStates.ts"
import { branchStateFolder, type FileState, NOTES, WORLDS } from "./support/stBranchStates.ts"
import { card, encode, header, jsonl, message } from "./support/stFolder.ts"
import { png, worldInfo } from "./formats/support.ts"
import { importStFolder } from "./support/stUpload.ts"
import { KAREN, KIM, RHEE } from "./support/stPersonaSwitches.ts"

const say = (i: number, label: string, persona: typeof KIM | null) =>
  persona === null
    ? message({ name: KAREN, mes: `${KAREN} (${label}, ${i}) speaks.`, minute: i })
    : message({
        name: persona.name,
        user: true,
        mes: `${persona.name} (${label}, ${i}) answers.`,
        minute: i,
        persona: persona.avatar
      })
const lines = (from: number, count: number, label: string, persona: (i: number) => typeof KIM) =>
  Array.from({ length: count }, (_, k) => say(from + k, label, (from + k) % 2 === 1 ? persona(from + k) : null))
const meta = (world: string | null, note: string | null, mood: string, file: string) => ({
  variables: { mood, file },
  ...(world === null ? {} : { world_info: world }),
  ...(note === null ? {} : { note_prompt: note, note_position: 1, note_depth: 2, note_role: 0, note_interval: 1 })
})

/**
 * Main (Kim throughout, Amber, the first note); B leaves it at 10 and switches to Rhee at 20
 * (Basalt, the second note); C leaves B in B's own part, before the switch, with nothing of
 * its own; D leaves B in the part B shares with main, with B's state exactly.
 */
const handMade = () => {
  const main = lines(0, 20, "main", () => KIM)
  const b = [...main.slice(0, 10), ...lines(10, 30, "B", (i) => (i < 20 ? KIM : RHEE))]
  const c = [...b.slice(0, 16), ...lines(16, 6, "C", () => KIM)]
  const d = [...b.slice(0, 6), ...lines(6, 6, "D", () => KIM)]
  const MAIN = `${KAREN} - 2025-11-01@20h00m00s`
  const B = "Branch #9 - 2025-12-27@12h00m01s001ms"
  const at = (name: string) => `chats/${KAREN}/${name}.jsonl`
  const files = new Map<string, Uint8Array>([
    [
      "settings.json",
      encode({
        power_user: {
          personas: { [RHEE.avatar]: RHEE.name, [KIM.avatar]: KIM.name },
          persona_descriptions: {
            [RHEE.avatar]: { description: RHEE.description, position: 0 },
            [KIM.avatar]: { description: KIM.description, position: 0 }
          }
        }
      })
    ],
    [`User Avatars/${RHEE.avatar}`, png()],
    [`User Avatars/${KIM.avatar}`, png()],
    [`characters/${KAREN}.png`, card(KAREN, `${KAREN} says hello.`)],
    ...WORLDS.map(
      (world) =>
        [
          `worlds/${world}.json`,
          encode({ entries: { "3": { ...worldInfo().entries["3"], comment: world, content: `${world}'s entry.` } } })
        ] as const
    ),
    [at(MAIN), jsonl([header(meta(WORLDS[0], NOTES[0], "calm", "main")), ...main])],
    [at(B), jsonl([header({ ...meta(WORLDS[1], NOTES[1], "tense", "B"), main_chat: MAIN }), ...b])],
    [
      at("Branch #15 - 2025-12-27@12h00m02s002ms"),
      jsonl([header({ ...meta(null, null, "merry", "C"), main_chat: B }), ...c])
    ],
    [
      at("Branch #5 - 2025-12-27@12h00m03s003ms"),
      jsonl([header({ ...meta(WORLDS[1], NOTES[1], "tense", "B"), main_chat: B }), ...d])
    ]
  ])
  const state = (
    persona: string,
    spoke: ReadonlyArray<string>,
    world: string | null,
    note: string | null,
    vars: Record<string, string>,
    parent: string | null,
    forkAt: number,
    sharedPart: boolean
  ): FileState => ({
    persona,
    personasSpoke: new Set(spoke),
    world,
    note,
    vars,
    parent,
    forkAt,
    sharedPart
  })
  const states = new Map<string, FileState>([
    [at(MAIN), state(KIM.name, [KIM.name], WORLDS[0], NOTES[0], { mood: "calm", file: "main" }, null, 0, false)],
    [
      at(B),
      state(RHEE.name, [KIM.name, RHEE.name], WORLDS[1], NOTES[1], { mood: "tense", file: "B" }, at(MAIN), 10, false)
    ],
    [
      at("Branch #15 - 2025-12-27@12h00m02s002ms"),
      state(KIM.name, [KIM.name], null, null, { mood: "merry", file: "C" }, at(B), 16, false)
    ],
    [
      at("Branch #5 - 2025-12-27@12h00m03s003ms"),
      state(KIM.name, [KIM.name], WORLDS[1], NOTES[1], { mood: "tense", file: "B" }, at(B), 6, true)
    ]
  ])
  return { files, states }
}

describe("a branch file's inherited state", () => {
  it.live(
    "is what applies where it leaves its parent: a hand-made family",
    () =>
      Effect.gen(function* () {
        const folder = handMade()
        const { answers } = yield* importStFolder(folder.files)
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        yield* checkBranchStates(yield* client(), folder.states)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    180_000
  )

  it.live(
    "is what applies where it leaves its parent: branches of branches with their own state",
    () =>
      Effect.gen(function* () {
        const folder = branchStateFolder({ messages: 400, switchEvery: 100, singleBranches: 15, groupBranches: 25 })
        const nested = [...folder.states.values()].filter((s) => s.parent !== null && !s.parent.endsWith("00s.jsonl"))
        assert.isAbove(nested.filter((s) => s.sharedPart).length, 0, "some leave in a shared part")
        assert.isAbove(nested.filter((s) => !s.sharedPart).length, 0, "some leave in their parent's own part")
        const { answers } = yield* importStFolder(folder.files)
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        yield* checkBranchStates(yield* client(), folder.states)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    600_000
  )

  it.live(
    "is what applies where it leaves its parent: a hand-made family's files new at a confirmed re-import",
    () => checkReimportedBranchStates(handMade()).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    180_000
  )

  it.live(
    "is what applies where it leaves its parent: generated branch files new at a confirmed re-import",
    () =>
      checkReimportedBranchStates(
        branchStateFolder({ messages: 400, switchEvery: 100, singleBranches: 15, groupBranches: 25 })
      ).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    600_000
  )
})
