import { Effect } from "effect"
import { EditRefused } from "@rp/shared/editorApi.ts"
import { cardNameClash } from "@rp/shared/cardNames.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import type { AppClient } from "../../rpc.ts"

/** Read directly at submission: another tab or an import may have changed the pair. */
export const checkCardNames = Effect.fnUntraced(function* (
  client: AppClient["Service"],
  name: string,
  version: string,
  current?: LibraryRef
) {
  const live = yield* client("ListLibrary", { kind: "card" })
  const archived = yield* client("ListLibrary", { kind: "card", archived: true })
  const clash = cardNameClash([...live, ...archived], name, version, current)
  if (clash) return yield* new EditRefused({ message: clash })
})
