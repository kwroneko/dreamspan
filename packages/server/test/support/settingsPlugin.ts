import { Schema } from "effect"
import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (_keys, _kinds, settings) =>
  settings.register({ id: "synthetic/setting", scope: "app", schema: Schema.Int.check(Schema.isGreaterThan(0)) })
