// The core features, each registering its routes and slot entries the way a plugin will.
import * as accounts from "./accounts.tsx"
import * as connections from "./connections/index.ts"
import * as credentials from "./credentials.tsx"
import * as library from "./library/index.ts"
import * as login from "./login.tsx"
import * as network from "./network.tsx"
import * as shell from "./shell.tsx"
import * as status from "./status.tsx"

export const registerFeatures = () => {
  shell.register()
  login.register()
  status.register()
  library.register()
  connections.register()
  credentials.register()
  network.register()
  accounts.register()
}
