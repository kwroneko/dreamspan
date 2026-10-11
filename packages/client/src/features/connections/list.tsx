// The connection list and the form for a new connection.
import type { Credential, CredentialId, ProviderKindInfo } from "@rp/shared/providers.ts"
import { originOf } from "@rp/shared/providers.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { RadioGroup } from "../../ui/Choice.tsx"
import { Field, Fieldset, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { connectionsAtom, credentialsAtom, effectiveOrigin, kindsAtom, parseOptionalInt } from "./data.ts"

export function ConnectionsPage() {
  useTitle("Connections")
  return (
    <Card>
      <CardHeader
        title="Connections"
        description="Each connection is one provider API at one address, with the key it sends."
        actions={
          <Link to="/settings/connections/new" className={buttonClass("primary")}>
            New connection
          </Link>
        }
      />
      <AsyncView atom={kindsAtom}>
        {(kinds) => (
          <AsyncView atom={connectionsAtom} loading="Loading connections…">
            {(connections) =>
              connections.length === 0 ? (
                <EmptyState title="No connections yet">
                  <p>Add one to reach a model provider or a local server.</p>
                </EmptyState>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {connections.map((connection) => (
                    <li key={connection.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/settings/connections/$connectionId"
                          params={{ connectionId: connection.id }}
                          className="font-medium text-accent underline-offset-4 hover:underline"
                        >
                          {connection.name}
                        </Link>
                        {connection.hasKey ? (
                          <Badge>key •••• {connection.keyHint || "set"}</Badge>
                        ) : (
                          <Badge tone="warning">no key</Badge>
                        )}
                        {connection.proxyMode !== "inherit" && (
                          <Badge>{connection.proxyMode === "direct" ? "direct" : "own proxy"}</Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted [overflow-wrap:anywhere]">
                        {kinds.find((kind) => kind.id === connection.kind)?.label ?? connection.kind} ·{" "}
                        {effectiveOrigin(connection, kinds) ?? "no address"}
                      </p>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncView>
        )}
      </AsyncView>
    </Card>
  )
}

type KeyMode = "typed" | "saved" | "none"

function NewConnectionForm({
  kinds,
  credentials
}: {
  kinds: ReadonlyArray<ProviderKindInfo>
  credentials: ReadonlyArray<Credential>
}) {
  const navigate = useNavigate()
  const action = useAction()
  const keyModeLabel = useId()
  const [kindId, setKindId] = useState(kinds[0]?.id ?? "")
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [keyMode, setKeyMode] = useState<KeyMode>("typed")
  const [keyEmpty, setKeyEmpty] = useState(true)
  const [credentialId, setCredentialId] = useState<CredentialId | null>(credentials[0]?.id ?? null)
  const [maxConcurrent, setMaxConcurrent] = useState("")
  const [submitted, setSubmitted] = useState(false)

  const kind = kinds.find((entry) => entry.id === kindId)
  const url = baseUrl.trim() || kind?.defaultBaseUrl || ""
  const origin = originOf(url)
  const concurrency = parseOptionalInt(maxConcurrent, 1)
  const problems = {
    name: name.trim() === "" ? "Give the connection a name." : null,
    baseUrl: baseUrl.trim() !== "" && origin === null ? "Enter a full URL, such as http://localhost:8000/v1." : null,
    apiKey: keyMode === "typed" && keyEmpty ? "Enter the key, or choose another option." : null,
    maxConcurrent: concurrency.problem
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return
    const apiKey = formText(event.currentTarget, "apiKey")
    const result = await action.run(
      (client) =>
        client("CreateConnection", {
          kind: kindId,
          settings: {
            name: name.trim(),
            baseUrl: baseUrl.trim() || null,
            compat: {},
            cacheTtlS: null,
            maxConcurrent: concurrency.value,
            presetOverrideRefId: null
          },
          ...(keyMode === "typed" ? { apiKey } : keyMode === "saved" ? { credentialId } : {})
        }),
      ["connections", "credentials"]
    )
    if (result.ok) {
      void navigate({ to: "/settings/connections/$connectionId", params: { connectionId: result.value.id } })
    }
  }

  const shown = (problem: string | null) => (submitted ? problem : null)
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <Field label="Provider">
        <Select
          items={kinds.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={kindId}
          onValueChange={(value) => {
            setKindId(value)
            if (keyMode === "none" && !kinds.find((entry) => entry.id === value)?.keyOptional) setKeyMode("typed")
          }}
        />
      </Field>
      <Field label="Name" error={shown(problems.name)}>
        <Input value={name} onValueChange={setName} placeholder={kind?.label} autoComplete="off" />
      </Field>
      <Field
        label="Base URL"
        description="Leave empty for the provider's own address. The whole API moves with it."
        error={shown(problems.baseUrl)}
      >
        <Input
          value={baseUrl}
          onValueChange={setBaseUrl}
          placeholder={kind?.defaultBaseUrl}
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
        />
      </Field>
      <Fieldset legend={<span id={keyModeLabel}>API key</span>}>
        <RadioGroup<KeyMode>
          aria-labelledby={keyModeLabel}
          value={keyMode}
          onValueChange={(mode) => {
            setKeyMode(mode)
            setKeyEmpty(true)
          }}
          options={[
            { value: "typed", label: "Enter a key" },
            ...(credentials.length > 0 ? [{ value: "saved" as const, label: "Use a saved key" }] : []),
            ...(kind?.keyOptional
              ? [{ value: "none" as const, label: "No key", description: "For local servers that take none." }]
              : [])
          ]}
        />
        {keyMode === "typed" && (
          <Field
            label="Key"
            description={
              origin ? `It will be sent only to ${origin}. It's never shown again.` : "It's never shown again."
            }
            error={shown(problems.apiKey)}
          >
            <SecretInput name="apiKey" onEmptyChange={setKeyEmpty} />
          </Field>
        )}
        {keyMode === "saved" && (
          <Field label="Saved key" description="It's sent only to the addresses it was allowed for.">
            <Select
              items={credentials.map((credential) => ({
                value: credential.id,
                label: credential.keyHint ? `${credential.name} (•••• ${credential.keyHint})` : credential.name
              }))}
              value={credentialId}
              onValueChange={setCredentialId}
            />
          </Field>
        )}
      </Fieldset>
      <Field
        label="Concurrent requests"
        description="At most this many requests at once; more wait their turn. Empty: no limit."
        error={shown(problems.maxConcurrent)}
      >
        <Input value={maxConcurrent} onValueChange={setMaxConcurrent} inputMode="numeric" className="sm:max-w-32" />
      </Field>
      <ErrorAlert error={action.error} title="The connection wasn't created" />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" variant="primary" pending={action.pending}>
          Create connection
        </Button>
        <Link to="/settings/connections" className={buttonClass("ghost")}>
          Cancel
        </Link>
      </div>
    </form>
  )
}

export function NewConnectionPage() {
  useTitle("New connection")
  return (
    <Card>
      <CardHeader title="New connection" />
      <AsyncView atom={kindsAtom}>
        {(kinds) => (
          <AsyncView atom={credentialsAtom}>
            {(credentials) => <NewConnectionForm kinds={kinds} credentials={credentials} />}
          </AsyncView>
        )}
      </AsyncView>
    </Card>
  )
}
