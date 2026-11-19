// This chat's Decisions setting (spec/AGENTIC.md §7): each decision a decision connection has
// on, with a switch that turns it off for this chat only, from the latest message on, on this
// branch, as every chat setting does. A chat can only turn off what a connection has on:
// turning a decision on for the first time stays with its connection (nothing is sent to a
// provider the user didn't turn it on for). Shown only once a decision is on somewhere, or
// while this chat still has one off.
import { useAtomValue } from "@effect/atom-react"
import type { Cast } from "@dreamspan/shared/chatSetupApi.ts"
import type { ConnectionDecisions, DecisionPointInfo } from "@dreamspan/shared/decisions.ts"
import { Link } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { useState, useSyncExternalStore } from "react"
import type { AppError } from "../../errors.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import type { ChatSession } from "../chat/session.ts"
import { pointsAtom, settingsAtom } from "./data.ts"

/** What the setting does, when, and what the model sees: one example, no internals. */
const DECISIONS_ABOUT =
  "Turn a decision off for this chat only, from the latest message on, on this branch. While it's off, nothing is sent to the decision model for it here, and the app decides as it does without one. Example: with “Who replies next” off, the chat's reply order picks who replies, as in a chat with no decision model; other chats keep asking. A reply's request view says which decisions were off and what decided instead."

export interface ChatDecisionRow {
  readonly point: DecisionPointInfo
  /** A decision connection has it on with a model chosen: this chat can turn it off, and back on. */
  readonly available: boolean
  /** Asked in this chat: available, and not turned off here. */
  readonly on: boolean
}

/**
 * The rows the setting shows: every registered point a connection has on, and any this chat
 * still lists as off (so it can be cleared after its connection turned it off). None: no section.
 */
export const chatDecisionRows = (
  points: ReadonlyArray<DecisionPointInfo>,
  settings: ReadonlyArray<ConnectionDecisions>,
  off: ReadonlyArray<string>
): ReadonlyArray<ChatDecisionRow> =>
  points.flatMap((point) => {
    const available = settings.some((entry) => entry.model !== null && entry.points[point.id]?.on === true)
    const offHere = off.includes(point.id)
    return available || offHere ? [{ point, available, on: available && !offHere }] : []
  })

/** The chat's off-list after one switch moved; unavailable plugin ids keep their consent setting. */
export const withDecision = (
  points: ReadonlyArray<DecisionPointInfo>,
  off: ReadonlyArray<string>,
  id: string,
  on: boolean
): Array<string> => [
  ...points.map((point) => point.id).filter((other) => (other === id ? !on : off.includes(other))),
  ...off.filter((other) => !points.some((point) => point.id === other) && other !== id)
]

export function ChatDecisions({ session }: { session: ChatSession }) {
  const cast: Cast | null = useSyncExternalStore(session.subscribe, () => session.snapshot().cast)
  const points = useAtomValue(pointsAtom)
  const settings = useAtomValue(settingsAtom)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  if (cast === null || !AsyncResult.isSuccess(points) || !AsyncResult.isSuccess(settings)) return null
  const off = cast.decisionsOff ?? []
  const rows = chatDecisionRows(points.value, settings.value, off)
  if (rows.length === 0) return null
  const change = async (id: string, on: boolean) => {
    setPending(true)
    const outcome = await session.changeCast({ _tag: "DecisionPoints", off: withDecision(points.value, off, id, on) })
    setPending(false)
    setError(outcome.ok ? null : outcome.error)
  }
  return (
    <section aria-label="Decisions" className="flex flex-col gap-2">
      <Fieldset legend="Decisions" about={DECISIONS_ABOUT}>
        {rows.map(({ point, available, on }) => (
          <Switch
            key={point.id}
            checked={on}
            disabled={pending}
            onCheckedChange={(next) => void change(point.id, next)}
            hint={
              !available
                ? `No decision connection has this on now, so nothing is asked anywhere. Click to clear this chat's own “off”.`
                : on
                  ? `Click to stop asking in this chat. ${point.instead ?? ""}`.trim()
                  : "Click to ask in this chat again, as your decision connection is set to."
            }
            description={
              !available
                ? "Off for this chat, and not on for any decision connection."
                : on
                  ? point.description
                  : `Off for this chat: nothing is sent for it here. ${point.instead ?? ""}`.trim()
            }
          >
            {point.label}
          </Switch>
        ))}
        <p className="text-sm text-muted">
          A decision is turned on, and its model chosen, under{" "}
          <Tooltip label="Opens connections, where decision models and their decisions are set for every chat.">
            <Link
              to="/settings/connections"
              className="text-accent hover:underline focus-visible:ring-2 focus-visible:ring-focus"
            >
              Decision connections
            </Link>
          </Tooltip>
          .
        </p>
      </Fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          Decisions weren't changed: {error.message}
        </p>
      )}
    </section>
  )
}
