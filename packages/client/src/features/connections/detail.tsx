import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { usePlaceParam } from "../../usePlaceParam.ts"
import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { selectablePresets } from "../pickers/presetList.ts"
import type { LibraryRef } from "@rp/shared/library.ts"
import { Effect } from "effect"
import { useEffect } from "react"
// One connection's page. Its sections are entries in the `connection.sections` slot, so a
// plugin's provider can add its own.
import { providerBaseUrl } from "@rp/shared/providerDefinitions.ts"
import type {
  Connection,
  Credential,
  CredentialId,
  ProviderInfo,
  ProviderKindInfo,
  ProxyMode
} from "@rp/shared/providers.ts"
import { originOf } from "@rp/shared/providers.ts"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { RadioGroup } from "../../ui/Choice.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Fieldset, focusFirstInvalid, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { AllowHostDialog } from "../credentials.tsx"
import {
  effectiveBaseUrl,
  effectiveOrigin,
  parseOptionalInt,
  providerLabel,
  providerOf,
  providerSetupAtom
} from "./data.ts"
import {
  AwsKeyFields,
  awsKey,
  KeyTypeField,
  parseProviderDraft,
  ProviderAdvanced,
  type ProviderDraft,
  providerDraftOf,
  RegionField
} from "./providerFields.tsx"

export interface ConnectionSectionProps {
  readonly connection: Connection
  readonly kinds: ReadonlyArray<ProviderKindInfo>
  /** The providers offered: a connection's own is `providerOf(connection, providers)`. */
  readonly providers: ReadonlyArray<ProviderInfo>
  readonly credentials: ReadonlyArray<Credential>
}

export const connectionSections = defineSlot<ConnectionSectionProps>("connection.sections")

/** The form's own copy while the user edits; null shows the connection as it is. */
interface SettingsDraft {
  readonly name: string
  readonly baseUrl: string
  readonly maxConcurrent: string
  readonly cacheTtlS: string
  /** Absent in drafts saved before the field existed. */
  readonly modelIdPrefix?: string
  /** The version the edit started from, so a change made elsewhere meanwhile is a StaleWrite. */
  readonly rowVersion: number
  readonly preset: string
  /** The provider's settings the user changed; absent in drafts saved before providers had any. */
  readonly provider?: ProviderDraft
}

const draftOf = (connection: Connection): SettingsDraft => ({
  preset: connection.presetOverrideRefId ?? "none",
  name: connection.name,
  baseUrl: connection.baseUrl ?? "",
  maxConcurrent: connection.maxConcurrent?.toString() ?? "",
  cacheTtlS: connection.cacheTtlS?.toString() ?? "",
  modelIdPrefix: connection.modelIdPrefix ?? "",
  rowVersion: connection.rowVersion,
  provider: providerDraftOf(connection.providerSettings)
})

