// Text as it's written goes through the regex scripts with neither flag (ARCHITECTURE §12,
// "Rewrites"): a reply as it finishes, a message as it's sent or edited. The scripts run in a
// reader worker, inside the bounded engine (`RewriteText`); the main thread only sends the text
// and stores what comes back, with the text as it was. If the rewrite itself can't run, the
// text is written as it is.
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@rp/shared/chat.ts"
import type { UserId } from "@rp/shared/domain.ts"
import type { StoredRewrite } from "@rp/shared/regexScripts.ts"
import { type Context, Effect } from "effect"
import type { Reader } from "../db/Database.ts"

export interface Rewritten {
  readonly content: string
  readonly reasoning?: string
  /** Absent when no script changed or failed on anything. */
  readonly rewrite?: StoredRewrite
}

export const rewriteText = (
  reader: Context.Service.Shape<typeof Reader>,
  params: {
    readonly userId: UserId
    readonly chatId: ChatId
    readonly forkId?: ForkId | null | undefined
    readonly at:
      | { readonly slotId: SlotId; readonly versionId: VersionId }
      | { readonly leafSlotId: SlotId | null; readonly speakerEntityId: EntityId | null }
    readonly edit: boolean
    readonly content: string
    readonly reasoning?: string | undefined
  }
): Effect.Effect<Rewritten> => {
  const { content, reasoning } = params
  const unchanged: Rewritten = { content, ...(reasoning === undefined ? {} : { reasoning }) }
  if (content === "" && !reasoning) return Effect.succeed(unchanged)
  return reader
    .RewriteText({
      userId: params.userId,
      chatId: params.chatId,
      ...(params.forkId === undefined ? {} : { forkId: params.forkId }),
      at: params.at,
      edit: params.edit,
      items: [
        { text: content, kind: "message" as const },
        ...(reasoning ? [{ text: reasoning, kind: "reasoning" as const }] : [])
      ]
    })
    .pipe(
      Effect.map(([text, thought]): Rewritten => {
        const applied = [...(text?.applied ?? []), ...(thought?.applied ?? [])]
        const failed = [...(text?.failed ?? []), ...(thought?.failed ?? [])]
        const nextContent = text?.text ?? content
        const nextReasoning = thought?.text ?? reasoning
        if (applied.length === 0 && failed.length === 0) return unchanged
        return {
          content: nextContent,
          ...(nextReasoning === undefined ? {} : { reasoning: nextReasoning }),
          rewrite: {
            applied,
            failed,
            raw: nextContent === content ? null : content,
            rawReasoning: reasoning === undefined || nextReasoning === reasoning ? null : reasoning
          }
        }
      }),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("rewriting text with the regex scripts failed; it's kept as it is", cause),
          unchanged
        )
      )
    )
}
