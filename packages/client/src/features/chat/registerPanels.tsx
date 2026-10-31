import { Loading } from "../../ui/Spinner.tsx"
import { chatPanels, lazyPanel, type PanelProps } from "./panels.tsx"

const loadNotes = () =>
  import("./ChatNotes.tsx").then((module) => ({
    default: ({ session, view, notesFocus }: PanelProps) => (
      <module.NotesTab session={session} leafSlotId={view.leafSlotId} focusCard={notesFocus} />
    )
  }))

/** Built-ins use exactly the descriptor API available to a plugin. */
export const registerPanels = () => [
  chatPanels.register({
    id: "model",
    label: "Model",
    order: 10,
    icon: "sliders",
    component: lazyPanel(
      () =>
        import("./GenerationControls.tsx").then((m) => ({
          default: ({ session, view }: PanelProps) => (
            <m.GenerationSettingsPanel session={session} view={view} kind="model" />
          )
        })),
      "model"
    )
  }),
  chatPanels.register({
    id: "preset",
    label: "Prompt preset",
    order: 20,
    icon: "sliders",
    component: lazyPanel(
      () => import("./PresetTab.tsx").then((m) => ({ default: ({ view }: PanelProps) => <m.PresetTab view={view} /> })),
      "preset"
    )
  }),
  chatPanels.register({
    id: "portrait",
    label: "Portrait",
    order: 30,
    icon: "people",
    component: lazyPanel(() => import("../../ui/Portrait.tsx").then((m) => ({ default: m.PortraitView })), "portrait")
  }),
  chatPanels.register({
    id: "cast",
    label: "Cast",
    order: 40,
    icon: "people",
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
    order: 50,
    icon: "sliders",
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
    order: 60,
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
    order: 70,
    icon: "note",
    component: lazyPanel(loadNotes, "notes"),
    preload: () => {
      void loadNotes().catch(() => undefined)
    }
  }),
  chatPanels.register({
    id: "summaries",
    label: "Summaries",
    order: 80,
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
    icon: "edit",
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
