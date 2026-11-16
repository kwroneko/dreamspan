// stBranchInheritedState.test.ts at the owner's size: a one-to-one and a group chat of 2,000
// messages each, with 60 and 240 branch files, about 30% of them branches of branches, each
// file with its own variables, lorebook, author's note and persona. Every file's fork shows
// its own at its tip, wherever it leaves its parent.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { checkBranchStates } from "./support/branchStates.ts"
import { branchStateFolder } from "./support/stBranchStates.ts"
import { importStFolder } from "./support/stUpload.ts"

describe("a branch file's inherited state at scale", () => {
  it.live(
    "hundreds of branches of long chats each show their own state",
    () =>
      Effect.gen(function* () {
        const folder = branchStateFolder({ messages: 2_000, switchEvery: 400, singleBranches: 60, groupBranches: 240 })
        const branches = [...folder.states.values()].filter((s) => s.parent !== null)
        const nested = branches.filter((s) => !s.parent!.endsWith("00s.jsonl"))
        assert.isAbove(nested.length / branches.length, 0.2)
        assert.isAbove(nested.filter((s) => s.sharedPart).length, 10)
        const { answers } = yield* importStFolder(folder.files)
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        yield* checkBranchStates(yield* client(), folder.states)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    40 * 60_000
  )
})
