import { Loading } from "../../ui/Spinner.tsx"
import { chatPanels, lazyPanel, type PanelProps } from "./panels.tsx"

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
    order: 20,
    icon: "model",
    component: lazyPanel(
      () =>
        import("./GenerationControls.tsx").then((m) => ({
          default: ({ session }: PanelProps) => <m.GenerationSettingsPanel session={session} kind="model" />
        })),
      "model"
    )
  }),
  chatPanels.register({
    id: "preset",
    label: "Prompt preset",
    order: 30,
    icon: "preset",
    component: lazyPanel(
      () => import("./PresetTab.tsx").then((m) => ({ default: ({ view }: PanelProps) => <m.PresetTab view={view} /> })),
      "preset"
    )
  }),
  chatPanels.register({
    id: "portrait",
    label: "Portrait",
    order: 70,
    icon: "image",
    component: lazyPanel(() => import("../../ui/Portrait.tsx").then((m) => ({ default: m.PortraitView })), "portrait")
  }),
  chatPanels.register({
    id: "cast",
    label: "Cast",
    order: 10,
    icon: "people",
    placement: "cast",
    component: lazyPanel(
      () =>
        import("./CastTab.tsx").then((m) => ({
          default: ({ session }: PanelProps) => <m.CastTab session={session} />
        })),
      "cast"
    )
  }),
  chatPanels.register({
    id: "chat",
    default: true,
    label: "This chat",
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
    label: "Lorebooks",
    order: 50,
    icon: "book",
    component: lazyPanel(
      () =>
        import("./LorebooksTab.tsx").then((m) => ({
          default: ({ session, active }: PanelProps) => <m.LorebooksTab session={session} active={active} />
        })),
      "lorebooks"
    )
  }),
  chatPanels.register({
    id: "notes",
    label: "Notes",
    order: 40,
    icon: "note",
    component: lazyPanel(loadNotes, "notes"),
    preload: () => {
      void loadNotes().catch(() => undefined)
    }
  }),
  chatPanels.register({
    id: "summaries",
    label: "Summaries",
    order: 60,
    icon: "summary",
    component: lazyPanel(
      () =>
        import("./SummaryPanel.tsx").then((m) => ({
          default: ({ session, view, focus, onJump, onEnable }: PanelProps) =>
            view.lcm === null ? (
              <Loading label="Loading the summaries…" />
            ) : (
              <m.SummaryPanel session={session} lcm={view.lcm} focus={focus} onJump={onJump} onEnable={onEnable} />
            )
        })),
      "summaries"
    )
  }),
  chatPanels.register({
    id: "history",
    label: "History edits",
    order: 90,
    icon: "history",
    component: lazyPanel(
      () =>
        import("./HistoryPanel.tsx").then((m) => ({
          default: ({ session, view, active, onJump, onSummaries }: PanelProps) => (
            <m.HistoryPanel session={session} view={view} active={active} onJump={onJump} onSummaries={onSummaries} />
          )
        })),
      "history edits"
    )
  })
]
