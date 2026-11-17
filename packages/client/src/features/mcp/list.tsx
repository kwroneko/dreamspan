// Settings → MCP servers: the list, and the form for a new server (spec/MCP.md §13.1).
import { MCP_TIMEOUT_DEFAULT_S, type McpConnectionSettings, type RemoteMcpTransport } from "@rp/shared/mcp.ts"
import { originOf } from "@rp/shared/providers.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, focusFirstInvalid, formText, Input, SecretInput, Textarea } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useTitle } from "../shell.tsx"
import { credentialsAtom, mcpConnectionsAtom, mcpHost, mcpStatus } from "./data.ts"

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
              {connections.map((connection) => {
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

/** The transports a user picks from, with what each is for. */
export const transportItems: ReadonlyArray<{
  readonly value: RemoteMcpTransport
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

/** The address's problem, or null. */
export const addressProblem = (url: string) => {
  const trimmed = url.trim()
  if (trimmed === "") return "Enter the server’s address."
  const origin = originOf(trimmed)
  return origin === null || !/^https?:/.test(trimmed) ? "Enter a full address, such as https://example.com/mcp." : null
}

function NewServerForm({ hasSavedKeys }: { hasSavedKeys: boolean }) {
  const navigate = useNavigate()
  const action = useAction()
  const [name, setName] = useState("")
  const [about, setAbout] = useState("")
  const [transport, setTransport] = useState<RemoteMcpTransport>("streamable-http")
  const [url, setUrl] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const origin = originOf(url.trim())
  const host = origin === null ? null : new URL(origin).host
  const problems = {
    name: name.trim() === "" && host === null ? "Give the server a name." : null,
    url: addressProblem(url)
  }
  const shown = (problem: string | null) => (submitted ? problem : null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    const apiKey = formText(event.currentTarget, "apiKey")
    const settings: McpConnectionSettings = {
      name: name.trim() || host!,
      about: about.trim(),
      transport,
      url: url.trim(),
      timeoutS: MCP_TIMEOUT_DEFAULT_S
    }
    const result = await action.run(
      (client) => client("CreateMcpConnection", { settings, apiKey: apiKey.trim() === "" ? null : apiKey }),
      ["mcp", "credentials"]
    )
    if (result.ok)
      void navigate({ to: "/settings/mcp/$connectionId", params: { connectionId: result.value.connection.id } })
  }

  return (
    <Card>
      <CardHeader center inline title="Add an MCP server" />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <Field label="Name" about="How this server is listed. Empty uses its address." error={shown(problems.name)}>
          <Input value={name} onValueChange={setName} placeholder={host ?? undefined} autoComplete="off" />
        </Field>
        <Field label="What it’s for" about="Shown to the model so it knows when to use these tools. In your own words.">
          <Textarea value={about} onChange={(event) => setAbout(event.currentTarget.value)} rows={2} />
        </Field>
        <Field label="Transport" about="How the app talks to the server. Most servers speak Streamable HTTP.">
          <Select items={transportItems} value={transport} onValueChange={setTransport} />
        </Field>
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
          <SecretInput name="apiKey" />
        </Field>
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
            <Link to="/settings/mcp" className={buttonClass("ghost")}>
              Cancel
            </Link>
          </Tooltip>
        </div>
      </form>
    </Card>
  )
}

export function NewMcpServerPage() {
  useTitle("Add an MCP server")
  return (
    <AsyncView atom={credentialsAtom}>
      {(credentials) => <NewServerForm hasSavedKeys={credentials.length > 0} />}
    </AsyncView>
  )
}
