import { Tooltip } from "../../ui/Tooltip.tsx"
import { useUserDraft, UserDraftNotices } from "../editor/userDraft.tsx"
import { StSettingsImporter } from "./StSettingsImport.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
// The connection list and the form for a new connection.
import { providerBaseUrl } from "@rp/shared/providerDefinitions.ts"
import type { Credential, CredentialId, ProviderInfo } from "@rp/shared/providers.ts"
import { originOf } from "@rp/shared/providers.ts"
import { Link, useNavigate } from "@tanstack/react-router"
import { type FormEvent, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../../actions.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Field, focusFirstInvalid, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Badge, Card, CardHeader, EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import { effectiveOrigin, freshConnections, parseOptionalInt, providerLabel, providerSetupAtom } from "./data.ts"
import {
  AwsKeyFields,
  awsKey,
  KeyTypeField,
  parseProviderDraft,
  ProviderAdvanced,
  type ProviderDraft,
  RegionField
} from "./providerFields.tsx"

export function ConnectionsPage() {
  useTitle("Connections")
  const [importing, setImporting] = useState(false)
  const action = useAction()
  const navigate = useNavigate()
  return (
    <Card>
      <CardHeader
        center
        title="Connections"
        actions={
          <>
            <Button
              hint="Makes a connection from an ST preset’s API type, address and model. Keys aren’t read."
              onClick={() => setImporting(true)}
            >
              Import connection settings
            </Button>
            <Tooltip label="Opens a form to create a connection.">
              <Link to="/settings/connections/new" className={buttonClass("primary")}>
                New connection
              </Link>
            </Tooltip>
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
        {({ kinds, providers, connections }) =>
          connections.length === 0 ? (
            <EmptyState title="No connections yet">
              <p>Add one to reach a model provider or a local server.</p>
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {connections.map((connection) => (
                <li key={connection.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tooltip label="Opens this connection’s settings.">
                      <Link
                        to="/settings/connections/$connectionId"
                        params={{ connectionId: connection.id }}
                        className="font-medium text-accent underline-offset-4 hover:underline"
                      >
                        {connection.name}
                      </Link>
                    </Tooltip>
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
                    {providerLabel(connection, { kinds, providers })} ·{" "}
                    {effectiveOrigin(connection, { kinds, providers }) ?? "no address"}
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

/** The form as its draft keeps it. */
interface NewConnectionDraft {
  readonly providerId: string
  /** The API type, as a provider kind; empty for the provider's first. */
  readonly apiId: string
  readonly name: string
  readonly baseUrl: string
  readonly maxConcurrent: string
  readonly cacheTtlS: string
  readonly provider: ProviderDraft
}

const blankDraft = (providers: ReadonlyArray<ProviderInfo>): NewConnectionDraft => ({
  providerId: providers[0]?.id ?? "",
  apiId: "",
  name: "",
  baseUrl: "",
  maxConcurrent: "",
  cacheTtlS: "",
  provider: {}
})

const noKeys = { apiKey: true, accessKeyId: true, secretAccessKey: true }

function NewConnectionForm({
  providers,
  credentials
}: {
  providers: ReadonlyArray<ProviderInfo>
  credentials: ReadonlyArray<Credential>
}) {
  const navigate = useNavigate()
  const action = useAction()
  const durable = useUserDraft("connection:new", "Settings", JSON.stringify(blankDraft(providers)))
  // A draft saved before providers were the first choice lacks these fields.
  const values: NewConnectionDraft = {
    ...blankDraft(providers),
    ...(JSON.parse(durable.text) as Partial<NewConnectionDraft>)
  }
  const edit = (change: Partial<NewConnectionDraft>) => durable.setText(JSON.stringify({ ...values, ...change }))
  const [keyMode, setKeyMode] = useState<KeyMode>("typed")
  const [keyEmpty, setKeyEmpty] = useState(noKeys)
  const [credentialId, setCredentialId] = useState<CredentialId | null>(credentials[0]?.id ?? null)
  const [submitted, setSubmitted] = useState(false)

  const provider = providers.find((entry) => entry.id === values.providerId) ?? providers[0]
  const api = provider?.apis.find((entry) => entry.id === values.apiId) ?? provider?.apis[0]
  const parsed = parseProviderDraft(provider, values.provider)
  const aws = parsed.settings.auth === "aws-sigv4"
  const defaultUrl = provider ? providerBaseUrl(provider, parsed.settings) : null
  const origin = originOf(values.baseUrl.trim() || defaultUrl || "")
  const concurrency = parseOptionalInt(values.maxConcurrent, 1)
  const ttl = parseOptionalInt(values.cacheTtlS, 1)
  // Left empty, the name is the provider's, or the server's address when one is typed.
  const host = values.baseUrl.trim() !== "" && origin !== null ? new URL(origin).host : null
  const defaultName = host ?? provider?.label ?? ""
  const example = provider?.baseUrlExample ?? "http://localhost:8000/v1"
  const keyMissing = aws ? keyEmpty.accessKeyId || keyEmpty.secretAccessKey : keyEmpty.apiKey
  const problems = {
    name: values.name.trim() === "" && defaultName === "" ? "Give the connection a name." : null,
    region: parsed.problems.region,
    baseUrl:
      values.baseUrl.trim() === ""
        ? defaultUrl === null
          ? `Enter the server’s address, such as ${example}.`
          : null
        : originOf(values.baseUrl.trim()) === null
          ? `Enter a full URL, such as ${example}.`
          : null,
    apiKey:
      keyMode === "typed" && keyMissing && !provider?.keyOptional
        ? credentials.length > 0
          ? "Enter the key, or use a saved one."
          : "Enter the key."
        : null,
    maxConcurrent: concurrency.problem,
    maxMarkers: parsed.problems.maxMarkers,
    minTokens: parsed.problems.minTokens,
    cacheTtlS: ttl.problem
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitted(true)
    if (!provider || !api) return
    if (Object.values(problems).some((problem) => problem !== null)) return focusFirstInvalid(event.currentTarget)
    const apiKey = aws ? awsKey(event.currentTarget) : formText(event.currentTarget, "apiKey")
    await durable.commit(durable.text, async () => {
      const result = await action.run(
        (client) =>
          client("CreateConnection", {
            provider: provider.id,
            kind: api.id,
            settings: {
              name: values.name.trim() || defaultName,
              baseUrl: values.baseUrl.trim() || null,
              compat: {},
              cacheTtlS: ttl.value,
              maxConcurrent: concurrency.value,
              presetOverrideRefId: null,
              providerSettings: parsed.changes
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
  const typed = (name: keyof typeof noKeys) => (empty: boolean) =>
    setKeyEmpty((current) => ({ ...current, [name]: empty }))
  const editProvider = (draft: ProviderDraft) => edit({ provider: draft })
  return (
    <Card>
      <CardHeader center inline title="New connection" />
      <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <UserDraftNotices draft={durable} />
        <Field
          label="Provider"
          about="Who serves the models. It sets up the address, the key and caching as that provider needs."
        >
          <Select
            items={providers.map((entry) => ({ value: entry.id, label: entry.label, description: entry.about }))}
            value={provider?.id ?? null}
            // Another provider starts from its own defaults.
            onValueChange={(providerId) => edit({ providerId, apiId: "", provider: {} })}
          />
        </Field>
        {provider && provider.apis.length > 1 && (
          <Field label="API type" about="How requests are sent. Each choice is explained in the list.">
            <Select
              items={provider.apis.map((entry) => ({ value: entry.id, label: entry.label, description: entry.about }))}
              value={api?.id ?? null}
              onValueChange={(apiId) => edit({ apiId })}
            />
          </Field>
        )}
        <Field label="Name" about="Empty uses the name shown in the box." error={shown(problems.name)}>
          <Input
            value={values.name}
            onValueChange={(name) => edit({ name })}
            placeholder={defaultName}
            autoComplete="off"
          />
        </Field>
        {provider && (
          <RegionField
            provider={provider}
            draft={values.provider}
            onChange={editProvider}
            error={shown(problems.region)}
          />
        )}
        <Field
          label="Base URL"
          about={
            defaultUrl === null
              ? "The server’s address, up to where its API starts."
              : "Connect to this address instead of the provider’s default. Empty uses the default."
          }
          error={shown(problems.baseUrl)}
        >
          <Input
            value={values.baseUrl}
            onValueChange={(baseUrl) => edit({ baseUrl })}
            placeholder={defaultUrl ?? example}
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        {provider && keyMode === "typed" && (
          <KeyTypeField provider={provider} draft={values.provider} onChange={editProvider} />
        )}
        <div className="flex flex-col gap-2">
          {keyMode === "saved" ? (
            <Field label="API key" about="A saved key is sent only to the addresses it was allowed for.">
              <Select
                items={credentials.map((credential) => ({
                  value: credential.id,
                  label: credential.keyHint ? `${credential.name} (•••• ${credential.keyHint})` : credential.name
                }))}
                value={credentialId}
                onValueChange={setCredentialId}
              />
            </Field>
          ) : aws ? (
            <AwsKeyFields origin={origin} error={shown(problems.apiKey)} onEmptyChange={typed} />
          ) : (
            <Field
              label="API key"
              about={
                provider?.auth.find((choice) => choice.id === parsed.settings.auth)?.about ?? provider?.auth[0]?.about
              }
              description={
                provider?.keyOptional ? `Optional: leave it empty for a server that takes none. ${sentTo}` : sentTo
              }
              error={shown(problems.apiKey)}
            >
              <SecretInput name="apiKey" onEmptyChange={typed("apiKey")} />
            </Field>
          )}
          {credentials.length > 0 && (
            <Tooltip label={keyMode === "typed" ? "Click to choose a saved key." : "Click to enter a new key."}>
              <button
                type="button"
                className="self-start text-sm text-accent underline-offset-4 hover:underline"
                onClick={() => {
                  setKeyMode(keyMode === "typed" ? "saved" : "typed")
                  setKeyEmpty(noKeys)
                }}
              >
                {keyMode === "typed" ? "Use a saved key instead" : "Enter a new key instead"}
              </button>
            </Tooltip>
          )}
        </div>
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
        {provider && (
          <ProviderAdvanced
            provider={provider}
            draft={values.provider}
            onChange={editProvider}
            problems={{
              region: null,
              maxMarkers: shown(problems.maxMarkers),
              minTokens: shown(problems.minTokens)
            }}
            cacheTtl={{
              value: values.cacheTtlS,
              onChange: (cacheTtlS) => edit({ cacheTtlS }),
              error: shown(problems.cacheTtlS)
            }}
          />
        )}
        <ErrorAlert error={action.error} title="The connection wasn't created" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button hint="Creates the connection." type="submit" variant="primary" pending={action.pending}>
            Create connection
          </Button>
          <Tooltip label="Returns to Connections without creating a connection.">
            <Link to="/settings/connections" className={buttonClass("ghost")}>
              Cancel
            </Link>
          </Tooltip>
        </div>
      </form>
    </Card>
  )
}

export function NewConnectionPage() {
  useTitle("New connection")
  return (
    <AsyncView atom={providerSetupAtom}>
      {({ providers, credentials }) => <NewConnectionForm providers={providers} credentials={credentials} />}
    </AsyncView>
  )
}
