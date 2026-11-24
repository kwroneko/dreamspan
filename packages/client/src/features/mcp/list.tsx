// Settings → MCP servers: the list, and the form for a new server (spec/MCP.md §13.1).
import { MCP_TIMEOUT_DEFAULT_S, type McpConnectionSettings, type McpTransport } from "@dreamspan/shared/mcp.ts"
import { originOf } from "@dreamspan/shared/providers.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useRef, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, focusFirstInvalid, formText, Input, SecretInput, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useDurableForm } from "../editor/durable.tsx"
import { useTitle } from "../shell.tsx"
import { credentialsAtom, localProgramsAtom, mcpConnectionsAtom, mcpHost, mcpStatus } from "./data.ts"

export function McpServersPage() {
  useTitle("MCP servers")
  return (
    <Card>
      <CardHeader
        center
        title="MCP servers"
        about="Programs and services whose tools the model can use. Nothing is sent to a server until you check it."
        actions={
          <Tooltip label="Adds a server whose tools the model can use. Nothing is sent to it until you check it.">
            <Link to="/settings/mcp/new" className={buttonClass("primary")}>
              Add a server
            </Link>
          </Tooltip>
        }
      />
      <AsyncView atom={mcpConnectionsAtom} loading="Loading MCP servers…">
        {(connections) =>
          connections.length === 0 ? (
            <EmptyState title="No MCP servers yet">
              <p>Add one to give the model tools from another program or service.</p>
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {/* Your own first, then those shared with you, each in the order they were added. */}
              {[...connections.filter((c) => c.owned), ...connections.filter((c) => !c.owned)].map((connection) => {
                const status = mcpStatus(connection)
                return (
                  <li key={connection.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Tooltip label="Opens this server’s settings and tools.">
                        <Link
                          to="/settings/mcp/$connectionId"
                          params={{ connectionId: connection.id }}
                          className="font-medium text-accent underline-offset-4 [overflow-wrap:anywhere] hover:underline"
                        >
                          {connection.name}
                        </Link>
                      </Tooltip>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {connection.use.stories && <Badge>Stories</Badge>}
                      {connection.use.workshops && <Badge>Workshops</Badge>}
                      {!connection.owned && <Badge tone="accent">Shared by {connection.ownerName}</Badge>}
                    </div>
                    <p className="text-sm text-muted [overflow-wrap:anywhere]">
                      {mcpHost(connection)} · {connection.toolCount} {connection.toolCount === 1 ? "tool" : "tools"}
                    </p>
                  </li>
                )
              })}
            </ul>
          )
        }
      </AsyncView>
    </Card>
  )
}

/** What a local program is, on its choice and its form. */
const LOCAL_PROGRAM_NOTE =
  "Runs a program on this server, in a sandbox that sees only its own folder and the internet. Only add programs you trust."

/**
 * The transports a user picks from, with what each is for. A local program is listed for
 * everyone, disabled with the reason where the user can't add one.
 */
export const transportItems = (local: {
  readonly allowed: boolean
  readonly reason: string | null
}): ReadonlyArray<{
  readonly value: McpTransport
  readonly label: string
  readonly description: string
  readonly disabled?: boolean
}> => [
  ...remoteTransportItems,
  {
    value: "stdio",
    label: "Local program",
    description: local.allowed ? LOCAL_PROGRAM_NOTE : (local.reason ?? "Not available here."),
    disabled: !local.allowed
  }
]

const remoteTransportItems: ReadonlyArray<{
  readonly value: McpTransport
  readonly label: string
  readonly description: string
}> = [
  {
    value: "streamable-http",
    label: "Streamable HTTP",
    description: "What current servers speak. Check tells you if the server only answers the older one."
  },
  {
    value: "sse",
    label: "SSE (older servers)",
    description: "The transport servers spoke before 2025: a stream for answers, and posts for requests."
  }
]

/** "" or a whole number of seconds in range; anything else is a problem to show. */
export const parseTimeout = (text: string): { value: number; problem: string | null } => {
  const trimmed = text.trim()
  if (trimmed === "") return { value: MCP_TIMEOUT_DEFAULT_S, problem: null }
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 5 && value <= 1800
    ? { value, problem: null }
    : { value: MCP_TIMEOUT_DEFAULT_S, problem: "Enter a whole number of seconds from 5 to 1800." }
}

/** Arguments as typed, one per line; blank lines dropped. */
export const parseArguments = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

/** The program's problem, or null. */
export const programProblem = (command: string) => (command.trim() === "" ? "Enter the program to run." : null)

/** The address's problem, or null. */
export const addressProblem = (url: string) => {
  const trimmed = url.trim()
  if (trimmed === "") return "Enter the server’s address."
  const origin = originOf(trimmed)
  return origin === null || !/^https?:/.test(trimmed) ? "Enter a full address, such as https://example.com/mcp." : null
}

function NewServerForm({
  hasSavedKeys,
  local
}: {
  hasSavedKeys: boolean
  local: { readonly allowed: boolean; readonly reason: string | null }
}) {
  const navigate = useNavigate()
  const action = useAction()
  // Kept as typed (editor/durable.tsx); the bearer token is a secret and stays in the form only.
  const form = useDurableForm("mcp:new", "Settings", {
    name: "",
    about: "",
    transport: "streamable-http" as McpTransport,
    url: "",
    command: "",
    args: ""
  })
  const tokens = useRef(new Map<string, string>())
  const { name, about, transport, url, command, args } = form.values
  const setName = (name: string) => form.edit({ name })
  const setAbout = (about: string) => form.edit({ about })
  const setTransport = (transport: McpTransport) => form.edit({ transport })
  const setUrl = (url: string) => form.edit({ url })
  const setCommand = (command: string) => form.edit({ command })
  const setArgs = (args: string) => form.edit({ args })
  const [submitted, setSubmitted] = useState(false)
  const program = transport === "stdio"
  const origin = program ? null : originOf(url.trim())
  const host = origin === null ? null : new URL(origin).host
  const problems = {
    name: name.trim() === "" && (program ? command.trim() === "" : host === null) ? "Give the server a name." : null,
    url: program ? null : addressProblem(url),
    command: program ? programProblem(command) : null
  }
  const shown = (problem: string | null) => (submitted ? problem : null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    const apiKey = program ? "" : formText(event.currentTarget, "apiKey")
    const settings: McpConnectionSettings = {
      name: name.trim() || (program ? command.trim() : host!),
      about: about.trim(),
      transport,
      url: program ? "" : url.trim(),
      ...(program ? { program: { command: command.trim(), args: parseArguments(args) } } : {}),
      timeoutS: MCP_TIMEOUT_DEFAULT_S
    }
    let created: string | null = null
    await form.commit(async () => {
      const result = await action.run(
        (client) => client("CreateMcpConnection", { settings, apiKey: apiKey.trim() === "" ? null : apiKey }),
        ["mcp", "credentials"]
      )
      if (result.ok) created = result.value.connection.id
      return result.ok
    })
    if (created !== null) void navigate({ to: "/settings/mcp/$connectionId", params: { connectionId: created } })
  }

  return (
    <Card>
      <CardHeader center inline title="Add an MCP server" />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Name" about="How this server is listed. Empty uses its address." error={shown(problems.name)}>
          <Input value={name} onValueChange={setName} placeholder={host ?? undefined} autoComplete="off" />
        </Field>
        <Field label="What it’s for" about="Shown to the model so it knows when to use these tools. In your own words.">
          <Textarea
            value={about}
            readOnly={!form.ready}
            onChange={(event) => setAbout(event.currentTarget.value)}
            rows={2}
          />
        </Field>
        <Field label="Transport" about="How the app talks to the server. Most servers speak Streamable HTTP.">
          <Select items={transportItems(local)} value={transport} onValueChange={setTransport} />
        </Field>
        {program ? (
          <ProgramFields
            command={command}
            onCommandChange={setCommand}
            args={args}
            onArgsChange={setArgs}
            readOnly={!form.ready}
            error={shown(problems.command)}
          />
        ) : (
          <>
            <Field
              label="Address"
              about="The server’s full address, as its documentation gives it."
              error={shown(problems.url)}
            >
              <Input
                value={url}
                onValueChange={setUrl}
                placeholder="https://example.com/mcp"
                inputMode="url"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Bearer token"
              about="A key the server gave you, if it needs one. It's never shown again."
              description={
                origin
                  ? `Optional. Sent only to ${origin}.${hasSavedKeys ? " A saved key can be chosen on the next page." : ""}`
                  : "Optional."
              }
            >
              <SecretInput name="apiKey" memory={tokens} memoryKey={url.trim()} />
            </Field>
          </>
        )}
        <ErrorAlert error={action.error} title="Not added" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            hint="Saves the server, then connects to it once and asks for its tools. Nothing from your chats is sent."
            type="submit"
            variant="primary"
            pending={action.pending}
          >
            Add and check
          </Button>
          <Tooltip label="Returns to the list without adding a server.">
            <Link to="/settings/mcp" className={buttonClass("ghost")} onClick={() => void form.discard()}>
              Cancel
            </Link>
          </Tooltip>
          {form.refusedAction}
        </div>
      </form>
    </Card>
  )
}

/** A local program's Program and Arguments fields (spec/MCP.md §13.1). */
export function ProgramFields({
  command,
  onCommandChange,
  args,
  onArgsChange,
  readOnly = false,
  error
}: {
  command: string
  onCommandChange: (command: string) => void
  args: string
  onArgsChange: (args: string) => void
  /** Until the kept text is read back (editor/durable.tsx). */
  readOnly?: boolean
  error: string | null
}) {
  return (
    <>
      <Field label="Program" about={LOCAL_PROGRAM_NOTE} description="Such as npx, node or python3." error={error}>
        <Input
          value={command}
          onValueChange={onCommandChange}
          placeholder="npx"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <Field
        label="Arguments"
        about="Passed to the program as they are, never through a shell."
        description="One per line."
      >
        <Textarea
          value={args}
          readOnly={readOnly}
          onChange={(event) => onArgsChange(event.currentTarget.value)}
          rows={3}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={"-y\n@example/mcp-server"}
          className="font-mono"
        />
      </Field>
    </>
  )
}

export function NewMcpServerPage() {
  useTitle("Add an MCP server")
  return (
    <AsyncView atom={credentialsAtom}>
      {(credentials) => (
        <AsyncView atom={localProgramsAtom}>
          {(local) => <NewServerForm hasSavedKeys={credentials.length > 0} local={local} />}
        </AsyncView>
      )}
    </AsyncView>
  )
}
