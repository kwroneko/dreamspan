// What a chat shows while its messages load: the shapes of messages where they will be, so
// nothing jumps when they arrive, and the composer already where it stays. Like `Loading`, a
// load that takes too long says so and offers to ask again.
import { useEffect, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Alert } from "../../ui/Surface.tsx"

const SLOW_MS = 15_000
/** Lines per placeholder message, alternating sides of the conversation. */
const SHAPES = [[92, 78, 40], [60], [88, 95, 82, 55], [45], [90, 70]] as const

export function SkeletonMessages({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [attempt])
  return (
    <div data-testid="messages-loading" className="chat-column flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4">
      <p role="status" className="sr-only">
        Loading the chat…
      </p>
      {slow && (
        <Alert
          tone="warning"
          title="This is taking longer than it should"
          actions={
            <Button
              variant="ghost"
              onClick={() => {
                setSlow(false)
                setAttempt((n) => n + 1)
                onRetry()
              }}
            >
              Try again
            </Button>
          }
        >
          <p>The server may be busy, or the connection dropped.</p>
        </Alert>
      )}
      <div aria-hidden="true" className="mt-auto flex flex-col gap-6">
        {SHAPES.map((lines, i) => (
          <div key={i} className="flex gap-3">
            <span className="size-12 shrink-0 animate-pulse rounded-md bg-surface-raised motion-reduce:animate-none" />
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <span className="h-3.5 w-28 animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
              {lines.map((width, j) => (
                <span
                  key={j}
                  style={{ width: `${width}%` }}
                  className="h-3 animate-pulse rounded bg-surface-raised motion-reduce:animate-none"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The chat as it looks while its code loads (the route's fallback, before ChatPage and its
 * header exist): the header's faces and title as placeholders, then the messages' shapes.
 */
export function ChatSkeleton({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex min-h-13 w-full shrink-0 items-center gap-3 border-b border-border px-2 py-1.5 sm:px-4">
        <span className="size-9 shrink-0 animate-pulse rounded-full bg-surface-raised motion-reduce:animate-none" />
        <span className="h-5 w-40 animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
      </div>
      <SkeletonMessages onRetry={onRetry} />
    </div>
  )
}
