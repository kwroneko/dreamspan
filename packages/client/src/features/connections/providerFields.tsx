// A provider's settings in the connection forms (providerDefinitions.ts): the region and key type
// fields a provider needs, and the advanced section with each setting it sets up, shown at the
// provider's default until the user changes it, and how it counts tokens. A connection stores
// only the changes.
import { awsRegionOf, providerChanges } from "@rp/shared/providerDefinitions.ts"
import type { ProviderInfo, ProviderSettings } from "@rp/shared/providers.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Field, Fieldset, formText, Input, SecretInput } from "../../ui/Field.tsx"
import { Select } from "../../ui/Select.tsx"
import { Disclosure } from "../../ui/Surface.tsx"
import { useState } from "react"
import { parseOptionalInt } from "./data.ts"

/** The provider settings as the form holds them: only what the user changed, numbers as typed. */
export interface ProviderDraft {
  readonly auth?: string
  readonly region?: string
  readonly project?: string
  readonly cacheBreakpoints?: "auto" | "explicit" | "none"
  readonly lookback?: boolean
  readonly maxMarkers?: string
  readonly minTokens?: string
  readonly promptCacheKey?: boolean
}

/** A connection's stored changes as a draft. */
export const providerDraftOf = ({ maxMarkers, minTokens, ...settings }: ProviderSettings): ProviderDraft => ({
  ...settings,
  ...(maxMarkers !== undefined ? { maxMarkers: String(maxMarkers) } : {}),
  ...(minTokens !== undefined ? { minTokens: String(minTokens) } : {})
})

/** AWS's Region codes, for a provider that doesn't say how its regions are written. */
const awsRegions = { example: "eu-west-1", pattern: "^[a-z]{2}(?:-[a-z]+)+-\\d+$" }

/** A Google Cloud project ID: 6 to 30 lowercase letters, digits and hyphens, from a letter. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

/** The settings in effect, the changes to store, and what's wrong with what's typed. */
export const parseProviderDraft = (provider: ProviderInfo | undefined, draft: ProviderDraft) => {
  // An emptied or mistyped number stays at the provider's default.
  const number = (text: string | undefined) =>
    text === undefined ? { value: null, problem: null } : parseOptionalInt(text, 1)
  const maxMarkers = number(draft.maxMarkers)
  const minTokens = number(draft.minTokens)
  const region = draft.region?.trim() ?? ""
  const regions = provider?.regionFormat ?? awsRegions
  const project = draft.project?.trim() ?? ""
  const settings: ProviderSettings = {
    ...provider?.defaults,
    ...(draft.auth !== undefined ? { auth: draft.auth } : {}),
    ...(region !== "" ? { region } : {}),
    ...(project !== "" ? { project } : {}),
    ...(draft.cacheBreakpoints !== undefined ? { cacheBreakpoints: draft.cacheBreakpoints } : {}),
    ...(draft.lookback !== undefined ? { lookback: draft.lookback } : {}),
    ...(maxMarkers.value !== null ? { maxMarkers: maxMarkers.value } : {}),
    ...(minTokens.value !== null ? { minTokens: minTokens.value } : {}),
    ...(draft.promptCacheKey !== undefined ? { promptCacheKey: draft.promptCacheKey } : {})
  }
  return {
    settings,
    changes: providerChanges(provider, settings),
    problems: {
      region:
        region !== "" && !new RegExp(regions.pattern).test(region)
          ? `Enter a region code, such as ${regions.example}.`
          : null,
      project: project !== "" && !PROJECT.test(project) ? "Enter a project ID, such as my-project-123456." : null,
      maxMarkers: maxMarkers.problem,
      minTokens: minTokens.problem
    }
  }
}

type Problems = ReturnType<typeof parseProviderDraft>["problems"]

/** The provider's Region field, for a provider whose address names one. */
export function RegionField({
  provider,
  draft,
  onChange,
  error
}: {
  provider: ProviderInfo
  draft: ProviderDraft
  onChange: (draft: ProviderDraft) => void
  error: string | null
}) {
  if (!provider.settings.includes("region")) return null
  const placeholder = provider.defaults.region ?? (provider.baseUrl && awsRegionOf(provider.baseUrl)) ?? undefined
  return (
    <Field
      label="Region"
      about={
        provider.regionFormat?.about ??
        "The AWS Region your models run in, such as eu-west-1. It sets the address. Empty uses the one shown."
      }
      error={error}
    >
      <Input
        value={draft.region ?? ""}
        onValueChange={(region) => onChange({ ...draft, region })}
        placeholder={placeholder}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        className="sm:max-w-48"
      />
    </Field>
  )
}

