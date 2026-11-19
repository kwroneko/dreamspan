// Runs untrusted imports and activation under a clean environment and Node permissions.
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import type { PluginManifest } from "@dreamspan/shared/plugins.ts"
const [folder, encoded] = process.argv.slice(2) as [string, string]
const manifest = JSON.parse(encoded) as PluginManifest
const ids = new Set<string>()
const storage = Object.freeze({
  get: () => Effect.succeed(null),
  list: () => Effect.succeed([]),
  set: () => Effect.void,
  delete: () => Effect.void
})
for (const side of ["server", "worker"] as const) {
  if (!manifest[side]) continue
  const registries: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const surface of manifest.surfaces) {
    if (!surface.startsWith(`${side}:`)) continue
    const name = surface.slice(side.length + 1)
    if (name === "storage") continue
    registries[name] = Object.freeze({
      register: (entry: { id: string }) =>
        Effect.sync(() => {
          if (!entry || typeof entry.id !== "string" || ids.has(`${surface}:${entry.id}`))
            throw new Error("Invalid registration")
          ids.add(`${surface}:${entry.id}`)
        }),
      disable: (id: string) =>
        Effect.sync(() => {
          if (!manifest.replaces.includes(`${name}:${id}`)) throw new Error("Undeclared replacement")
        }),
      list: () => [],
      get: () => undefined
    })
  }
  const module = (await import(pathToFileURL(join(folder, `${side}.mjs`)).href)) as {
    activate?: (host: unknown) => Effect.Effect<void, unknown>
  }
  if (typeof module.activate !== "function") throw new Error("Missing activate")
  await Effect.runPromise(
    Effect.scoped(
      Effect.suspend(() =>
        module.activate!(
          Object.freeze({
            api: 1,
            id: manifest.id,
            registries: Object.freeze(registries),
            ...(manifest.surfaces.includes(`${side}:storage`) ? { storage } : {}),
            log: () => undefined,
            notices: Object.freeze({ publish: () => undefined })
          })
        )
      )
    )
  )
}
