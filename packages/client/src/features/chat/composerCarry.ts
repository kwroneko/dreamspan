// A durable handoff of text typed while StartChat was on its way. It stays in the
// browser until the new chat's composer replaces it with a draft-addressed copy.
import type { Draft } from "@rp/shared/drafts.ts"
import { type Copy, makeCopy } from "../editor/backup.ts"

export const composerCarryCopy = (
  userId: string,
  chatId: string,
  entityId: string,
  name: string,
  content: string,
  previous: Copy | null,
  composer: Draft
): Copy =>
  makeCopy(
    userId,
    `composer-handoff:${chatId}`,
    "next message",
    {
      kind: "pendingChat",
      payload: {
        entityId,
        name,
        chatId,
        content,
        composerBase: { draftId: composer.id, rowVersion: composer.rowVersion, session: composer.session }
      }
    },
    Date.now(),
    previous === null ? [] : [previous]
  )
