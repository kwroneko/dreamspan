import { useUserDraft, UserDraftStatus } from "./editor/userDraft.tsx"
// Saved keys (ARCHITECTURE §3.12). A key goes in and never comes out, and it's sent only
// to the origins the user confirmed. Every origin is confirmed by the user, one by one:
// the server can't tell a stolen session's choices from the user's.
import type { Connection, Credential } from "@dreamspan/shared/providers.ts"
import { originOf } from "@dreamspan/shared/providers.ts"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { Button } from "../ui/Button.tsx"
import { Checkbox } from "../ui/Choice.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../ui/Dialog.tsx"
import { Field, Fieldset, formText, Input, SecretInput, Textarea } from "../ui/Field.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../ui/Surface.tsx"
import { effectiveOrigin, type ProviderSetup, providerSetupAtom } from "./connections/data.ts"
import { useTitle } from "./shell.tsx"

const keyLabel = (credential: Credential) =>
  credential.keyHint ? `Key ending in ${credential.keyHint}` : "A short key (no hint shown)"

/** Lets a saved key go to one more address. The key is typed again, as proof. */
export function AllowHostDialog({
  credential,
  url,
  open,
  onOpenChange
}: {
  credential: Credential
  /** The address to allow; the user types one when it's null. */
  url: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const [keyEmpty, setKeyEmpty] = useState(true)
  const [typedUrl, setTypedUrl] = useState("")
  // The address as the dialog opened: the key the user types is for that one.
  const [shown] = useState(url)
  const target = shown ?? typedUrl.trim()
  const origin = originOf(target)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const apiKey = formText(event.currentTarget, "apiKey")
    const result = await action.run(
      (client) => client("AllowCredentialHost", { credentialId: credential.id, apiKey, url: target }),
      ["credentials", "connections"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        shown ? `Allow “${credential.name}” for ${origin ?? shown}?` : `Allow “${credential.name}” for another address`
      }
      description="Allow this address to receive the key by entering it again. Only allow addresses you trust."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {shown === null && (
          <Field
            label="Address"
            description={origin ? `The key may go to ${origin}.` : "A URL such as https://api.example.com/v1."}
          >
            <Input
              value={typedUrl}
              onValueChange={setTypedUrl}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        )}
        <Field label="Key" description={keyLabel(credential)}>
          <SecretInput name="apiKey" onEmptyChange={setKeyEmpty} />
        </Field>
        <ErrorAlert error={action.error} title="Not allowed" />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Allows use of this credential."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={keyEmpty || origin === null}
          >
            Allow
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

interface Candidate {
  readonly origin: string
  /** Not among the origins the credential allowed before. */
  readonly isNew: boolean
  readonly usedBy: ReadonlyArray<string>
}

/**
 * The origins to offer when a key is replaced: those of the connections using it first,
 * then the ones it allowed before. None is ticked: the user confirms each.
 */
const candidatesFor = (
  credential: Credential,
  connections: ReadonlyArray<Connection>,
  setup: ProviderSetup
): ReadonlyArray<Candidate> => {
  const usedBy = new Map<string, Array<string>>()
  for (const connection of connections) {
    if (connection.credentialId !== credential.id) continue
    const origin = effectiveOrigin(connection, setup)
    if (origin !== null) usedBy.set(origin, [...(usedBy.get(origin) ?? []), connection.name])
  }
  const origins = [...new Set([...usedBy.keys(), ...credential.origins])]
  return origins.map((origin) => ({
    origin,
    isNew: !credential.origins.includes(origin),
    usedBy: usedBy.get(origin) ?? []
  }))
}

function ReplaceKeyDialog({
  credential,
  connections,
  setup,
  onOpenChange
}: {
  credential: Credential
  connections: ReadonlyArray<Connection>
  setup: ProviderSetup
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const [keyEmpty, setKeyEmpty] = useState(true)
  const [extra, setExtra] = useState<ReadonlyArray<string>>([])
  const [typedUrl, setTypedUrl] = useState("")
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  /** The connections the user was warned would stop working, as they were at the warning. */
  const [warned, setWarned] = useState<string | null>(null)
  const offered = candidatesFor(credential, connections, setup)
  const candidates = [
    ...offered,
    ...extra
      .filter((origin) => !offered.some((candidate) => candidate.origin === origin))
      .map((origin) => ({ origin, isNew: !credential.origins.includes(origin), usedBy: [] }))
  ]
  const typedOrigin = originOf(typedUrl.trim())
  const stranded = candidates
    .filter((candidate) => candidate.usedBy.length > 0 && !confirmed.has(candidate.origin))
    .flatMap((candidate) => candidate.usedBy)
  const strandedKey = stranded.join("\n")

  const toggle = (origin: string, checked: boolean) => {
    const next = new Set(confirmed)
    if (checked) next.add(origin)
    else next.delete(origin)
    setConfirmed(next)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Leaving a used address unticked stops its connections: say so once, then go ahead.
    if (stranded.length > 0 && warned !== strandedKey) {
      setWarned(strandedKey)
      return
    }
    const apiKey = formText(event.currentTarget, "apiKey")
    const result = await action.run(
      (client) =>
        client("ReplaceCredentialKey", {
          credentialId: credential.id,
          apiKey,
          urls: candidates.filter((candidate) => confirmed.has(candidate.origin)).map((candidate) => candidate.origin)
        }),
      ["credentials", "connections"]
    )
    if (result.ok) onOpenChange(false)
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={`Replace the key of “${credential.name}”`}
      description="Choose which addresses may receive the replacement key. No addresses are allowed until you select them."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="New key" about="It's never shown again.">
          <SecretInput name="apiKey" onEmptyChange={setKeyEmpty} />
        </Field>
        <Fieldset
          legend="Send the new key to"
          about="New addresses weren’t allowed for the old key. Only allow addresses you trust to receive it."
        >
          {candidates.length === 0 && <p className="text-sm text-muted">No addresses yet. Add one below.</p>}
          {candidates.map((candidate) => (
            <Checkbox
              key={candidate.origin}
              checked={confirmed.has(candidate.origin)}
              onCheckedChange={(checked) => toggle(candidate.origin, checked)}
              description={
                candidate.usedBy.length > 0 ? `Used by ${candidate.usedBy.join(", ")}` : "No connection uses it now"
              }
            >
              <span className="font-mono [overflow-wrap:anywhere]">{candidate.origin}</span>{" "}
              {candidate.isNew && <Badge tone="warning">new</Badge>}
            </Checkbox>
          ))}
          <div className="flex items-end gap-2">
            <Field label="Another address" className="flex-1">
              <Input
                value={typedUrl}
                onValueChange={setTypedUrl}
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Button
              hint="Adds this API key."
              disabled={typedOrigin === null}
              onClick={() => {
                if (typedOrigin === null) return
                setExtra([...extra, typedOrigin])
                toggle(typedOrigin, true)
                setTypedUrl("")
              }}
            >
              Add
            </Button>
          </div>
        </Fieldset>
        {stranded.length > 0 && warned === strandedKey && (
          <Alert tone="warning" title="Some connections will stop working">
            The new key won't be sent to the address of {stranded.join(", ")}. They'll refuse every request until you
            allow it with the key. Tick their address, or replace the key anyway.
          </Alert>
        )}
        <ErrorAlert error={action.error} title="The key wasn't replaced" />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Replaces the saved API key."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={keyEmpty}
          >
            {stranded.length > 0 && warned === strandedKey ? "Replace anyway" : "Replace key"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function CreateCredentialDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const durable = useUserDraft("credential:new", "Non-secret settings", JSON.stringify({ name: "", urls: "" }))
  const values = JSON.parse(durable.text) as { name: string; urls: string }
  const { name, urls } = values
  const setName = (name: string) => durable.setText(JSON.stringify({ ...values, name }))
  const setUrls = (urls: string) => durable.setText(JSON.stringify({ ...values, urls }))
  const [keyEmpty, setKeyEmpty] = useState(true)
  const lines = urls
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const bad = lines.filter((line) => originOf(line) === null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const apiKey = formText(event.currentTarget, "apiKey")
    await durable
      .commit(durable.text, async () => {
        const result = await action.run(
          (client) => client("CreateCredential", { name: name.trim(), apiKey, urls: lines }),
          ["credentials"]
        )
        return result.ok
      })
      .then((ok) => {
        if (ok) onOpenChange(false)
      })
  }
  return (
    <Dialog open onOpenChange={onOpenChange} title="Save a key">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
        <Field label="Name">
          <Input value={name} onValueChange={setName} autoComplete="off" />
        </Field>
        <Field label="Key" about="It's never shown again.">
          <SecretInput name="apiKey" onEmptyChange={setKeyEmpty} />
        </Field>
        <Field
          label="Addresses it may be sent to"
          about="Allow the key to be sent to these addresses. Enter one URL per line; permission covers all paths on that host and port."
          error={bad.length > 0 ? `Not a URL: ${bad.join(", ")}` : null}
        >
          <Textarea value={urls} onChange={(event) => setUrls(event.target.value)} spellCheck={false} />
        </Field>
        <ErrorAlert error={action.error} title="The key wasn't saved" />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves the API key."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={name.trim() === "" || keyEmpty || bad.length > 0}
          >
            Save key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function RenameDialog({ credential, onOpenChange }: { credential: Credential; onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const durable = useUserDraft(`credential:${credential.id}`, "Name", credential.name)
  const { text: name, setText: setName } = durable
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await durable
      .commit(name, async () => {
        const result = await action.run(
          (client) => client("RenameCredential", { credentialId: credential.id, name: name.trim() }),
          ["credentials", "connections"]
        )
        return result.ok
      })
      .then((ok) => {
        if (ok) onOpenChange(false)
      })
  }
  return (
    <Dialog open onOpenChange={onOpenChange} title="Rename the key">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <UserDraftStatus draft={durable} />
        <Field label="Name">
          <Input value={name} onValueChange={setName} autoComplete="off" />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves the credential’s new name."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={name.trim() === ""}
          >
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

type Open = { readonly dialog: "rename" | "replace" | "allow" | "delete"; readonly credential: Credential } | null

function CredentialList({
  credentials,
  connections,
  setup
}: {
  credentials: ReadonlyArray<Credential>
  connections: ReadonlyArray<Connection>
  setup: ProviderSetup
}) {
  const remove = useAction()
  const [open, setOpen] = useState<Open>(null)
  const close = (isOpen: boolean) => {
    if (!isOpen) setOpen(null)
  }
  if (credentials.length === 0) {
    return (
      <EmptyState title="No saved keys">
        <p>Keys typed into a connection are saved here too, under the connection's name.</p>
      </EmptyState>
    )
  }
  return (
    <>
      <ul className="flex flex-col divide-y divide-border">
        {credentials.map((credential) => (
          <li key={credential.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium [overflow-wrap:anywhere]">{credential.name}</p>
                <p className="text-sm text-muted">
                  {keyLabel(credential)} · used by {credential.usedBy} connection{credential.usedBy === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  hint="Opens the credential’s name editor."
                  variant="ghost"
                  onClick={() => setOpen({ dialog: "rename", credential })}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  hint="Lets the key go to one more address. You type the key again to confirm."
                  onClick={() => setOpen({ dialog: "allow", credential })}
                >
                  Allow an address
                </Button>
                <Button
                  variant="ghost"
                  hint="A new key in its place for every connection using it. You allow its addresses again."
                  onClick={() => setOpen({ dialog: "replace", credential })}
                >
                  Replace key
                </Button>
                <Button
                  variant="ghost"
                  hint="Deletes the key, after you confirm. Connections using it are left without one."
                  onClick={() => setOpen({ dialog: "delete", credential })}
                >
                  Delete
                </Button>
              </div>
            </div>
            <ul className="flex flex-wrap gap-1.5" aria-label={`Addresses ${credential.name} may be sent to`}>
              {credential.origins.length === 0 ? (
                <li>
                  <Badge tone="warning">not sent anywhere yet</Badge>
                </li>
              ) : (
                credential.origins.map((origin) => (
                  <li key={origin}>
                    <Badge>{origin}</Badge>
                  </li>
                ))
              )}
            </ul>
          </li>
        ))}
      </ul>
      {open?.dialog === "rename" && <RenameDialog credential={open.credential} onOpenChange={close} />}
      {open?.dialog === "replace" && (
        <ReplaceKeyDialog credential={open.credential} connections={connections} setup={setup} onOpenChange={close} />
      )}
      {open?.dialog === "allow" && (
        <AllowHostDialog credential={open.credential} url={null} open onOpenChange={close} />
      )}
      {open?.dialog === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`Delete “${open.credential.name}”?`}
          description={
            open.credential.usedBy > 0
              ? `${open.credential.usedBy} connection${open.credential.usedBy === 1 ? " uses" : "s use"} it, and will be left without a key.`
              : "No connection uses it."
          }
          confirmLabel="Delete key"
          pending={remove.pending}
          onConfirm={async () => {
            const result = await remove.run(
              (client) => client("DeleteCredential", { credentialId: open.credential.id }),
              ["credentials", "connections"]
            )
            if (result.ok) setOpen(null)
          }}
        >
          <ErrorAlert error={remove.error} />
        </ConfirmDialog>
      )}
    </>
  )
}

function CredentialsPage() {
  useTitle("Keys")
  const [creating, setCreating] = useState(false)
  return (
    <Card>
      <CardHeader
        center
        title="Saved keys"
        about="Each key is sent only to the addresses you allow for it."
        actions={
          <Button
            variant="primary"
            hint="Saves a key once, for any number of connections to use."
            onClick={() => setCreating(true)}
          >
            Save a key
          </Button>
        }
      />
      <AsyncView atom={providerSetupAtom} loading="Loading keys…">
        {({ kinds, providers, connections, credentials }) => (
          <CredentialList credentials={credentials} connections={connections} setup={{ kinds, providers }} />
        )}
      </AsyncView>
      {creating && <CreateCredentialDialog onOpenChange={setCreating} />}
    </Card>
  )
}

export const register = () => {
  routes.register({
    id: "settings.credentials",
    parent: "settings",
    path: "keys",
    component: CredentialsPage,
    nav: { label: "Keys", order: 20, description: "Your API keys, and the addresses each may be sent to." }
  })
}
