import { CostSettings, type CostRule, type CostRates } from "@rp/shared/costFormulas.ts"
import type { Connection } from "@rp/shared/providers.ts"
import { Schema } from "effect"
import { useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { routes } from "../routes.tsx"
import { Button } from "../ui/Button.tsx"
import { Field, Input } from "../ui/Field.tsx"
import { Select } from "../ui/Select.tsx"
import { Alert, Card, CardHeader } from "../ui/Surface.tsx"
import { useUserDraft, UserDraftStatus } from "./editor/userDraft.tsx"
import { useTitle } from "./shell.tsx"

const settingsAtom = AppClient.query("GetCostSettings", undefined, { reactivityKeys: ["costs"] })
const connectionsAtom = AppClient.query("ListConnections", undefined, { reactivityKeys: ["connections"] })
const zero: CostRates = { input: 0, read: 0, write: 0, writeLong: 0, output: 0 }
const labels = {
  input: "Uncached input",
  read: "Cache read",
  write: "Cache write",
  writeLong: "Long cache write",
  output: "Output"
}
function Rates({ rates, change }: { rates: CostRates; change: (rates: CostRates) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {(Object.keys(labels) as Array<keyof CostRates>).map((key) => (
        <Field key={key} label={labels[key]}>
          <Input
            type="number"
            min={0}
            max={1e9}
            step="any"
            required
            value={rates[key]}
            onValueChange={(value) => change({ ...rates, [key]: Number(value) })}
          />
        </Field>
      ))}
    </div>
  )
}
function CostForm({ settings, connections }: { settings: CostSettings; connections: ReadonlyArray<Connection> }) {
  const durable = useUserDraft("cost-settings", "Pricing rules", JSON.stringify(settings))
  const values = JSON.parse(durable.text) as CostSettings
  const action = useAction()
  const [message, setMessage] = useState<string | null>(null)
  const edit = (rules: ReadonlyArray<CostRule>) => {
    setMessage(null)
    durable.setText(JSON.stringify({ ...values, rules }))
  }
  const update = (index: number, change: Partial<CostRule>) =>
    edit(values.rules.map((r, i) => (i === index ? { ...r, ...change } : r)))
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault()
        const decoded = Schema.decodeUnknownExit(CostSettings)(values)
        if (decoded._tag === "Failure") {
          setMessage(
            "Check the model, name, currency and rates. Rates must be finite and non-negative; use at most 100 formulas and 16 distinct context thresholds each."
          )
          return
        }
        let revision = values.revision
        const ok = await durable.commit(
          durable.text,
          async () => {
            const result = await action.run(
              (client) => client("SetCostSettings", { expectedRevision: values.revision, rules: values.rules }),
              ["costs"]
            )
            if (result.ok) revision = result.value.revision
            return result.ok
          },
          (text) => JSON.stringify({ ...JSON.parse(text), revision })
        )
        if (ok) setMessage("Saved. New requests use these prices; past costs stay as recorded.")
      }}
    >
      <p className="text-sm text-muted">
        Prices per million tokens. The model must match exactly. Optional conditions narrow the match; connection
        conditions take precedence, then upstream, then provider. The last rule breaks ties. Currency is a label;
        nothing is converted.
      </p>
      <UserDraftStatus draft={durable} />
      {values.revision !== settings.revision && (
        <Alert>
          <p>
            Pricing changed in another tab. Your draft is based on version {values.revision}; the saved version is{" "}
            {settings.revision}.
          </p>
          <p>Saved formulas: {settings.rules.map((r) => r.name).join(", ") || "None"}.</p>
          <Button
            hint="Your rules replace the newer saved ones when you save."
            onClick={() => durable.setText(JSON.stringify({ ...values, revision: settings.revision }))}
          >
            Keep my rules on the latest version
          </Button>
        </Alert>
      )}
      <fieldset disabled={!durable.ready || action.pending} className="flex min-w-0 flex-col gap-5">
        {values.rules.map((rule, index) => (
          <section
            key={rule.id}
            aria-label={`Formula ${index + 1}`}
            className="flex min-w-0 flex-col gap-4 rounded-lg border border-border p-4"
          >
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <h2 className="min-w-0 font-semibold [overflow-wrap:anywhere]">{rule.name || "New formula"}</h2>
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => edit(values.rules.filter((_, i) => i !== index))}
              >
                Remove formula
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input required maxLength={160} value={rule.name} onValueChange={(name) => update(index, { name })} />
              </Field>
              <Field label="Model" description="Exact provider model ID.">
                <Input
                  required
                  maxLength={160}
                  value={rule.model}
                  onValueChange={(model) => update(index, { model })}
                />
              </Field>
              <Field label="Provider kind" description="Optional, for example openrouter. Blank matches any.">
                <Input
                  maxLength={160}
                  value={rule.kind ?? ""}
                  onValueChange={(kind) => update(index, { kind: kind || null })}
                />
              </Field>
              <Field label="Connection">
                <Select
                  value={rule.connectionId ?? ""}
                  items={[
                    { value: "", label: "Any connection" },
                    ...connections.map((c) => ({ value: c.id, label: c.name })),
                    ...(rule.connectionId && !connections.some((c) => c.id === rule.connectionId)
                      ? [{ value: rule.connectionId, label: "Unavailable connection" }]
                      : [])
                  ]}
                  onValueChange={(connectionId) =>
                    update(index, { connectionId: (connectionId as Connection["id"]) || null })
                  }
                />
              </Field>
              <Field label="Upstream" description="Optional exact route reported by the provider.">
                <Input
                  maxLength={160}
                  value={rule.upstream ?? ""}
                  onValueChange={(upstream) => update(index, { upstream: upstream || null })}
                />
              </Field>
              <Field label="Currency label">
                <Input
                  required
                  maxLength={16}
                  value={rule.currency}
                  onValueChange={(currency) => update(index, { currency })}
                />
              </Field>
            </div>
            <p className="text-sm text-muted">Base rates, per million tokens. Output includes reasoning tokens.</p>
            <Rates rates={rule.rates} change={(rates) => update(index, { rates })} />
            {rule.tiers.map((tier, ti) => (
              <fieldset key={ti} className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm">Context tier {ti + 1}</legend>
                <Field
                  label="Total input above"
                  description="Uncached input + cache reads + cache writes. The highest exceeded threshold prices the whole request."
                >
                  <Input
                    type="number"
                    min={0}
                    max={1e9}
                    step={1}
                    required
                    value={tier.above}
                    onValueChange={(value) =>
                      update(index, {
                        tiers: rule.tiers.map((t, i) => (i === ti ? { ...t, above: Number(value) } : t))
                      })
                    }
                  />
                </Field>
                <Rates
                  rates={tier.rates}
                  change={(rates) =>
                    update(index, { tiers: rule.tiers.map((t, i) => (i === ti ? { ...t, rates } : t)) })
                  }
                />
                <Button variant="ghost" onClick={() => update(index, { tiers: rule.tiers.filter((_, i) => i !== ti) })}>
                  Remove tier
                </Button>
              </fieldset>
            ))}
            <div>
              <Button
                disabled={rule.tiers.length >= 16}
                hint="Other rates for requests whose total input is above a size you set."
                onClick={() => update(index, { tiers: [...rule.tiers, { above: 128000, rates: rule.rates }] })}
              >
                Add context tier
              </Button>
            </div>
          </section>
        ))}
        {values.rules.length === 0 && (
          <p className="text-sm text-muted">
            No custom formulas. Provider-reported costs and built-in model prices apply.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={values.rules.length >= 100}
            hint="Your own prices for one model, which win over the provider’s and the built-in ones."
            onClick={() =>
              edit([
                ...values.rules,
                {
                  id: crypto.randomUUID(),
                  name: "New formula",
                  kind: null,
                  connectionId: null,
                  model: "",
                  upstream: null,
                  currency: "USD",
                  rates: zero,
                  tiers: []
                }
              ])
            }
          >
            Add formula
          </Button>
          <Button type="submit" variant="primary" pending={action.pending}>
            Save pricing
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void durable.discard()
              setMessage(null)
            }}
          >
            Discard changes
          </Button>
        </div>
      </fieldset>
      <ErrorAlert error={action.error} title="Pricing wasn't saved" />
      {message && <Alert>{message}</Alert>}
      <p className="text-sm text-muted">
        Summary spending caps count each request at the most it could cost. An unknown price or mixed currencies pause
        capped work.
      </p>
    </form>
  )
}
function CostPage() {
  useTitle("Costs")
  return (
    <Card>
      <CardHeader
        title="Costs"
        description="Your prices for model requests, including replies, summaries and retries."
      />
      <AsyncView atom={settingsAtom}>
        {(settings) => (
          <AsyncView atom={connectionsAtom}>
            {(connections) => <CostForm settings={settings} connections={connections} />}
          </AsyncView>
        )}
      </AsyncView>
    </Card>
  )
}
export const register = () =>
  routes.register({
    id: "settings.costs",
    parent: "settings",
    path: "costs",
    component: CostPage,
    nav: {
      label: "Costs",
      order: 25,
      description: "Your prices for model requests, for counting what replies and summaries cost."
    }
  })
