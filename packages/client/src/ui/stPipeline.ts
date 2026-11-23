// The built-in message formatter's Markdown steps that don't render anything: how its text is
// split into blocks and the remark plugins each block is parsed with. The renderer
// (StMarkdown.tsx) and the message editor's styling (messageStyles.ts) both use these, so what
// the editor shows as dialogue, italics or bold is what the message renders as such.
import { defaultRemarkPlugins, parseMarkdownIntoBlocks } from "streamdown"
import { withDefinitions } from "./referenceDefinitions.ts"
import { stFormatting } from "./stFormatting.ts"

export const stRemarkPlugins = [...Object.values(defaultRemarkPlugins), stFormatting]
/** With "Show HTML as formatting": raw HTML stays HTML for the HTML pipeline (ui/html). */
export const stHtmlRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  [stFormatting, { html: true }]
] as typeof stRemarkPlugins

/**
 * The display-fixed text (`fixMarkdownRuns`) in the blocks Streamdown renders one by one: each
 * block's text, where it starts in `fixed`, and what it is parsed as (with the reference
 * definitions it refers to copied in at its end).
 */
export function stBlocks(fixed: string): {
  readonly blocks: ReadonlyArray<string>
  readonly starts: ReadonlyArray<number>
  readonly rendered: ReadonlyArray<string>
} {
  const blocks = parseMarkdownIntoBlocks(fixed)
  const starts: number[] = []
  let cursor = 0
  for (const block of blocks) {
    const start = fixed.indexOf(block, cursor)
    starts.push(start)
    cursor = start + block.length
  }
  return { blocks, starts, rendered: withDefinitions(fixed, blocks) }
}
