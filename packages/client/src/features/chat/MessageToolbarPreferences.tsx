// Which message actions show as buttons on messages: the account's choice, in its display
// preferences (`messageToolbar`, by action id), so it follows the user to every device.
// Mounted through app.tools; replacing or disabling this registration keeps the choices in
// the tab instead (messageActionPins).
import { useEffect } from "react"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { messageActionPins } from "./messageActions.tsx"

export function MessageToolbarPreferences() {
  const viewer = useViewPrefs()
  const choices = viewer.prefs.messageToolbar
  const { change } = viewer
  const error = viewer.error?.message ?? null
  useEffect(() => {
    // Shown at once as the whole map; the server is asked to merge only the one choice, so
    // another device's choices made meanwhile stay.
    messageActionPins.connect(choices, error, (id, pinned) => {
      void change({ messageToolbar: { ...choices, [id]: pinned } }, { messageToolbar: { [id]: pinned } })
    })
  }, [choices, error, change])
  useEffect(() => () => messageActionPins.connect({}, null, null), [])
  return null
}
