// Testing a connection: its model list, then one short message to a model. The same result on
// the new connection form (the values as typed, nothing saved) and on a connection's page.
import type { ConnectionTest } from "@dreamspan/shared/api.ts"
import type { ProviderErrorReason } from "@dreamspan/shared/errors.ts"
import type { ReactNode } from "react"
import { Button } from "../../ui/Button.tsx"
import { Alert } from "../../ui/Surface.tsx"

/** What went wrong, in plain words; the provider's own words follow. */
export const failure = (reason: ProviderErrorReason | null, status: number | null): string => {
  if (status === 404) return "Not found: check the address and the model id"
  switch (reason) {
    case "auth":
      return "The key was refused"
    case "network":
      return "The server couldn't be reached"
    case "no_response":
      return "The server didn't answer"
    case "rate_limited":
      return "Rate limited: try again later"
    case "overloaded":
      return "The provider is overloaded or failing"
    case "refused":
      return "The model refused"
    case "bad_request":
      return "The request was rejected"
    case "unusable":
      return "This setup can't be used"
    case "budget_held":
      return "Held by a spending limit"
    case "context_overflow":
      return "Too long for the model"
    default:
      return "It failed"
  }
}

const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/** The model list line of a successful check: "1 model listed in 3 ms." */
export const listSummary = (result: Pick<ConnectionTest, "catalog" | "models" | "ms">): string => {
  const count = `${result.models} ${result.models === 1 ? "model" : "models"}`
  return result.catalog
    ? `${count} in the built-in list.`
    : `${count} listed${result.ms === null ? "" : ` in ${duration(result.ms)}`}.`
}

export const TEST_HINT = "Lists the models, then sends one short message to the chosen model and shows its reply."
const SEND_HINT = "Sends one short message to this model and shows its reply."

/**
 * A check's result: whether it works, the list, the reply, and the route. `picker` chooses the
 * model the message goes to; `onSend` sends it.
 */
export function CheckResult({
  result,
  picker,
  onSend,
  sending
}: {
  result: ConnectionTest
  picker?: ReactNode
  onSend?: (() => void) | undefined
  sending: boolean
}) {
  const reply = result.reply
  return (
    <Alert tone={result.ok ? "success" : "danger"} title={result.ok ? "It works" : "It doesn't work"}>
      <div className="flex flex-col gap-1">
        {result.reason === null ? (
          <p>{listSummary(result)}</p>
        ) : (
          <p>
            Model list: {failure(result.reason, result.status)}. <span className="text-muted">{result.detail}</span>
          </p>
        )}
        {reply &&
          (reply.ok ? (
            <p>
              <span className="font-medium [overflow-wrap:anywhere]">{reply.model}</span>{" "}
              {reply.text === ""
                ? `answered in ${duration(reply.ms)}, with no text.`
                : `replied in ${duration(reply.ms)}:`}
              {reply.text !== "" && <span className="italic"> “{reply.text}”</span>}
            </p>
          ) : (
            <p>
              <span className="font-medium [overflow-wrap:anywhere]">{reply.model}</span>:{" "}
              {failure(reply.reason, reply.status)}. <span className="text-muted">{reply.detail}</span>
            </p>
          ))}
        {(reply?.route ?? result.route) && <p className="text-muted">Route: {reply?.route ?? result.route}</p>}
        {(picker || onSend) && (
          <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end">
            {picker && <div className="min-w-0 sm:max-w-96 sm:grow">{picker}</div>}
            {onSend && (
              <Button hint={SEND_HINT} onClick={onSend} pending={sending}>
                Send test message
              </Button>
            )}
          </div>
        )}
      </div>
    </Alert>
  )
}
