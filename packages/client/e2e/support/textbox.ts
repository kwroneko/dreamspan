import { expect, type Locator } from "@playwright/test"

/** Read the complete document, including lines CodeMirror virtualizes out of the DOM.
 * This bridge follows EditorView.findFromDOM in the pinned @codemirror/view version.
 * Plain inputs/textareas keep their native value assertions through the same helper.
 */
export const textBoxValue = (box: Locator) =>
  box.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
    const content = element as HTMLElement & {
      cmTile?: { root: { view: { state: { doc: { toString: () => string } } } } }
    }
    if (!content.cmTile) throw new Error("Expected a native textbox or a mounted CodeMirror content element")
    return content.cmTile.root.view.state.doc.toString()
  })

/** The box's whole text is `value`, or matches it; the chat composer is a CodeMirror editor too. */
export const expectTextBox = async (box: Locator, value: string | RegExp, options?: { timeout?: number }) => {
  if (typeof value === "string") await expect.poll(() => textBoxValue(box), options).toBe(value)
  else await expect.poll(() => textBoxValue(box), options).toMatch(value)
}

/** Replace the complete editor document through its own keyboard selection,
 * including text virtualized out of the DOM.
 */
export const replaceEditorText = async (box: Locator, value: string) => {
  await box.focus()
  await box.press("ControlOrMeta+a")
  await box.page().keyboard.insertText(value)
}
