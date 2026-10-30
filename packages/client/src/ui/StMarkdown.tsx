import { createContext, useContext, useMemo, useCallback, type ComponentProps } from "react"
import { diff } from "@codemirror/merge"
import {
  Block,
  type BlockProps,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  parseMarkdownIntoBlocks,
  Streamdown
} from "streamdown"
import { fixMarkdownMapped, stFormatting } from "./stFormatting.ts"
import type { MessageTextProps } from "./Markdown.tsx"
import { withDefinitions } from "./referenceDefinitions.ts"
import { sourcePositions, type SourceChar, type PositionedNode } from "./sourcePositions.ts"

const [harden] = defaultRehypePlugins.harden as [unknown, unknown]
// The hardener replaces blocked images with a caption and otherwise drops their
// provenance. Preserve only position/alt data, without changing its policy or output.
function hardenWithPositions(options: unknown) {
  const transform = (harden as (options: unknown) => (tree: PositionedNode) => void)(options)
  return (tree: PositionedNode) => {
    const images: Array<{ parent: PositionedNode; node: PositionedNode; index: number }> = []
    const visit = (parent: PositionedNode) => {
      for (const [index, node] of (parent.children ?? []).entries()) {
        if (node.tagName === "img") images.push({ parent, node, index })
        else visit(node)
      }
    }
    visit(tree)
    transform(tree)
    for (const { parent, node, index } of images) {
      const replacement = parent.children?.[index]
      if (replacement && replacement !== node && node.position) {
        replacement.position = node.position
        replacement.data = { copyAlt: String(node.properties?.alt ?? "") }
      }
    }
  }
}
const rehypePlugins = [
  defaultRehypePlugins.sanitize!,
  [
    hardenWithPositions,
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
const SourceBlocks = createContext<ReadonlyArray<string>>([])

function PositionedBlock(props: BlockProps) {
  const key = useContext(SourceBlocks)[props.index] ?? "[]"
  // Streamdown caches processors by plugin name + serialized options, not function identity.
  const plugins = useMemo(
    () => [...rehypePlugins, [sourcePositions, { offsets: JSON.parse(key) as SourceChar[] }]] as typeof rehypePlugins,
    [key]
  )
  return <Block {...props} rehypePlugins={plugins} />
}

/** Display transforms can replace a stored token (for example a greeting macro).
 * A replacement refers to that original range; purely inserted display text has no source. */
function displayRanges(stored: string, display: string): SourceChar[] {
  const ranges: SourceChar[] = []
  let a = 0
  let b = 0
  for (const change of diff(stored, display, { scanLimit: 500 })) {
    while (b < change.fromB) {
      ranges.push([a, a + 1])
      a++
      b++
    }
    while (b < change.toB) {
      ranges.push(change.fromA === change.toA ? null : [change.fromA, change.toA])
      b++
    }
    a = change.toA
  }
  while (b < display.length) {
    ranges.push([a, a + 1])
    a++
    b++
  }
  return ranges
}

/** The built-in ST formatter; storage, copy and prompt text never pass through it. */
export function StMarkdown({ text, sourceText = text }: MessageTextProps) {
  const { fixed, renderedBlocks, sourceBlocks } = useMemo(() => {
    const fixed = fixMarkdownMapped(text)
    const display = displayRanges(sourceText, text)
    const mapped = fixed.offsets.map((offset) => (offset === null ? null : (display[offset] ?? null)))
    const offsets: SourceChar[] = []
    // Streamdown's block parser normalizes line endings before reporting blocks.
    // Normalize explicitly so parser positions still address the stored CRLF range.
    const normalized = fixed.text.replace(/\r\n|\r|[^\r]/g, (char, at: number) => {
      const first = mapped[at]
      const last = mapped[at + char.length - 1]
      offsets.push(first && last ? [first[0], last[1]] : null)
      return char === "\r\n" || char === "\r" ? "\n" : char
    })
    const parsed = parseMarkdownIntoBlocks(normalized)
    let cursor = 0
    const sourceBlocks: string[] = []
    for (const block of parsed) {
      const start = normalized.indexOf(block, cursor)
      cursor = start + block.length
      sourceBlocks.push(JSON.stringify(offsets.slice(start, cursor)))
    }
    return { fixed: normalized, renderedBlocks: [...withDefinitions(normalized, parsed)], sourceBlocks }
  }, [text, sourceText])
  const blocks = useCallback(() => renderedBlocks, [renderedBlocks])
  return (
    <SourceBlocks.Provider value={sourceBlocks}>
      <Streamdown
        className="markdown"
        mode="streaming"
        parseIncompleteMarkdown={false}
        parseMarkdownIntoBlocksFn={blocks}
        BlockComponent={PositionedBlock}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
        components={components}
        controls={false}
        linkSafety={{ enabled: false }}
        lineNumbers={false}
      >
        {fixed}
      </Streamdown>
    </SourceBlocks.Provider>
  )
}
