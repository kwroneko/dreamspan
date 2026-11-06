import type { InstallStateModule } from "../../src/db/stateModules.ts"

export const install: InstallStateModule = (_keys, kinds) => {
  const original = kinds.get("versions.origin")!
  return kinds.register({ ...original, values: [...original.values, "review/plugin"] })
}
