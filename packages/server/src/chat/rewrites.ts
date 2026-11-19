// Text as it's written goes through the regex scripts with neither flag (ARCHITECTURE §12,
// "Rewrites"): a reply as it finishes, a message as it's sent or edited. The scripts run in a
// reader worker, inside the bounded engine (`RewriteText`); the main thread only sends the text
// and stores what comes back, with the text as it was. If the rewrite itself can't run, the
// text is written as it is.
import type { ChatId, EntityId, ForkId, SlotId, VersionId } from "@dreamspan/shared/chat.ts"
import type { UserId } from "@dreamspan/shared/domain.ts"
import type { StoredRewrite } from "@dreamspan/shared/regexScripts.ts"
import type { ReplySections } from "@dreamspan/shared/replySections.ts"
import { type Context, Effect } from "effect"
import type { Reader } from "../db/Database.ts"

export interface Rewritten {
  readonly content: string
  readonly reasoning?: string
  readonly sections?: ReplySections
  /** Absent when no script changed or failed on anything. */
  readonly rewrite?: StoredRewrite
}

type Item = { readonly text: string; readonly kind: "message" | "reasoning" }

/**
 * The texts of a reply the scripts run on, in order: its body, the provider's reasoning, then
 * each reply section's text, which ST's placement 6 (reasoning) covers as it does parsed
 * reasoning (spec/REPLY-SECTIONS.md).
 */
export const rewriteItems = (
  content: string,
  reasoning: string | undefined,
  sections: ReplySections | null | undefined
): Array<Item> => [
  { text: content, kind: "message" },
  ...(reasoning ? [{ text: reasoning, kind: "reasoning" as const }] : []),
  ...(sections?.sections ?? []).map((section) => ({ text: section.text, kind: "reasoning" as const }))
]

/** The rewritten texts back in place: the reasoning, if there was any, then the sections. */
export const fromItems = <T extends { readonly text: string }>(
  results: ReadonlyArray<T | undefined>,
  content: string,
  reasoning: string | undefined,
  sections: ReplySections | null | undefined
) => {
  const at = reasoning ? 2 : 1
  return {
    content: results[0]?.text ?? content,
    reasoning: reasoning ? (results[1]?.text ?? reasoning) : reasoning,
    sections: sections
      ? {
          ...sections,
          sections: sections.sections.map((section, i) => ({ ...section, text: results[at + i]?.text ?? section.text }))
        }
      : sections
  }
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
    readonly sections?: ReplySections | null | undefined
  }
): Effect.Effect<Rewritten> => {
  const { content, reasoning, sections } = params
  const unchanged: Rewritten = {
    content,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(sections ? { sections } : {})
  }
  if (content === "" && !reasoning && !sections?.sections.length) return Effect.succeed(unchanged)
  // Suspended, so even a reader that can't take the call leaves the text as it is.
  return Effect.suspend(() =>
    reader.RewriteText({
      userId: params.userId,
      chatId: params.chatId,
      ...(params.forkId === undefined ? {} : { forkId: params.forkId }),
      at: params.at,
      edit: params.edit,
      items: rewriteItems(content, reasoning, sections)
    })
  ).pipe(
    Effect.map((results): Rewritten => {
      const applied = results.flatMap((result) => result.applied)
      const failed = results.flatMap((result) => result.failed)
      if (applied.length === 0 && failed.length === 0) return unchanged
      const next = fromItems(results, content, reasoning, sections)
      const sectionsChanged =
        !!sections && sections.sections.some((section, i) => next.sections!.sections[i]!.text !== section.text)
      return {
        content: next.content,
        ...(next.reasoning === undefined ? {} : { reasoning: next.reasoning }),
        ...(next.sections ? { sections: next.sections } : {}),
        rewrite: {
          applied,
          failed,
          raw: next.content === content ? null : content,
          rawReasoning: reasoning === undefined || next.reasoning === reasoning ? null : reasoning,
          ...(sectionsChanged ? { rawSections: sections } : {})
        }
      }
    }),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("rewriting text with the regex scripts failed; it's kept as it is", cause), unchanged)
    )
  )
}
