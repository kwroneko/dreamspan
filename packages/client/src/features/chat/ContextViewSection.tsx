// The request inspector's account of a separate context (spec/CHARACTER-CONTEXT.md §9.2 unit CU5;
// DESIGN §7.4): whose view the reply was written from, and each message left out because that
// character wasn't present for it, in the same row as "Not sent this turn". The gap lines that
// stand in for them are labelled among the messages ("Gap line: …"), and summaries withheld are
// in "Notes on this context". A `runInspectorSections` entry, so a plugin can replace it.
import type { RunContext } from "@rp/shared/inspectorApi.ts"
import { Link } from "@tanstack/react-router"
import { Tooltip } from "../../ui/Tooltip.tsx"

/** "Message 4 (Mira)" or, with no card named, "Message 4". */
const messageLabel = (number: number, speaker: string | null) =>
  speaker ? `Message ${number} (${speaker})` : `Message ${number}`

export function ContextViewSection({ run }: { run: RunContext }) {
  const view = run.separateContext
  if (!view) return null
  const who = view.viewer || "The speaker"
  if (view.narrator)
    return (
      <section aria-label="Whose context" className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Whose context</h2>
        <p className="text-sm text-muted">
          {who} is the narrator: this reply saw the whole chat, whoever was present for each message.
        </p>
      </section>
    )
  return (
    <section aria-label="Whose context" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Whose context</h2>
      <p className="text-sm text-muted">
        Separate contexts: written from {who}'s view.{" "}
        {view.leftOut.length === 0
          ? `${who} was present for every message it read.`
          : `Messages ${who} wasn't present for were left out, and a gap line stands in for each stretch of them.`}
      </p>
      {view.leftOut.length > 0 && (
        <ul aria-label={`Left out of ${who}'s context`} className="flex flex-col gap-2">
          {view.leftOut.map((message) => (
            <li
              key={message.slotId}
              className="flex items-start gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs"
            >
              <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-semibold tracking-wide text-muted uppercase">
                Not sent
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <Tooltip label="Opens this message in the chat.">
                  <Link
                    to="/chats/$chatId"
                    params={{ chatId: run.chatId }}
                    search={{ slot: message.slotId }}
                    className="font-medium break-words text-accent underline-offset-2 hover:underline"
                  >
                    {messageLabel(message.number, message.speaker)}
                  </Link>
                </Tooltip>
                <span className="text-muted">{who} wasn't present</span>
              </span>
            </li>
          ))}
          {view.more > 0 && (
            <li className="text-xs text-muted">
              And {view.more.toLocaleString()} more {who} wasn't present for.
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
