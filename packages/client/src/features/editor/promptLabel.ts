/**
 * What a prompt is called: its name, else the first words of its text, marked `derived` so it's
 * shown muted (ST files often leave a prompt unnamed). Never empty.
 */
export function promptLabel(name: string, content: string): { readonly text: string; readonly derived: boolean } {
  if (name.trim() !== "") return { text: name, derived: false }
  const words = content
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "")
  if (words.length === 0) return { text: "Unnamed prompt", derived: true }
  const head = words.slice(0, 6).join(" ")
  const text = head.length > 48 ? `${head.slice(0, 47).trimEnd()}…` : words.length > 6 ? `${head}…` : head
  return { text, derived: true }
}
