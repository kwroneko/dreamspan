// Errors as the user reads them. Each tag the server sends (@rp/shared/errors.ts) gets a
// sentence; the server's own messages are shown as given, since they name the problem.
import { PluginRejected } from "@rp/shared/plugins.ts"
import { LcmEstimateChanged } from "@rp/shared/lcm.ts"
import { BinChanged, CannotDeleteLastFork } from "@rp/shared/bin.ts"
import { InvalidNetworkSettings, Unauthorized } from "@rp/shared/api.ts"
import {
  AccountRejected,
  Forbidden,
  LeafMoved,
  ModelKeyTaken,
  NotFound,
  ProviderError,
  ServerError,
  StaleWrite
} from "@rp/shared/errors.ts"
import { ForkNotesChanged, GenerationUnavailable, NotAmendable } from "@rp/shared/chatApi.ts"
import { EditConflict, EditRefused, InvalidDocument } from "@rp/shared/editorApi.ts"
import { StFolderUnreadable } from "@rp/shared/stImportApi.ts"
import { StImportPlanChanged } from "@rp/shared/stReimportPlan.ts"
import { MergeChanged, MergeRefused } from "@rp/shared/mergeApi.ts"
import { NotResumable } from "@rp/shared/agent.ts"
import { ApprovalRefused, EffectUndoRefused, GrantRefused } from "@rp/shared/workshopApi.ts"
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

/** "It's already being resumed." → "it's already being resumed.", to follow a colon. */
const lowerFirst = (text: string) => (text === "" ? text : text[0]!.toLowerCase() + text.slice(1))

const make = (tag: string, message: string, reason: string | null = null, problems: ReadonlyArray<string> = []) => ({
  tag,
  message,
  reason,
  problems
})

/** `useAction` reloads what the write would have changed, so the user sees the latest version. */
const stale = (entity: string) =>
  make(
    "StaleWrite",
    `This ${entity} changed since you opened it, maybe in another tab. The latest version is loaded: check it, then make your change again.`
  )

const describeError = (error: unknown): AppError => {
  if (error instanceof PluginRejected) return make("PluginRejected", sentence(error.message))
  if (error instanceof ForkNotesChanged) return make("ForkNotesChanged", error.message)
  if (error instanceof LcmEstimateChanged) return make("LcmEstimateChanged", error.message)
  if (error instanceof CannotDeleteLastFork)
    return make("CannotDeleteLastFork", "A chat keeps at least one branch, so this one can't be deleted.")
  if (error instanceof Unauthorized) return make("Unauthorized", "Your session has ended. Log in again.")
  if (error instanceof RpcClientError.RpcClientError)
    return make("RpcClientError", "Can't reach the server. Check that it's running.")
  if (error instanceof BinChanged)
    return make(
      "BinChanged",
      "The bin or affected branches changed since you opened this confirmation. Close it to reload the bin, then check and confirm again."
    )
  if (error instanceof NotFound)
    return make(
      "NotFound",
      // A library entry is an "item" to the user; a link to one may be stale or mistyped.
      error.entity === "ref"
        ? "This item was deleted or never existed."
        : `This ${error.entity} doesn't exist any more.`
    )
  if (error instanceof StaleWrite) return stale(error.entity)
  if (error instanceof ProviderError) return make("ProviderError", sentence(error.message), error.reason)
  if (error instanceof AccountRejected) return make("AccountRejected", sentence(error.message), error.reason)
  if (error instanceof Forbidden) return make("Forbidden", sentence(error.message))
  if (error instanceof StFolderUnreadable) return make("StFolderUnreadable", sentence(error.message))
  if (error instanceof StImportPlanChanged) return make("StImportPlanChanged", sentence(error.message))
  if (error instanceof InvalidNetworkSettings) {
    return make("InvalidNetworkSettings", "These settings can't be used:", null, error.problems.map(sentence))
  }
  if (error instanceof ModelKeyTaken) {
    return make("ModelKeyTaken", `This connection already has a model called “${error.key}”.`)
  }
  // Chats
  if (error instanceof LeafMoved)
    return make("LeafMoved", "A newer message arrived meanwhile. The chat is up to date now: try again.")
  if (error instanceof GenerationUnavailable) return make("GenerationUnavailable", sentence(error.message))
  if (error instanceof NotAmendable)
    return make("NotAmendable", "Only a finished message you wrote can be changed in place.")
  if (error instanceof NotResumable)
    return make(
      "NotResumable",
      `This reply can't be carried on: ${lowerFirst(sentence(error.message))}`,
      // Its stored request can still be sent unchanged, if the user chooses to (Message.tsx).
      error.savedRequest ? "saved_request" : null
    )
  if (error instanceof MergeRefused) return make("MergeRefused", sentence(error.message))
  if (error instanceof MergeChanged)
    return make("MergeChanged", "One of the chats changed while this was open. Check what merging brings now.")
  // Workshops: the server's reason, said for the user.
  if (error instanceof EffectUndoRefused) return make("EffectUndoRefused", sentence(error.message))
  if (error instanceof ApprovalRefused) return make("ApprovalRefused", sentence(error.message))
  if (error instanceof GrantRefused) return make("GrantRefused", sentence(error.message))
  // Editors
  if (error instanceof InvalidDocument) {
    return make("InvalidDocument", "These changes wouldn't make a valid document:", null, error.problems)
  }
  if (error instanceof EditRefused) return make("EditRefused", sentence(error.message))
  if (error instanceof EditConflict) {
    return make("EditConflict", "Some fields changed in the saved version since you started editing them.")
  }
  if (error instanceof ServerError) {
    return make("ServerError", "Something failed on the server. The details are in the server's log.")
  }
  return make("Unknown", "Something went wrong.")
}

export const describeCause = (cause: Cause.Cause<unknown>): AppError =>
  Cause.hasInterruptsOnly(cause) ? make("Interrupted", "Cancelled.") : describeError(Cause.squash(cause))
