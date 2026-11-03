import { useUserDraft, UserDraftStatus } from "./userDraft.tsx"
import { Effect } from "effect"
import { DISPLAY_HINT, NICKNAME_HINT } from "./cardNameHints.ts"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// A card from scratch: the three standard names, then the editor for the rest.
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input } from "../../ui/Field.tsx"

export function NewCardButton() {
  const action = useAction()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const durable = useUserDraft("card:new", "Names", JSON.stringify({ name: "", nickname: "", version: "" }))
  const names = JSON.parse(durable.text) as { name: string; nickname: string; version: string }
  const { name, nickname, version } = names
  const setName = (name: string) => durable.setText(JSON.stringify({ ...names, name }))
  const setNickname = (nickname: string) => durable.setText(JSON.stringify({ ...names, nickname }))
  const setVersion = (version: string) => durable.setText(JSON.stringify({ ...names, version }))
  const clash = useCardNameCheck(name.trim(), version.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (clash) return
    const trimmed = name.trim()
    await durable.commit(durable.text, async () => {
      const result = await action.run(
        (client) =>
          Effect.gen(function* () {
            yield* checkCardNames(client, trimmed, version.trim())
            return yield* client("CreateCard", { label: trimmed, name: trimmed, nickname, version: version.trim() })
          }),
        ["library"]
      )
      if (result.ok) void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
      return result.ok
    })
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New card</Button>
      <Dialog open={open} onOpenChange={setOpen} title="New card">
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
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
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
    </>
  )
}
