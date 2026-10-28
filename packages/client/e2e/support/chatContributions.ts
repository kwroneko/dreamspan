// Loaded only by the Vite-backed contribution regression tests, never by the app.
import { useNavigate } from "@tanstack/react-router"
import { Effect, Exit, Scope } from "effect"
import { createElement } from "react"
import { chatCommands } from "../../src/features/chat/commands.tsx"
import { composerControls } from "../../src/features/chat/composerControls.tsx"
import { messageActions } from "../../src/features/chat/messageActions.tsx"
import { chatPanels } from "../../src/features/chat/panels.tsx"

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

export const install = async (id: "plugin" | "settings" | "notes" | "history" | "family-tab") => {
  await close(id)
  const scope = await Effect.runPromise(Scope.make())
  scopes.set(id, scope)
  const own = async (dispose: () => void) => Effect.runPromise(Scope.addFinalizer(scope, Effect.sync(dispose)))
  if (id === "settings") {
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
        run: () => {
          document.body.dataset.pluginCommands = String(Number(document.body.dataset.pluginCommands ?? 0) + 1)
        }
      })
    )
  }
}
