import { viewParams } from "../../tabLayoutParams.ts"
import { tabKinds } from "../workbench/kinds.ts"
import { fieldTabKind } from "./fieldTab.ts"
import { panelEditorActions, PanelHistory, PanelVariant } from "./panelActions.tsx"
import { replyHooks } from "../chat/replyHooks.ts"
import { editorExtensions } from "../../ui/editorExtensions.ts"
import { flushOpenEditors, refreshOpenEditors } from "./openEditors.ts"
import { registerUserDraftNotices } from "./userDraft.tsx"
import { libraryActions, libraryPanels } from "../library/slots.ts"
import { LibraryReplaceButton, LibraryReplacePanel } from "./LibraryReplace.tsx"
import { NewCardButton } from "./NewCard.tsx"
import { NewPresetButton } from "./NewPreset.tsx"
import { NewDocumentButton } from "./NewDocument.tsx"
import { BrowserRecoveryWarning } from "./BrowserRecovery.tsx"
import { appTools, navigationNotices } from "../shell.tsx"
import { CardSavedHost } from "./CardSavedHost.tsx"
import { CARD_LOREBOOK_SECTION, cardEditorSections, lorebookEditorSections } from "./cardSections.ts"
import { EmbeddedLorebook } from "./EmbeddedLorebook.tsx"
import { EndOfRequest } from "./EndOfRequest.tsx"
import { SendNudge } from "./SendNudge.tsx"
import { ReplySectionsSettings } from "./ReplySectionsSettings.tsx"
import { presetEditorSections } from "./presetSections.ts"
import { registerPresetWarnings } from "./PromptDocument.tsx"
import { editorTextFields, regexScriptFields } from "./fields.ts"
import { CardPanelScripts, PresetPanelScripts } from "./PanelScripts.tsx"
import { CardRegexScripts } from "./RegexScripts.tsx"
import { registerCardTabs } from "./cardTabsRegister.tsx"
import { lorebookFields, standaloneLorebookFields } from "./lorebookFields.ts"
import { LorebookUse, StandaloneLorebook } from "./StandaloneLorebook.tsx"
import { registerLorebookTable } from "./lorebookColumns.tsx"
import { registerLorebookEntrySettings } from "./lorebookSettingsDefaults.tsx"
import { lazy, Suspense } from "react"
import { routes } from "../../routes.tsx"
import { Loading } from "../../ui/Spinner.tsx"
import { CUTOUT_CHOOSER, type CutoutChooserProps, cutoutChoosers } from "../../ui/portraitParts.ts"

// The editors load with the first entry opened.
const EditorPage = lazy(() => import("./EditorPage.tsx").then((module) => ({ default: module.EditorPage })))
// The portrait's cutout chooser (§14.5c), loaded when a picture is first set or adjusted.
const CutoutChooser = lazy(() =>
  import("../../ui/CutoutChooser.tsx").then((module) => ({ default: module.CutoutChooser }))
)

function LazyCutoutChooser(props: CutoutChooserProps) {
  return (
    <Suspense fallback={null}>
      <CutoutChooser {...props} />
    </Suspense>
  )
}

const FieldPage = lazy(() => import("./FieldPage.tsx").then((module) => ({ default: module.FieldPage })))

function LazyFieldPage() {
  return (
    <Suspense fallback={<Loading label="Opening the field…" />}>
      <FieldPage />
    </Suspense>
  )
}

function LazyEditorPage() {
  return (
    <Suspense fallback={<Loading label="Opening the editor…" />}>
      <EditorPage />
    </Suspense>
  )
}

