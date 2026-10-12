// Stands in for rehype-raw in the build (vite.config.ts). Streamdown imports it to parse
// raw HTML, which this app never does: HTML in a message shows as text (ui/Markdown.tsx).
// Used anyway, it leaves the tree as it is, so raw HTML still isn't parsed.
export default function rehypeRaw() {
  return undefined
}
