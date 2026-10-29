// All revisioned library documents use the same full-text history browser.
import { Button } from "../../ui/Button.tsx"
import { Dialog, DialogActions } from "../../ui/Dialog.tsx"
import type { Caller } from "./caller.ts"
import { CardRevisionBrowser } from "./CardRevisionBrowser.tsx"
import type { EditorStore } from "./store.ts"

export function RevisionsDialog({ store, call, onClose }: { store: EditorStore; call: Caller; onClose: () => void }) {
  return (
    <Dialog
      wide
      open
      onOpenChange={(open) => !open && onClose()}
      title="History"
      description="Restoring makes a new revision with that content: the revisions after it stay."
    >
      <CardRevisionBrowser store={store} call={call} />
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
