import * as costs from "./costs.tsx"
import * as snippets from "./snippets/index.tsx"
// The core features, each registering its routes and slot entries the way a plugin will.
import * as cardRename from "./cardRename/index.tsx"
import * as cardForks from "./cardForks/index.tsx"
import * as accounts from "./accounts.tsx"
import * as bin from "./bin/index.ts"
import * as characters from "./characters/index.ts"
import * as chat from "./chat/index.tsx"
import * as insertMessage from "./chat/insertMessage/index.tsx"
import * as connections from "./connections/index.ts"
import * as credentials from "./credentials.tsx"
import * as editor from "./editor/index.tsx"
import * as library from "./library/index.ts"
import * as login from "./login.tsx"
import * as network from "./network.tsx"
import * as notices from "./notices.tsx"
import * as completionSound from "./completionSoundFeature.tsx"
import * as shell from "./shell.tsx"
import * as status from "./status.tsx"

export const registerFeatures = () => {
  cardForks.register()
  cardRename.register()
  shell.register()
  login.register()
  characters.register()
  status.register()
  library.register()
  editor.register()
  chat.register()
  insertMessage.register()
  snippets.register()
  bin.register()
  connections.register()
  costs.register()
  credentials.register()
  network.register()
  accounts.register()
  notices.register()
  completionSound.register()
}