/** The Google Cloud project, for a provider whose requests name one (Vertex AI). */
export function ProjectField({
  provider,
  draft,
  onChange,
  error,
  keyProject
}: {
  provider: ProviderInfo
  draft: ProviderDraft
  onChange: (draft: ProviderDraft) => void
  error: string | null
  /** The project the loaded key file names, if any. */
  keyProject?: string | null
}) {
  if (!provider.settings.includes("project")) return null
  return (
    <Field
      label="Project"
      about="The Google Cloud project ID your requests are billed to. Empty uses the project the key file names."
      error={error}
    >
      <Input
        value={draft.project ?? ""}
        onValueChange={(project) => onChange({ ...draft, project })}
        placeholder={keyProject ?? "From the key file"}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        className="sm:max-w-64"
      />
    </Field>
  )
}

/** What a service account key file shows about itself; null when the text isn't one. */
const serviceAccountOf = (text: string): { email: string; project: string | null } | null => {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") return null
    if (parsed.type !== undefined && parsed.type !== "service_account") return null
    return { email: parsed.client_email, project: typeof parsed.project_id === "string" ? parsed.project_id : null }
  } catch {
    return null
  }
}

/**
 * A service account's JSON key file, read in the browser and sent with the form as `apiKey` (a
 * hidden field), so it's never part of the saved draft.
 */
export function ServiceAccountKeyField({
  about,
  origin,
  error,
  onLoad
}: {
  about: string | undefined
  origin: string | null
  error: string | null
  /** The file's account, or null when none is loaded or it isn't a key file. */
  onLoad: (account: { email: string; project: string | null } | null) => void
}) {
  const [key, setKey] = useState<{ text: string; email: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <Field
      label="Service account key"
      about={about}
      description={
        key
          ? `Loaded: ${key.email}. Used only for ${origin ?? "this connection"}, and never shown again.`
          : "The JSON key file from Google Cloud’s IAM page. Never shown again."
      }
      error={problem ?? error}
    >
      <Input
        type="file"
        accept=".json,application/json"
        className="py-1.5 leading-5"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0]
          setKey(null)
          setProblem(null)
          onLoad(null)
          if (!file) return
          const text = file.size > 100_000 ? "" : await file.text().catch(() => "")
          const account = serviceAccountOf(text)
          if (!account) {
            setProblem("This file isn’t a service account’s JSON key.")
            return
          }
          setKey({ text: text.trim(), email: account.email })
          onLoad(account)
        }}
      />
      <input type="hidden" name="apiKey" value={key?.text ?? ""} />
    </Field>
  )
}

/** How the key signs requests, for a provider that takes more than one kind of key. */
export function KeyTypeField({
  provider,
  draft,
  onChange,
  about = "The kind of key you have. Each choice is explained in the list."
}: {
  provider: ProviderInfo
  draft: ProviderDraft
  onChange: (draft: ProviderDraft) => void
  about?: string
}) {
  if (provider.auth.length < 2) return null
  return (
    <Field label="Key type" about={about}>
      <Select
        items={provider.auth.map((choice) => ({ value: choice.id, label: choice.label, description: choice.about }))}
        value={draft.auth ?? provider.defaults.auth ?? provider.auth[0]!.id}
        onValueChange={(auth) => onChange({ ...draft, auth })}
      />
    </Field>
  )
}

/** An AWS access key as a connection stores it: the ID and secret, and a temporary key's session token. */
export const awsKey = (form: HTMLFormElement) => {
  const [id = "", secret = "", token = ""] = ["accessKeyId", "secretAccessKey", "sessionToken"].map((name) =>
    formText(form, name).trim()
  )
  return id === "" && secret === "" ? "" : [id, secret, ...(token === "" ? [] : [token])].join(":")
}

/** The fields of an AWS access key, read with `awsKey`. The secret only signs requests. */
export function AwsKeyFields({
  origin,
  error,
  onEmptyChange
}: {
  origin: string | null
  error: string | null
  onEmptyChange: (name: "accessKeyId" | "secretAccessKey") => (empty: boolean) => void
}) {
  return (
    <Fieldset
      legend="AWS access key"
      about="An IAM user’s or role’s access key. Requests are signed with it; the secret itself is never sent."
      description={origin ? `Used only for ${origin}, and never shown again.` : "Never shown again."}
    >
      <Field label="Access key ID" about="The key’s ID, such as AKIA… or ASIA…." error={error}>
        <SecretInput name="accessKeyId" masked={false} onEmptyChange={onEmptyChange("accessKeyId")} />
      </Field>
      <Field label="Secret access key" about="The secret shown once, when the key was made.">
        <SecretInput name="secretAccessKey" onEmptyChange={onEmptyChange("secretAccessKey")} />
      </Field>
      <Field label="Session token" about="Only for a temporary key. Empty for a long-term one.">
        <SecretInput name="sessionToken" />
      </Field>
    </Fieldset>
  )
}

