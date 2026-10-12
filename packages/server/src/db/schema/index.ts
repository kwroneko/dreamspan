import { accounts } from "./accounts.ts"
import { bin, binIndex } from "./bin.ts"
import { chats } from "./chats.ts"
import { credentials } from "./credentials.ts"
import { draftHistory } from "./drafts.ts"
import { graphIntegrity } from "./graphIntegrity.ts"
import { ownership } from "./ownership.ts"
import { history } from "./history.ts"
import { integrity } from "./integrity.ts"
import { library } from "./library.ts"
import { platform } from "./platform.ts"
import { providers } from "./providers.ts"
import { queue } from "./queue.ts"
import { search } from "./search.ts"

export const users = [
  `CREATE TABLE users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  ) STRICT`
]

// Tables first, then the triggers that refer across them.
export const dataModel = [...platform, ...library, ...chats, ...history, ...integrity, ...search]

export { accounts, bin, binIndex, credentials, draftHistory, graphIntegrity, ownership, providers, queue }
export { secretBindings } from "./credentials.ts"
