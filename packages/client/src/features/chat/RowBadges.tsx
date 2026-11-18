// A list row's secondary line with its badges (Workshop, opens here) right after its text, never
// in the title's flow (owner, 2026-11-18). The badges are glued to the text's last word (`whole`:
// to all of it), so they follow the text where it ends and never start a line of their own.
import type { ReactNode } from "react"

export function TextThenBadges({
  text,
  whole = false,
  children
}: {
  text: string
  whole?: boolean
  children: ReactNode
}) {
  const cut = whole ? -1 : text.lastIndexOf(" ")
  return (
    <>
      {cut < 0 ? null : text.slice(0, cut + 1)}
      <span className="whitespace-nowrap *:ms-1.5">
        {text.slice(cut + 1)}
        {children}
      </span>
    </>
  )
}
