// Workshop chats in the client (spec/WORKSHOP.md W2, W4, W9), registered as a plugin would: the
// kind's look, its start card on the Chats page, the capability chip in the composer's strip, the
// Changes tab, each change's Undo and Open under its step, the warning before a new version of a
// reply that changed things outside the chat, and the workshop beside a story (its Workshop tab
// and "Talk about this chat").
import { lazy, Suspense } from "react"
import { stepActions } from "../chat/agent/stepActions.ts"
import { chatStartSections } from "../chat/ChatsPage.tsx"
import { composerControls } from "../chat/composerControls.tsx"
import { chatCommands } from "../chat/commands.tsx"
import { chatKindLooks, kindShows, takesSideChat } from "../chat/kindLooks.ts"
import { chatPanels, lazyPanel, type PanelProps } from "../chat/panels.tsx"
import { chatHeaderAbout, chatRowAbout } from "../chat/presentation.tsx"
import { WorkshopStoryLink, WorkshopStoryName } from "./storyLink.tsx"
import { WorkshopBranchNote } from "./workshopBranches.tsx"
import { branchControlParts } from "../chat/branchParts.ts"
import { replyGuards } from "../chat/replyGuards.ts"
import { appTools } from "../shell.tsx"
import { CapabilityChip } from "./CapabilityChip.tsx"
import { CHANGES } from "./effects.ts"
import { CAPABILITY_CHIP, STORY_SUBAGENT_MODELS_CHIP, SUBAGENT_MODELS_CHIP, workshopLook } from "./kinds.ts"
import { SavedSubagentModelsChip, StorySubagentModelsChip } from "./SubagentModelsChip.tsx"
import { SubagentLimitsSection, SubagentModelsSection } from "./SubagentSettings.tsx"
import { SubagentTypesSection } from "./SubagentTypes.tsx"
import { assistantToolsSections } from "../assistantTools/index.tsx"
import { askBeforeReply } from "./regenerateWarning.ts"
import { SIDE_CHAT_TAB, TALK_ABOUT } from "./sideChat.ts"
import { StepEffects } from "./StepEffects.tsx"
import { talkAbout } from "./talkAbout.ts"
import { NewWorkshopStart, NewWorkshopWithCharacter, WorkshopStartCard } from "./StartCard.tsx"
import { characterChatActions, sidebarChatStarts } from "../characters/homeSlots.ts"
import { ConvertPresetButton } from "./ConvertPreset.tsx"
import { registerWorkshopPersona } from "./workshopPersona.tsx"
import { registerWorkshopWithCard } from "./workshopWithCard.tsx"
import { editorActions } from "../editor/editorSlots.ts"
import { panelEditorActions } from "../editor/panelActions.tsx"
import type { EditorStore } from "../editor/store.ts"
import { cardEditorSections } from "../editor/cardSections.ts"
import { routes } from "../../routes.tsx"
import { Loading, reloadPage } from "../../ui/Spinner.tsx"
import { sidebarSearch } from "../characters/sidebarSearch.ts"
import { tabKinds } from "../workbench/kinds.ts"

const CardSkills = lazy(() => import("./CardSkills.tsx").then((m) => ({ default: m.CardSkills })))
function CardSkillsSection({ store }: { store: EditorStore }) {
  return (
    <Suspense fallback={null}>
      <CardSkills store={store} />
    </Suspense>
  )
}

const convert = (compact: boolean) =>
  function ConvertAction({ store }: { store: EditorStore }) {
    return <ConvertPresetButton store={store} compact={compact} />
  }

const RegenerateWarning = lazy(() => import("./RegenerateWarning.tsx"))

const StartWorkshopPage = lazy(() => import("./StartWorkshopPage.tsx").then((m) => ({ default: m.StartWorkshopPage })))
function LazyStartWorkshopPage() {
  return (
    <Suspense fallback={<Loading label="Loading…" onRetry={reloadPage} />}>
      <StartWorkshopPage />
    </Suspense>
  )
}

