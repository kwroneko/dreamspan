// Loaded only by the Vite-backed contribution regression tests, never by the app.
import { useNavigate } from "@tanstack/react-router"
import { Effect, Exit, Scope } from "effect"
import { createElement } from "react"
import { chatCommands } from "../../src/features/chat/commands.tsx"
import { composerControls } from "../../src/features/chat/composerControls.tsx"
import { messageActions } from "../../src/features/chat/messageActions.tsx"
import { cardContributions } from "../../src/features/cardForks/surfaces.tsx"
import { chatPanels } from "../../src/features/chat/panels.tsx"
import { libraryItemActions } from "../../src/features/library/itemActions.tsx"
import { MenuItem } from "../../src/ui/Menu.tsx"

const scopes = new Map<string, Scope.Closeable>()

function UnlistedUrl() {
  const navigate = useNavigate()
  return createElement(
    "button",
    { onClick: () => void navigate({ to: ".", search: { panel: "synthetic:absent" } }) },
    "Unlisted family URL"
  )
}

export const close = async (id: string) => {
  const scope = scopes.get(id)
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  scopes.delete(id)
}

export const install = async (
  id: "plugin" | "settings" | "notes" | "history" | "family-tab" | "cards" | "card-hide"
) => {
  await close(id)
  const scope = await Effect.runPromise(Scope.make())
  scopes.set(id, scope)
  const own = async (dispose: () => void) => Effect.runPromise(Scope.addFinalizer(scope, Effect.sync(dispose)))
  if (id === "cards") {
    for (const [placement, suffix] of [
      ["actions", "fork"],
      ["family", "family-surface"],
      ["provenance", "provenance-surface"],
      ["badge", "badge-surface"]
    ] as const)
      await own(
        cardContributions.register({
          id: `card-forks.${suffix}`,
          placement,
          order: 0,
          component: () => createElement("p", null, `Plugin card ${placement}`),
          ...(placement === "actions" ? { menu: () => createElement(MenuItem, null, "Plugin card actions") } : {})
        })
      )
    await own(
      cardContributions.register({
        id: "synthetic.card-action",
        placement: "actions",
        order: 0,
        component: () => createElement("p", null, "Added card action"),
        menu: () => createElement(MenuItem, null, "Added card action")
      })
    )
    await own(
      libraryItemActions.register({
        id: "synthetic.library-action",
        order: 0,
        menu: () => createElement(MenuItem, null, "Added library action")
      })
    )
  } else if (id === "card-hide") {
    await own(cardContributions.disable("card-forks.fork"))
    await own(libraryItemActions.disable("library.edit"))
  } else if (id === "settings") {
    await own(chatPanels.disable("model"))
    await own(chatPanels.disable("preset"))
  } else if (id === "family-tab") {
    await own(chatPanels.disable("synthetic:visible"))
  } else if (id === "notes" || id === "history") {
    await own(chatPanels.disable(id))
  } else {
    await own(
      chatPanels.register({
        id: "synthetic.family",
        label: "Plugin panel",
        order: 1,
        icon: "note",
        matches: (value) => value.startsWith("synthetic:"),
        tabs: () => [{ value: "synthetic:visible", label: "Plugin panel" }],
        component: () =>
          createElement("div", null, createElement("p", null, "Scoped plugin panel"), createElement(UnlistedUrl))
      })
    )
    await own(
      composerControls.register({
        id: "composer.send",
        order: 40,
        placement: "actions",
        component: ({ invoke }) => createElement("button", { onClick: invoke }, "Plugin send"),
        run: () => {
          document.body.dataset.pluginSends = String(Number(document.body.dataset.pluginSends ?? 0) + 1)
        }
      })
    )
    await own(
      messageActions.register({
        id: "synthetic.action",
        order: 0,
        toolbar: ({ openDialog }) =>
          createElement("button", { onClick: () => openDialog("synthetic.action") }, "Plugin message action"),
        dialog: () => createElement("div", { role: "dialog", "aria-label": "Plugin dialog" }, "Scoped dialog")
      })
    )
    await own(
      chatCommands.register({
        id: "synthetic.command",
        label: "Plugin command",
        order: 0,
        icon: "note",
        shortcut: { key: "y", mod: true },
        // A command with a key is listed in ⋯ only when it asks to be.
        menu: true,
        run: () => {
          document.body.dataset.pluginCommands = String(Number(document.body.dataset.pluginCommands ?? 0) + 1)
        }
      })
    )
  }
}
