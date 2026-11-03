import { replyHooks } from "../chat/replyHooks.ts"
import { flushOpenEditors, refreshOpenEditors } from "./openEditors.ts"
import { registerUserDraftNotices } from "./userDraft.tsx"
import { libraryActions } from "../library/slots.ts"
import { NewCardButton } from "./NewCard.tsx"
import { NewPresetButton } from "./NewPreset.tsx"
import { appTools } from "../shell.tsx"
import { CardSavedHost } from "./CardSavedHost.tsx"
import { CARD_LOREBOOK_SECTION, cardEditorSections, lorebookEditorSections } from "./cardSections.ts"
import { EmbeddedLorebook } from "./EmbeddedLorebook.tsx"
import { EndOfRequest } from "./EndOfRequest.tsx"
import { ReplySectionsSettings } from "./ReplySectionsSettings.tsx"
import { presetEditorSections } from "./presetSections.ts"
import { registerPresetWarnings } from "./PromptDocument.tsx"
import { editorTextFields, regexScriptFields } from "./fields.ts"
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

function LazyEditorPage() {
  return (
    <Suspense fallback={<Loading label="Opening the editor…" />}>
      <EditorPage />
    </Suspense>
  )
}

export const register = () => {
  // Live text is what's sent: open editors flush before a reply, and read again after one cut revisions.
  replyHooks.register({
    id: "editor.live-text",
    beforeReply: flushOpenEditors,
    stateChanged: () => void refreshOpenEditors()
  })
  registerUserDraftNotices()
  cutoutChoosers.register({ id: CUTOUT_CHOOSER, component: LazyCutoutChooser })
  libraryActions.register({ id: "editor.new-card", order: 10, component: NewCardButton })
  libraryActions.register({ id: "editor.new-preset", order: 20, component: NewPresetButton })
  appTools.register({ id: "editor.card-saved", order: 200, component: CardSavedHost })
  cardEditorSections.register({ id: CARD_LOREBOOK_SECTION, order: 100, component: EmbeddedLorebook })
  cardEditorSections.register({ id: "card.regex", order: 110, component: CardRegexScripts })
  editorTextFields.register({ id: "card.regex", kind: "card", fields: (doc) => regexScriptFields("card", doc) })
  registerCardTabs()
  registerLorebookTable()
  registerLorebookEntrySettings()
  presetEditorSections.register({ id: "preset.end-of-request", order: 100, component: EndOfRequest })
  presetEditorSections.register({ id: "preset.reply-sections", order: 110, component: ReplySectionsSettings })
  registerPresetWarnings()
  editorTextFields.register({ id: "card.embedded-lorebook", kind: "card", fields: lorebookFields })
  lorebookEditorSections.register({ id: "lorebook.use", order: 10, component: LorebookUse })
  lorebookEditorSections.register({ id: "lorebook.entries", order: 100, component: StandaloneLorebook })
  editorTextFields.register({ id: "lorebook.entries", kind: "lorebook", fields: standaloneLorebookFields })
  routes.register({ id: "library.editor", parent: "app", path: "/library/$refId", component: LazyEditorPage })
}
