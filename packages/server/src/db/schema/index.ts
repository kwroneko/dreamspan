import { bin } from "./bin.ts"
import { chats } from "./chats.ts"
import { draftHistory } from "./drafts.ts"
import { history } from "./history.ts"
import { integrity } from "./integrity.ts"
import { library } from "./library.ts"
import { platform } from "./platform.ts"
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

export { bin, draftHistory }
