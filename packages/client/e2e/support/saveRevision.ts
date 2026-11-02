// Saving a revision from an editor's SaveControls (ARCHITECTURE §14.6): a plain Save asks
// nothing; "Save with a message…" takes one line, Enter saving it. Either way the Save button
// goes back to disabled once nothing changed since the new revision.
import { expect, type Locator, type Page } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { Client } from "./rpc.ts"

/** The editor's Save button (the SaveControls one, not a held-order bar's). */
export const saveButton = (scope: Page | Locator) => scope.getByRole("button", { name: "Save", exact: true })

/** Saves a revision from the SaveControls in `scope`, with a message when given, and waits for it. */
export const saveRevision = async (scope: Page | Locator, message?: string) => {
  const state = revisionStatus(scope)
  if (message === undefined) await saveButton(scope).click()
  else {
    await scope.getByRole("button", { name: "Save with a message…", exact: true }).click()
    await scope.getByRole("textbox", { name: "Revision message", exact: true }).fill(message)
    await scope.getByRole("textbox", { name: "Revision message", exact: true }).press("Enter")
    await expect(scope.getByRole("textbox", { name: "Revision message", exact: true })).toHaveCount(0)
  }
  // Pending also disables Save. Wait for the saved state and the end of the
  // request; a valid no-op save clears drafts without advancing the revision.
  await expect(state).toHaveText(/^Saved as revision \d+$/)
  await expect(saveButton(scope)).not.toHaveAttribute("aria-busy", "true")
  await expect(saveButton(scope)).toBeDisabled()
}

/** The state line SaveControls (or the library editor's toolbar) shows: "Saved as revision N" or "Changed since revision N". */
export const revisionStatus = (scope: Page | Locator) =>
  scope.getByRole("status").filter({ hasText: /^(Saved as|Changed since) revision \d+$/ })

/** Every text a library field's edit history holds, newest first (`EditorDraftHistory` + `EditorDraftState`); `field` is a `textField` key. */
export const editHistoryTexts = (api: Client, refId: RefId, field: string) =>
  Effect.flatMap(api.EditorDraftHistory({ refId, field, limit: 200 }), (states) =>
    Effect.forEach(states, (state) => api.EditorDraftState({ refId, field, seq: state.seq }))
  )
