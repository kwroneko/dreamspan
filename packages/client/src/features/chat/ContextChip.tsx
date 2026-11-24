// The context chip in the next-reply strip: how big the next request is against the context the
// model's settings allow ("24k / 128k"), its popover the parts it's made of and how many of the
// chat's messages fit, and View request, which opens the request as an inspector tab
// (`/request/next`, NextRequestPage.tsx). The server works the size out with each pushed
// estimate, from the request view the tab shows (`NextContext.size`, `GetNextRequest`), counted
// locally: nothing is sent. What's typed is added once typing pauses (`restedText.ts`), so
// keystrokes neither render this chip nor count anything. A chat not sent yet's chip
// (draftRequest.tsx) shows the same popover for its first request.
import type { ChatId } from "@dreamspan/shared/chat.ts"
import type { TokenizerInfo } from "@dreamspan/shared/generation.ts"
import { useNavigate } from "@tanstack/react-router"
import { memo, useEffect, useState, useSyncExternalStore } from "react"
import { Button, LinkButton } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { type CountModel, tokenizerText, useTokenCounts } from "../editor/tokenCounts.ts"
import { useWorkbenchTab } from "../workbench/tab.tsx"
import { compactTokens } from "./CacheIndicator.tsx"
import { nextRequestHref, nextRequests } from "./nextRequest.ts"
import { chipClass } from "./nextReplyStrip.tsx"
import type { RestedText } from "./restedText.ts"
import type { ChatView } from "./session.ts"

/** "24k / 128k": the request's size, then the context size the model's settings allow. */
export const contextText = (tokens: number, maximum: number | null) =>
  maximum === null ? `~${compactTokens(tokens)}` : `${compactTokens(tokens)} / ${compactTokens(maximum)}`

/** What the typed text is in the request: a message, or guidance for the reply. */
const typedLabel = (guidance: boolean) => (guidance ? "Guidance you're typing" : "Your message")

/** Memoized: the strip renders on every keystroke, and none of this chip's props change with one. */
export const ContextChip = memo(function ContextChip({
  view,
  typed,
  guidance,
  editingGuidance
}: {
  view: ChatView
  typed: RestedText
  guidance: boolean
  editingGuidance: boolean
}) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const workbenchTab = useWorkbenchTab()
  const rested = useSyncExternalStore(typed.subscribe, typed.snapshot)
  // While a reply's guidance is edited the box makes a new version of it, not the next request.
  const text = editingGuidance ? "" : rested.trim()
  const model = view.history?.model
  const choice = model
    ? { connection: model.connection as CountModel["connection"], model: model.model as CountModel["model"] }
    : undefined
  const counted = useTokenCounts([choice ? text : ""], choice, true)
  const size = view.history?.size
  const budget = view.history?.budget ?? null
  const chatId = (view.chat?.id ?? null) as ChatId | null
  // Where this view stands, for the next request's tab (nextRequest.ts).
  const [token] = useState(() => Symbol("next request"))
  useEffect(() => {
    if (chatId === null || view.contextRevision === 0) nextRequests.withdraw(token)
    else
      nextRequests.publish(token, chatId, {
        leaf: view.leafSlotId,
        fork: view.forkId,
        revision: view.contextRevision
      })
  }, [token, chatId, view.leafSlotId, view.forkId, view.contextRevision])
  useEffect(() => () => nextRequests.withdraw(token), [token])
  if (view.loading || size === undefined || chatId === null) return null
  // The typed text as the request would hold it: its tokens, and 3 for its message.
  const typedTokens = text === "" ? 0 : (counted.counts[0] ?? Math.ceil(text.length / 4)) + 3
  const tokens = size.tokens + typedTokens
  const maximum = budget?.maximum ?? null
  const reserve = budget?.responseReserve ?? 0
  const over = maximum !== null && tokens + reserve > maximum
  const parts = [
    ...size.parts,
    ...(typedTokens > 0 ? [{ id: "typed", label: typedLabel(guidance), tokens: typedTokens }] : [])
  ]
  const href = nextRequestHref(chatId, view.leafSlotId, view.forkId)
  return (
    <ContextPopover
      open={open}
      onOpenChange={setOpen}
      request="next"
      tokens={tokens}
      maximum={maximum}
      reserve={reserve}
      tone={over ? "warning" : "neutral"}
      parts={parts}
      messages={size.messages}
      tokenizer={size.tokenizer}
      requestHref={href}
      // As a reply's request inspector opens: the chat's tab is kept, the request opens beside it.
      onViewRequest={() => {
        if (workbenchTab) workbenchTab.store.pin(workbenchTab.tabId)
        void navigate({ href })
      }}
    />
  )
})

