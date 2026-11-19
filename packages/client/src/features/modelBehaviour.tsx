// Settings → Models → Reply behaviour (spec/REPLY-CONTRACT.md §3.6, milestone 4): per model, how
// its story replies under the send tool met the contract, over every reply that reached an
// outcome: how often the app had to ask for the reply to be sent, and what came of it.
import type { ModelBehaviour } from "@dreamspan/shared/agent.ts"
import { AsyncView } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { routes } from "../routes.tsx"
import { Card, CardHeader, EmptyState } from "../ui/Surface.tsx"
import { modelValue, useModelChoices } from "./chat/modelChoices.ts"
import { useTitle } from "./shell.tsx"

const behaviourAtom = AppClient.query("GetModelBehaviour", undefined, { reactivityKeys: ["model-behaviour"] })

const share = (n: number, of: number) => (of === 0 ? "" : ` (${Math.round((n / of) * 100)}%)`)

/** One figure: its count, its share of the model's replies, and what it counts. */
function Figure({ label, n, of }: { label: string; n: number; of?: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm text-text tabular-nums">
        {n.toLocaleString()}
        {of === undefined ? "" : <span className="text-muted">{share(n, of)}</span>}
      </dd>
    </div>
  )
}

function Rows({ rows }: { rows: ReadonlyArray<ModelBehaviour> }) {
  const choices = useModelChoices(
    rows.length > 0,
    rows.map((r) => modelValue(r.connectionId, r.modelId))
  )
  if (rows.length === 0)
    return (
      <EmptyState title="No replies counted yet">
        <p>Counts appear here once replies with tools are given through the send tool.</p>
      </EmptyState>
    )
  return (
    <ul className="flex flex-col divide-y divide-border">
      {rows.map((row) => {
        const choice = choices.find((c) => c.value === modelValue(row.connectionId, row.modelId))
        return (
          <li key={`${row.connectionId} ${row.modelId}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{choice?.name ?? row.modelKey}</span>
              <span className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">{row.connectionName}</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
              <Figure label="Replies" n={row.replies} />
              <Figure label="Asked to send" n={row.nudged} of={row.replies} />
              <Figure label="Sent after asking" n={row.recovered} of={row.replies} />
              <Figure label="Silent after asking" n={row.gaveUp} of={row.replies} />
              <Figure label="Never sent" n={row.exhausted} of={row.replies} />
            </dl>
          </li>
        )
      })}
    </ul>
  )
}

function ModelBehaviourPage() {
  useTitle("Reply behaviour")
  return (
    <Card>
      <CardHeader
        center
        title="Reply behaviour"
        about="How each model gives its replies with tools on. The reply must be sent with the send tool; when a model writes text instead, the app asks it to send, up to three times. Asked to send: replies where the app had to ask. Sent after asking: those then sent. Silent after asking: those where the character then stayed silent. Never sent: those that failed after the third ask. A reply carried on with Resume counts once."
      />
      <AsyncView atom={behaviourAtom}>{(rows) => <Rows rows={rows} />}</AsyncView>
    </Card>
  )
}

export const register = () =>
  routes.register({
    id: "settings.model-behaviour",
    parent: "settings",
    path: "model-behaviour",
    component: ModelBehaviourPage,
    nav: {
      label: "Reply behaviour",
      order: 27,
      group: "models",
      description: "How each model gives its replies with tools on: how often it had to be asked to send."
    }
  })
