import { useUserDraft, UserDraftNotices, UserDraftUndo } from "../editor/userDraft.tsx"
import { StSettingsImporter } from "./StSettingsImport.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
// The connection list and the form for a new connection.
import type { Credential, CredentialId, ProviderKindInfo } from "@rp/shared/providers.ts"
import { originOf } from "@rp/shared/providers.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, focusFirstInvalid, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { effectiveOrigin, freshConnections, parseOptionalInt, providerSetupAtom } from "./data.ts"

export function ConnectionsPage() {
  useTitle("Connections")
  const [importing, setImporting] = useState(false)
  const action = useAction()
  const navigate = useNavigate()
  return (
    <Card>
      <CardHeader
        title="Connections"
        description="Each connection is one provider API at one address, with the key it sends."
        actions={
          <>
            <Button
              hint="Makes a connection from an ST preset’s API type, address and model. Keys aren’t read."
              onClick={() => setImporting(true)}
            >
              Import connection settings
            </Button>
            <Link to="/settings/connections/new" className={buttonClass("primary")}>
              New connection
            </Link>
          </>
        }
      />
      {importing && (
        <Dialog
          open
          onOpenChange={setImporting}
          title="Import connection settings"
          description="Import API type, URL and model name from a shared ST preset. Keys and passwords are ignored."
        >
          <StSettingsImporter
            surface="connection"
            apply={async (preview) => {
              const value = preview.connection
              if (!value) return
              const created = await action.run(
                (client) =>
                  client("CreateConnection", {
                    kind: value.kind,
                    settings: {
                      name: value.model ?? "Imported connection",
                      baseUrl: value.baseUrl,
                      compat: {},
                      cacheTtlS: null,
                      maxConcurrent: null,
                      presetOverrideRefId: null
                    }
                  }),
                ["connections"]
              )
              if (!created.ok) return
              if (value.model)
                await action.run(
                  (client) =>
                    client("AddUserModel", { connectionId: created.value.id, key: value.model!, overrides: {} }),
                  ["models"]
                )
              void navigate({ to: "/settings/connections/$connectionId", params: { connectionId: created.value.id } })
            }}
          />
          <ErrorAlert error={action.error} />
        </Dialog>
      )}
      <AsyncView atom={providerSetupAtom} loading="Loading connections…">
        {({ kinds, connections }) =>
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
    </Card>
  )
}

/** A key typed here, or one saved in Keys. An empty typed key means none, where the provider allows it. */
type KeyMode = "typed" | "saved"

function NewConnectionForm({
  kinds,
  credentials
}: {
  kinds: ReadonlyArray<ProviderKindInfo>
  credentials: ReadonlyArray<Credential>
}) {
  const navigate = useNavigate()
  const action = useAction()
  const durable = useUserDraft(
    "connection:new",
    "Settings",
    JSON.stringify({ name: "", baseUrl: "", kindId: kinds[0]?.id ?? "", maxConcurrent: "" })
  )
  const values = JSON.parse(durable.text) as { name: string; baseUrl: string; kindId: string; maxConcurrent: string }
  const { name, baseUrl, kindId, maxConcurrent } = values
  const edit = (change: Partial<typeof values>) => durable.setText(JSON.stringify({ ...values, ...change }))
  const setName = (name: string) => edit({ name })
  const setBaseUrl = (baseUrl: string) => edit({ baseUrl })
  const setKindId = (kindId: string) => edit({ kindId })
  const setMaxConcurrent = (maxConcurrent: string) => edit({ maxConcurrent })
  const [keyMode, setKeyMode] = useState<KeyMode>("typed")
  const [keyEmpty, setKeyEmpty] = useState(true)
  const [credentialId, setCredentialId] = useState<CredentialId | null>(credentials[0]?.id ?? null)
  const [submitted, setSubmitted] = useState(false)

  const kind = kinds.find((entry) => entry.id === kindId)
  const url = baseUrl.trim() || kind?.defaultBaseUrl || ""
  const origin = originOf(url)
  const concurrency = parseOptionalInt(maxConcurrent, 1)
  // Left empty, the name is the provider's, or the server's address when one is typed.
  const host = baseUrl.trim() !== "" && origin !== null ? new URL(origin).host : null
  const defaultName = host ?? kind?.label ?? ""
  const problems = {
    name: name.trim() === "" && defaultName === "" ? "Give the connection a name." : null,
    baseUrl: baseUrl.trim() !== "" && origin === null ? "Enter a full URL, such as http://localhost:8000/v1." : null,
    apiKey:
      keyMode === "typed" && keyEmpty && !kind?.keyOptional
        ? credentials.length > 0
          ? "Enter the key, or use a saved one."
          : "Enter the key."
        : null,
    maxConcurrent: concurrency.problem
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    const apiKey = formText(event.currentTarget, "apiKey")
    await durable.commit(durable.text, async () => {
      const result = await action.run(
        (client) =>
          client("CreateConnection", {
            kind: kindId,
            settings: {
              name: name.trim() || defaultName,
              baseUrl: baseUrl.trim() || null,
              compat: {},
              cacheTtlS: null,
              maxConcurrent: concurrency.value,
              presetOverrideRefId: null
            },
            ...(keyMode === "saved" ? { credentialId } : apiKey !== "" ? { apiKey } : {})
          }),
        ["connections", "credentials"]
      )
      if (result.ok) {
        // Its page fetches the model list at once (defaultModel.tsx).
        freshConnections.add(result.value.id)
        void navigate({ to: "/settings/connections/$connectionId", params: { connectionId: result.value.id } })
      }
      return result.ok
    })
  }

  const shown = (problem: string | null) => (submitted ? problem : null)
  const sentTo = origin ? `It's sent only to ${origin} and never shown again.` : "It's never shown again."
  return (
    <Card>
      <CardHeader inline title="New connection" actions={<UserDraftUndo draft={durable} />} />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <UserDraftNotices draft={durable} />
        <Field label="Provider">
          <Select
            items={kinds.map((entry) => ({ value: entry.id, label: entry.label }))}
            value={kindId}
            onValueChange={setKindId}
          />
        </Field>
        <Field label="Name" description="Optional: left empty, it's named as shown." error={shown(problems.name)}>
          <Input value={name} onValueChange={setName} placeholder={defaultName} autoComplete="off" />
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
        <div className="flex flex-col gap-2">
          {keyMode === "typed" ? (
            <Field
              label="API key"
              description={
                kind?.keyOptional ? `Optional: leave it empty for a local server that takes none. ${sentTo}` : sentTo
              }
              error={shown(problems.apiKey)}
            >
              <SecretInput name="apiKey" onEmptyChange={setKeyEmpty} />
            </Field>
          ) : (
            <Field label="API key" description="A saved key is sent only to the addresses it was allowed for.">
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
          {credentials.length > 0 && (
            <button
              type="button"
              className="self-start text-sm text-accent underline-offset-4 hover:underline"
              onClick={() => {
                setKeyMode(keyMode === "typed" ? "saved" : "typed")
                setKeyEmpty(true)
              }}
            >
              {keyMode === "typed" ? "Use a saved key instead" : "Enter a new key instead"}
            </button>
          )}
        </div>
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
    </Card>
  )
}

export function NewConnectionPage() {
  useTitle("New connection")
  return (
    <AsyncView atom={providerSetupAtom}>
      {({ kinds, credentials }) => <NewConnectionForm kinds={kinds} credentials={credentials} />}
    </AsyncView>
  )
}
