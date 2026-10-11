// Errors as the user reads them. Each tag the server sends (@rp/shared/errors.ts) gets a
// sentence; the server's own messages are shown as given, since they name the problem.
import { InvalidNetworkSettings, Unauthorized } from "@rp/shared/api.ts"
import {
  AccountRejected,
  Forbidden,
  ModelKeyTaken,
  NotFound,
  ProviderError,
  ServerError,
  StaleWrite
} from "@rp/shared/errors.ts"
import { Cause } from "effect"
import { RpcClientError } from "effect/rpc"

export interface AppError {
  readonly tag: string
  readonly message: string
  /** Separate problems, when the server lists them. */
  readonly problems: ReadonlyArray<string>
  /** The provider error's or account rejection's reason, when there is one. */
  readonly reason: string | null
}

/** "wrong handle or password" → "Wrong handle or password." */
const sentence = (text: string) => {
  const trimmed = text.trim()
  if (trimmed === "") return trimmed
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

const make = (tag: string, message: string, reason: string | null = null, problems: ReadonlyArray<string> = []) => ({
  tag,
  message,
  reason,
  problems
})

const describeError = (error: unknown): AppError => {
  if (error instanceof Unauthorized) return make("Unauthorized", "Your session has ended. Log in again.")
  if (error instanceof RpcClientError.RpcClientError)
    return make("RpcClientError", "Can't reach the server. Check that it's running.")
  if (error instanceof NotFound) return make("NotFound", `This ${error.entity} doesn't exist any more.`)
  if (error instanceof StaleWrite) {
    return make(
      "StaleWrite",
      `This ${error.entity} changed since you opened it, maybe in another tab. Load the latest version, then make your change again.`
    )
  }
  if (error instanceof ProviderError) return make("ProviderError", sentence(error.message), error.reason)
  if (error instanceof AccountRejected) return make("AccountRejected", sentence(error.message), error.reason)
  if (error instanceof Forbidden) return make("Forbidden", sentence(error.message))
  if (error instanceof InvalidNetworkSettings) {
    return make("InvalidNetworkSettings", "These settings can't be used:", null, error.problems.map(sentence))
  }
  if (error instanceof ModelKeyTaken) {
    return make("ModelKeyTaken", `This connection already has a model called “${error.key}”.`)
  }
  if (error instanceof ServerError) {
    return make("ServerError", "Something failed on the server. The details are in the server's log.")
  }
  return make("Unknown", "Something went wrong.")
}

export const describeCause = (cause: Cause.Cause<unknown>): AppError =>
  Cause.hasInterruptsOnly(cause) ? make("Interrupted", "Cancelled.") : describeError(Cause.squash(cause))
