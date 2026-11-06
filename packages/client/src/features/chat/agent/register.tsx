// Agent replies in the client (spec/AGENTIC.md §5, §6), as registered parts a plugin can replace:
// the steps inside a reply and its header badge, the run inspector's tools and steps, the
// Activity tab, and the Reply mode setting.
import { lazy, Suspense, type ComponentProps } from "react"
import { Loading } from "../../../ui/Spinner.tsx"
import { chatPanels, lazyPanel, type PanelProps } from "../panels.tsx"
import { chatSettingSections, messageHeaderDetails, reasoningPanels, runInspectorSections } from "../presentation.tsx"
import { Steps, StepsBadge } from "./Steps.tsx"
import { cardDefinitionSections } from "../../editor/cardSections.ts"

const RunSteps = lazy(() => import("./RunSteps.tsx").then((m) => ({ default: m.RunSteps })))
const ReplyModeSection = lazy(() => import("./ReplyModeSection.tsx").then((m) => ({ default: m.ReplyModeSection })))
const AgentPermissionsSection = lazy(() =>
  import("./AgentPermissionsSection.tsx").then((m) => ({ default: m.AgentPermissionsSection }))
)
const AgentEditableFields = lazy(() =>
  import("./AgentEditableFields.tsx").then((m) => ({ default: m.AgentEditableFields }))
)

export const registerAgent = () => [
  // Above the reasoning: the steps came before the final turn's reasoning and text.
  reasoningPanels.register({ id: "agent.steps", order: 5, component: Steps }),
  messageHeaderDetails.register({ id: "message.steps-badge", order: 15, component: StepsBadge }),
  runInspectorSections.register({
    id: "inspector.run-steps",
    order: 10,
    component: (props: ComponentProps<typeof RunSteps>) => (
      <Suspense fallback={<Loading label="Loading the steps…" />}>
        <RunSteps {...props} />
      </Suspense>
    )
  }),
  chatSettingSections.register({
    id: "settings.reply-mode",
    order: 20,
    component: (props: ComponentProps<typeof ReplyModeSection>) => (
      <Suspense fallback={null}>
        <ReplyModeSection {...props} />
      </Suspense>
    )
  }),
  // Below the Reply mode's tools: what the tools may change in this chat.
  chatSettingSections.register({
    id: "settings.agent-permissions",
    order: 21,
    component: (props: ComponentProps<typeof AgentPermissionsSection>) => (
      <Suspense fallback={null}>
        <AgentPermissionsSection {...props} />
      </Suspense>
    )
  }),
  // A card's own Model may change list, under its prompt fields.
  cardDefinitionSections.register({
    id: "card.agent-editable-fields",
    order: 50,
    component: (props: ComponentProps<typeof AgentEditableFields>) => (
      <Suspense fallback={null}>
        <AgentEditableFields {...props} />
      </Suspense>
    )
  }),
  chatPanels.register({
    id: "activity",
    label: "Activity",
    description: "Model work in this chat that wrote no message: summaries and checks, with their tokens and cost.",
    order: 95,
    icon: "activity",
    component: lazyPanel(
      () =>
        import("./ActivityPanel.tsx").then((m) => ({
          default: (props: PanelProps) => <m.ActivityPanel {...props} />
        })),
      "activity"
    )
  })
]
