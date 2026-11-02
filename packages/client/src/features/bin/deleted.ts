// Every delete says so in a toast, with Undo and a way to the bin (DESIGN §6.2), so deleting
// needs no confirmation anywhere but inside the bin.
import { RegistryContext } from "@effect/atom-react"
import type { BinItem } from "@rp/shared/bin.ts"
import { useNavigate } from "@tanstack/react-router"
import { Context, Effect } from "effect"
import { AtomRegistry, Reactivity } from "effect/reactivity"
import { useCallback, useContext } from "react"
import { describeCause } from "../../errors.ts"
import { AppClient } from "../../rpc.ts"
import { showToast } from "../../ui/Toast.tsx"
import { binTitle } from "./titles.ts"

/** What a restore can bring back, for the lists showing it to read again. */
export const RESTORED_KEYS = ["bin", "chats", "library", "connections"]

/** Restores a bin item; the lists that show what came back read again. */
export const restoreItem = (registry: AtomRegistry.AtomRegistry, itemId: string, keys = RESTORED_KEYS) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
      const item = yield* Context.get(services, AppClient)("RestoreBinItem", { itemId })
      Context.get(
        services as unknown as Context.Context<Reactivity.Reactivity>,
        Reactivity.Reactivity
      ).invalidateUnsafe(keys)
      return item
    })
  )

/** Shows the toast for something just deleted. */
export const useDeletedToast = () => {
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  return useCallback(
    /** `onRestored`: for a view that doesn't read the restored lists again by itself. */
    (item: BinItem, onRestored?: () => void) =>
      showToast({
        title: `${binTitle(item)} moved to the bin.`,
        // Long enough to reach Undo after reading it; hovering or focusing it holds it.
        timeout: 10_000,
        ...(item.excerpt && item.kind !== "entity" && item.kind !== "connection" ? { description: item.excerpt } : {}),
        actions: [
          {
            label: "Undo",
            onClick: () =>
              void restoreItem(registry, item.id).then((exit) => {
                if (exit._tag === "Failure") showToast({ title: describeCause(exit.cause).message })
                else onRestored?.()
              })
          },
          { label: "Open the bin", onClick: () => void navigate({ to: "/bin" }) }
        ]
      }),
    [registry, navigate]
  )
}
