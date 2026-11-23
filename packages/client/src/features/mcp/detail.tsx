// One MCP server's page (spec/MCP.md §13.1). Its sections are entries in the `mcp.sections` slot,
// so a plugin can add its own, as for provider connections.
import type { Credential, CredentialId, ProxyMode } from "@dreamspan/shared/providers.ts"
import { originOf } from "@dreamspan/shared/providers.ts"
import {
  MCP_DESCRIPTION_LIMIT,
  type McpCall,
  type McpCheck,
  type McpConnection,
  type McpConnectionId,
  type McpLoading,
  mcpAnnotationNotes,
  mcpToolAllowed,
  mcpOfferedToolName,
  mcpToolIsNew,
  type McpTool,
  type McpTransport
} from "@dreamspan/shared/mcp.ts"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { defineSlot, SlotOutlet } from "../../slots.tsx"
import { Button } from "../../ui/Button.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { Checkbox, RadioGroup, Switch } from "../../ui/Choice.tsx"
import { ConfirmDialog, Dialog, DialogActions } from "../../ui/Dialog.tsx"
import { Field, Fieldset, focusFirstInvalid, formText, Input, SecretInput, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Alert, Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { formatWhen } from "../chat/chatTitle.ts"
import { AllowHostDialog } from "../credentials.tsx"
import { useDurableForm } from "../editor/durable.tsx"
import { useTitle } from "../shell.tsx"
import {
  bytesLabel,
  callLabel,
  callStatusLabels,
  credentialsAtom,
  durationLabel,
  localProgramsAtom,
  mcpCallsAtom,
  mcpConnectionAtom,
  mcpHost,
  mcpStatus,
  transportLabels
} from "./data.ts"
import { addressProblem, parseArguments, parseTimeout, ProgramFields, programProblem, transportItems } from "./list.tsx"
import { SignInWithServer } from "./signIn.tsx"

export interface McpSectionProps {
  readonly connection: McpConnection
  readonly credentials: ReadonlyArray<Credential>
}

export const mcpSections = defineSlot<McpSectionProps>("mcp.sections")

/** What Check found, as an alert, with the switch it suggests. */
function CheckResult({ connection, check }: { connection: McpConnection; check: McpCheck }) {
  const action = useAction()
  const other = check.alternative
  return (
    <Alert
      tone={check.ok ? "success" : "danger"}
      title={check.ok ? "It works" : "It doesn't work"}
      actions={
        other !== null && connection.url !== null ? (
          <Button
            hint={`Saves the server with ${transportLabels[other]} and checks it again.`}
            pending={action.pending}
            onClick={() =>
              void action.run(
                (client) =>
                  client("UpdateMcpConnection", {
                    connectionId: connection.id,
                    expectedRowVersion: connection.rowVersion,
                    settings: {
                      name: connection.name,
                      about: connection.about,
                      transport: other,
                      url: connection.url!,
                      timeoutS: connection.timeoutS
                    }
                  }),
                ["mcp"]
              )
            }
          >
            Switch to {transportLabels[other]}
          </Button>
        ) : undefined
      }
    >
      <p>{check.detail}</p>
      {check.route && <p className="text-muted">Route: {check.route}</p>}
      <ErrorAlert error={action.error} />
    </Alert>
  )
}

interface ServerDraft {
  readonly name: string
  readonly about: string
  readonly transport: McpTransport
  readonly url: string
  readonly command: string
  readonly args: string
  readonly timeoutS: string
}

const draftOf = (connection: McpConnection): ServerDraft => ({
  name: connection.name,
  about: connection.about,
  transport: connection.transport,
  url: connection.url ?? "",
  command: connection.program?.command ?? "",
  args: connection.program?.args.join("\n") ?? "",
  timeoutS: String(connection.timeoutS)
})

/** A server someone else shared: what it is, read-only. */
function SharedServer({ connection }: McpSectionProps) {
  return (
    <Card>
      <CardHeader
        title="Server"
        about="Shared with you by an admin. You use its tools with your own settings; its address, keys and program stay theirs."
      />
      <dl className="flex flex-col gap-3 text-sm" data-mcp-shared-server>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium">Shared by</dt>
          <dd className="[overflow-wrap:anywhere]">{connection.ownerName}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium">What it’s for</dt>
          <dd className="[overflow-wrap:anywhere] text-muted">{connection.about || "Not said."}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-medium">Calls go to</dt>
          <dd className="[overflow-wrap:anywhere]">{mcpHost(connection)}</dd>
        </div>
      </dl>
    </Card>
  )
}

export function ServerSection(props: McpSectionProps) {
  return props.connection.owned ? <OwnServer {...props} /> : <SharedServer {...props} />
}

function OwnServer({ connection }: McpSectionProps) {
  const action = useAction()
  // Kept as typed (editor/durable.tsx); keys and headers are secrets, set in their own dialogs.
  const saved = draftOf(connection)
  const form = useDurableForm<ServerDraft>(`mcp:${connection.id}`, "Settings", saved)
  const [check, setCheck] = useState<McpCheck | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const values = form.values
  const edit = (change: Partial<ServerDraft>) => form.edit(change)
  const timeout = parseTimeout(values.timeoutS)
  const program = values.transport === "stdio"
  const problems = {
    name: values.name.trim() === "" ? "Give the server a name." : null,
    url: program ? null : addressProblem(values.url),
    command: program ? programProblem(values.command) : null,
    timeoutS: timeout.problem
  }
  const shown = (problem: string | null) => (submitted ? problem : null)
  const changed = JSON.stringify(values) !== JSON.stringify(saved)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    let checked: McpCheck | null = null
    const ok = await form.commit(async () => {
      const result = await action.run(
        (client) =>
          client("UpdateMcpConnection", {
            connectionId: connection.id,
            expectedRowVersion: connection.rowVersion,
            settings: {
              name: values.name.trim(),
              about: values.about.trim(),
              transport: values.transport,
              url: program ? "" : values.url.trim(),
              ...(program ? { program: { command: values.command.trim(), args: parseArguments(values.args) } } : {}),
              timeoutS: timeout.value
            }
          }),
        ["mcp"]
      )
      if (result.ok) checked = result.value.check
      return result.ok
    })
    if (ok) {
      setSubmitted(false)
      setCheck(checked)
    }
  }
  const discard = () => {
    void form.discard()
    setSubmitted(false)
    action.clearError()
  }

  return (
    <Card>
      <CardHeader title="Server" />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field
          label="Name"
          about="How this server is listed. The model knows its tools by a short key that stays."
          error={shown(problems.name)}
        >
          <Input value={values.name} onValueChange={(name) => edit({ name })} autoComplete="off" />
        </Field>
        <Field label="What it’s for" about="Shown to the model so it knows when to use these tools. In your own words.">
          <Textarea
            value={values.about}
            readOnly={!form.ready}
            onChange={(event) => edit({ about: event.currentTarget.value })}
            rows={2}
          />
        </Field>
        <Field label="Transport" about="How the app talks to the server. Most servers speak Streamable HTTP.">
          <AsyncView atom={localProgramsAtom}>
            {(local) => (
              <Select
                items={transportItems(local)}
                value={values.transport}
                onValueChange={(transport) => edit({ transport })}
              />
            )}
          </AsyncView>
        </Field>
        {program ? (
          <ProgramFields
            command={values.command}
            onCommandChange={(command) => edit({ command })}
            args={values.args}
            onArgsChange={(args) => edit({ args })}
            readOnly={!form.ready}
            error={shown(problems.command)}
          />
        ) : (
          <Field
            label="Address"
            about="The server’s full address. A key or headers set for another address must be entered again."
            error={shown(problems.url)}
          >
            <Input
              value={values.url}
              onValueChange={(url) => edit({ url })}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        )}
        <Field
          label="Timeout (seconds)"
          about="How long a request may wait for the server before it counts as failed. Progress the server reports restarts the wait."
          error={shown(problems.timeoutS)}
        >
          <Input value={values.timeoutS} onValueChange={(timeoutS) => edit({ timeoutS })} inputMode="numeric" />
        </Field>
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
        {check && <CheckResult connection={connection} check={check} />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            hint="Saves the server. A new address or transport is checked again at once."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={!changed}
          >
            Save
          </Button>
          {changed && (
            <Button hint="Discards the unsaved changes to this server." variant="ghost" onClick={discard}>
              Discard changes
            </Button>
          )}
        </div>
      </form>
    </Card>
  )
}

function SetKeyDialog({
  connection,
  onOpenChange
}: {
  connection: McpConnection
  onOpenChange: (open: boolean) => void
}) {
  const action = useAction()
  const origin = connection.url === null ? null : originOf(connection.url)
  const [empty, setEmpty] = useState(true)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const apiKey = formText(event.currentTarget, "apiKey")
    const result = await action.run(
      (client) =>
        client("SetMcpKey", { connectionId: connection.id, apiKey, expectedRowVersion: connection.rowVersion }),
      ["mcp", "credentials"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog open onOpenChange={onOpenChange} title="Enter a bearer token">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="Token"
          about={origin ? `Sent only to ${origin}, as “Authorization: Bearer”. It's never shown again.` : undefined}
        >
          <SecretInput name="apiKey" onEmptyChange={setEmpty} />
        </Field>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint="Saves the token for this server."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={empty}
          >
            Save token
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

function SavedKeyDialog({
  connection,
  credentials,
  onOpenChange
}: McpSectionProps & { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const [credentialId, setCredentialId] = useState<CredentialId | null>(
    connection.credentialId ?? credentials[0]?.id ?? null
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action.run(
      (client) => client("SetMcpCredential", { connectionId: connection.id, credentialId }),
      ["mcp", "credentials"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open
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
            hint="Sends the chosen saved key to this server."
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

interface HeaderRow {
  readonly id: number
  readonly name: string
  readonly filled: boolean
}

/** Names shown, values write-only: a remote server's request headers, or a local program's environment. */
function HeadersDialog({
  connection,
  env = false,
  onOpenChange
}: {
  connection: McpConnection
  env?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const names = env ? connection.envNames : connection.headerNames
  const word = env ? "variable" : "header"
  const action = useAction()
  const origin = connection.url === null ? null : originOf(connection.url)
  const [rows, setRows] = useState<ReadonlyArray<HeaderRow>>(() =>
    names.length > 0 ? names.map((name, id) => ({ id, name, filled: false })) : [{ id: 0, name: "", filled: false }]
  )
  const update = (id: number, change: Partial<HeaderRow>) =>
    setRows(rows.map((row) => (row.id === id ? { ...row, ...change } : row)))
  const named = rows.filter((row) => row.name.trim() !== "")
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const headers =
      named.length === 0
        ? null
        : Object.fromEntries(named.map((row) => [row.name.trim(), formText(form, `value-${row.id}`)]))
    const result = await action.run(
      (client) =>
        env
          ? client("SetMcpEnvironment", {
              connectionId: connection.id,
              env: headers,
              expectedRowVersion: connection.rowVersion
            })
          : client("SetMcpHeaders", {
              connectionId: connection.id,
              headers,
              expectedRowVersion: connection.rowVersion
            }),
      ["mcp"]
    )
    if (result.ok) onOpenChange(false)
  }
  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={env ? "Environment variables" : "Request headers"}
      description={
        env
          ? "These replace all current variables. Values often hold secrets, so they're never shown again. Only this program gets them."
          : `These replace all current headers. Values often hold secrets, so they're never shown again${origin ? `, and they're sent only to ${origin}` : ""}.`
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div aria-hidden="true" className="grid grid-cols-[1fr_1fr_2.25rem] gap-2 text-sm font-medium">
          <span>Name</span>
          <span>Value</span>
        </div>
        {rows.map((row, index) => (
          <div key={row.id} className="-mt-2 grid grid-cols-[1fr_1fr_2.25rem] items-end gap-2">
            <Field
              label={
                <span className="sr-only">
                  {env ? "Variable" : "Header"} {index + 1} name
                </span>
              }
            >
              <Input
                value={row.name}
                onValueChange={(name) => update(row.id, { name })}
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field
              label={
                <span className="sr-only">
                  {env ? "Variable" : "Header"} {index + 1} value
                </span>
              }
            >
              <SecretInput name={`value-${row.id}`} onEmptyChange={(empty) => update(row.id, { filled: !empty })} />
            </Field>
            <Button
              hint={env ? "Removes this variable." : "Removes this request header."}
              variant="ghost"
              aria-label={`Remove ${word} ${index + 1}`}
              onClick={() => setRows(rows.filter((other) => other.id !== row.id))}
            >
              ✕
            </Button>
          </div>
        ))}
        <div>
          <Button
            hint={env ? "Adds an empty variable." : "Adds an empty request header."}
            variant="ghost"
            onClick={() =>
              setRows([...rows, { id: Math.max(-1, ...rows.map((row) => row.id)) + 1, name: "", filled: false }])
            }
          >
            Add a {word}
          </Button>
        </div>
        <ErrorAlert error={action.error} />
        <DialogActions>
          <Button hint="Closes this dialog without applying changes." onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            hint={env ? "Saves the program's environment variables." : "Saves the request headers."}
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={named.some((row) => !row.filled)}
          >
            {named.length === 0 ? `Remove all ${word}s` : `Save ${word}s`}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

export function SignInSection(props: McpSectionProps) {
  const { connection } = props
  if (connection.transport === "stdio") return connection.owned ? <EnvironmentCard {...props} /> : null
  if (connection.owned) return <OwnSignIn {...props} />
  if (connection.url === null) return null
  return (
    <Card>
      <CardHeader
        title="Sign-in"
        about="Your own sign-in with the server, if it asks for one. The admin's key and headers stay theirs and are never shown."
      />
      <SignInWithServer connection={connection} />
    </Card>
  )
}

/** A local program's own variables (spec/MCP.md §13.1, Environment): names visible, values write-only. */
function EnvironmentCard({ connection }: McpSectionProps) {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <CardHeader
        title="Environment"
        about="Variables the program gets, such as its own keys. The app sets PATH, HOME and LANG; nothing else of the server's is passed on."
        description={connection.envNames.length === 0 ? "No variables." : connection.envNames.join(", ")}
        actions={
          <Button hint="Opens the environment variable editor." onClick={() => setOpen(true)}>
            {connection.envNames.length > 0 ? "Replace variables" : "Add variables"}
          </Button>
        }
      />
      {open && <HeadersDialog connection={connection} env onOpenChange={setOpen} />}
    </Card>
  )
}

/**
 * What the owner's own copy of a local program wrote to its error output lately. Never for a
 * shared program: programs print their configuration, which is the owner's.
 */
export function ProgramOutputSection({ connection }: McpSectionProps) {
  if (connection.transport !== "stdio" || !connection.owned) return null
  return <ProgramOutput connection={connection} />
}

function ProgramOutput({ connection }: { connection: McpConnection }) {
  const [shown, setShown] = useState<{ running: boolean; output: string } | null>(null)
  const read = useAction()
  const load = async () => {
    const result = await read.run((client) => client("GetMcpProgramOutput", { connectionId: connection.id }), [])
    if (result.ok) setShown(result.value)
  }
  return (
    <Card>
      <CardHeader
        title="Program output"
        about="What your copy of the program wrote to its error output lately (the last 64 KB), with your variables' values hidden. It's where a program says why it stopped."
        description={shown === null ? undefined : shown.running ? "Running now." : "Not running."}
        actions={
          <Button hint="Shows what the program wrote lately." pending={read.pending} onClick={() => void load()}>
            {shown === null ? "Show" : "Refresh"}
          </Button>
        }
      />
      <ErrorAlert error={read.error} title="Not loaded" />
      {shown !== null && (
        <pre
          className="max-h-80 overflow-auto rounded-md border border-border bg-surface-raised p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
          data-mcp-program-output
        >
          {shown.output === "" ? "Nothing yet." : shown.output}
        </pre>
      )}
    </Card>
  )
}

function OwnSignIn(props: McpSectionProps) {
  const { connection, credentials } = props
  const remove = useAction()
  const [dialog, setDialog] = useState<"key" | "saved" | "remove" | "allow" | "headers" | null>(null)
  const close = (open: boolean) => setDialog(open ? dialog : null)
  const origin = connection.url === null ? null : originOf(connection.url)
  const credential = credentials.find((entry) => entry.id === connection.credentialId)
  const keyBlocked = credential !== undefined && origin !== null && !credential.origins.includes(origin)
  const headersBlocked = connection.headerNames.length > 0 && connection.headersOrigin !== origin
  return (
    <Card>
      <CardHeader
        title="Sign-in"
        about="What the server needs to know it's you: a bearer token, your own sign-in with the server, or headers its documentation names. None is shown again once saved."
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Bearer token</p>
          {connection.hasKey ? (
            <p className="text-sm">
              {connection.keyHint ? (
                <>
                  Token ending in <span className="font-mono">{connection.keyHint}</span>
                </>
              ) : (
                "A short token (no hint shown)"
              )}
              {connection.credentialName && (
                <span className="text-muted">, saved as “{connection.credentialName}”</span>
              )}
            </p>
          ) : (
            <p className="text-sm text-muted">None.</p>
          )}
          {keyBlocked && (
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
              Requests are refused until you enter the key again for this address.
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              hint="Gives the server a token you type, sent only to its address."
              onClick={() => setDialog("key")}
            >
              Enter a token
            </Button>
            <Button
              disabled={credentials.length === 0}
              focusableWhenDisabled
              hint={
                credentials.length === 0
                  ? "No saved keys yet."
                  : "Uses a key saved in Settings → Keys, which others can share."
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
                  ? "Sends requests without a token. You’ll confirm first."
                  : "There's no token to remove."
              }
              onClick={() => setDialog("remove")}
            >
              Remove
            </Button>
          </div>
        </div>
        {connection.url !== null && <SignInWithServer connection={connection} />}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Headers</p>
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
          {headersBlocked && (
            <Alert tone="warning" title="The headers were set for another address">
              Requests are refused until you set them again for {origin}.
            </Alert>
          )}
          <div>
            <Button hint="Opens the request header editor." onClick={() => setDialog("headers")}>
              {connection.headerNames.length > 0 ? "Replace headers" : "Add headers"}
            </Button>
          </div>
        </div>
      </div>
      {dialog === "key" && <SetKeyDialog connection={connection} onOpenChange={close} />}
      {dialog === "saved" && <SavedKeyDialog {...props} onOpenChange={close} />}
      {dialog === "headers" && <HeadersDialog connection={connection} onOpenChange={close} />}
      {dialog === "allow" && credential && connection.url && (
        <AllowHostDialog credential={credential} url={connection.url} open onOpenChange={close} />
      )}
      <ConfirmDialog
        open={dialog === "remove"}
        onOpenChange={close}
        title="Remove the token?"
        description="The server will be asked without one. A token used only here is deleted; a saved key stays."
        confirmLabel="Remove token"
        pending={remove.pending}
        onConfirm={async () => {
          const result = await remove.run(
            (client) =>
              client("SetMcpKey", {
                connectionId: connection.id,
                apiKey: null,
                expectedRowVersion: connection.rowVersion
              }),
            ["mcp", "credentials"]
          )
          if (result.ok) setDialog(null)
        }}
      >
        <ErrorAlert error={remove.error} />
      </ConfirmDialog>
    </Card>
  )
}

/** A tool's description for its hover: cut to a few lines. */
const shortDescription = (tool: McpTool) => {
  const text = tool.description.trim() || "The server gives no description."
  return text.length > 280 ? `${text.slice(0, 279)}…` : text
}

function ToolRow({
  tool,
  connection,
  onChange,
  pending
}: {
  tool: McpTool
  connection: McpConnection
  onChange: (tool: McpTool, on: boolean) => void
  pending: boolean
}) {
  const allowed = mcpToolAllowed(tool, connection.use)
  const isNew = mcpToolIsNew(tool, connection.use)
  const notes = mcpAnnotationNotes(tool.annotations)
  return (
    <li className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
      <Checkbox
        checked={allowed}
        disabled={tool.problem !== null || pending}
        onCheckedChange={(on) => onChange(tool, on)}
        hint={tool.problem ?? shortDescription(tool)}
        hintInline={false}
        description={
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-xs [overflow-wrap:anywhere]">
              {mcpOfferedToolName(tool.exposed, connection.key, connection.use.offeredKey)}
            </span>
            {tool.problem && <span className="text-danger">Can't be used: {tool.problem}</span>}
            {tool.description.length > MCP_DESCRIPTION_LIMIT && (
              <span>Its description is cut to {MCP_DESCRIPTION_LIMIT.toLocaleString()} characters for the model.</span>
            )}
          </span>
        }
      >
        <span className="inline-flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
          {tool.title ?? tool.name}
          {isNew && <Badge tone="accent">New</Badge>}
        </span>
      </Checkbox>
      {notes.length > 0 && (
        <Tooltip label="What the server says about this tool. The app can't check it, so it changes nothing.">
          <p tabIndex={0} className="ml-6.5 self-start text-xs text-muted">
            {notes.join(" · ")}
          </p>
        </Tooltip>
      )}
    </li>
  )
}

export function ToolsSection({ connection }: McpSectionProps) {
  const check = useAction()
  const choose = useAction()
  const [result, setResult] = useState<McpCheck | null>(null)
  const status = mcpStatus(connection)
  const allowed = connection.tools.filter((tool) => mcpToolAllowed(tool, connection.use)).length
  const host = mcpHost(connection)
  /** Every tool's choice as the page shows it, so tools listed later stay off until chosen here. */
  const choose1 = (tool: McpTool, on: boolean) => {
    const choices = Object.fromEntries(
      connection.tools.map((entry) => [
        entry.name,
        { on: entry.name === tool.name ? on : mcpToolAllowed(entry, connection.use) }
      ])
    )
    void choose.run(
      (client) =>
        client("SetMcpUse", {
          connectionId: connection.id,
          tools: { choices, reviewedRevision: connection.catalogRevision }
        }),
      ["mcp"]
    )
  }
  return (
    <Card>
      <CardHeader
        title="Tools"
        about="Allowed tools are offered to the model wherever this server is turned on. What the server says about a tool is shown, but can't be checked."
        description={
          connection.listedAt === null
            ? "Not checked yet."
            : `${status.label} · ${allowed} of ${connection.tools.length} allowed · listed ${formatWhen(connection.listedAt)}`
        }
        actions={
          connection.owned && (
            <Button
              hint={`Connects to ${host} and asks for its tools. Nothing from your chats is sent.`}
              pending={check.pending}
              onClick={async () => {
                setResult(null)
                const outcome = await check.run(
                  (client) => client("CheckMcpConnection", { connectionId: connection.id }),
                  ["mcp"]
                )
                if (outcome.ok) setResult(outcome.value.check)
              }}
            >
              Check now
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-4">
        {result && <CheckResult connection={connection} check={result} />}
        {!result && connection.checkError !== null && (
          <Alert tone="danger" title="The last check failed">
            {connection.checkError}
          </Alert>
        )}
        <ErrorAlert error={check.error} title="Not checked" />
        <ErrorAlert error={choose.error} title="Not changed" />
        {connection.tools.length === 0 ? (
          <p className="text-sm text-muted">
            {connection.listedAt === null ? "Check the server to see its tools." : "The server lists no tools."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" aria-label="Tools">
            {connection.tools.map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                connection={connection}
                onChange={choose1}
                pending={choose.pending}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

/**
 * Use it in (spec/MCP.md §13.1): the account's defaults for story chats and workshops. A chat or
 * workshop can still turn the server on or off for itself.
 */
export function UsesSection({ connection }: McpSectionProps) {
  const action = useAction()
  const host = mcpHost(connection)
  const set = (change: { readonly stories?: boolean; readonly workshops?: boolean }) =>
    void action.run(
      (client) => client("SetMcpUse", { connectionId: connection.id, ...change }),
      ["mcp", "workshop-capabilities"]
    )
  return (
    <Card>
      <CardHeader
        title="Use it in"
        about="Where the model may use this server's allowed tools by default. A chat or workshop can still turn it on or off for itself."
      />
      <div className="flex flex-col gap-3" data-mcp-uses>
        <Switch
          checked={connection.use.stories}
          disabled={action.pending}
          onCheckedChange={(stories) => set({ stories })}
          hint={`Lets story replies with tools use its allowed tools, unless a chat turns it off. Each call sends what the model writes in it to ${host}.`}
        >
          Stories
        </Switch>
        <Switch
          checked={connection.use.workshops}
          disabled={action.pending}
          onCheckedChange={(workshops) => set({ workshops })}
          hint={`Lets workshops use its allowed tools, unless a workshop turns it off. Each call sends what the assistant writes in it to ${host}.`}
        >
          Workshops
        </Switch>
        <p className="text-xs text-muted">
          Changes a server makes outside the app aren’t undone by a new swipe or a branch.
        </p>
        <ErrorAlert error={action.error} title="Not changed" />
      </div>
    </Card>
  )
}

/**
 * Sending its tools (spec/MCP.md §4.4): whether the model gets the server's tools with every
 * request or loads them when it needs them, and whether loading them brings the server's own
 * instructions. Only models that can load tools later wait; others get every tool at once.
 */
export function LoadingSection(props: McpSectionProps) {
  return props.connection.owned ? <OwnLoading {...props} /> : null
}

function OwnLoading({ connection }: McpSectionProps) {
  const action = useAction()
  const legend = useId()
  const set = (change: { readonly loading?: McpLoading; readonly useInstructions?: boolean }) =>
    void action.run((client) => client("SetMcpLoading", { connectionId: connection.id, ...change }), ["mcp"])
  const instructions = connection.server?.instructions?.trim() ?? ""
  return (
    <Card>
      <CardHeader
        title="Sending its tools"
        about="Whether each request carries this server's tools, or the model loads them when it needs them. Waiting keeps requests smaller; models that can't load tools later always get them all."
      />
      <div className="flex flex-col gap-4" data-mcp-loading>
        <div className="flex flex-col gap-2">
          <p id={legend} className="text-sm font-medium">
            Send its tools
          </p>
          <RadioGroup<McpLoading>
            aria-labelledby={legend}
            value={connection.loading}
            disabled={action.pending}
            onValueChange={(loading) => set({ loading })}
            options={[
              {
                value: "auto",
                label: "Automatically",
                description: "From the start with up to 5 allowed tools; with more, when the model asks."
              },
              { value: "immediate", label: "From the start", description: "Every request carries them." },
              {
                value: "deferred",
                label: "When the model asks",
                description: "The model sees what the server is for and loads its tools when it needs them."
              }
            ]}
          />
        </div>
        <Switch
          checked={connection.useInstructions}
          disabled={action.pending}
          onCheckedChange={(useInstructions) => set({ useInstructions })}
          hint={
            connection.useInstructions
              ? "Click to stop sending the server's own instructions when the model loads its tools."
              : "Click to send the server's own instructions to the model when it loads its tools."
          }
        >
          Use the server’s instructions
        </Switch>
        <p className="text-xs text-muted [overflow-wrap:anywhere]">
          {instructions
            ? "Sent only when the model loads its tools, not when they’re sent from the start."
            : "The server gave no instructions when it was last checked."}
        </p>
        <ErrorAlert error={action.error} title="Not changed" />
      </div>
    </Card>
  )
}

export function RouteSection(props: McpSectionProps) {
  // A local program reaches the internet through the sandbox's own proxy.
  return props.connection.owned && props.connection.transport !== "stdio" ? <OwnRoute {...props} /> : null
}

function OwnRoute({ connection }: McpSectionProps) {
  const action = useAction()
  const legend = useId()
  const [mode, setMode] = useState<ProxyMode | null>(null)
  const [urlEmpty, setUrlEmpty] = useState(true)
  const current = mode ?? connection.proxyMode
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = formText(event.currentTarget, "proxyUrl")
    const result = await action.run(
      (client) =>
        client("SetMcpProxy", {
          connectionId: connection.id,
          mode: current,
          url: current === "custom" ? url.trim() : null
        }),
      ["mcp"]
    )
    if (result.ok) {
      setMode(null)
      setUrlEmpty(true)
    }
  }
  return (
    <Card>
      <CardHeader
        title="Network route"
        about="How requests to this server leave the app: as the instance sends them, direct, or through a proxy of its own."
      />
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
            hint="Saves this server’s route."
            type="submit"
            variant="primary"
            pending={action.pending}
            disabled={mode === null || (current === "custom" && urlEmpty)}
          >
            Save route
          </Button>
        </div>
      </form>
    </Card>
  )
}

function CallRow({ call }: { call: McpCall }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium [overflow-wrap:anywhere]">{callLabel(call)}</span>
        <Badge tone={call.status === "complete" ? "success" : call.status === "running" ? "neutral" : "danger"}>
          {callStatusLabels[call.status]}
        </Badge>
        {call.purpose === "check" && <Badge>Check</Badge>}
      </div>
      <p className="text-muted">
        {formatWhen(call.startedAt)} · {durationLabel(call)} · {bytesLabel(call.sentBytes)} sent ·{" "}
        {bytesLabel(call.receivedBytes)} back
      </p>
      {call.error && <p className="text-muted [overflow-wrap:anywhere]">{call.error}</p>}
    </li>
  )
}

export function CallsSection({ connection }: McpSectionProps) {
  const more = useAction()
  const [older, setOlder] = useState<ReadonlyArray<McpCall>>([])
  const [done, setDone] = useState(false)
  return (
    <Card>
      <CardHeader
        title="Recent calls"
        about="Every request the app sent to this server for you, newest first. What was sent is kept with the chat it was for."
        description={
          connection.othersCalls > 0
            ? `Others it's shared with sent ${connection.othersCalls} ${connection.othersCalls === 1 ? "request" : "requests"}, not listed here.`
            : undefined
        }
      />
      <AsyncView atom={mcpCallsAtom(connection.id)} loading="Loading calls…">
        {(calls) => {
          const all = [...calls, ...older]
          const last = all.at(-1)
          return all.length === 0 ? (
            <p className="text-sm text-muted">Nothing sent yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <ul className="flex flex-col divide-y divide-border" aria-label="Recent calls">
                {all.map((call) => (
                  <CallRow key={call.id} call={call} />
                ))}
              </ul>
              {!done && calls.length >= 50 && last && (
                <div>
                  <Button
                    hint="Shows the next 50 older calls."
                    variant="ghost"
                    pending={more.pending}
                    onClick={async () => {
                      const page = await more.run((client) =>
                        client("ListMcpCalls", {
                          connectionId: connection.id,
                          before: { startedAt: last.startedAt, id: last.id }
                        })
                      )
                      if (!page.ok) return
                      setOlder([...older, ...page.value])
                      if (page.value.length < 50) setDone(true)
                    }}
                  >
                    Show older
                  </Button>
                </div>
              )}
              <ErrorAlert error={more.error} />
            </div>
          )
        }}
      </AsyncView>
    </Card>
  )
}

export function DeleteSection(props: McpSectionProps) {
  return props.connection.owned ? <OwnDelete {...props} /> : null
}

function OwnDelete({ connection }: McpSectionProps) {
  const action = useAction()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <CardHeader
        title="Delete the server"
        about="Moves this server to the bin, from which it can be restored later. Its record of calls stays."
        actions={
          <Button hint="Moves this server to the bin." variant="danger" onClick={() => setOpen(true)}>
            Delete
          </Button>
        }
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete “${connection.name}”?`}
        description="Moves this server to the bin, from which it can be restored later."
        confirmLabel="Delete"
        pending={action.pending}
        onConfirm={async () => {
          const result = await action.run(
            (client) => client("DeleteMcpConnection", { connectionId: connection.id }),
            ["mcp", "credentials", "bin"]
          )
          if (result.ok) void navigate({ to: "/settings/mcp" })
        }}
      >
        <ErrorAlert error={action.error} />
      </ConfirmDialog>
    </Card>
  )
}

function ServerView(props: McpSectionProps) {
  const { connection } = props
  useTitle(connection.name)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {/* On a phone the settings layout has the way back above the page. */}
        <Tooltip label="Returns to MCP servers.">
          <Link to="/settings/mcp" className="hidden self-start text-sm text-muted hover:text-text md:block">
            ← MCP servers
          </Link>
        </Tooltip>
        <CenterHeaderContent>
          <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{connection.name}</h1>
        </CenterHeaderContent>
        <p className="text-sm text-muted [overflow-wrap:anywhere]">
          {connection.owned
            ? connection.program !== null
              ? `${transportLabels[connection.transport]} · ${[connection.program.command, ...connection.program.args].join(" ")}`
              : `${transportLabels[connection.transport]} · ${connection.url ?? ""}`
            : `Shared by ${connection.ownerName ?? "an admin"} · ${mcpHost(connection)}`}
        </p>
      </div>
      <SlotOutlet slot={mcpSections} props={props} />
    </div>
  )
}

function Loaded({ connectionId }: { connectionId: McpConnectionId }) {
  return (
    <AsyncView atom={credentialsAtom} loading="Loading the server…">
      {(credentials) => (
        <AsyncView atom={mcpConnectionAtom(connectionId)} loading="Loading the server…">
          {(connection) => <ServerView connection={connection} credentials={credentials} />}
        </AsyncView>
      )}
    </AsyncView>
  )
}

export function McpServerPage() {
  const { connectionId }: { connectionId?: string } = useParams({ strict: false })
  if (connectionId === undefined)
    return (
      <EmptyState title="This server doesn't exist">
        <p>It may have been deleted.</p>
      </EmptyState>
    )
  return <Loaded connectionId={connectionId as McpConnectionId} />
}