export const register = () => {
  navigationNotices.register({ id: "editor.browser-recovery", order: 10, component: BrowserRecoveryWarning })
  // The dialogs and disclosures open on a page (durable.tsx `useOpenPlace`): opening one isn't
  // going anywhere, so the phone's menu stays open over a dialog opened from it.
  viewParams.register({ id: "editor.open-places", keys: ["open"] })
  panelEditorActions.register({ id: "editor.panel.history", order: 10, component: PanelHistory })
  panelEditorActions.register({ id: "editor.panel.variant", order: 20, component: PanelVariant })
  editorExtensions.register({
    id: "editor.macro-highlighting",
    load: () => import("../../ui/macroHighlight.ts").then((module) => module.macroHighlight)
  })
  // Live text is what's sent: open editors flush before a reply, and read again after one cut revisions.
  replyHooks.register({
    id: "editor.live-text",
    beforeReply: flushOpenEditors,
    stateChanged: () => void refreshOpenEditors()
  })
  registerUserDraftNotices()
  cutoutChoosers.register({ id: CUTOUT_CHOOSER, component: LazyCutoutChooser })
  libraryActions.register({
    id: "editor.new-card",
    order: 10,
    component: ({ kind, personas }) => (kind === "card" ? <NewCardButton persona={personas} /> : null)
  })
  libraryActions.register({
    id: "editor.new-preset",
    order: 20,
    component: ({ kind }) => (kind === "preset" ? <NewPresetButton /> : null)
  })
  libraryActions.register({
    id: "editor.new-lorebook",
    order: 30,
    component: ({ kind }) => (kind === "lorebook" ? <NewDocumentButton kind="lorebook" /> : null)
  })
  libraryActions.register({
    id: "editor.new-note",
    order: 40,
    component: ({ kind }) => (kind === "note" ? <NewDocumentButton kind="note" /> : null)
  })
  // Search and replace through every entry at once (LibraryReplace.tsx): its button among the
  // library's actions, its panel under them.
  libraryActions.register({ id: "editor.library-replace", order: 90, component: LibraryReplaceButton })
  libraryPanels.register({ id: "editor.library-replace", order: 10, component: LibraryReplacePanel })
  appTools.register({ id: "editor.card-saved", order: 200, component: CardSavedHost })
  cardEditorSections.register({ id: CARD_LOREBOOK_SECTION, order: 100, component: EmbeddedLorebook })
  cardEditorSections.register({ id: "card.regex", order: 110, component: CardRegexScripts })
  cardEditorSections.register({ id: "card.panels", order: 115, component: CardPanelScripts })
  editorTextFields.register({ id: "card.regex", kind: "card", fields: (doc) => regexScriptFields("card", doc) })
  registerCardTabs()
  registerLorebookTable()
  registerLorebookEntrySettings()
  presetEditorSections.register({ id: "preset.end-of-request", order: 100, component: EndOfRequest })
  presetEditorSections.register({ id: "preset.send-nudge", order: 105, component: SendNudge })
  presetEditorSections.register({ id: "preset.reply-sections", order: 110, component: ReplySectionsSettings })
  presetEditorSections.register({ id: "preset.panels", order: 120, component: PresetPanelScripts })
  registerPresetWarnings()
  editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: lorebookFields })
  lorebookEditorSections.register({ id: "lorebook.use", order: 10, component: LorebookUse })
  lorebookEditorSections.register({ id: "lorebook.entries", order: 100, component: StandaloneLorebook })
  editorTextFields.register({ id: "lorebook.entries", kind: "lorebook", fields: standaloneLorebookFields })
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
  // One tab per library entry; the view names it once its document has loaded.
  tabKinds.register({
    id: "library.editor",
    order: 200,
    match: (url) => /^\/library\/([^/]+)$/.exec(url.pathname)?.[1] ?? null,
    title: () => "Editor",
    icon: "edit",
    document: true
  })
  // A field in a tab of its own (fieldTab.ts, owner 2026-11-23): one tab per entry and field,
  // titled "<entry> · <field>" once the entry has loaded.
  routes.register({
    id: "library.field",
    parent: "app",
    path: "/library/$refId/field",
    component: LazyFieldPage,
    fillBelowHeader: true
  })
  tabKinds.register(fieldTabKind)
}
