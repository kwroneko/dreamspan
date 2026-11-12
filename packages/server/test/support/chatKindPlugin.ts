import { Effect } from "effect"
import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (_keys, kinds, _settings, profiles) =>
  Effect.gen(function* () {
    const stored = kinds.get("chats.kind")!
    yield* kinds.register({ ...stored, values: [...stored.values, "review/assistant"] })
    yield* profiles.register({ ...profiles.get("workshop")!, id: "review/assistant" })
  })
