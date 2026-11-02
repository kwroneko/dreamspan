// How a connection counts tokens: the editors' text and the next request's images (owner,
// 2026-11-02: "NEVER send anything to providers users didn't actually choose to… It should
// also be possible to specify a separate token counting endpoint for a connection"; DESIGN §11).
// On this server by default; otherwise through this connection's provider, or through another
// of the user's connections used only for counting. The explanation names the provider that
// receives what is counted.
import { useAtomValue } from "@effect/atom-react"
import type { Connection, ConnectionId, ProviderKindInfo } from "@rp/shared/providers.ts"
import { AsyncResult } from "effect/reactivity"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Field } from "../../ui/Field.tsx"
import { Select, type SelectItem } from "../../ui/Select.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import { connectionsAtom, effectiveOrigin } from "./data.ts"
import type { ConnectionSectionProps } from "./detail.tsx"

const countingAtom = AppClient.query("GetTokenCounting", undefined, { reactivityKeys: ["settings"] })

const LOCAL = "local"

/** "Anthropic (https://api.anthropic.com)": the provider and where it is. */
const provider = (connection: Connection, kinds: ReadonlyArray<ProviderKindInfo>) => {
  const kind = kinds.find((k) => k.id === connection.kind)?.label ?? connection.kind
  const origin = effectiveOrigin(connection, kinds)
  return origin ? `${kind} (${origin})` : kind
}

const LOCAL_TEXT = "Counted on this server; nothing is sent. Some models' counts are close estimates, marked ~."

/** What choosing a way of counting sends, and to whom. */
const sends = (via: Connection, own: Connection, kinds: ReadonlyArray<ProviderKindInfo>) =>
  via.id === own.id
    ? `The text and images being counted are sent to ${provider(via, kinds)}, this connection's provider, under its retention policy.`
    : `The text and images being counted are sent to ${provider(via, kinds)} through “${via.name}”, under that provider's retention policy. Replies still go to this connection.`

export function TokenCountingSection({ connection, kinds }: ConnectionSectionProps) {
  const counting = useAtomValue(countingAtom)
  const connections = useAtomValue(connectionsAtom)
  const action = useAction()
  if (!AsyncResult.isSuccess(counting) || !AsyncResult.isSuccess(connections)) return null
  const via = counting.value.find((choice) => choice.connectionId === connection.id)?.via ?? null
  const others = connections.value.filter((c) => c.id !== connection.id)
  const byId = new Map(connections.value.map((c) => [c.id as string, c]))
  const items: Array<SelectItem<string>> = [
    { value: LOCAL, label: "Local estimate", description: LOCAL_TEXT },
    {
      value: connection.id,
      label: "This connection's provider",
      description: sends(connection, connection, kinds)
    },
    ...others.map((other) => ({
      value: other.id as string,
      label: `Another: ${other.name}`,
      description: sends(other, connection, kinds)
    }))
  ]
  const chosen = via ? byId.get(via) : undefined
  return (
    <Card>
      <CardHeader title="Token counts" about="Choose how to count tokens for this connection’s models." />
      <Field label="Count with" description={chosen ? sends(chosen, connection, kinds) : LOCAL_TEXT}>
        <Select
          items={items}
          value={chosen ? chosen.id : LOCAL}
          onValueChange={(next) =>
            void action.run(
              (client) =>
                client("SetTokenCounting", {
                  connectionId: connection.id,
                  via: next === LOCAL ? null : (next as ConnectionId)
                }),
              ["settings"]
            )
          }
        />
      </Field>
      <ErrorAlert error={action.error} title="Couldn't change it" />
    </Card>
  )
}