export const register = () => [
  chatKindLooks.register(workshopLook),
  // The way back to the story an attached workshop is about, in its header and its list rows.
  chatHeaderAbout.register({ id: "workshop.story-link", order: 10, component: WorkshopStoryLink }),
  chatRowAbout.register({ id: "workshop.story-name", order: 10, component: WorkshopStoryName }),
  // In its own pane or the center, each workshop branch names the story branch it goes with.
  branchControlParts.register({ id: "workshop.story-branch", order: 20, RowNote: WorkshopBranchNote }),
  ...registerWorkshopPersona(),
  ...registerWorkshopWithCard(),
  chatStartSections.register({ id: "workshop.start", order: 20, component: WorkshopStartCard }),
  sidebarChatStarts.register({ id: "workshop.sidebar-start", order: 20, component: NewWorkshopStart }),
  characterChatActions.register({ id: "workshop.character-start", order: 20, component: NewWorkshopWithCharacter }),
  // A workshop of its own before it exists, which the card's New workshop opens: made by its first send.
  routes.register({
    id: "workshop.start",
    parent: "app",
    path: "/new/workshop",
    component: LazyStartWorkshopPage,
    fill: true,
    retainSearch: sidebarSearch
  }),
  tabKinds.register({
    id: "workshop.start",
    order: 100,
    match: (url) => (url.pathname === "/new/workshop" ? url.pathname : null),
    title: () => "New workshop",
    icon: "tool",
    document: true
  }),
  // The skills a card carries for a workshop assistant (spec/TOOL-LOADING.md §6), in its Extra tab.
  cardEditorSections.register({ id: "card.skills", order: 112, component: CardSkillsSection }),
  // A story preset made into a workshop one (spec/WORKSHOP-CONTEXT.md §4.4), in the large and side-panel editors.
  editorActions.register({ id: "workshop.convert-preset", order: 20, component: convert(false) }),
  panelEditorActions.register({ id: "workshop.convert-preset", order: 30, component: convert(true) }),
  // Settings → Assistant tools: the subagents' models and limits (spec/SUBAGENTS.md §5.1, §6.2).
  assistantToolsSections.register({ id: "subagent-models", order: 10, component: SubagentModelsSection }),
  assistantToolsSections.register({ id: "subagent-limits", order: 20, component: SubagentLimitsSection }),
  // The kinds of subagents, built in, from plugins and the user's own (spec/SUBAGENTS.md §10).
  assistantToolsSections.register({ id: "subagent-types", order: 30, component: SubagentTypesSection }),
  // Beside the model chip, while subagents are allowed here (spec/SUBAGENTS.md §5.1a).
  composerControls.register({
    id: SUBAGENT_MODELS_CHIP,
    order: 25,
    placement: "strip",
    available: ({ view }) => kindShows(view.chat?.kind, SUBAGENT_MODELS_CHIP),
    component: ({ session }) => <SavedSubagentModelsChip session={session} />
  }),
  // In a story, the same place, while its tools allow the story helper (spec/SUBAGENTS.md §9).
  composerControls.register({
    id: STORY_SUBAGENT_MODELS_CHIP,
    order: 25,
    placement: "strip",
    // Where the workshop's chip isn't, with tools on and a chosen tools list (the default list
    // starts no subagents); the chip itself checks that an allowed tool does.
    available: ({ view }) =>
      view.chat != null &&
      !kindShows(view.chat.kind, SUBAGENT_MODELS_CHIP) &&
      view.cast?.agentEnabled === true &&
      view.cast.agentTools != null,
    component: ({ session }) => <StorySubagentModelsChip session={session} />
  }),
  // First, where Next stands in a story chat: what the reply may do, before the model and preset.
  composerControls.register({
    id: CAPABILITY_CHIP,
    order: 12,
    placement: "strip",
    available: ({ view }) => kindShows(view.chat?.kind, CAPABILITY_CHIP),
    component: CapabilityChip
  }),
  chatPanels.register({
    id: CHANGES,
    label: "Changes",
    description: "What the assistant changed outside this chat, each with Undo and Open.",
    order: 92,
    icon: "undo",
    available: (view) => kindShows(view.chat?.kind, CHANGES),
    component: lazyPanel(
      () =>
        import("./ChangesPanel.tsx").then((m) => ({
          default: (props: PanelProps) => <m.ChangesPanel {...props} />
        })),
      "changes"
    )
  }),
  // The workshop beside a story (§4): its tab after Changes, and the ⋯ menu's way in.
  chatPanels.register({
    id: SIDE_CHAT_TAB,
    label: "Workshop",
    description: "Talk about this chat with an assistant, out of character. Nothing said there reaches the story.",
    order: 96,
    icon: "tool",
    fill: true,
    savedOnly: true,
    available: (view) => takesSideChat(view.chat),
    component: lazyPanel(
      () =>
        import("./SidePanel.tsx").then((m) => ({
          default: (props: PanelProps) => <m.WorkshopSidePanel {...props} />
        })),
      SIDE_CHAT_TAB
    )
  }),
  chatCommands.register({
    id: "workshop.talk-about",
    label: TALK_ABOUT,
    description: "Opens a workshop beside this chat to talk about it out of character",
    order: 3.5,
    icon: "tool",
    panel: SIDE_CHAT_TAB,
    available: ({ view, navigate }) => navigate !== undefined && takesSideChat(view.chat),
    run: (context) => void talkAbout(context)
  }),
  // After the answer to a waiting call: what the call changed, once it's done.
  stepActions.register({ id: "workshop.step-effects", order: 20, component: StepEffects }),
  replyGuards.register({ id: "workshop.regenerate-warning", check: askBeforeReply }),
  appTools.register({
    id: "workshop.regenerate-warning",
    order: 220,
    component: () => (
      <Suspense fallback={null}>
        <RegenerateWarning />
      </Suspense>
    )
  })
]
