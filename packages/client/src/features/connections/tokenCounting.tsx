// A connection's opt-in to counting the editors' text with its provider (owner, 2026-11-02:
// "I think this isn't a good idea to do behind the user's back, especially given varying
// retention policies… We probably should support it but not do it by default"). Off by
// default; the explanation says plainly that the text being counted goes to the provider.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { ErrorAlert, useAction } from "../../actions.tsx"
import { AppClient } from "../../rpc.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Card, CardHeader } from "../../ui/Surface.tsx"
import type { ConnectionSectionProps } from "./detail.tsx"

const countingAtom = AppClient.query("GetTokenCounting", undefined, { reactivityKeys: ["settings"] })

const SENDS =
  "On, the text whose tokens the editors count (a card's fields as you type them, a preset's prompts) is sent to this provider's token-counting endpoint, where it has one (Anthropic, Google Gemini, OpenAI's own API), under that provider's retention policy. Off, counts are made on this server: exact for OpenAI's models, approximate (o200k_base, marked ~) for the others."

export function TokenCountingSection({ connection }: ConnectionSectionProps) {
  const counting = useAtomValue(countingAtom)
  const action = useAction()
  if (!AsyncResult.isSuccess(counting)) return null
  const on = counting.value.includes(connection.id)
  return (
    <Card>
      <CardHeader
        title="Token counts"
        description="How the editors count tokens when this connection's model is the one chats use."
      />
      <Switch
        checked={on}
        disabled={action.pending}
        hint={SENDS}
        description="On, the text whose tokens the editors count is sent to this provider. Off, it's counted on this server."
        onCheckedChange={(enabled) =>
          void action.run(
            (client) => client("SetTokenCounting", { connectionId: connection.id, enabled }),
            ["settings"]
          )
        }
      >
        Count with the provider (sends the text to it)
      </Switch>
      <ErrorAlert error={action.error} title="Couldn't change it" />
    </Card>
  )
}
