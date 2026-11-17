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
import { replyGuards } from "../chat/replyGuards.ts"
import { appTools } from "../shell.tsx"
import { CapabilityChip } from "./CapabilityChip.tsx"
import { CHANGES } from "./effects.ts"
import { CAPABILITY_CHIP, workshopLook } from "./kinds.ts"
import { askBeforeReply } from "./regenerateWarning.ts"
import { SIDE_CHAT_TAB, TALK_ABOUT } from "./sideChat.ts"
import { StepEffects } from "./StepEffects.tsx"
import { talkAbout } from "./talkAbout.ts"
import { WorkshopStartCard } from "./StartCard.tsx"
import { ConvertPresetButton } from "./ConvertPreset.tsx"
import { registerWorkshopPersona } from "./workshopPersona.tsx"
import { editorActions } from "../editor/editorSlots.ts"
import { panelEditorActions } from "../editor/panelActions.tsx"
import type { EditorStore } from "../editor/store.ts"
import { cardEditorSections } from "../editor/cardSections.ts"

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

export const register = () => [
  chatKindLooks.register(workshopLook),
  // The way back to the story an attached workshop is about, in its header and its list rows.
  chatHeaderAbout.register({ id: "workshop.story-link", order: 10, component: WorkshopStoryLink }),
  chatRowAbout.register({ id: "workshop.story-name", order: 10, component: WorkshopStoryName }),
  ...registerWorkshopPersona(),
  chatStartSections.register({ id: "workshop.start", order: 20, component: WorkshopStartCard }),
  // The skills a card carries for a workshop assistant (spec/TOOL-LOADING.md §6), in its Extra tab.
  cardEditorSections.register({ id: "card.skills", order: 112, component: CardSkillsSection }),
  // A story preset made into a workshop one (spec/WORKSHOP-CONTEXT.md §4.4), in the large and side-panel editors.
  editorActions.register({ id: "workshop.convert-preset", order: 20, component: convert(false) }),
  panelEditorActions.register({ id: "workshop.convert-preset", order: 30, component: convert(true) }),
  // After the cache chip, where Next stands in a story chat.
  composerControls.register({
    id: CAPABILITY_CHIP,
    order: 35,
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
