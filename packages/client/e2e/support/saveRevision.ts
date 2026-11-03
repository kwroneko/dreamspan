// Saving a revision from an editor's save cluster (ui/SaveControls, ARCHITECTURE §14.6): a plain
// Save asks nothing; "Save with message…" takes one line, Enter saving it. Either way Save
// goes back to not actionable once nothing changed since the new revision.
import { expect, type Locator, type Page } from "@playwright/test"
import type { RefId } from "@rp/shared/library.ts"
import { Effect } from "effect"
import type { Client } from "./rpc.ts"

/** The editor's Save button (the cluster's, in a held-order bar too). */
export const saveButton = (scope: Page | Locator) => scope.getByRole("button", { name: "Save", exact: true })

/** Saves a revision from the save cluster in `scope`, with a message when given, and waits for it. */
export const saveRevision = async (scope: Page | Locator, message?: string) => {
  if (message === undefined) await saveButton(scope).click()
  else {
    await scope.getByRole("button", { name: "Save with message…", exact: true }).click()
    await scope.getByRole("textbox", { name: "Revision message", exact: true }).fill(message)
    await scope.getByRole("textbox", { name: "Revision message", exact: true }).press("Enter")
    await expect(scope.getByRole("textbox", { name: "Revision message", exact: true })).toHaveCount(0)
  }
  // Pending also disables Save. Wait for the saved state and the end of the
  // request; a valid no-op save clears drafts without advancing the revision.
  await expect(saveCluster(scope)).toHaveAttribute("data-save-state", NOTHING_TO_SAVE)
  await expect(saveButton(scope)).not.toHaveAttribute("aria-busy", "true")
  await expect(saveButton(scope)).toBeDisabled()
}

/** The save cluster in `scope` (its `data-save-state`: clean, unsaved, blocked, saving, saved, failed). */
export const saveCluster = (scope: Page | Locator) => scope.getByRole("group", { name: "Save", exact: true })

/** Something changed since the last save. */
export const UNSAVED = "unsaved"
/** Nothing to save: just saved (its tick still showing) or settled. */
export const NOTHING_TO_SAVE = /^(clean|saved)$/

/** Waits for the cluster in `scope` to be in `state` (a name or a pattern of them). */
export const expectSaveState = (scope: Page | Locator, state: string | RegExp, options?: { timeout?: number }) =>
  expect(saveCluster(scope)).toHaveAttribute("data-save-state", state, options)

/** Every text a library field's edit history holds, newest first (`EditorDraftHistory` + `EditorDraftState`); `field` is a `textField` key. */
export const editHistoryTexts = (api: Client, refId: RefId, field: string) =>
  Effect.flatMap(api.EditorDraftHistory({ refId, field, limit: 200 }), (states) =>
    Effect.forEach(states, (state) => api.EditorDraftState({ refId, field, seq: state.seq }))
  )
