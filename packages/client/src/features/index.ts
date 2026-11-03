import * as costs from "./costs.tsx"
import * as clientVersion from "./clientVersion.tsx"
import * as snippets from "./snippets/index.tsx"
// The core features, each registering its routes and slot entries the way a plugin will.
import * as gallery from "./gallery/index.tsx"
import * as cardRename from "./cardRename/index.tsx"
import * as cardForks from "./cardForks/index.tsx"
import * as cardSources from "./cardSources/index.tsx"
import * as cardExport from "./cardExport/index.tsx"
import * as cardImport from "./cardImport/index.tsx"
import * as accounts from "./accounts.tsx"
import * as bin from "./bin/index.ts"
import * as characters from "./characters/index.ts"
import * as chat from "./chat/index.tsx"
import * as insertMessage from "./chat/insertMessage/index.tsx"
import * as connections from "./connections/index.ts"
import * as credentials from "./credentials.tsx"
import * as editor from "./editor/index.tsx"
import * as firstRun from "./firstRun/index.tsx"
import * as library from "./library/index.ts"
import * as login from "./login.tsx"
import * as network from "./network.tsx"
import * as pickers from "./pickers/index.tsx"
import * as regex from "./regex/index.tsx"
import * as notices from "./notices.tsx"
import * as completionSound from "./completionSoundFeature.tsx"
import * as settings from "./settings/index.tsx"
import * as shell from "./shell.tsx"
import * as status from "./status.tsx"

export const registerFeatures = () => {
  cardForks.register()
  cardRename.register()
  gallery.register()
  cardSources.register()
  cardExport.register()
  cardImport.register()
  shell.register()
  clientVersion.register()
  settings.register()
  login.register()
  characters.register()
  status.register()
  library.register()
  editor.register()
  chat.register()
  pickers.register()
  insertMessage.register()
  snippets.register()
  bin.register()
  connections.register()
  firstRun.register()
  costs.register()
  credentials.register()
  network.register()
  regex.register()
  accounts.register()
  notices.register()
  completionSound.register()
}
