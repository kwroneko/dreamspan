// Message text as sanitized Markdown (DESIGN §10.2, §11), on Streamdown: it splits text
// into blocks and memoizes each, so a streaming message re-renders only its last block,
// and it closes unfinished Markdown (an open `**`, a half-written link) as it arrives.
//
// What we change: raw HTML is shown as text, never parsed (Streamdown drops rehype-raw's
// pass when it isn't listed); no image is loaded, since a model or a card could point one
// at a server to report on the chat; links open in a new tab without a referrer; and only
// the last block of a streaming message is closed up, not the whole text.
import type { ComponentProps } from "react"
import remend from "remend"
import { defaultRehypePlugins, parseMarkdownIntoBlocks, Streamdown } from "streamdown"
import { withDefinitions } from "./referenceDefinitions.ts"

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

/**
 * Markdown, with `streaming` while the text is still arriving: the last block is then
 * closed up for display, the way Streamdown does it for a whole message.
 */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  // The whole text is split again on every update: the performance harness's long reply
  // (4,000+ tokens) measured no difference from splitting only the tail.
  const blocks = (markdown: string) => {
    const all = parseMarkdownIntoBlocks(markdown)
    const shown = !streaming || all.length === 0 ? all : [...all.slice(0, -1), remend(all.at(-1)!)]
    return [...withDefinitions(markdown, shown)]
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
