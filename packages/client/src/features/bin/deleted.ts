// Every delete says so in a toast, with Undo and a way to the bin (DESIGN §6.2), so deleting
// needs no confirmation anywhere but inside the bin.
import { RegistryContext } from "@effect/atom-react"
import type { BinItem } from "@dreamspan/shared/bin.ts"
import { useNavigate } from "@tanstack/react-router"
import { Context, Effect } from "effect"
import { AtomRegistry, Reactivity } from "effect/reactivity"
import { useCallback, useContext } from "react"
import { describeCause } from "../../errors.ts"
import { notifyEntriesChanged, notifyLibraryChange } from "../../libraryChanges.ts"
import { AppClient } from "../../rpc.ts"
import { showToast } from "../../ui/Toast.tsx"
import { binTitle } from "./titles.ts"

/** What a restore can bring back, for the lists showing it to read again. */
export const RESTORED_KEYS = ["bin", "chats", "library", "connections", "mcp"]

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
      // Editors of what came back read it again, here and in other tabs, so its unsaved markers return.
      notifyLibraryChange(keys)
      return item
    })
  )

/** Restores a multi-delete's items in one change, in the order given (its Undo). */
const restoreItems = (registry: AtomRegistry.AtomRegistry, itemIds: ReadonlyArray<string>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const services = yield* AtomRegistry.getResult(registry, AppClient.runtime)
      const items = yield* Context.get(services, AppClient)("RestoreBinItems", { itemIds })
      Context.get(
        services as unknown as Context.Context<Reactivity.Reactivity>,
        Reactivity.Reactivity
      ).invalidateUnsafe(RESTORED_KEYS)
      notifyLibraryChange(RESTORED_KEYS)
      return items
    })
  )

/**
 * The toast for several messages deleted together (selection/): one line for them all, and one
 * Undo that puts them all back, with what else it offers (`more`) before Open the bin.
 */
export const useDeletedManyToast = () => {
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  return useCallback(
    (
      items: ReadonlyArray<BinItem>,
      more: ReadonlyArray<{ readonly label: string; readonly hint?: string; readonly onClick: () => void }> = []
    ) => {
      // Every delete shows this toast: editors whose entry, chat or branch went read it again,
      // so no unsaved marker stays on what's gone (features/editor/store.ts, `recheck`).
      notifyEntriesChanged()
      return showToast({
        title:
          items.length === 1
            ? `${binTitle(items[0]!)} moved to the bin.`
            : `${items.length} messages moved to the bin.`,
        timeout: 10_000,
        actions: [
          {
            label: "Undo",
            hint: items.length === 1 ? "Puts the message back where it was." : "Puts them all back where they were.",
            onClick: () =>
              void restoreItems(
                registry,
                items.map((item) => item.id)
              ).then((exit) => {
                if (exit._tag === "Failure") showToast({ title: describeCause(exit.cause).message })
              })
          },
          ...more,
          {
            label: "Open the bin",
            hint: "Shows deleted items you can restore.",
            onClick: () => void navigate({ to: "/bin" })
          }
        ]
      })
    },
    [registry, navigate]
  )
}

/** Shows the toast for something just deleted. */
export const useDeletedToast = () => {
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  return useCallback(
    /**
     * `onRestored`: for a view that doesn't read the restored lists again by itself. `more`: what
     * else the toast offers, after Undo ("Delete the copy in … too", spec/THREADS.md §6.3).
     */
    (
      item: BinItem,
      onRestored?: () => void,
      more: ReadonlyArray<{ readonly label: string; readonly hint?: string; readonly onClick: () => void }> = []
    ) => {
      notifyEntriesChanged()
      return showToast({
        title: `${binTitle(item)} moved to the bin.`,
        // Long enough to reach Undo after reading it; hovering or focusing it holds it.
        timeout: 10_000,
        ...(item.excerpt && item.kind !== "entity" && item.kind !== "connection" && item.kind !== "mcp_connection"
          ? { description: item.excerpt }
          : {}),
        actions: [
          {
            label: "Undo",
            onClick: () =>
              void restoreItem(registry, item.id).then((exit) => {
                if (exit._tag === "Failure") showToast({ title: describeCause(exit.cause).message })
                else onRestored?.()
              })
          },
          ...more,
          {
            label: "Open the bin",
            hint: "Shows deleted items you can restore.",
            onClick: () => void navigate({ to: "/bin" })
          }
        ]
      })
    },
    [registry, navigate]
  )
}
