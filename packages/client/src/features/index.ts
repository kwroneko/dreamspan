// The core features, each registering its routes and slot entries the way a plugin will.
import * as login from "./login.tsx"
import * as shell from "./shell.tsx"
import * as status from "./status.tsx"

export const registerFeatures = () => {
  for (const feature of [shell, login, status]) feature.register()
}
