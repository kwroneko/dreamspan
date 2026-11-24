// A greeting of a chat not made yet, as the saved chat shows a message: the portrait, the name,
// the text, and its card's alternates to step through (StartChatPage.tsx; a pending workshop's
// assistant, PendingWorkshop.tsx).
import type { CardForChat } from "@dreamspan/shared/chatSetupApi.ts"
import { Avatar } from "../../ui/Avatar.tsx"
import { Markdown } from "../../ui/Markdown.tsx"
import { IconButton } from "../../ui/Tooltip.tsx"
import { HtmlPreview } from "./htmlDisplay.tsx"

/**
 * One greeting of the chat not made yet, as the saved chat shows a message: the portrait, the
 * name, the text, and its card's alternates to step through at its end, as a message's versions.
 */
export function Greeting({
  card,
  index,
  onIndex,
  text,
  groupOnly,
  count
}: {
  card: CardForChat
  index: number
  onIndex: (index: number) => void
  /** The greeting shown, its macros expanded. */
  text: string
  groupOnly: boolean
  count: number
}) {
  const name = card.card.name
  return (
    <article
      aria-label={`Greeting from ${name}`}
      className="group flex gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:bg-surface-raised/40 max-sm:gap-2.5 max-sm:px-2.5"
    >
      <div className="flex shrink-0 flex-col items-center gap-1.5">
        <Avatar
          id={card.card.entityId}
          name={name}
          mediaId={card.card.avatarMediaId}
          crop={card.card.avatarCrop}
          size="chat"
          preview
          className="mt-0.5"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <header className="flex min-h-8 min-w-0 items-center gap-x-2 text-sm max-sm:flex-wrap max-sm:gap-y-1">
          <span
            data-layout-name
            className="min-w-0 font-semibold max-sm:w-full max-sm:[overflow-wrap:anywhere] sm:max-w-48 sm:shrink-0 sm:truncate"
          >
            {name}
          </span>
          {groupOnly && <span className="shrink-0 text-xs text-muted">group greeting</span>}
        </header>
        <HtmlPreview id={`greeting:${card.card.entityId}`} text={text}>
          <Markdown text={text} streaming={false} />
        </HtmlPreview>
        {count > 1 && (
          <footer className="flex min-h-8 items-center">
            <span className="flex-1" />
            <div className="flex shrink-0 items-center" role="group" aria-label={`${name}'s greetings`}>
              <IconButton
                label={`Previous greeting from ${name}`}
                hint="Shows their previous greeting: the chat starts with the one shown"
                icon="left"
                className="max-sm:size-7"
                disabled={index === 0}
                onClick={() => onIndex(index - 1)}
              />
              <span className="inline-flex h-8 min-w-9 items-center justify-center px-1 text-xs text-muted tabular-nums">
                {index + 1}/{count}
              </span>
              <IconButton
                label={`Next greeting from ${name}`}
                hint="Shows their next greeting: the chat starts with the one shown"
                icon="right"
                className="max-sm:size-7"
                disabled={index === count - 1}
                onClick={() => onIndex(index + 1)}
              />
            </div>
          </footer>
        )}
      </div>
    </article>
  )
}
