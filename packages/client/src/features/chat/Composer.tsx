// The composer: send as the user (a reply is generated after it), generate a reply,
// regenerate the last one, stop it. Its text is local state, so typing re-renders nothing
// else.
//
// Sending into a chat whose leaf is still generating is an open decision (DESIGN §2.2:
// queue or cancel?), so Send waits for it; everything else stays usable.
import { type KeyboardEvent, useState } from "react"
import type { AppError } from "../../errors.ts"
import { Button } from "../../ui/Button.tsx"
import type { ChatSession, ChatView, Outcome } from "./session.ts"

const coarsePointer = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches

export function Composer({ session, view }: { session: ChatSession; view: ChatView }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  // Only known when the window reaches the leaf; otherwise the server takes the message anyway.
  const leaf = view.newer === null ? view.entries.at(-1) : undefined
  const leafGenerating = leaf?.version.status === "generating"
  const report = (outcome: Outcome<unknown>) => setError(outcome.ok ? null : outcome.error)

  const send = async () => {
    if (text.trim() === "" || leafGenerating || sending) return
    setSending(true)
    const { sent, outcome } = await session.send(text)
    setSending(false)
    report(outcome)
    // A message that wasn't sent stays in the box; one that was goes, even if its reply failed.
    if (sent) setText("")
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    if (event.ctrlKey || event.metaKey || (!event.shiftKey && !coarsePointer())) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 border-t border-border pt-3 pb-3">
      <label htmlFor="composer" className="sr-only">
        Message
      </label>
      <textarea
        id="composer"
        data-testid="composer"
        rows={3}
        value={text}
        placeholder="Write a message…"
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 text-base text-text outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/40 sm:text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          pending={sending}
          disabled={text.trim() === "" || leafGenerating}
          title={leafGenerating ? "Waiting for the reply to finish" : undefined}
          onClick={send}
        >
          Send
        </Button>
        <Button disabled={leafGenerating} onClick={async () => report(await session.generate())}>
          Reply
        </Button>
        {leaf?.version.writer === "model" && (
          <Button variant="ghost" onClick={async () => report(await session.regenerate(leaf))}>
            Regenerate
          </Button>
        )}
        {leafGenerating && (
          <Button variant="secondary" onClick={async () => report(await session.stop(leaf.version.id))}>
            Stop
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error.message}
          </p>
        )}
      </div>
    </div>
  )
}
