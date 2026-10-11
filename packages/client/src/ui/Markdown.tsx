// Message text as sanitized Markdown (DESIGN §10.2, §11), on Streamdown: it splits text
// into blocks and memoizes each, so a streaming message re-renders only its last block,
// and it closes unfinished Markdown (an open `**`, a half-written link) as it arrives.
//
// What we change: raw HTML is shown as text, never parsed (Streamdown drops rehype-raw's
// pass when it isn't listed); no image is loaded, since a model or a card could point one
// at a server to report on the chat; links open in a new tab without a referrer; and the
// split into blocks is incremental per message, so only the tail is lexed again.
import { type ComponentProps, useState } from "react"
import remend from "remend"
import { defaultRehypePlugins, parseMarkdownIntoBlocks, Streamdown } from "streamdown"

const [harden] = defaultRehypePlugins.harden as [unknown, unknown]
const rehypePlugins = [
  defaultRehypePlugins.sanitize!,
  [
    harden,
    {
      allowedLinkPrefixes: ["*"],
      allowedImagePrefixes: [],
      allowDataImages: false,
      blockedImageClass: "md-blocked",
      blockedLinkClass: "md-blocked"
    }
  ]
] as NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>

function Link({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  return <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
}

const components = { a: Link }

/** A reference definition anywhere can change how earlier text parses: then everything is lexed again. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/m

/**
 * Splits growing text into blocks, lexing only from the last settled block on: blocks
 * before the last two that end in a blank line can't change as text is appended.
 * Streamdown has a cache like this, but one for the whole page, so concurrent streams
 * would keep evicting each other's.
 */
const incrementalBlocks = () => {
  let input = ""
  let blocks: Array<string> = []
  return (text: string): Array<string> => {
    if (text === input) return blocks
    let keep = 0
    if (text.startsWith(input) && !REFERENCE_DEFINITION.test(text)) {
      for (let i = blocks.length - 3; i >= 0; i--) {
        if (blocks[i]!.endsWith("\n\n")) {
          keep = i + 1
          break
        }
      }
    }
    const settled = blocks.slice(0, keep)
    const offset = settled.reduce((sum, block) => sum + block.length, 0)
    blocks = settled.concat(parseMarkdownIntoBlocks(text.slice(offset)))
    input = text
    return blocks
  }
}

/**
 * Markdown, with `streaming` while the text is still arriving: the last block is then
 * closed up for display, the way Streamdown does it for a whole message.
 */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const [split] = useState(incrementalBlocks)
  const blocks = (markdown: string) => {
    const all = split(markdown)
    if (!streaming || all.length === 0) return all
    return [...all.slice(0, -1), remend(all.at(-1)!)]
  }
  return (
    <Streamdown
      className="markdown"
      mode="streaming"
      parseIncompleteMarkdown={false}
      parseMarkdownIntoBlocksFn={blocks}
      rehypePlugins={rehypePlugins}
      components={components}
      controls={false}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  )
}
