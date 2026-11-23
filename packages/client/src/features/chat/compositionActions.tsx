// The composition's text actions (DESIGN §3.1; composition.ts): add the whole text, or the
// selection, to the end of your own version of a message. Offered in the bar over a version
// while you write your own (its `ownVersion`), and in a snippet's editor, where they go to the
// composition used last that still shows. In the editor's own chrome, never a context menu.
import { type TextActionContext, textActions } from "../../textActions.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { compositionTarget } from "./composition.ts"

const targetOf = (context: TextActionContext) =>
  context.ownVersion ?? (context.source === "snippet" ? compositionTarget() : null)

const applies = (context: TextActionContext) => context.ownVersion !== undefined || context.source === "snippet"

const unavailable = (context: TextActionContext) =>
  context.text.trim() === "" ? "No text to add yet." : "Open “Write your own swipe” on a message to add text to it."

/** From a snippet the composition is elsewhere on screen: a notice says where the text went. */
const add = (context: TextActionContext) => {
  const target = targetOf(context)
  if (target === null) return
  target.add(context.text)
  if (context.ownVersion === undefined) showToast({ title: `Added to your swipe of ${target.name}` })
}

export const registerCompositionActions = () => [
  textActions.register({
    id: "version.add-selection",
    label: "Add selection to your swipe",
    shortLabel: "Selection to swipe",
    description: (context) =>
      context.ownVersion
        ? "Adds the selected text to the end of your swipe of this message."
        : `Adds the selected text to the end of your swipe of ${compositionTarget()?.name ?? "a message"}.`,
    icon: "versionAddSelection",
    editor: "selection",
    applies,
    unavailable,
    available: (context) => context.text.length > 0 && targetOf(context) !== null,
    run: add
  }),
  textActions.register({
    id: "version.add-text",
    label: "Add to your swipe",
    shortLabel: "To your swipe",
    description: (context) =>
      context.ownVersion
        ? "Adds this swipe's whole text to the end of your swipe of this message."
        : `Adds this snippet's text to the end of your swipe of ${compositionTarget()?.name ?? "a message"}.`,
    icon: "versionAdd",
    editor: "text",
    applies,
    unavailable,
    available: (context) => context.text.trim().length > 0 && targetOf(context) !== null,
    run: add
  })
]
