// Request registries change synchronously, before plugin pins can be committed. The writer
// stores this digest with a run; admission and dispatch compare it again. Local per-request
// registries are deliberately not watched. No database or provider work happens here.
import { createHash } from "node:crypto"
import { Effect } from "effect"

const watched = new Set<() => ReadonlyArray<number>>()
let scopes = 0
let unversioned = 0

export const configurationRevision = (value: unknown): number => {
  const registry = value as { readonly revision?: () => number; readonly register?: unknown } | null
  if (typeof registry?.revision === "function") return registry.revision()
  // An unknown mutable registry cannot supply a stable proof. Ordinary sends do not
  // inspect this stamp; Auto fails closed until that registry provides a revision.
  return typeof registry?.register === "function" ? ++unversioned : 0
}

export const trackAutoConfiguration = (read: () => ReadonlyArray<number>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      watched.add(read)
      scopes++
    }),
    () =>
      Effect.sync(() => {
        watched.delete(read)
        scopes++
      })
  )

export const autoConfigurationStamp = () =>
  createHash("sha256")
    .update(JSON.stringify([scopes, [...watched].map((read) => read())]))
    .digest("hex")
