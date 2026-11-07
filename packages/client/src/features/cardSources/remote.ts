// Card sources in the client (spec/CARD-SOURCES.md §3): the list of sources (local: it never
// contacts a source), and the calls that do, each cancellable, so a superseded search is
// dropped on the server too (the server drops its upstream request when nobody waits on it).
import { RegistryContext } from "@effect/atom-react"
import type { SourceFailure } from "@rp/shared/cardSources.ts"
import { Cause, Context, Effect, Exit } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { useContext } from "react"
import { describeCause } from "../../errors.ts"
import { makeRegistry } from "../../registry.ts"
import { AppClient } from "../../rpc.ts"
import type { ReactNode } from "react"
import type { RemoteSummary } from "@rp/shared/cardSources.ts"

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
