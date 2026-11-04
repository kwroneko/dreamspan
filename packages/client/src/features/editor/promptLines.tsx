// Editor dividers retain every assembler breakpoint; the inspector retains its existing reuse projection.
import { SectionLine } from "../../ui/SectionLine.tsx"

export type Reuse = "every" | "until"
type Reason = import("@rp/shared/inspectorApi.ts").PresetContext["cacheAfter"][number]["reason"] | "end"

const REUSE_TITLE = "Reused between replies"

export function ReuseLine({ kind, alone }: { kind: Reuse; alone: boolean }) {
  return kind === "every" ? (
    <SectionLine
      data-reuse-line="every"
      tone="reuse"
      icon="history"
      label="Above this line: reused by every reply"
      title={REUSE_TITLE}
      explanation="Marks the stable cache prefix. Changing a prompt invalidates the cache from that prompt onward."
    />
  ) : (
    <SectionLine
      data-reuse-line="until"
      tone="reuse"
      icon="history"
      label="Above this line: reused until old messages drop out"
      title={REUSE_TITLE}
      explanation={`Marks the ${alone ? "cache prefix" : "cached history"}. Moving the history window invalidates this prefix.`}
    />
  )
}

export const AfterChatLine = () => (
  <SectionLine
    data-section="after-chat"
    icon="continue"
    label="After the chat: sent last"
    title="Sent after the chat"
    explanation="Marks prompts sent after the chat history. These prompts are outside the cached prefix."
  />
)

/** Where a reuse line goes: after a block of the order, at the very start, or just before the chat. */
export const AT_START = "context_start"
export const BEFORE_CHAT = "~before-chat"

/** Every assembler breakpoint, including several that project to the same editor row. */
export const placeReuseLines = (
  cacheAfter: ReadonlyArray<{ readonly identifier: string; readonly reason: Reason }>,
  order: ReadonlyArray<string>
): ReadonlyMap<string, ReadonlyArray<Reason>> => {
  const lines = new Map<string, Array<Reason>>()
  for (const point of cacheAfter) {
    const place =
      point.identifier === AT_START || order.includes(point.identifier) || point.identifier === "summaries"
        ? point.identifier
        : order.includes("chatHistory")
          ? BEFORE_CHAT
          : AT_START
    lines.set(place, [...(lines.get(place) ?? []), point.reason])
  }
  return lines
}

const CACHE_EXPLANATION =
  "Marks a prompt cache breakpoint. Editing a prompt above the breakpoint invalidates the cache from that prompt onward."

export function CacheBreakpointLine({ kind }: { kind: Reason }) {
  const qualifier = kind === "summary" ? "summaries" : kind === "pinned" ? "prefix" : kind
  return (
    <SectionLine
      data-cache-breakpoint={kind}
      tone="cache"
      icon="history"
      label={`Cache breakpoint · ${qualifier}`}
      title="Cache breakpoint"
      explanation={CACHE_EXPLANATION}
    />
  )
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
