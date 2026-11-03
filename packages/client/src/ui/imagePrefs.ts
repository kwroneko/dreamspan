// Images shown, blurred or hidden on this device, including before the first render.
//
// They're applied as attributes on the root element (`data-images`) that
// one rule each in styles.css reads, so every image surface, a new one included, follows
// them without knowing about them. `applyImagePrefs` runs before the first render
// (main.tsx), so no image is ever painted unblurred after a reload; another tab's change
// arrives through the `storage` event and applies at once.
import { useSyncExternalStore } from "react"

export type ImageMode = "show" | "blur" | "hide"
const MODE_KEY = "rp.images"
/** The concealment the toggle switches to: the one last picked, blur at first. */
const CONCEAL_KEY = "rp.images.conceal"

const get = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const set = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage off: the setting lasts until the page closes.
  }
}

const memory = new Map<string, string>()
const read = (key: string) => memory.get(key) ?? get(key)

const parseMode = (value: string | null): ImageMode => (value === "blur" || value === "hide" ? value : "show")
const parseConceal = (value: string | null): Exclude<ImageMode, "show"> => (value === "hide" ? "hide" : "blur")

interface ImagePrefs {
  readonly mode: ImageMode
  readonly conceal: Exclude<ImageMode, "show">
}

let current: ImagePrefs = { mode: "show", conceal: "blur" }
const listeners = new Set<() => void>()

const load = (): ImagePrefs => ({
  mode: parseMode(read(MODE_KEY)),
  conceal: parseConceal(read(CONCEAL_KEY))
})

const apply = () => {
  const next = load()
  const root = document.documentElement
  root.dataset.images = next.mode
  if (next.mode !== current.mode || next.conceal !== current.conceal) {
    current = next
    for (const listener of listeners) listener()
  }
}

let installed = false

/** Sets the root's attributes from storage, and follows changes from other tabs and the shortcut. */
export const applyImagePrefs = () => {
  apply()
  if (installed) return
  installed = true
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === MODE_KEY || event.key === CONCEAL_KEY) {
      memory.clear()
      apply()
    }
  })
  // Alt+Shift+B anywhere, a text field included: by the key's position, so it's the same on
  // every keyboard layout and a Mac's Option doesn't turn it into another character.
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !event.repeat &&
        event.code === "KeyB" &&
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        toggleImages()
      }
    },
    { capture: true }
  )
}

const store = (key: string, value: string) => {
  memory.set(key, value)
  set(key, value)
  apply()
}

export const setImageMode = (mode: ImageMode) => {
  if (mode !== "show") {
    memory.set(CONCEAL_KEY, mode)
    set(CONCEAL_KEY, mode)
  }
  store(MODE_KEY, mode)
}

/** Choose concealment without hiding images that are currently shown. */
export const setImageConceal = (conceal: Exclude<ImageMode, "show">) => {
  if (current.mode === "show") store(CONCEAL_KEY, conceal)
  else setImageMode(conceal)
}

/** Show ↔ the concealment last picked: the one-click toggle. */
export const toggleImages = () => setImageMode(current.mode === "show" ? current.conceal : "show")

export const IMAGES_SHORTCUT = "Alt+Shift+B"

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useImagePrefs = () => useSyncExternalStore(subscribe, () => current)
