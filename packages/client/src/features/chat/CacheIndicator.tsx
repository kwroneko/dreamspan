// The cache chip in the next-reply strip (DESIGN §5.5): whether the next reply reads the chat's
// prefix from the provider's cache, as one compact chip whose popover says why in plain words.
// The server works the estimate out and pushes it; the countdown runs here from its TTL, and can
// be turned off. A changed prefix shows whatever the TTL (DESIGN: even with none known); nothing
// shows when what would be re-sent rounds to 0. Other parts of the chat add notes about what a
// pending change will cost (`cacheNotes`: the insertion editor's re-read), shown in its popover.
import type { CacheWarmth } from "@rp/shared/inspectorApi.ts"
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Button } from "../../ui/Button.tsx"
import { Popover } from "../../ui/Popover.tsx"
import { chipClass } from "./nextReplyStrip.tsx"
import type { ChatSession, ChatView } from "./session.ts"

const COUNTDOWN_KEY = "rp.cacheCountdown"

const countdownOn = () => {
  try {
    return localStorage.getItem(COUNTDOWN_KEY) !== "off"
  } catch {
    return true
  }
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

const duration = (seconds: number) =>
  seconds % 3600 === 0
    ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`
    : seconds % 60 === 0
      ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
      : `${seconds} seconds`

/** "2.9k", "12k", "340"; "0" for what isn't worth a chip. */
export const compactTokens = (tokens: number) =>
  tokens >= 9_950
    ? `${Math.round(tokens / 1000)}k`
    : tokens >= 950
      ? `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
      : `${Math.round(tokens / 10) * 10}`

/** A note about the next reply's cache from a change still being made (an insertion, say). */
interface CacheNote {
  /** The chip's text when nothing else shows one. */
  readonly short: string
  readonly text: string
}

class CacheNotes {
  private notes = new Map<string, CacheNote>()
  private shown: ReadonlyArray<CacheNote> = []
  private readonly listeners = new Set<() => void>()
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  readonly snapshot = () => this.shown
  /** Sets the note under `key`; null removes it. */
  set(key: string, note: CacheNote | null) {
    const before = this.notes.get(key)
    if (note === null ? before === undefined : before?.text === note.text && before.short === note.short) return
    this.notes = new Map(this.notes)
    if (note === null) this.notes.delete(key)
    else this.notes.set(key, note)
    this.shown = [...this.notes.values()]
    for (const listener of this.listeners) listener()
  }
}

const notesBySession = new WeakMap<ChatSession, CacheNotes>()

/** The cache notes of a chat's session, which the chip shows in its popover. */
export const cacheNotes = (session: ChatSession) => {
  let notes = notesBySession.get(session)
  if (notes === undefined) {
    notes = new CacheNotes()
    notesBySession.set(session, notes)
  }
  return notes
}

type Shown =
  | { readonly kind: "uncached"; readonly tokens: number; readonly why: string }
  | { readonly kind: "warm"; readonly verified: boolean }
  | null

/** What the chip shows for an estimate as of `now`. */
export const cacheState = (warmth: CacheWarmth | null, now: number): Shown => {
  if (warmth === null) return null
  const timed = warmth.ttlS != null && warmth.expiresAt !== null
  if (warmth.changed !== null)
    return compactTokens(warmth.changed.tokens) === "0"
      ? null
      : { kind: "uncached", tokens: warmth.changed.tokens, why: warmth.changed.reason }
  if (!timed) return null
  if (now < warmth.expiresAt!) return { kind: "warm", verified: warmth.verified }
  return compactTokens(warmth.prefixTokens) === "0"
    ? null
    : {
        kind: "uncached",
        tokens: warmth.prefixTokens,
        why: `More than ${duration((warmth.expiresAt! - warmth.lastRequestAt) / 1000)} passed since the last request, so the provider's cache has expired.`
      }
}

/** How long the chip waits after a reply for the estimate that follows it (one that fails never comes). */
const AFTER_REPLY_MS = 30_000

/**
 * Whether the estimate shown predates a reply in the chat: from the reply's start until the first
 * estimate after it ends. The server works none out while a reply is written (CacheWarmth.hold),
 * so the last one would otherwise read as current.
 */
const useBeforeReply = (session: ChatSession, replying: boolean) => {
  const [waiting, setWaiting] = useState(replying)
  if (replying && !waiting) setWaiting(true)
  const replyingNow = useRef(replying)
  useEffect(() => {
    replyingNow.current = replying
  }, [replying])
  useEffect(
    () =>
      session.subscribeContext(() => {
        if (!replyingNow.current) setWaiting(false)
      }),
    [session]
  )
  useEffect(() => {
    if (replying || !waiting) return
    const timer = setTimeout(() => setWaiting(false), AFTER_REPLY_MS)
    return () => clearTimeout(timer)
  }, [replying, waiting])
  return waiting
}

export function CacheChip({ session, view }: { session: ChatSession; view: ChatView }) {
  const warmth = view.cache
  const waiting = useBeforeReply(
    session,
    view.entries.some((entry) => entry.version.status === "generating")
  )
  const notes = useSyncExternalStore(cacheNotes(session).subscribe, cacheNotes(session).snapshot)
  const [now, setNow] = useState(() => Date.now())
  const [countdown, setCountdown] = useState(countdownOn)
  const [open, setOpen] = useState(false)
  const shown = cacheState(warmth, now)
  const warm = !waiting && shown?.kind === "warm"
  const expiresAt = warmth?.expiresAt ?? 0
  // Ticks every second while counting down, otherwise once, when the cache expires.
  useEffect(() => {
    if (!warm) return
    if (countdown) {
      const timer = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(timer)
    }
    const timer = setTimeout(() => setNow(Date.now()), expiresAt - Date.now())
    return () => clearTimeout(timer)
  }, [warm, countdown, expiresAt])
  if (view.loading || (shown === null && notes.length === 0)) return null
  if (waiting)
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger={<span>Cache after reply</span>}
        triggerLabel="Cache: worked out again when this reply ends. Details"
        hint="Whether your next reply can read this chat from the provider's cache, at a lower price: known once this reply ends"
        triggerClassName={chipClass("neutral")}
        title="Cache"
      >
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
          <p>
            The request being sent now changes what your next reply can read from the provider's cache, so the estimate
            is worked out again when this reply ends.
          </p>
          <p className="text-xs text-muted">An estimate.</p>
        </div>
      </Popover>
    )

  const toggle = () => {
    setCountdown(!countdown)
    try {
      localStorage.setItem(COUNTDOWN_KEY, countdown ? "off" : "on")
    } catch {
      // The choice then lasts until the page is reloaded.
    }
  }
  const left = warm && countdown ? clock(expiresAt - now) : null
  const text =
    shown?.kind === "uncached"
      ? `↻ ${compactTokens(shown.tokens)} uncached`
      : warm
        ? `Cache warm${left ? ` ${left}` : ""}`
        : `↻ ${notes[0]!.short}`
  const label =
    shown?.kind === "uncached"
      ? `Cache: ${shown.tokens.toLocaleString()} tokens uncached on the next reply. Why`
      : warm
        ? `Cache warm${left ? `, ${left} left` : ""}. Details`
        : `Cache: ${notes[0]!.text}`
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={<span className="tabular-nums">{text}</span>}
      triggerLabel={label}
      hint={
        shown?.kind === "uncached"
          ? "Part of your next reply's request is re-sent at full price instead of read from the provider's cache. Why"
          : warm
            ? "Your next reply should read this chat from the provider's cache, at a lower price. Details"
            : "What your next reply can read from the provider's cache. Details"
      }
      triggerClassName={chipClass(shown?.kind === "uncached" ? "warning" : warm ? "success" : "neutral")}
      title={shown?.kind === "uncached" ? "Not cached" : warm ? "Cache warm" : "Cache"}
    >
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
        {shown?.kind === "uncached" && (
          <>
            <p>
              Your next reply re-sends about {shown.tokens.toLocaleString()} tokens at full price, instead of reading
              them from the provider's cache.
            </p>
            <p className="text-muted">Why: {shown.why}</p>
          </>
        )}
        {shown?.kind === "warm" && (
          <>
            <p>
              Your next reply should read this chat from the provider's cache
              {left ? ` if it's sent in the next ${left}` : ""}.
            </p>
            <p className="text-muted">
              {shown.verified
                ? "The provider reported using its cache on the last request."
                : "Assumed: the provider didn't report its cache on the last request."}
            </p>
            <Button
              variant="ghost"
              className="h-7 self-start px-2 text-xs"
              hint={
                countdown
                  ? "The chip stops showing the time left"
                  : "The chip shows the time left before the cache expires"
              }
              onClick={toggle}
            >
              {countdown ? "Hide countdown" : "Show countdown"}
            </Button>
          </>
        )}
        {notes.map((note) => (
          <p key={note.text}>{note.text}</p>
        ))}
        <p className="text-xs text-muted">An estimate.</p>
      </div>
    </Popover>
  )
}
