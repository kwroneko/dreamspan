import { useSyncExternalStore } from "react"

export const messageColors = [
  { key: "mainTextColor", label: "Main text", token: "--message-main" },
  { key: "italicsTextColor", label: "Italics", token: "--message-italics" },
  { key: "underlineTextColor", label: "Underline", token: "--message-underline" },
  { key: "quoteTextColor", label: "Quote", token: "--message-quote" }
] as const

// The CSS tokens own defaults, including automatic and explicitly selected themes.
const subscribeTheme = (changed: () => void) => {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  media.addEventListener("change", changed)
  const observer = new MutationObserver(changed)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  return () => {
    media.removeEventListener("change", changed)
    observer.disconnect()
  }
}
export function useMessageColorDefault(token: string) {
  return useSyncExternalStore(
    subscribeTheme,
    () => getComputedStyle(document.documentElement).getPropertyValue(`${token}-default`).trim(),
    () => "#000000"
  )
}
