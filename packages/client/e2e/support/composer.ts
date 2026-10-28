// A composer's text set up over RPC, as the client types it: the composer of a fork opened,
// then text saved onto the draft that names (composerDraft.ts).
import type { ChatId, ForkId } from "@rp/shared/chat.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import type { Client } from "./rpc.ts"

export const typeInto = (api: Client, chatId: ChatId, forkId: ForkId | null, content: string, onto?: Draft) =>
  Effect.gen(function* () {
    const draft = onto ?? (yield* api.OpenComposer({ chatId, forkId }))
    const saved = yield* api.SaveComposer({
      next: false,
      operationId: crypto.randomUUID(),
      chatId,
      draftId: draft.id,
      rowVersion: draft.rowVersion,
      session: draft.session,
      content
    })
    return saved.draft!
  })
