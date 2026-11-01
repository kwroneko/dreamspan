// All revisioned library documents use the same full-text history browser.
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import type { Caller } from "./caller.ts"
import { CardRevisionBrowser, type SettingLines } from "./CardRevisionBrowser.tsx"
import type { EditorStore } from "./store.ts"

export function RevisionsDialog({
  store,
  call,
  onClose,
  title = "History",
  settingLines
}: {
  store: EditorStore
  call: Caller
  onClose: () => void
  /** "History: <name>", where the page doesn't say whose it is. */
  title?: string
  /** How the kind's settings read in its comparisons (a note's position), past the generic reading. */
  settingLines?: SettingLines | undefined
}) {
  return (
    <Dialog
      wide
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description="Restoring makes a new revision with that content: the revisions after it stay."
    >
      <CardRevisionBrowser store={store} call={call} settingLines={settingLines} />
      <DialogActions>
        <Button onClick={onClose} hint="Closes the history; nothing changes.">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
