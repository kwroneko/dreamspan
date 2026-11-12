// Card sources in the client (spec/CARD-SOURCES.md §3): the list of sources (local: it never
// contacts a source), and the calls that do, each cancellable, so a superseded search is
// dropped on the server too (the server drops its upstream request when nobody waits on it).
import { RegistryContext } from "@effect/atom-react"
import type { SourceFailure } from "@rp/shared/cardSources.ts"
import { Cause, Context, Effect, Exit } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { useNavigate } from "@tanstack/react-router"
import { useContext } from "react"
import { invalidateKeys } from "../../actions.tsx"
import { describeCause } from "../../errors.ts"
import { showToast } from "../../ui/Toast.tsx"
import { makeRegistry } from "../../registry.ts"
import { AppClient } from "../../rpc.ts"
import type { ReactNode } from "react"
import type { RemoteSummary } from "@rp/shared/cardSources.ts"
import type { RefId } from "@rp/shared/library.ts"
import { askMediaApproval } from "../savedMedia/approval.ts"

/** The reactivity key of everything card sources show from the server. */
export const SOURCES_KEY = "cardSources"

export const sourcesAtom = AppClient.query("ListCardSources", undefined, { reactivityKeys: [SOURCES_KEY] })

export const recentAtom = Atom.family((sourceId: string) =>
  AppClient.query("ListRecentRemote", { sourceId }, { reactivityKeys: [SOURCES_KEY] })
)

/** A failed call to a source, as the UI words it (§5.4); `other` for anything that isn't the source's. */
export type SourceProblem =
  | { readonly reason: SourceFailure; readonly retryAfterMs?: number }
  | { readonly reason: "other"; readonly message: string }

export type SourceOutcome<A> =
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly problem: SourceProblem }

const problemOf = (cause: Cause.Cause<unknown>): SourceProblem => {
  const error = Cause.squash(cause) as { _tag?: string; reason?: SourceFailure; retryAfterMs?: number }
  if (error?._tag === "SourceFailed" && error.reason)
    return { reason: error.reason, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }
  if (error?._tag === "NotFound") return { reason: "disabled" }
  return { reason: "other", message: describeCause(cause).message }
}

/** Runs a source call; aborting the signal interrupts it, on the server too. */
export function useSourceCall() {
  const registry = useContext(RegistryContext)
  return async <A, E>(
    call: (client: AppClient["Service"]) => Effect.Effect<A, E>,
    signal?: AbortSignal
  ): Promise<SourceOutcome<A> | null> => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
        return yield* call(Context.get(services, AppClient))
      }),
      signal ? { signal } : undefined
    )
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
    if (Cause.hasInterruptsOnly(exit.cause)) return null
    return { ok: false, problem: problemOf(exit.cause) }
  }
}

/** A remote card's picture through this server, by the key it issued (§3.4). */
export const remoteImageUrl = (sourceId: string, key: string) => (width: number) =>
  `/sources/${encodeURIComponent(sourceId)}/image?k=${encodeURIComponent(key)}&w=${width}`

/**
 * A source's optional presentation (§2.1): what a tile's muted line says, say. A source with no
 * entry still works, from what its capabilities describe; a plugin adds or replaces one by id.
 */
export interface CardSourceView {
  readonly id: string
  /** The tile's muted line; the default is the main stat and token count, else the first tags. */
  readonly tileLine?: (card: RemoteSummary) => ReactNode
}

export const cardSourceViews = makeRegistry<CardSourceView>()

/** A failed call to a source, as a sentence the user can act on (§5.4). */
export const problemText = (name: string, problem: SourceProblem) =>
  problem.reason === "no_newer_file"
    ? `No newer file is available on ${name}.`
    : problem.reason === "region_unavailable"
      ? "This card is not available in your region."
      : problem.reason === "not_found"
        ? `This card is no longer on ${name}.`
        : problem.reason === "unreachable"
          ? `Can't reach ${name} right now.`
          : problem.reason === "rate_limited"
            ? `${name} is limiting requests. Try again in a moment.`
            : problem.reason === "unauthorized"
              ? `${name} refused the API key.`
              : problem.reason === "disabled"
                ? `${name} is turned off in Settings.`
                : problem.reason === "refused"
                  ? `${name} doesn't allow downloading this card.`
                  : problem.reason === "bad_response"
                    ? `${name} sent something this app can't read.`
                    : "message" in problem
                      ? problem.message
                      : `${name} couldn't answer.`

export interface Adopted {
  readonly entityId: string
  readonly refId: string
  readonly name: string
  readonly existing: boolean
}

/**
 * Add to my cards (§4.5, trigger 3): the card joins the user's cards, and a notice says so with
 * a link to it; a card they already have from there is answered as theirs, never added twice.
 */
export function useAdoptRemote() {
  const call = useSourceCall()
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  return async (sourceId: string, sourceName: string, remoteId: string): Promise<Adopted | null> => {
    const out = await call((client) => client("AdoptRemoteCard", { sourceId, remoteId }))
    if (out === null) return null
    if (!out.ok) {
      showToast({ title: "The card wasn't added", description: problemText(sourceName, out.problem) })
      return null
    }
    const added = out.value
    invalidateKeys(registry, ["library", "chats"])
    showAdopted(navigate, added)
    // Its media on sites the user hasn't approved (spec/SAVED-MEDIA.md §3.2).
    if (!added.existing) askMediaApproval([added.refId as RefId])
    return added
  }
}

/** The notice for a card that joined the user's cards (§4.4), or that they had already, with a link to it. */
export const showAdopted = (
  navigate: ReturnType<typeof useNavigate>,
  added: { readonly entityId: string; readonly name: string; readonly existing: boolean }
) =>
  showToast({
    title: added.existing ? `You have ${added.name} already.` : `Added ${added.name} to your cards.`,
    actions: [
      {
        label: "Show it",
        hint: `Opens ${added.name}'s page in your cards.`,
        onClick: () => void navigate({ to: "/cards/$entityId", params: { entityId: added.entityId } })
      }
    ]
  })
