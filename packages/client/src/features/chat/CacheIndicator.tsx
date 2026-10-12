// The cache-warmth indicator (DESIGN §5.5), near the composer: whether the provider's cache
// for this chat is likely still warm for the next reply. The server works the estimate out
// and pushes it; the countdown runs here from its TTL, and can be turned off.
import type { CacheWarmth } from "@rp/shared/inspectorApi.ts"
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Badge } from "../../ui/Surface.tsx"

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

export function CacheIndicator({ warmth }: { warmth: CacheWarmth | null }) {
  const [now, setNow] = useState(() => Date.now())
  const [countdown, setCountdown] = useState(countdownOn)
  const expiresAt = warmth === null ? 0 : warmth.expiresAt
  const warm = warmth !== null && warmth.changed === null && now < expiresAt
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
  if (warmth === null) return null

  const toggle = () => {
    setCountdown(!countdown)
    try {
      localStorage.setItem(COUNTDOWN_KEY, countdown ? "off" : "on")
    } catch {
      // The choice then lasts until the page is reloaded.
    }
  }
  const { changed } = warmth
  const detail = changed
    ? `${changed.reason} The next reply writes about ${changed.tokens.toLocaleString()} tokens to the cache again.`
    : !warm
      ? `More than ${duration((warmth.expiresAt - warmth.lastRequestAt) / 1000)} passed since the last request.`
      : warmth.verified
        ? "The provider reported using its cache on the last request."
        : "Assumed: the provider didn't report its cache on the last request."
  return (
    <section
      aria-label="Cache estimate"
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs text-muted"
    >
      <span aria-live="polite" className="flex flex-wrap items-center gap-2">
        <Badge tone={warm ? "success" : changed ? "warning" : "neutral"}>
          {warm ? "Cache warm" : "Cache cold"} (estimate)
        </Badge>
        <span>{detail}</span>
      </span>
      {warm && countdown && <span className="tabular-nums">{clock(expiresAt - now)} left</span>}
      {warm && (
        <Button variant="ghost" className="h-6 px-2 text-xs" onClick={toggle}>
          {countdown ? "Hide countdown" : "Show countdown"}
        </Button>
      )}
    </section>
  )
}
