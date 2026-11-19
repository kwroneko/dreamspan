// The editor's browser copies (features/editor/backup.ts): each change is kept in this
// browser until the server has it, so none left means every change reached the server.
import type { Page } from "@playwright/test"

/** How many of the editor's changes this browser still holds for the server. */
export const unsentEditorCopies = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("dreamspan-editor-copies", 1)
        request.onsuccess = () => {
          const db = request.result
          const count = db.transaction("copies").objectStore("copies").count()
          count.onsuccess = () => {
            db.close()
            resolve(count.result)
          }
        }
      })
  )
