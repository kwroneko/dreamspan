// The instance's outbound network settings, for admins (spec/PROVIDERS.md §6.2). The
// proxy is shown only as the server returns it: scheme, host and port.
import type { NetworkSettings } from "@dreamspan/shared/api.ts"
import { type FormEvent, useId, useState } from "react"
import { AsyncView, ErrorAlert, useAction } from "../actions.tsx"
import { routes } from "../routes.tsx"
import { AppClient } from "../rpc.ts"
import { Button } from "../ui/Button.tsx"
import { RadioGroup, Switch } from "../ui/Choice.tsx"
import { Field, Fieldset, formText, SecretInput, Textarea } from "../ui/Field.tsx"
import { Alert, Card, CardHeader } from "../ui/Surface.tsx"
import { useTitle } from "./shell.tsx"

const networkAtom = AppClient.query("GetNetworkSettings", undefined, { reactivityKeys: ["network"] })

type ProxyChange = "keep" | "replace" | "remove"

interface Draft {
  readonly proxy: ProxyChange
  readonly bypass: string
  readonly forceProxy: boolean
}

const draftOf = (settings: NetworkSettings): Draft => ({
  proxy: "keep",
  bypass: settings.bypass.join("\n"),
  forceProxy: settings.forceProxy
})

function NetworkForm({ settings }: { settings: NetworkSettings }) {
  const action = useAction()
  const proxyLegend = useId()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saved, setSaved] = useState(false)
  const values = draft ?? draftOf(settings)
  const edit = (change: Partial<Draft>) => {
    setSaved(false)
    setDraft({ ...values, ...change })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const proxyUrl = formText(event.currentTarget, "proxyUrl").trim()
    const bypass = values.bypass
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    const result = await action.run(
      (client) =>
        client("SetNetworkSettings", {
          ...(values.proxy === "replace" ? { proxyUrl } : {}),
          ...(values.proxy === "remove" ? { proxyUrl: null } : {}),
          bypass,
          forceProxy: values.forceProxy
        }),
      ["network"]
    )
    if (result.ok) {
      setDraft(null)
      setSaved(true)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Fieldset
        legend={<span id={proxyLegend}>Proxy</span>}
        description={
          settings.proxy === null ? (
            "No proxy is set: requests go direct."
          ) : (
            <>
              Requests go through <span className="font-mono">{settings.proxy}</span>. Any password in it is never
              shown.
            </>
          )
        }
      >
        <RadioGroup<ProxyChange>
          aria-labelledby={proxyLegend}
          value={values.proxy}
          onValueChange={(proxy) => edit({ proxy })}
          options={[
            { value: "keep", label: settings.proxy === null ? "No proxy" : "Keep this proxy" },
            { value: "replace", label: settings.proxy === null ? "Set a proxy" : "Replace it" },
            ...(settings.proxy === null
              ? []
              : [
                  {
                    value: "remove" as const,
                    label: "Remove it",
                    description: "Requests go direct, unless a connection sets its own proxy."
                  }
                ])
          ]}
        />
        {values.proxy === "replace" && (
          <Field label="Proxy URL" about="HTTP, HTTPS or SOCKS5, for example socks5://user:password@vpn:1080.">
            <SecretInput name="proxyUrl" masked={false} />
          </Field>
        )}
      </Fieldset>
      <Field
        label="Bypass list"
        about="Hosts that go direct, one per line: names, *.domain suffixes, IPs and CIDR ranges. Local networks are on it by default."
      >
        <Textarea value={values.bypass} onChange={(event) => edit({ bypass: event.target.value })} spellCheck={false} />
      </Field>
      <Switch
        checked={values.forceProxy}
        onCheckedChange={(forceProxy) => edit({ forceProxy })}
        about="Other users' connections can't go direct or through their own proxy. The bypass list still applies."
      >
        Require the proxy for everyone else
      </Switch>
      <ErrorAlert error={action.error} title="Not saved" />
      {saved && draft === null && <Alert tone="success">Saved.</Alert>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          hint="Saves the network settings."
          type="submit"
          variant="primary"
          pending={action.pending}
          disabled={draft === null}
        >
          Save
        </Button>
        {draft !== null && (
          <Button
            hint="Discards unsaved network changes."
            variant="ghost"
            onClick={() => {
              setDraft(null)
              action.clearError()
            }}
          >
            Discard changes
          </Button>
        )}
      </div>
    </form>
  )
}

function NetworkPage() {
  useTitle("Network")
  return (
    <Card>
      <CardHeader center title="Network" about="Each connection can override this." />
      <AsyncView atom={networkAtom}>{(settings) => <NetworkForm settings={settings} />}</AsyncView>
    </Card>
  )
}

export const register = () => {
  routes.register({
    id: "settings.network",
    parent: "settings",
    path: "network",
    component: NetworkPage,
    nav: { label: "Network", order: 30, adminOnly: true, description: "How the server reaches model providers." }
  })
}
