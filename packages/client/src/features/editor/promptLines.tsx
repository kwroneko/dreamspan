// The lines between a prompt list's rows (owner, 2026-11-02: "Cached part starts/cached part
// ends ??? This is confusing"): where the chat goes, what's sent after it, and how much of the
// request each reply reuses, each with a "?" that says what it means for where a prompt goes.
// The request's cache points have four internal reasons; the user can act on only one
// difference between them: what stays reused when the chat's oldest messages drop out (the
// preset's part ahead of everything that moves) and what doesn't (the rest, down to the end of
// the history). So there are two reuse lines at most: the first kind, and the last of the
// other kinds, which covers every one above it.
import { SectionLine } from "../../ui/SectionLine.tsx"

export type Reuse = "every" | "until"
type Reason = "prefix" | "summary" | "history" | "pinned"

const REUSE_TITLE = "Reused between replies"

export function ReuseLine({ kind, alone }: { kind: Reuse; alone: boolean }) {
  return kind === "every" ? (
    <SectionLine
      data-reuse-line="every"
      tone="reuse"
      icon="history"
      label="Above this line: reused by every reply"
      title={REUSE_TITLE}
      explanation="The model's provider keeps what's above this line from one reply to the next and reuses it, so replies cost less and start sooner. It's reused only while it stays exactly the same: changing a prompt above this line makes the next reply send everything from that prompt down in full, once. Prompts that rarely change belong up here. Not every provider reuses text."
    />
  ) : (
    <SectionLine
      data-reuse-line="until"
      tone="reuse"
      icon="history"
      label="Above this line: reused until old messages drop out"
      title={REUSE_TITLE}
      explanation={`The next reply reuses what's above this line too, so it costs less and starts sooner. When the chat outgrows the context and its oldest messages drop out or are summarized, ${
        alone ? "everything above this line" : "what's between the two lines"
      } is sent again in full, once. Changing a prompt above this line does the same. Not every provider reuses text.`}
    />
  )
}

export const ChatStartsLine = () => (
  <SectionLine
    data-section="chat"
    icon="chat"
    label="The chat goes here"
    title="Where the chat goes"
    explanation="The chat's messages are sent here, oldest first, as many as fit. Prompts above this line come before the chat; notes set to a depth go inside it, that many messages before the newest one."
  />
)

export const AfterChatLine = () => (
  <SectionLine
    data-section="after-chat"
    icon="continue"
    label="After the chat: sent last"
    title="Sent after the chat"
    explanation="What's below this line comes after the chat's newest message, just before the model writes its reply, so it weighs most on the reply. It's sent in full with every reply, which makes this the place for text that changes often."
  />
)

/** Where a reuse line goes: after a block of the order, at the very start, or just before the chat. */
export const AT_START = "context_start"
export const BEFORE_CHAT = "~before-chat"

/**
 * The reuse lines to show for the request's cache points, by place. A point inside a part the
 * list has no row for (the new chat's opening line) shows just before the chat.
 */
export const placeReuseLines = (
  cacheAfter: ReadonlyArray<{ readonly identifier: string; readonly reason: Reason }>,
  order: ReadonlyArray<string>
): ReadonlyMap<string, Reuse> => {
  const history = order.indexOf("chatHistory")
  const placed = cacheAfter.flatMap((point) => {
    const at = order.indexOf(point.identifier)
    if (point.identifier === AT_START) return [{ ...point, place: AT_START, position: -1 }]
    if (at >= 0) return [{ ...point, place: point.identifier, position: at }]
    return history >= 0 ? [{ ...point, place: BEFORE_CHAT, position: history - 0.5 }] : []
  })
  const every = placed.find((p) => p.reason === "prefix")
  const until = placed
    .filter((p) => p.reason !== "prefix")
    .reduce<(typeof placed)[number] | undefined>(
      (last, p) => (last && last.position >= p.position ? last : p),
      undefined
    )
  const lines = new Map<string, Reuse>()
  if (every) lines.set(every.place, "every")
  if (until && (!every || until.position > every.position)) lines.set(until.place, "until")
  return lines
}

/** The same for a request's messages, by message index. */
export const reuseByMessage = (breakpoints: ReadonlyArray<Reason | undefined>): ReadonlyMap<number, Reuse> => {
  const every = breakpoints.indexOf("prefix")
  const until = breakpoints.findLastIndex((b) => b !== undefined && b !== "prefix")
  const lines = new Map<number, Reuse>()
  if (every >= 0) lines.set(every, "every")
  if (until >= 0 && until > every) lines.set(until, "until")
  return lines
}
