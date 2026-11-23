// Agent replies in the client (spec/AGENTIC.md §5, §6), as registered parts a plugin can replace:
// a stopped reply's Resume, the steps inside a reply and its header badge, the run inspector's
// tools and steps (with their edits), the Activity tab, the Tools setting, and the answer to a
// call that waits for the user, under its step.
import { lazy, Suspense, type ComponentProps } from "react"
import { Loading } from "../../../ui/Spinner.tsx"
import { chatPanels, lazyPanel, type PanelProps } from "../panels.tsx"
import {
  chatSettingSections,
  messageHeaderDetails,
  reasoningPanels,
  runInspectorSections,
  runInspectorTranscript
} from "../presentation.tsx"
import { Steps, StepsBadge } from "./Steps.tsx"
import { cardDefinitionSections } from "../../editor/cardSections.ts"
import { invokeMessageAction, messageActions, viewOf } from "../messageActions.tsx"
import { resumeOffer } from "./resume.ts"
import { stepActions } from "./stepActions.ts"
import { ApprovalPanel } from "./ApprovalPanel.tsx"
import { SubagentPanel } from "./SubagentPanel.tsx"

const RunSteps = lazy(() => import("./RunSteps.tsx").then((m) => ({ default: m.RunSteps })))
const RunAttempts = lazy(() => import("./RunSteps.tsx").then((m) => ({ default: m.RunAttempts })))
const ToolsSection = lazy(() => import("./ToolsSection.tsx").then((m) => ({ default: m.ToolsSection })))
const AgentPermissionsSection = lazy(() =>
  import("./AgentPermissionsSection.tsx").then((m) => ({ default: m.AgentPermissionsSection }))
)
const AgentEditableFields = lazy(() =>
  import("./AgentEditableFields.tsx").then((m) => ({ default: m.AgentEditableFields }))
)

export const registerAgent = () => [
  // Resume (DESIGN §7.5 [D]): an agent reply that stopped or failed, carried on as a new version.
  messageActions.register({
    id: "message.resume",
    order: 25,
    group: "change",
    pinned: true,
    available: ({ entry }) => resumeOffer(entry.version) !== null,
    disabled: ({ entry }) => resumeOffer(entry.version)?.disabled ?? null,
    run: async ({ session, entry, report }) => report(await session.resumeVersion(entry)),
    describe: viewOf((context) => ({
      label: "Resume",
      icon: "play",
      hint: "Carries on this reply from where it stopped, as a new swipe.",
      onSelect: () => invokeMessageAction("message.resume", context, "button")
    }))
  }),
  // Above the reasoning: the steps came before the final turn's reasoning and text.
  reasoningPanels.register({ id: "agent.steps", order: 5, component: Steps }),
  messageHeaderDetails.register({ id: "message.steps-badge", order: 15, component: StepsBadge }),
  // A call that asks the user first: what it will do, and Allow, Allow in this workshop, Decline.
  stepActions.register({ id: "agent.approval", order: 10, component: ApprovalPanel }),
  // The subagent an `agent` call started (spec/SUBAGENTS.md §7): its row, with Stop and Inspect.
  stepActions.register({ id: "agent.subagent", order: 20, component: SubagentPanel }),
  // Above the sent messages: how the run tried to reply. After them: its tools and steps.
  runInspectorSections.register({
    id: "inspector.reply-attempts",
    order: 10,
    component: (props: ComponentProps<typeof RunAttempts>) => (
      <Suspense fallback={null}>
        <RunAttempts {...props} />
      </Suspense>
    )
  }),
  runInspectorTranscript.register({
    id: "inspector.run-steps",
    order: 10,
    component: (props: ComponentProps<typeof RunSteps>) => (
      <Suspense fallback={<Loading label="Loading the steps…" />}>
        <RunSteps {...props} />
      </Suspense>
    )
  }),
  chatSettingSections.register({
    id: "settings.tools",
    order: 20,
    component: (props: ComponentProps<typeof ToolsSection>) => (
      <Suspense fallback={null}>
        <ToolsSection {...props} />
      </Suspense>
    )
  }),
  // Below Tools: what the tools may change in this chat.
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