const breakpointItems = [
  {
    value: "auto" as const,
    label: "Automatic",
    description: "One marker where the reusable part of the request ends."
  },
  {
    value: "explicit" as const,
    label: "Each section",
    description: "A marker after the prompt, the summaries and the history, so each part is reused on its own."
  },
  { value: "none" as const, label: "None", description: "No cache markers. Providers that need them cache nothing." }
]

/** A provider's advanced section: its settings at their defaults until changed, and how it counts. */
export function ProviderAdvanced({
  provider,
  draft,
  onChange,
  problems,
  cacheTtl
}: {
  provider: ProviderInfo
  draft: ProviderDraft
  onChange: (draft: ProviderDraft) => void
  problems: Problems
  /** The connection's cache lifetime field, for providers that show it. */
  cacheTtl: { readonly value: string; readonly onChange: (value: string) => void; readonly error: string | null }
}) {
  const { settings } = parseProviderDraft(provider, draft)
  const shows = (name: string) => provider.settings.includes(name)
  // The Region, project and key type have fields of their own, outside this section.
  const own = ["auth", "region", "project"]
  const changed = Object.keys(draft).some((key) => !own.includes(key))
  const shown = provider.settings.filter((name) => !own.includes(name))
  if (shown.length === 0 && provider.accounting.length === 0 && provider.rules.length === 0) return null
  return (
    <Disclosure
      title="Advanced"
      hint={`Click to show what ${provider.label} sets up: caching and how tokens are counted.`}
    >
      {shows("cacheBreakpoints") && (
        <Field label="Cache markers" about="Where requests mark the parts the provider should keep for reuse.">
          <Select
            items={breakpointItems}
            value={settings.cacheBreakpoints ?? "auto"}
            onValueChange={(cacheBreakpoints) => onChange({ ...draft, cacheBreakpoints })}
          />
        </Field>
      )}
      {shows("lookback") && (
        <Switch
          checked={settings.lookback ?? true}
          onCheckedChange={(lookback) => onChange({ ...draft, lookback })}
          about="On: the provider finds a cached part before the newest marker. Off: it finds one only at a marker the last request also had, so that marker is sent again."
        >
          Finds earlier cached parts
        </Switch>
      )}
      {shows("promptCacheKey") && (
        <Switch
          checked={settings.promptCacheKey ?? false}
          onCheckedChange={(promptCacheKey) => onChange({ ...draft, promptCacheKey })}
          about="Sends the chat’s ID with each request, so one chat’s requests reach the same cache."
        >
          Send a cache key
        </Switch>
      )}
      {(shows("maxMarkers") || shows("minTokens")) && (
        <div className="grid gap-5 sm:grid-cols-2">
          {shows("maxMarkers") && (
            <Field
              label="Most cache markers"
              about="The most cache markers one request carries. Empty uses the provider’s limit."
              error={problems.maxMarkers}
            >
              <Input
                value={draft.maxMarkers ?? settings.maxMarkers?.toString() ?? ""}
                onValueChange={(maxMarkers) => onChange({ ...draft, maxMarkers })}
                inputMode="numeric"
              />
            </Field>
          )}
          {shows("minTokens") && (
            <Field
              label="Smallest cached size (tokens)"
              about="Shorter starts of a request aren’t cached, so the cache estimate counts none. Empty uses each model’s documented size."
              error={problems.minTokens}
            >
              <Input
                value={draft.minTokens ?? settings.minTokens?.toString() ?? ""}
                onValueChange={(minTokens) => onChange({ ...draft, minTokens })}
                inputMode="numeric"
                placeholder="By model"
              />
            </Field>
          )}
        </div>
      )}
      {shows("cacheTtlS") && (
        <Field
          label="Cache lifetime (seconds)"
          about="How long the provider keeps a request’s start ready for cheaper reuse. Empty uses each model’s default."
          description={provider.cacheLifetime ? `${provider.label}: ${provider.cacheLifetime}.` : undefined}
          error={cacheTtl.error}
        >
          <Input value={cacheTtl.value} onValueChange={cacheTtl.onChange} inputMode="numeric" className="sm:max-w-32" />
        </Field>
      )}
      {provider.accounting.length > 0 && <Facts title="How tokens are counted" items={provider.accounting} />}
      {provider.rules.length > 0 && <Facts title="Fixes for some models" items={provider.rules} />}
      {changed && (
        <Button
          variant="ghost"
          className="self-start"
          hint={`Puts these settings back to ${provider.label}’s defaults.`}
          onClick={() =>
            onChange({
              ...(draft.auth ? { auth: draft.auth } : {}),
              ...(draft.region ? { region: draft.region } : {}),
              ...(draft.project ? { project: draft.project } : {})
            })
          }
        >
          Use the defaults
        </Button>
      )}
    </Disclosure>
  )
}

function Facts({ title, items }: { title: string; items: ReadonlyArray<string> }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium text-text">{title}</p>
      <ul className="list-disc pl-5 text-sm text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
