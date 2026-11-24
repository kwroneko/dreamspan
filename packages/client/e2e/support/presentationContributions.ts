// Synthetic plugin, loaded by the Vite browser tests only.
import { Effect, Exit, Scope } from "effect"
import { createElement } from "react"
import {
  accountSettingSections,
  chatCardActions,
  chatBranchControls,
  messagePreviews,
  chatComposer,
  chatOverlays,
  chatSettingSections,
  chatSurfaceProviders,
  messageVersions,
  summarySettingFields,
  timelineBoundaries,
  timelineRails,
  timelineSummaries
} from "../../src/features/chat/presentation.tsx"
import { timelineTransforms } from "../../src/features/chat/timelineContributions.tsx"
import { cardContributions } from "../../src/features/cardForks/surfaces.tsx"
let scope: Scope.Closeable | undefined
export const close = async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
  scope = undefined
}
export const install = async (
  mode:
    | "surfaces"
    | "fields"
    | "rows"
    | "hide"
    | "providers"
    | "composer"
    | "account"
    | "hide-card-fork"
    | "replace-card-fork"
) => {
  await close()
  scope = await Effect.runPromise(Scope.make())
  const own = (dispose: () => void) => Effect.runPromise(Scope.addFinalizer(scope!, Effect.sync(dispose)))
  const text = (name: string) => () => createElement("span", null, `Plugin ${name}`)
  if (mode === "hide-card-fork") await own(cardContributions.disable("card-forks.fork"))
  if (mode === "replace-card-fork")
    await own(cardContributions.register({ ...cardContributions.get("card-forks.fork")! }))
  if (mode === "surfaces") {
    await own(chatBranchControls.register({ id: "chat.branches", order: 10, component: text("branches") }))
    await own(messagePreviews.register({ id: "history.message-preview", order: 10, component: text("preview") }))
    await own(chatCardActions.register({ id: "card.fork-for-chat", order: 20, component: text("card action") }))
    await own(chatCardActions.register({ id: "synthetic.card-peer", order: 40, component: text("card peer") }))
    await own(
      chatSettingSections.register({ id: "settings.summaries", order: 10, component: text("settings section") })
    )
    await own(timelineBoundaries.register({ id: "timeline.lcm-boundary", order: 10, component: text("boundary") }))
    await own(timelineSummaries.register({ id: "timeline.summary", order: 10, component: text("summary") }))
    await own(timelineRails.register({ id: "timeline.coverage", order: 10, component: text("rail") }))
    await own(
      messageVersions.register({
        id: "message.versions",
        order: 10,
        component: ({ onStep }) => createElement("button", { onClick: () => onStep(1) }, "Plugin version"),
        step: () => {
          document.body.dataset.pluginSteps = String(Number(document.body.dataset.pluginSteps ?? 0) + 1)
        }
      })
    )
    await own(chatOverlays.register({ id: "synthetic.overlay", order: 20, component: text("overlay") }))
  }
  if (mode === "fields")
    await own(
      summarySettingFields.register({ id: "settings.summary-fields", order: 10, component: text("summary fields") })
    )
  if (mode === "rows")
    await own(
      timelineTransforms.register({
        id: "timeline.lcm",
        order: 20,
        transform: (rows) => [{ key: "synthetic-row", estimate: 40, from: -1, to: -1, render: text("row") }, ...rows]
      })
    )
  if (mode === "composer")
    await own(chatComposer.register({ id: "chat.composer", order: 10, component: text("composer") }))
  if (mode === "account")
    await own(
      accountSettingSections.register({
        id: "settings.summary-defaults",
        order: 10,
        component: text("account section")
      })
    )
  if (mode === "hide") {
    for (const [registry, id] of [
      [timelineSummaries, "timeline.summary"],
      [timelineRails, "timeline.coverage"],
      [timelineBoundaries, "timeline.lcm-boundary"],
      [messageVersions, "message.versions"],
      [chatOverlays, "chat.preset-overlay"],
      [chatSurfaceProviders, "chat.preset-workspace"]
    ] as const)
      await own(registry.disable(id))
  }
  if (mode === "providers") {
    // Every registered provider is wrapped; the test checks each one mounts.
    document.body.dataset.pluginProviderCount = String(chatSurfaceProviders.list().length)
    for (const entry of chatSurfaceProviders.list())
      await own(
        chatSurfaceProviders.register({
          ...entry,
          component: ({ children }) =>
            createElement("div", { "data-plugin-provider": entry.id, style: { display: "contents" } }, children)
        })
      )
  }
}
