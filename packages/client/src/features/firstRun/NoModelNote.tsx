// In the composer when neither the chat nor the account names a model: the send would
// fail, so say so and offer the choice right there.
import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Popover } from "../../ui/Popover.tsx"
import type { ChatView } from "../chat/session.ts"
import { generationDefaultsAtom } from "../connections/data.ts"
import { parseModelValue, useModelChoices } from "../chat/modelChoices.ts"

const link = "font-medium text-accent underline-offset-4 hover:underline"

function ChooseModel() {
  const [open, setOpen] = useState(false)
  const models = useModelChoices(open)
  const action = useAction()
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="Choose"
      triggerLabel="Choose a model for all chats"
      triggerClassName={`${link} outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm`}
      title="Model for new replies"
    >
      {models.length === 0 ? (
        <p className="text-sm text-muted">
          No models yet.{" "}
          <Link to="/settings/connections/new" className={link}>
            Connect one
          </Link>
          .
        </p>
      ) : (
        <ul aria-label="Models" className="-mx-1 flex min-h-0 flex-col overflow-auto">
          {models.map((model) => (
            <li key={model.value}>
              <button
                type="button"
                className="w-full rounded-md px-2 py-1.5 text-left text-sm outline-none [overflow-wrap:anywhere] hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
                onClick={() =>
                  void action
                    .run(
                      (client) =>
                        client("ChangeGenerationDefaults", { change: { model: parseModelValue(model.value) } }),
                      ["settings"]
                    )
                    .then((result) => result.ok && setOpen(false))
                }
              >
                {model.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorAlert error={action.error} />
      <p className="text-xs text-muted">It becomes the default for all chats; change it in Settings → Chats.</p>
    </Popover>
  )
}

function NoModel({ className = "" }: { className?: string }) {
  return (
    <p role="status" className={`flex flex-wrap items-baseline gap-x-2 text-sm ${className}`}>
      <span>No model chosen</span>
      <span aria-hidden="true" className="text-muted">
        ·
      </span>
      <ChooseModel />
    </p>
  )
}

/** Above an open chat's composer (the `chat.composer-notes` slot). */
export function NoModelNote({ view }: { view: ChatView }) {
  // Null (not absent) is the server saying no model is named anywhere.
  if (view.history?.model !== null) return null
  return (
    <div className="chat-column pb-2">
      <NoModel className="rounded-md border border-warning/50 bg-surface px-3 py-2" />
    </div>
  )
}

/** Above a chat not started yet's composer, which has only the account's model. */
export function PendingNoModel() {
  const defaults = useAtomValue(generationDefaultsAtom)
  if (!AsyncResult.isSuccess(defaults) || defaults.value.model) return null
  return <NoModel className="rounded-md border border-warning/50 bg-surface px-3 py-2" />
}
