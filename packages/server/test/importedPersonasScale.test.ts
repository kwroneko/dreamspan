// importedPersonas.test.ts at the owner's size: a one-to-one and a group chat of 2,000 messages each,
// with 60 and 200 branch files, the persona switching every 400 messages (stgap1's shape).
// Every file's fork keeps only its last persona selected and no persona among its characters;
// groups, the shell and persona usage say the same.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { client, serverLayer, testConfig } from "./support/config.ts"
import { checkImportedPersonas } from "./support/importedPersonas.ts"
import { personaSwitchFolder } from "./support/stPersonaSwitches.ts"
import { importStFolder } from "./support/stUpload.ts"

describe("personas of imported ST chats at scale", () => {
  it.live(
    "hundreds of branches of long chats keep every persona the user's",
    () =>
      Effect.gen(function* () {
        const folder = personaSwitchFolder({
          messages: 2_000,
          switchEvery: 400,
          singleBranches: 60,
          groupBranches: 200
        })
        const { answers } = yield* importStFolder(folder.files)
        assert.isFalse([...answers.values()].some((r) => r.outcome === "failed"))
        yield* checkImportedPersonas(yield* client(), folder)
      }).pipe(Effect.scoped, Effect.provide(serverLayer(testConfig()))),
    30 * 60_000
  )
})