/**
 * The context chip and its popover, for a chat's next request and a chat not sent yet's first
 * alike: the size against the model's context, the parts, the messages that fit, the counting,
 * and View request.
 */
export function ContextPopover({
  open,
  onOpenChange,
  request,
  tokens,
  maximum,
  reserve,
  tone = "neutral",
  loading = false,
  parts,
  messages,
  tokenizer,
  onViewRequest,
  requestHref
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  request: "next" | "first"
  tokens: number
  maximum: number | null
  reserve: number
  tone?: "neutral" | "warning"
  loading?: boolean
  parts: ReadonlyArray<{ readonly id: string; readonly label: string; readonly tokens: number }>
  messages: { readonly sent: number; readonly total: number } | null
  tokenizer: TokenizerInfo | undefined
  /** Opens the request in its inspector tab. */
  onViewRequest: () => void
  /** That tab's URL, for the link's open menu and a middle click; a button without one. */
  requestHref?: string
}) {
  const viewHint = `Opens your ${request} request as it would be sent, message by message. Nothing is sent.`
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      trigger={<span className={`tabular-nums ${loading ? "opacity-60" : ""}`}>{contextText(tokens, maximum)}</span>}
      triggerLabel={`Context: about ${tokens.toLocaleString()}${maximum === null ? "" : ` of ${maximum.toLocaleString()}`} tokens in your ${request} request. Details`}
      hint={
        tone === "warning"
          ? "Your message makes the request bigger than the model's context allows: older messages will be left out. Details"
          : `How big your ${request} request is, and what it's made of`
      }
      triggerClassName={chipClass(tone)}
      title="Context"
    >
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
        <p>
          About {tokens.toLocaleString()} tokens
          {maximum === null ? "" : ` of the ${maximum.toLocaleString()} this model's context allows`}
          {reserve > 0 ? `; ${reserve.toLocaleString()} are kept for the reply` : ""}.
        </p>
        {parts.length > 0 && (
          <ul aria-label="Parts of the request" className="flex flex-col">
            {parts.map((part) => (
              <li key={part.id} className="flex justify-between gap-4">
                <span>{part.label}</span>
                <span className="text-muted tabular-nums">{part.tokens.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        {messages !== null && messages.total > 0 && (
          <p className="text-muted">
            {messages.sent === messages.total
              ? `All ${messages.total.toLocaleString()} messages fit.`
              : `${messages.sent.toLocaleString()} of ${messages.total.toLocaleString()} messages are sent; the others are summarized, hidden or don't fit.`}
          </p>
        )}
        <p className="text-xs text-muted">
          {tokenizer ? tokenizerText(tokenizer) : "An estimate."} Counted here: nothing is sent until you send. Random
          choices, the current time and automatic decisions can change it when you send.
        </p>
      </div>
      {/* Outside the part that scrolls, so it always shows within the popover's padding. */}
      {requestHref === undefined ? (
        <Button
          className="shrink-0 self-start"
          hint={viewHint}
          onClick={() => {
            onOpenChange(false)
            onViewRequest()
          }}
        >
          View request
        </Button>
      ) : (
        <LinkButton
          className="shrink-0 self-start"
          href={requestHref}
          hint={viewHint}
          onOpen={() => {
            onOpenChange(false)
            onViewRequest()
          }}
        >
          View request
        </LinkButton>
      )}
    </Popover>
  )
}
