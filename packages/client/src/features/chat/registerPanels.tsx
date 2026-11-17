import { Loading } from "../../ui/Spinner.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { chatPanels, lazyPanel, type PanelProps, type PendingPanelProps } from "./panels.tsx"
import { lazy, Suspense, type ComponentType } from "react"

/** A tab's body in a chat not made yet, loaded when first shown. */
const lazyPending = (load: () => Promise<{ default: ComponentType<PendingPanelProps> }>, label: string) => {
  const Body = lazy(load)
  return (props: PendingPanelProps) => (
    <Suspense fallback={<Loading label={`Loading the ${label}…`} />}>
      <Body {...props} />
    </Suspense>
  )
}
import { summaryPanelSections } from "./presentation.tsx"
import { summarizes } from "./kindLooks.ts"
import { NOTE_FOCUS, workspaceViews, type WorkspaceViewProps } from "../editor/workspaceViews.ts"

/** A note in the large editor over the chat, loaded when first opened. */
const NoteLarge = lazy(() => import("./ChatNotes.tsx").then((module) => ({ default: module.ChatNoteLarge })))

const loadNotes = () =>
  import("./ChatNotes.tsx").then((module) => ({
    default: ({ session, view, notesFocus }: PanelProps) => (
      <module.NotesTab session={session} leafSlotId={view.leafSlotId} focusCard={notesFocus} />
    )
  }))

/**
 * Built-ins use exactly the descriptor API available to a plugin. Tools go in the order they're
 * used most: this chat's settings, model and preset, notes, lorebooks, summaries; then the rest.
 */
export const registerPanels = () => [
  chatPanels.register({
    id: "model",
    label: "Model",
    description: "The model the next reply uses, to choose, and its settings, which apply wherever it's used.",
    order: 20,
    icon: "model",
    component: lazyPanel(
      () =>
        Promise.all([import("./GenerationControls.tsx"), import("../pickers/PanelPickers.tsx")]).then(([m, p]) => ({
          default: ({ session, view }: PanelProps) => (
            <>
              <p.ModelTabPicker session={session} />
              <m.GenerationSettingsPanel session={session} view={view} kind="model" />
            </>
          )
        })),
      "model"
    ),
    // The model is the account's: it's chosen here before the first send too; its settings show once saved.
    pending: lazyPending(
      () => import("../pickers/PanelPickers.tsx").then((p) => ({ default: () => <p.ModelTabPicker session={null} /> })),
      "model"
    )
  }),
  chatPanels.register({
    id: "preset",
    holdsEditor: (ref) => ref.kind === "preset",
    label: "Prompt preset",
    description: "The prompt preset the next reply is built with, to choose and edit.",
    order: 30,
    icon: "preset",
    component: lazyPanel(
      () =>
        Promise.all([import("./PresetTab.tsx"), import("../pickers/PanelPickers.tsx")]).then(([m, p]) => ({
          // The picker is its own mount above the tab's content (pickers/PanelPickers.tsx).
          default: ({ session, view }: PanelProps) => (
            <>
              <p.PresetTabPicker session={session} />
              <m.PresetTab session={session} view={view} />
            </>
          )
        })),
      "preset"
    ),
    // Before the first send too: the account's preset, chosen and edited the same way.
    pending: lazyPending(
      () =>
        Promise.all([import("./PresetTab.tsx"), import("../pickers/PanelPickers.tsx")]).then(([m, p]) => ({
          default: () => (
            <>
              <p.PresetTabPicker session={null} />
              <m.PendingPresetTab />
            </>
          )
        })),
      "preset"
    )
  }),
  chatPanels.register({
    id: "cast",
    label: "Cast",
    description: "Who's in this chat: add or remove characters, mute them or make one speak.",
    order: 10,
    icon: "people",
    placement: "cast",
    component: lazyPanel(
      () =>
        import("./CastTab.tsx").then((m) => ({
          default: ({ session }: PanelProps) => <m.CastTab session={session} />
        })),
      "cast"
    ),
    pending: lazyPending(
      () =>
        import("./CastTab.tsx").then((m) => ({
          default: ({ pending }: PendingPanelProps) => <m.PendingCastTab pending={pending} />
        })),
      "cast"
    )
  }),
  chatPanels.register({
    id: "chat",
    default: true,
    label: "This chat",
    description: "This chat's name, who you play, summaries on or off, and more.",
    order: 10,
    icon: "chat",
    component: lazyPanel(
      () =>
        import("./ThisChatTab.tsx").then((m) => ({
          default: ({ session, active }: PanelProps) => <m.ThisChatTab session={session} active={active} />
        })),
      "chat settings"
    )
  }),
  chatPanels.register({
    id: "lorebooks",
    holdsEditor: (ref) => ref.kind === "lorebook",
    label: "Lorebooks",
    description: "The lorebooks this chat reads, each with its switch, and where their entries go.",
    order: 50,
    icon: "book",
    component: lazyPanel(
      () =>
        import("./LorebooksTab.tsx").then((m) => ({
          default: ({ session, view, active }: PanelProps) => (
            <m.LorebooksTab session={session} view={view} active={active} />
          )
        })),
      "lorebooks"
    )
  }),
  chatPanels.register({
    id: "notes",
    label: "Notes",
    description: "What the model is sent with this chat: the chat's own notes and its characters'.",
    order: 40,
    icon: "note",
    component: lazyPanel(loadNotes, "notes")
  }),
  workspaceViews.register({
    id: NOTE_FOCUS,
    label: "Note editor",
    component: (props: WorkspaceViewProps) => (
      <Suspense fallback={<Loading label="Loading the note…" />}>
        <NoteLarge {...props} />
      </Suspense>
    )
  }),
  chatPanels.register({
    id: "summaries",
    // A kind whose summaries stay off (a workshop) has no Summaries tab.
    available: (view) => summarizes(view.chat),
    label: "Summaries",
    description: "The summaries that stand in for older messages, and how they're written.",
    order: 60,
    icon: "summary",
    component: lazyPanel(
      () =>
        import("./SummaryPanel.tsx").then((m) => ({
          // The summaries, then what's registered after them (their settings), shown before they load too.
          default: ({ session, view, focus, onJump, onEnable }: PanelProps) => (
            <div className="flex flex-col gap-4">
              {view.lcm === null ? (
                <Loading label="Loading the summaries…" />
              ) : (
                <m.SummaryPanel session={session} lcm={view.lcm} focus={focus} onJump={onJump} onEnable={onEnable} />
              )}
              <SlotOutlet slot={summaryPanelSections} props={{ session }} />
            </div>
          )
        })),
      "summaries"
    )
  }),
  chatPanels.register({
    id: "history",
    label: "History edits",
    description: "Search and replace in this branch’s messages, or review applied edits.",
    order: 90,
    icon: "history",
    component: lazyPanel(
      () =>
        import("./HistoryPanel.tsx").then((m) => ({
          default: ({ session, view, active, onJump, onSummaries }: PanelProps) => (
            <m.HistoryPanel session={session} view={view} active={active} onJump={onJump} onSummaries={onSummaries} />
          )
        })),
      "search and replace"
    )
  })
]
