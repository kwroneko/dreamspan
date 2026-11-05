// Naming something the user owns (DESIGN §2.1): a chat, a group of chats, a branch. One field
// with its name as it is now, what the name does, and Save; Enter saves, Escape cancels.
import { useUserDraft, UserDraftStatus } from "../editor/userDraft.tsx"
import { type ReactNode, useRef } from "react"
import type { AppError } from "../../errors.ts"
import { ErrorAlert } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"

export function NameDialog({
  draftTarget,
  open,
  onOpenChange,
  title,
  summary,
  label,
  initial,
  description,
  maxLength,
  saveLabel = "Save",
  saveHint = "Saves the new name.",
  pending,
  error,
  onSave,
  children
}: {
  draftTarget: string
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** What the dialog is about, under its title. */
  summary?: ReactNode
  label: string
  /** The name now, which the field starts with. */
  initial: string
  /** Help beside the field: what an empty name does, say. */
  description?: ReactNode
  maxLength: number
  saveLabel?: string
  saveHint?: string
  pending: boolean
  error: AppError | null
  onSave: (name: string) => Promise<boolean>
  /** More choices, under the field. */
  children?: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={summary}>
      {/* Mounted while open only, so it starts from the name as it is each time. */}
      {open && (
        <NameForm
          draftTarget={draftTarget}
          label={label}
          initial={initial}
          description={description}
          maxLength={maxLength}
          saveLabel={saveLabel}
          saveHint={saveHint}
          pending={pending}
          error={error}
          onSave={onSave}
          onCancel={() => onOpenChange(false)}
        >
          {children}
        </NameForm>
      )}
    </Dialog>
  )
}

function NameForm({
  draftTarget,
  label,
  initial,
  description,
  maxLength,
  saveLabel,
  saveHint,
  pending,
  error,
  onSave,
  onCancel,
  children
}: {
  draftTarget: string
  label: string
  initial: string
  description?: ReactNode
  maxLength: number
  saveLabel: string
  saveHint: string
  pending: boolean
  error: AppError | null
  onSave: (name: string) => Promise<boolean>
  onCancel: () => void
  children?: ReactNode
}) {
  const durable = useUserDraft(draftTarget, label, initial)
  const { text: name, setText: setName } = durable
  const submitting = useRef(false)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        // Draft persistence precedes onSave, so pending can still be false on a
        // second submit. Lock before queuing either part of the commit.
        if (pending || submitting.current) return
        submitting.current = true
        void durable
          .commit(name, () => onSave(name))
          .finally(() => {
            submitting.current = false
          })
      }}
    >
      <Field label={label} about={description}>
        <Input
          value={name}
          maxLength={maxLength}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </Field>
      <UserDraftStatus draft={durable} />
      {children}
      <ErrorAlert error={error} />
      <DialogActions>
        <Button hint="Closes this dialog without applying changes." type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button hint={saveHint} type="submit" variant="primary" pending={pending}>
          {saveLabel}
        </Button>
      </DialogActions>
    </form>
  )
}