export function SettingsSection({ connection, kinds, providers }: ConnectionSectionProps) {
  const action = useAction()
  const [presets, setPresets] = useState<{ live: ReadonlyArray<LibraryRef>; archived: ReadonlyArray<LibraryRef> }>({
    live: [],
    archived: []
  })
  useEffect(() => {
    void action.run((client) =>
      Effect.map(
        Effect.all({
          live: client("ListLibrary", { kind: "preset" }),
          archived: client("ListLibrary", { kind: "preset", archived: true })
        }),
        setPresets
      )
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const durable = useUserDraft(`connection:${connection.id}`, "Settings", JSON.stringify(draftOf(connection)))
  const values: SettingsDraft = JSON.parse(durable.text)
  const [submitted, setSubmitted] = useState(false)
  const edit = (change: Partial<SettingsDraft>) => durable.setText(JSON.stringify({ ...values, ...change }))
  const kind = kinds.find((entry) => entry.id === connection.kind)
  const provider = providerOf(connection, providers)
  const providerDraft = values.provider ?? providerDraftOf(connection.providerSettings)
  const parsed = parseProviderDraft(provider, providerDraft)
  const defaultUrl = provider ? providerBaseUrl(provider, parsed.settings) : (kind?.defaultBaseUrl ?? null)
  const editProvider = (draft: ProviderDraft) => edit({ provider: draft })

  const concurrency = parseOptionalInt(values.maxConcurrent, 1)
  const ttl = parseOptionalInt(values.cacheTtlS, 1)
  const problems = {
    name: values.name.trim() === "" ? "Give the connection a name." : null,
    region: parsed.problems.region,
    baseUrl:
      values.baseUrl.trim() === ""
        ? defaultUrl === null
          ? "Enter the server’s address."
          : null
        : originOf(values.baseUrl.trim()) === null
          ? "Enter a full URL, such as http://localhost:8000/v1."
          : null,
    maxConcurrent: concurrency.problem,
    maxMarkers: parsed.problems.maxMarkers,
    minTokens: parsed.problems.minTokens,
    cacheTtlS: ttl.problem
  }
  const shown = (problem: string | null) => (submitted ? problem : null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    let savedVersion = values.rowVersion
    // Sent only when changed: an unset prefix stays unset until a refresh detects one.
    const prefix = (values.modelIdPrefix ?? "").trim()
    await durable.commit(
      durable.text,
      async () => {
        const result = await action.run(
          (client) =>
            client("UpdateConnection", {
              connectionId: connection.id,
              expectedRowVersion: values.rowVersion,
              settings: {
                name: values.name.trim(),
                baseUrl: values.baseUrl.trim() || null,
                compat: connection.compat,
                cacheTtlS: ttl.value,
                maxConcurrent: concurrency.value,
                presetOverrideRefId: values.preset === "none" ? null : (values.preset as LibraryRef["id"]),
                ...(prefix !== (connection.modelIdPrefix ?? "") ? { modelIdPrefix: prefix } : {}),
                providerSettings: parsed.changes
              }
            }),
          ["connections"]
        )
        if (result.ok) {
          savedVersion = result.value.rowVersion
          setSubmitted(false)
        }
        return result.ok
      },
      (text) => JSON.stringify({ ...JSON.parse(text), rowVersion: savedVersion })
    )
  }

  const discard = () => {
    void durable.discard()
    setSubmitted(false)
    action.clearError()
  }

  return (
    <Card>
      <CardHeader inline title="Settings" actions={<UserDraftUndo draft={durable} />} />
      <UserDraftNotices draft={durable} />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Name" about="How this connection is listed and picked." error={shown(problems.name)}>
          <Input value={values.name} onValueChange={(name) => edit({ name })} autoComplete="off" />
        </Field>
        {provider && (
          <RegionField
            provider={provider}
            draft={providerDraft}
            onChange={editProvider}
            error={shown(problems.region)}
          />
        )}
        <Field
          label="Base URL"
          about="Connect to this address instead of the provider’s default. Empty uses the default. Keys go only to allowed addresses."
          error={shown(problems.baseUrl)}
        >
          <Input
            value={values.baseUrl}
            onValueChange={(baseUrl) => edit({ baseUrl })}
            placeholder={defaultUrl ?? undefined}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Model ID prefix"
          about="Text this provider puts before its model IDs, such as acme. It’s left out when looking up a model’s price and limits. Refresh fills it in from the model list. Empty means none."
        >
          <Input
            value={values.modelIdPrefix ?? ""}
            onValueChange={(modelIdPrefix) => edit({ modelIdPrefix })}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Select a prompt preset"
          about="Switching to this connection selects this preset. You can still switch the preset afterward."
        >
          <Select
            items={[
              {
                value: "none",
                label: "Keep current preset",
                description: "Switching to this connection leaves the preset as it is."
              },
              ...selectablePresets(presets.live, presets.archived, values.preset)
            ]}
            value={values.preset}
            onValueChange={(preset) => edit({ preset })}
          />
        </Field>
        {provider && (
          <KeyTypeField
            provider={provider}
            draft={providerDraft}
            onChange={editProvider}
            about="The kind of key this connection uses. After changing it, enter a key of that kind."
          />
        )}
        <Field
          label="Concurrent requests"
          about="Limit how many requests can run at once. Others wait. Empty means no limit."
          error={shown(problems.maxConcurrent)}
        >
          <Input
            value={values.maxConcurrent}
            onValueChange={(maxConcurrent) => edit({ maxConcurrent })}
            inputMode="numeric"
            className="sm:max-w-32"
          />
        </Field>
        {provider ? (
          <ProviderAdvanced
            provider={provider}
            draft={providerDraft}
            onChange={editProvider}
            problems={{ region: null, maxMarkers: shown(problems.maxMarkers), minTokens: shown(problems.minTokens) }}
            cacheTtl={{
              value: values.cacheTtlS,
              onChange: (cacheTtlS) => edit({ cacheTtlS }),
              error: shown(problems.cacheTtlS)
            }}
          />
        ) : (
          <Field
            label="Cache lifetime (seconds)"
            about="How long the provider keeps a request’s start ready for cheaper reuse. Empty uses each model’s default."
            error={shown(problems.cacheTtlS)}
          >
            <Input
              value={values.cacheTtlS}
              onValueChange={(cacheTtlS) => edit({ cacheTtlS })}
              inputMode="numeric"
              className="sm:max-w-32"
            />
          </Field>
        )}
        <ErrorAlert
          error={action.error}
          title="Not saved"
          actions={
            action.error?.tag === "StaleWrite" ? (
              <Button
                variant="ghost"
                hint="Drops your changes here and shows the settings saved meanwhile."
                onClick={discard}
              >
                Load the latest
              </Button>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            hint="Saves the connection settings."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={durable.text === JSON.stringify(draftOf(connection))}
          >
            Save
          </Button>
          {durable.text !== JSON.stringify(draftOf(connection)) && (
            <Button hint="Discards unsaved connection changes." variant="ghost" onClick={discard}>
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Card>
  )
}

/**
 * A secret is typed for the address shown when its dialog opened. If a reload (after a
 * StaleWrite) shows the connection now points elsewhere, the typed secret is dropped and
 * the user decides again: otherwise one more click would send it where someone else chose.
 */
function AddressChanged({ from, to }: { from: string | null; to: string | null }) {
  if (from === to) return null
  return (
    <Alert tone="warning" title="The address changed">
      The address changed from {from ?? "none"} to {to ?? "none"}. Enter the key again if it should go to{" "}
      {to ?? "that address"}.
    </Alert>
  )
}

function SetKeyDialog({
  connection,
  origin,
  aws,
  open,
  onOpenChange
}: {
  connection: Connection
  origin: string | null
  /** The provider takes an AWS access key: its ID and secret are typed apart. */
  aws: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const [opened] = useState(origin)
  /** The address the key in the field was typed for; null while it's empty. */
  const [typedFor, setTypedFor] = useState<string | null>(null)
  /** For an AWS key, which of its two required parts are still empty. */
  const [awsEmpty, setAwsEmpty] = useState({ accessKeyId: true, secretAccessKey: true })
  const awsTyped = (name: "accessKeyId" | "secretAccessKey") => (empty: boolean) => {
    const next = { ...awsEmpty, [name]: empty }
    setAwsEmpty(next)
    setTypedFor(next.accessKeyId || next.secretAccessKey ? null : origin)
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const apiKey = aws ? awsKey(event.currentTarget) : formText(event.currentTarget, "apiKey")
    const result = await action.run(
      (client) =>
        client("SetConnectionKey", { connectionId: connection.id, apiKey, expectedRowVersion: connection.rowVersion }),
      ["connections", "credentials"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Enter a new key">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {aws ? (
          // Keyed by the address, so a changed address empties the fields.
          <AwsKeyFields key={origin} origin={origin} error={null} onEmptyChange={awsTyped} />
        ) : (
          <Field label="Key" about={origin ? `The key is sent only to ${origin}. It's never shown again.` : undefined}>
            {/* Keyed by the address, so a changed address empties the field. */}
            <SecretInput key={origin} name="apiKey" onEmptyChange={(empty) => setTypedFor(empty ? null : origin)} />
          </Field>
        )}
        <AddressChanged from={opened} to={origin} />
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves the API key for this connection."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={typedFor === null || typedFor !== origin}
          >
            Save key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function UseSavedKeyDialog({
  connection,
  credentials,
  open,
  onOpenChange
}: ConnectionSectionProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const [credentialId, setCredentialId] = useState<CredentialId | null>(
    connection.credentialId ?? credentials[0]?.id ?? null
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run(
      (client) => client("SetConnectionCredential", { connectionId: connection.id, credentialId }),
      ["connections", "credentials"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Use a saved key"
      description="A saved key is sent only to the addresses it was allowed for."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Saved key">
          <Select
            items={credentials.map((credential) => ({
              value: credential.id,
              label: credential.keyHint ? `${credential.name} (•••• ${credential.keyHint})` : credential.name
            }))}
            value={credentialId}
            onValueChange={setCredentialId}
          />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Uses the selected API key for this connection."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={credentialId === null}
          >
            Use this key
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function KeySection(props: ConnectionSectionProps) {
  const { connection, credentials } = props
  const remove = useAction()
  const [dialog, setDialog] = useState<"set" | "saved" | "remove" | "allow" | null>(null)
  const origin = effectiveOrigin(connection, props)
  const provider = providerOf(connection, props.providers)
  const aws = { ...provider?.defaults, ...connection.providerSettings }.auth === "aws-sigv4"
  const credential = credentials.find((entry) => entry.id === connection.credentialId)
  const blocked = credential !== undefined && origin !== null && !credential.origins.includes(origin)
  const close = (open: boolean) => setDialog(open ? dialog : null)

  return (
    <Card>
      <CardHeader
        title="API key"
        about="Once saved, a key is never shown again: only its last four characters."
        actions={
          <>
            <Button hint="Gives it a key you type, sent only to its address." onClick={() => setDialog("set")}>
              Enter a new key
            </Button>
            <Button
              disabled={credentials.length === 0}
              focusableWhenDisabled
              hint={
                credentials.length === 0
                  ? "No saved keys yet."
                  : "Uses a key saved in Settings → Keys, which other connections can share."
              }
              onClick={() => setDialog("saved")}
            >
              Use a saved key
            </Button>
            <Button
              variant="ghost"
              disabled={!connection.hasKey}
              focusableWhenDisabled
              hint={
                connection.hasKey
                  ? "Send requests without a key. You’ll confirm first."
                  : "This connection has no key to remove."
              }
              onClick={() => setDialog("remove")}
            >
              Remove key
            </Button>
          </>
        }
      />
      {connection.hasKey ? (
        <p className="text-sm">
          {connection.keyHint ? (
            <>
              Key ending in <span className="font-mono">{connection.keyHint}</span>
            </>
          ) : (
            "A short key (no hint shown)"
          )}
          {connection.credentialName && <span className="text-muted">, saved as “{connection.credentialName}”</span>}
        </p>
      ) : (
        <p className="text-sm text-muted">No key. Requests go without one.</p>
      )}
      {blocked && (
        <div className="mt-3">
          <Alert
            tone="warning"
            title={`This key isn't allowed for ${origin}`}
            actions={
              <Button
                hint="Asks for the key again, then lets it go to this address."
                onClick={() => setDialog("allow")}
              >
                Allow it
              </Button>
            }
          >
            Requests are refused until you type the key again to allow this address. That happens when the address
            changes, or when the key is replaced without allowing it. If you made neither change, check the address
            before you allow it.
          </Alert>
        </div>
      )}
      {dialog === "set" && <SetKeyDialog connection={connection} origin={origin} aws={aws} open onOpenChange={close} />}
      {dialog === "saved" && <UseSavedKeyDialog {...props} open onOpenChange={close} />}
      {dialog === "allow" && credential && origin && (
        <AllowHostDialog
          credential={credential}
          url={effectiveBaseUrl(connection, props) ?? origin}
          open
          onOpenChange={close}
        />
      )}
      <ConfirmDialog
        open={dialog === "remove"}
        onOpenChange={close}
        title="Remove the key?"
        description="This connection will send requests without a key. A key used only here is deleted; a shared key stays available."
        confirmLabel="Remove key"
        pending={remove.pending}
        onConfirm={async () => {
          const result = await remove.run(
            (client) =>
              client("SetConnectionKey", {
                connectionId: connection.id,
                apiKey: null,
                expectedRowVersion: connection.rowVersion
              }),
            ["connections", "credentials"]
          )
          if (result.ok) setDialog(null)
        }}
      >
        <ErrorAlert error={remove.error} />
      </ConfirmDialog>
    </Card>
  )
}

/** A header being typed. Its value stays in the input, read from the form on submit. */
interface HeaderRow {
  readonly id: number
  readonly name: string
  /** The address the value in the field was typed for; null while it's empty. */
  readonly valueFor: string | null
}

function HeadersDialog({
  connection,
  origin,
  open,
  onOpenChange
}: {
  connection: Connection
  origin: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const [rows, setRows] = useState<ReadonlyArray<HeaderRow>>(() =>
    connection.headerNames.length > 0
      ? connection.headerNames.map((name, id) => ({ id, name, valueFor: null }))
      : [{ id: 0, name: "", valueFor: null }]
  )
  const update = (id: number, change: Partial<HeaderRow>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...change } : row)))
  const filled = rows.filter((row) => row.name.trim() !== "")
  const [opened] = useState(origin)
  const missingValue = filled.some((row) => row.valueFor === null || row.valueFor !== origin)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const headers =
      filled.length === 0
        ? null
        : Object.fromEntries(filled.map((row) => [row.name.trim(), formText(form, `value-${row.id}`)]))
    const result = await action.run(
      (client) =>
        client("SetConnectionHeaders", {
          connectionId: connection.id,
          headers,
          expectedRowVersion: connection.rowVersion
        }),
      ["connections"]
    )
    if (result.ok) onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Custom headers"
      description={`These replace all current headers. Values often hold secrets, so they're never shown again${origin ? `, and they're sent only to ${origin}` : ""}.`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div aria-hidden="true" className="grid grid-cols-[1fr_1fr_2.25rem] gap-2 text-sm font-medium">
          <span>Name</span>
          <span>Value</span>
        </div>
        {rows.map((row, index) => (
          <div key={row.id} className="-mt-2 grid grid-cols-[1fr_1fr_2.25rem] items-end gap-2">
            <Field label={<span className="sr-only">Header {index + 1} name</span>}>
              <Input
                value={row.name}
                onValueChange={(name) => update(row.id, { name })}
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field label={<span className="sr-only">Header {index + 1} value</span>}>
              <SecretInput
                key={origin}
                name={`value-${row.id}`}
                onEmptyChange={(empty) => update(row.id, { valueFor: empty ? null : origin })}
              />
            </Field>
            <Button
              hint="Removes this request header."
              variant="ghost"
              aria-label={`Remove header ${index + 1}`}
              onClick={() => setRows(rows.filter((other) => other.id !== row.id))}
            >
              ✕
            </Button>
          </div>
        ))}
        <div>
          <Button
            hint="Adds an empty request header."
            variant="ghost"
            onClick={() =>
              setRows([...rows, { id: Math.max(-1, ...rows.map((row) => row.id)) + 1, name: "", valueFor: null }])
            }
          >
            Add a header
          </Button>
        </div>
        <AddressChanged from={opened} to={origin} />
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves the request headers."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={missingValue}
          >
            {filled.length === 0 ? "Remove all headers" : "Save headers"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function HeadersSection(props: ConnectionSectionProps) {
  const { connection } = props
  const [place, setPlace] = usePlaceParam("connectionDialog", "", ["", "headers"])
  const open = place === "headers"
  const setOpen = (on: boolean) => setPlace(on ? "headers" : "")
  return (
    <Card>
      <CardHeader
        title="Custom headers"
        about="For gateways and proxies that need them: sent with every request."
        actions={
          <Button hint="Opens the request header editor." onClick={() => setOpen(true)}>
            {connection.headerNames.length > 0 ? "Replace headers" : "Add headers"}
          </Button>
        }
      />
      {connection.headerNames.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Header names">
          {connection.headerNames.map((name) => (
            <li key={name}>
              <Badge>{name}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">None.</p>
      )}
      {open && (
        <HeadersDialog
          connection={connection}
          origin={effectiveOrigin(connection, props)}
          open
          onOpenChange={setOpen}
        />
      )}
    </Card>
  )
}

export function RouteSection({ connection }: ConnectionSectionProps) {
  const action = useAction()
  const legend = useId()
  const [mode, setMode] = useState<ProxyMode | null>(null)
  const [urlEmpty, setUrlEmpty] = useState(true)
  const current = mode ?? connection.proxyMode
  const needsUrl = current === "custom" && urlEmpty

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = formText(event.currentTarget, "proxyUrl")
    const result = await action.run(
      (client) =>
        client("SetConnectionProxy", {
          connectionId: connection.id,
          mode: current,
          url: current === "custom" ? url.trim() : null
        }),
      ["connections"]
    )
    if (result.ok) {
      setMode(null)
      setUrlEmpty(true)
    }
  }

  return (
    <Card>
      <CardHeader title="Network route" />
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Fieldset
          legend={
            <span id={legend} className="sr-only">
              Route
            </span>
          }
        >
          <RadioGroup<ProxyMode>
            aria-labelledby={legend}
            value={current}
            onValueChange={setMode}
            options={[
              { value: "inherit", label: "Instance settings", description: "The admin's proxy and bypass list." },
              { value: "direct", label: "Direct", description: "Never through a proxy." },
              { value: "custom", label: "Own proxy", description: "HTTP, HTTPS or SOCKS5." }
            ]}
          />
        </Fieldset>
        {current === "custom" && (
          <Field
            label="Proxy URL"
            description={
              connection.proxyMode === "custom"
                ? "A proxy is set. Enter its URL again to change it; any password stays hidden."
                : "For example socks5://user:password@host:1080."
            }
          >
            <SecretInput name="proxyUrl" masked={false} onEmptyChange={setUrlEmpty} />
          </Field>
        )}
        <ErrorAlert error={action.error} title="The route wasn't changed" />
        <div>
          <Button
            hint="Saves this connection’s route."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={mode === null || needsUrl}
          >
            Save route
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function TestSection({ connection }: ConnectionSectionProps) {
  const action = useAction()
  const [result, setResult] = useState<{
    ok: boolean
    detail: string
    route: string | null
    models: number | null
  } | null>(null)
  return (
    <Card>
      <CardHeader
        title="Check the connection"
        about="See whether the connection works and which models it offers."
        actions={
          <Button
            hint="Checks this connection and lists available models."
            pending={action.pending}
            onClick={async () => {
              setResult(null)
              const outcome = await action.run((client) => client("TestConnection", { connectionId: connection.id }))
              if (outcome.ok) setResult(outcome.value)
            }}
          >
            Check
          </Button>
        }
      />
      {result && (
        <Alert tone={result.ok ? "success" : "danger"} title={result.ok ? "It works" : "It doesn't work"}>
          <p>{result.detail}</p>
          {result.models !== null && <p>{result.models} models listed.</p>}
          {result.route && <p className="text-muted">Route: {result.route}</p>}
        </Alert>
      )}
      <ErrorAlert error={action.error} title="It doesn't work" />
    </Card>
  )
}

export function DeleteSection({ connection }: ConnectionSectionProps) {
  const action = useAction()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <CardHeader
        title="Delete the connection"
        about="Moves this connection to the bin, from which it can be restored later."
        actions={
          <Button hint="Moves this connection to the bin." variant="danger" onClick={() => setOpen(true)}>
            Delete
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete “${connection.name}”?`}
        description="Moves this connection to the bin, from which it can be restored later."
        confirmLabel="Delete"
        pending={action.pending}
        onConfirm={async () => {
          const result = await action.run(
            (client) => client("DeleteConnection", { connectionId: connection.id }),
            ["connections", "credentials"]
          )
          if (result.ok) void navigate({ to: "/settings/connections" })
        }}
      >
        <ErrorAlert error={action.error} />
      </ConfirmDialog>
    </Card>
  )
}

export function ConnectionPage() {
  const { connectionId }: { connectionId?: string } = useParams({ strict: false })
  return (
    <AsyncView atom={providerSetupAtom} loading="Loading the connection…">
      {({ kinds, providers, connections, credentials }) => {
        const connection = connections.find((entry) => entry.id === connectionId)
        return connection ? (
          <ConnectionView connection={connection} kinds={kinds} providers={providers} credentials={credentials} />
        ) : (
          <EmptyState title="This connection doesn't exist">
            <p>It may have been deleted.</p>
            <Tooltip label="Opens the connections list.">
              <Link to="/settings/connections" className="text-accent underline-offset-4 hover:underline">
                All connections
              </Link>
            </Tooltip>
          </EmptyState>
        )
      }}
    </AsyncView>
  )
}

function ConnectionView(props: ConnectionSectionProps) {
  const { connection } = props
  useTitle(connection.name)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {/* On a phone the settings layout has the way back above the page. */}
        <Tooltip label="Returns to Connections.">
          <Link to="/settings/connections" className="hidden self-start text-sm text-muted hover:text-text md:block">
            ← Connections
          </Link>
        </Tooltip>
        <CenterHeaderContent>
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{connection.name}</h1>
        </CenterHeaderContent>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">
          {providerLabel(connection, props)} · {effectiveBaseUrl(connection, props)}
        </p>
      </div>
      <SlotOutlet slot={connectionSections} props={props} />
    </div>
  )
}
