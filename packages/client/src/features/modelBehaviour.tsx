// Settings → Models → Reply behaviour (spec/REPLY-CONTRACT.md §3.6, milestone 4): per model, how
// its story replies under the send tool met the contract, over every reply whose run ended: how
// often the app had to ask for the reply to be sent, what came of it, and how many were stopped,
// failed or ran out of requests first.
import type { ModelBehaviour } from "@dreamspan/shared/agent.ts"
import { AsyncView } from "../actions.tsx"
import { AppClient } from "../rpc.ts"
import { routes } from "../routes.tsx"
import { AboutHint, LabelWithHelp } from "../ui/AboutHint.tsx"
import { Card, CardHeader, EmptyState } from "../ui/Surface.tsx"
import { modelValue, useModelChoices } from "./chat/modelChoices.ts"
import { useTitle } from "./shell.tsx"

const behaviourAtom = AppClient.query("GetModelBehaviour", undefined, { reactivityKeys: ["model-behaviour"] })

const share = (n: number, of: number) => (of === 0 ? "" : ` (${Math.round((n / of) * 100)}%)`)

/** One figure: its count, its share of the model's replies, and what it counts (on hover). */
function Figure({ label, about, n, of }: { label: string; about: string; n: number; of?: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted">
        <LabelWithHelp help={<AboutHint heading={label}>{about}</AboutHint>}>
          <span className="text-xs">{label}</span>
        </LabelWithHelp>
      </dt>
      <dd className="text-sm text-text tabular-nums">
        {n.toLocaleString()}
        {of === undefined ? "" : <span className="text-muted">{share(n, of)}</span>}
      </dd>
    </div>
  )
}

/** The figures, in order: a short label, and what it counts, shown on hover. */
const FIGURES: ReadonlyArray<{
  readonly key: Exclude<keyof ModelBehaviour, "connectionId" | "connectionName" | "modelId" | "modelKey" | "nudges">
  readonly label: string
  readonly about: string
}> = [
  { key: "replies", label: "Replies", about: "Replies written with tools on that have ended, however they ended." },
  {
    key: "nudged",
    label: "Asked to send",
    about: "Replies where the model wrote text instead of sending it, so the app asked it to send."
  },
  { key: "recovered", label: "Sent after asking", about: "Replies sent after the app asked." },
  {
    key: "gaveUp",
    label: "Silent after asking",
    about: "Replies where the character stayed silent after the app asked."
  },
  {
    key: "exhausted",
    label: "Never sent",
    about: "Replies that failed because the model still hadn't sent after the third ask."
  },
  {
    key: "capped",
    label: "Out of requests",
    about: "Replies that used every model request allowed without being sent."
  },
  {
    key: "stopped",
    label: "Stopped",
    about: "Replies stopped before they were sent. They say nothing about the model."
  },
  {
    key: "failed",
    label: "Errors",
    about: "Replies ended by an error, such as the provider failing, before they were sent."
  }
]

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
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {FIGURES.map((figure) => (
                <Figure
                  key={figure.label}
                  label={figure.label}
                  about={figure.about}
                  n={row[figure.key]}
                  {...(figure.key === "replies" ? {} : { of: row.replies })}
                />
              ))}
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
        about="How each model gives its replies with tools on. The reply must be sent with the send tool; when a model writes text instead, the app asks it to send, up to three times. Hover a figure's ? to see what it counts. A reply carried on with Resume counts once, as it finally ended."
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
