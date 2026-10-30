import type { ComponentProps } from "react"
import { defaultRehypePlugins, defaultRemarkPlugins, parseMarkdownIntoBlocks, Streamdown } from "streamdown"
import { fixMarkdown, stFormatting } from "./stFormatting.ts"
import type { MessageTextProps } from "./Markdown.tsx"
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

function Underline({ node: _node, ...props }: ComponentProps<"ins"> & { node?: unknown }) {
  return <u {...props} />
}
function Strong({ node: _node, ...props }: ComponentProps<"strong"> & { node?: unknown }) {
  return <strong {...props} />
}
// ins survives the unchanged sanitizer. Only our Markdown AST emits it; raw HTML
// is still text. The React component then supplies the underline presentation.
const components = { a: Link, ins: Underline, strong: Strong }
const remarkPlugins = [...Object.values(defaultRemarkPlugins), stFormatting]

/** The built-in ST formatter; storage, copy and prompt text never pass through it. */
export function StMarkdown({ text }: MessageTextProps) {
  const fixed = fixMarkdown(text)
  const blocks = (markdown: string) => [...withDefinitions(markdown, parseMarkdownIntoBlocks(markdown))]
  return (
    <Streamdown
      className="markdown"
      mode="streaming"
      parseIncompleteMarkdown={false}
      parseMarkdownIntoBlocksFn={blocks}
      rehypePlugins={rehypePlugins}
      remarkPlugins={remarkPlugins}
      components={components}
      controls={false}
      linkSafety={{ enabled: false }}
      lineNumbers={false}
    >
      {fixed}
    </Streamdown>
  )
}
