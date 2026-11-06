import { ModelPickerPopover } from "../pickers/ModelPicker.tsx"
import { useModelSelection } from "../pickers/modelSelection.ts"
// In the composer when neither the chat nor the account names a model: the send would
// fail, so say so and offer the choice right there.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { ChatView } from "../chat/session.ts"
import { generationDefaultsAtom } from "../connections/data.ts"

const link = "font-medium text-accent underline-offset-4 hover:underline"

function ChooseModel() {
  const selection = useModelSelection(null)
  return (
    <ModelPickerPopover
      selection={selection}
      trigger="Choose"
      triggerLabel="Choose a model for all chats"
      triggerClassName={`${link} rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      hint="Choose the model for new replies"
    />
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
  // Where the open chat's note is: above the composer, in the chat's column.
  return (
    <div className="chat-column pb-2">
      <NoModel className="rounded-md border border-warning/50 bg-surface px-3 py-2" />
    </div>
  )
}
