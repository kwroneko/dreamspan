import { Effect } from "effect"
import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (_keys, kinds, _settings, _profiles, undoers) =>
  Effect.gen(function* () {
    const stored = kinds.get("rollout_effects.kind")!
    yield* kinds.register({ ...stored, values: [...stored.values, "review.commit"] })
    yield* undoers.register({
      id: "review.commit",
      run: () => Effect.succeed({ restoredCommit: "synthetic-revert", details: { files: 2 } })
    })
  })
