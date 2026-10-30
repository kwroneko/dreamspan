// Copying a message's text or reasoning to the clipboard, saying whether it worked.
import { showToast } from "../../ui/Toast.tsx"

export const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast({ title: `${what} copied` })
  } catch {
    showToast({ title: `Couldn't copy the ${what.toLowerCase()}`, description: "The browser didn't allow it." })
  }
}
