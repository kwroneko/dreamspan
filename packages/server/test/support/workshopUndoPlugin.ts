import { Effect } from "effect"
import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (_keys, _kinds, _settings, _profiles, undoers) =>
  undoers.register({
    id: "plugin.commit",
    run: () => Effect.succeed({ restoredCommit: "synthetic-revert", details: { files: 2 } })
  })
