import type { PathEntry } from "@rp/shared/chat.ts"
import { useSyncExternalStore } from "react"
import { SplitLink } from "./SplitChatSection.tsx"
import { useSplitChats } from "./splitChats.ts"
import type { ChatSession } from "./session.ts"

export function SplitChatDivider({
  entry,
  session,
  place
}: {
  entry: PathEntry
  session: ChatSession
  place: "above" | "below"
}) {
  const fork = useSyncExternalStore(session.subscribe, () => session.snapshot().forkId)
  const split = useSplitChats(session.id, fork)
  if (!split) return null
  const matches = (slot: string | null) => (place === "below" ? slot === entry.slotId : slot === null)
  const own = split.parent && matches(split.group.slotId)
  const children = split.children.filter((c) => matches(c.slotId))
  if (!own && children.length === 0) return null
  return (
    <div
      data-split-divider
      className="my-2 flex flex-col gap-1 border-t border-border pt-2 text-center text-xs text-muted"
    >
      {own && (
        <p>
          This chat was split from “
          <SplitLink group={split.parent!} hint={`Opens ${split.parent!.title}.`}>
            {split.parent!.title}
          </SplitLink>
          ” here
        </p>
      )}
      {children.map((child) => (
        <p key={child.id}>
          Split off from this chat here ·{" "}
          <SplitLink group={child} hint={`Opens ${child.title}.`}>
            {child.title}
          </SplitLink>
        </p>
      ))}
    </div>
  )
}
