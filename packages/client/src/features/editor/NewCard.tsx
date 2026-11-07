import { useUserDraft, UserDraftStatus } from "./userDraft.tsx"
import { Effect } from "effect"
import { DISPLAY_HINT, NICKNAME_HINT } from "./cardNameHints.ts"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// A card from scratch: the three standard names, then the editor for the rest. New persona is
// the same form and flow; its card is made in the persona folder (owner, 2026-11-07).
import type { LibraryRef, RefId } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"

export function NewCardButton({ persona = false }: { persona?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button hint={`Opens a form to create a ${persona ? "persona" : "card"}.`} onClick={() => setOpen(true)}>
        New {persona ? "persona" : "card"}
      </Button>
      <NewCardDialog key={persona ? "persona" : "card"} persona={persona} open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * Names a new card and creates it. `onCreated` says where it goes next; by default its editor
 * opens from the library. With `persona`, only the title differs: the card is created in the
 * persona folder, and the editor sets its picture and definitions as for any card.
 */
export function NewCardDialog({
  open,
  onOpenChange: setOpen,
  onCreated,
  persona = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (refId: RefId, ref: LibraryRef) => void
  persona?: boolean
}) {
  const action = useAction()
  const navigate = useNavigate()
  const durable = useUserDraft(
    persona ? "persona:new" : "card:new",
    "Names",
    JSON.stringify({ name: "", nickname: "", version: "" })
  )
  // An older persona draft has no nickname or version.
  const names = { name: "", nickname: "", version: "", ...(JSON.parse(durable.text) as object) } as {
    name: string
    nickname: string
    version: string
  }
  const { name, nickname, version } = names
  const setName = (name: string) => durable.setText(JSON.stringify({ ...names, name }))
  const setNickname = (nickname: string) => durable.setText(JSON.stringify({ ...names, nickname }))
  const setVersion = (version: string) => durable.setText(JSON.stringify({ ...names, version }))
  const clash = useCardNameCheck(name.trim(), version.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash || action.pending) return
    const trimmed = name.trim()
    await durable.commit(durable.text, async () => {
      const result = await action.run(
        (client) =>
          Effect.gen(function* () {
            yield* checkCardNames(client, trimmed, version.trim())
            return yield* client("CreateCard", {
              label: trimmed,
              name: trimmed,
              nickname,
              version: version.trim(),
              ...(persona ? { persona: true } : {})
            })
          }),
        ["library"]
      )
      if (result.ok) {
        setOpen(false)
        if (onCreated) onCreated(result.value.id, result.value)
        else void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
      }
      return result.ok
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} title={persona ? "New persona" : "New card"}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
        <Field label="Display name" about={DISPLAY_HINT}>
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} required />
        </Field>
        <Field label="In-chat nickname" about={NICKNAME_HINT}>
          <Input
            placeholder="Add an in-chat nickname"
            value={nickname}
            onChange={(event) => setNickname(event.currentTarget.value)}
          />
        </Field>
        <Field label="Version" about="Shown as the card's subtitle.">
          <Input value={version} onChange={(event) => setVersion(event.currentTarget.value)} />
        </Field>
        {clash && (
          <p role="status" className="text-sm text-muted">
            {clash}
          </p>
        )}
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog." onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            hint={`Creates the ${persona ? "persona" : "card"} and opens its editor.`}
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={name.trim() === "" || clash !== null}
          >
            Create
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
