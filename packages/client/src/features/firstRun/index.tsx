// Getting a new install to a working chat (uiaudit §2): the home screen's steps, and a note
// over a composer that has no model to send to. Both are slot entries, so a plugin can
// replace or disable either.
import { pendingComposerControls } from "../chat/pendingComposerControls.tsx"
import { chatComposerNotes } from "../chat/presentation.tsx"
import { homeIntro } from "../characters/homeSlots.ts"
import { FirstRunSteps } from "./FirstRunSteps.tsx"
import { NoModelNote, PendingNoModel } from "./NoModelNote.tsx"

export const register = () => {
  homeIntro.register({ id: "first-run.steps", order: 10, component: FirstRunSteps })
  chatComposerNotes.register({ id: "first-run.no-model", order: 1, component: NoModelNote })
  // A chat not started yet has no notes slot; its composer's controls carry the same note.
  pendingComposerControls.register({
    id: "first-run.no-model",
    order: 50,
    placement: "speaker",
    component: PendingNoModel
  })
}
