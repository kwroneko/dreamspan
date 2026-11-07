import { useUserDraft, UserDraftStatus } from "./userDraft.tsx"
import { Effect } from "effect"
import { DISPLAY_HINT, NICKNAME_HINT } from "./cardNameHints.ts"
import { useCardNameCheck } from "./cardNameCheck.ts"
import { checkCardNames } from "./checkCardNames.ts"
// A card from scratch: the three standard names, then the editor for the rest.
import type { LibraryRef, RefId } from "@rp/shared/library.ts"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Input, Textarea } from "../../ui/Field.tsx"
import { PICTURE_ACCEPT } from "../../ui/portraitParts.ts"

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
 * opens from the library.
 */
export function NewCardDialog({
  open,
  onOpenChange: setOpen,
  onCreated,
  persona = false
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (refId: RefId) => void
  persona?: boolean
}) {
  const action = useAction()
  const navigate = useNavigate()
  const durable = useUserDraft(
    persona ? "persona:new" : "card:new",
    "Names",
    JSON.stringify({ name: "", nickname: "", version: "", description: "" })
  )
  const names = JSON.parse(durable.text) as { name: string; nickname: string; version: string; description?: string }
  const [picture, setPicture] = useState<File | null>(null)
  const [created, setCreated] = useState<LibraryRef | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const { name, nickname, version } = names
  const setName = (name: string) => durable.setText(JSON.stringify({ ...names, name }))
  const setNickname = (nickname: string) => durable.setText(JSON.stringify({ ...names, nickname }))
  const setVersion = (version: string) => durable.setText(JSON.stringify({ ...names, version }))
  const clash = useCardNameCheck(name.trim(), version.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if ((!created && clash) || action.pending || uploading) return
    const trimmed = name.trim()
    await durable.commit(durable.text, async () => {
      const result = created
        ? { ok: true as const, value: created }
        : await action.run(
            (client) =>
              Effect.gen(function* () {
                yield* checkCardNames(client, trimmed, version.trim())
                return yield* client("CreateCard", {
                  label: trimmed,
                  name: trimmed,
                  nickname,
                  version: version.trim(),
                  ...(persona ? { persona: true, description: names.description ?? "" } : {})
                })
              }),
            ["library"]
          )
      if (result.ok) {
        if (persona && picture) {
          setCreated(result.value)
          setUploading(true)
          const response = await fetch(`/library/avatar?ref=${result.value.id}&rowVersion=${result.value.rowVersion}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: picture
          }).catch(() => null)
          setUploading(false)
          if (!response?.ok) {
            setUploadError("The persona was created, but the picture couldn't be uploaded. Choose a picture and retry.")
            return false
          }
          await action.run(() => Effect.void, ["library"])
        }
        setPicture(null)
        setCreated(null)
        setUploadError(null)
        setOpen(false)
        if (onCreated) onCreated(result.value.id)
        else void navigate({ to: "/library/$refId", params: { refId: result.value.id } })
      }
      return result.ok
    })
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen} title={persona ? "New persona" : "New card"}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <UserDraftStatus draft={durable} />
          <Field label={persona ? "Name" : "Display name"} about={DISPLAY_HINT}>
            <Input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              disabled={created !== null}
            />
          </Field>
          {persona ? (
            <>
              <Field label="Picture" about="Choose a PNG, JPEG, GIF or WebP picture, up to 16 MB.">
                <input
                  type="file"
                  aria-label="Picture"
                  accept={PICTURE_ACCEPT}
                  className="max-w-full text-sm"
                  onChange={(event) => {
                    setPicture(event.currentTarget.files?.[0] ?? null)
                    setUploadError(null)
                  }}
                />
              </Field>
              <Field label="Description" about="Describes who you play in chats.">
                <Textarea
                  value={names.description ?? ""}
                  disabled={created !== null}
                  onChange={(event) =>
                    durable.setText(JSON.stringify({ ...names, description: event.currentTarget.value }))
                  }
                  rows={5}
                />
              </Field>
            </>
          ) : (
            <>
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
            </>
          )}
          {!created && clash && (
            <p role="status" className="text-sm text-muted">
              {clash}
            </p>
          )}
          <ErrorAlert error={action.error} />
          {uploadError && (
            <p role="alert" className="text-sm text-danger">
              {uploadError}
            </p>
          )}
          <DialogActions>
            <Button hint="Closes this dialog." onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              hint={`Creates the ${persona ? "persona" : "card"} and opens its editor.`}
              type="submit"
              variant="primary"
              pending={action.pending || uploading}
              disabled={name.trim() === "" || (!created && clash !== null)}
            >
              Create
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  )
}
