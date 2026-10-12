// A composer's text set up over RPC, as the client types it: the composer opened at a tip,
// then text saved onto the draft that names (composerDraft.ts).
import type { ChatId, SlotId } from "@rp/shared/chat.ts"
import type { Draft } from "@rp/shared/drafts.ts"
import { Effect } from "effect"
import type { Client } from "./rpc.ts"

export const typeInto = (api: Client, chatId: ChatId, tipSlotId: SlotId | null, content: string, onto?: Draft) =>
  Effect.gen(function* () {
    const draft = onto ?? (yield* api.OpenComposer({ chatId, tipSlotId }))
    const saved = yield* api.SaveComposer({
      chatId,
      draftId: draft.id,
      rowVersion: draft.rowVersion,
      session: draft.session,
      content
    })
    return saved.draft!
  })
