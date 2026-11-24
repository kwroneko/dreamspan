import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useCallback,
  useState,
  useSyncExternalStore,
  type ComponentProps
} from "react"
import { diff } from "@codemirror/merge"
import rehypeRaw from "rehype-raw"
import { Block, type BlockProps, defaultRehypePlugins, Streamdown } from "streamdown"
import { fixMarkdownMapped, fixMarkdownRuns } from "./stFormatting.ts"
import { stBlocks, stHtmlRemarkPlugins, stRemarkPlugins } from "./stPipeline.ts"
import { MESSAGE_SCOPE, messageFontClass, scopeStyles } from "./html/css.ts"
import { BlockedMediaNote, htmlComponents, MediaBlocked } from "./html/HtmlParts.tsx"
import {
  extractStyles,
  hasImageSyntax,
  HtmlChatContext,
  HtmlMessageContext,
  HtmlSettingsContext,
  setStyleScoper
} from "./html/messageHtml.ts"
import { effectiveSchema, htmlPartsRevision, subscribeHtmlParts } from "./html/parts.ts"
import { htmlFinish, htmlMark, htmlPrepare, htmlRaw, htmlSanitize, urlAddress } from "./html/rehypeHtml.ts"
import { savedMediaRevision, subscribeSavedMedia } from "./html/savedMedia.ts"
import type { MessageTextProps } from "./Markdown.tsx"
import {
  sourcePositions,
  packSourceOffsets,
  packSourceRuns,
  type SourceChar,
  type SourceOffsets,
  type PositionedNode
} from "./sourcePositions.ts"

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
    // An anchor without an address (a card's `<a name>` target, or a link whose address the
    // sanitizer took out) stays an anchor: the hardener would caption it as a blocked link.
    const anchors: PositionedNode[] = []
    const bare = (node: PositionedNode) => {
      if (node.tagName === "a" && node.properties?.href === undefined) {
        node.tagName = "rp-anchor"
        anchors.push(node)
      }
      for (const child of node.children ?? []) bare(child)
    }
    bare(tree)
    transform(tree)
    for (const anchor of anchors) anchor.tagName = "a"
    for (const { parent, node, index } of images) {
      const replacement = parent.children?.[index]
      if (replacement && replacement !== node && node.position) {
        replacement.position = node.position
        replacement.data = { copyAlt: String(node.properties?.alt ?? "") }
      }
    }
  }
}
setStyleScoper((styles, key, bodyClass) => scopeStyles(styles, null, undefined, key, bodyClass).css)

type Plugins = NonNullable<ComponentProps<typeof Streamdown>["rehypePlugins"]>
const hardening = (allowDataImages: boolean, media = false) => [
  hardenWithPositions,
  {
    allowedLinkPrefixes: ["*"],
    defaultOrigin: typeof location === "undefined" ? "https://message.invalid" : location.origin,
    // Saved card media is this app's own file (html/savedMedia.ts); the proxy needs consent.
    allowedImagePrefixes: media ? ["/media/saved/", "/media/external?"] : ["/media/saved/"],
    allowDataImages,
    blockedImageClass: "md-blocked",
    blockedLinkClass: "md-blocked"
  }
]
/** "Show HTML as formatting" off: raw HTML stays text (Streamdown makes it text without rehype-raw). */
const rehypePlugins = [defaultRehypePlugins.sanitize!, hardening(false)] as Plugins
/**
 * On (ui/html/rehypeHtml.ts): parsed, sanitized by the registered schema and finished. `parts`
 * re-keys Streamdown's processor cache when a part is replaced; `block` keeps the document
 * blocks of different blocks apart. `data:` images load: they make no request.
 */
const htmlPlugins = (parts: number, block: number, mediaScope: string | null, saved: number) =>
  [
    htmlMark,
    // Streamdown keeps raw HTML as HTML only when rehype-raw is in the list (it compares the
    // plugin); off here, so unified skips it and htmlRaw parses in its place.
    [rehypeRaw, false],
    htmlRaw,
    [htmlPrepare, { parts }],
    [htmlSanitize, { parts }],
    [htmlFinish, { parts, block, mediaScope, saved }],
    hardening(true, mediaScope !== null)
  ] as Plugins

function Link({ node: _node, ...props }: ComponentProps<"a"> & { node?: unknown; xlinkHref?: unknown }) {
  // An SVG link may have only `xlink:href`: the browser follows that one then.
  const href = typeof props.href === "string" ? props.href : props.xlinkHref
  // A link to a place in the message (a card's own `#…` anchors) stays on the page.
  if (typeof href !== "string" || urlAddress(href).startsWith("#")) {
    const { target: _target, rel: _rel, ...rest } = props
    return <a {...rest} />
  }
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
const remarkPlugins = stRemarkPlugins
const htmlRemarkPlugins = stHtmlRemarkPlugins
const SourceBlocks = createContext<ReadonlyArray<string>>([])
/** How this text's blocks render HTML: null shows it as text. */
const BlockHtml = createContext<{
  readonly parts: number
  readonly mediaScope: string | null
  readonly saved: number
} | null>(null)

function PositionedBlock(props: BlockProps) {
  const key = useContext(SourceBlocks)[props.index] ?? "[]"
  const html = useContext(BlockHtml)
  // A block without a tag has no HTML to parse: the plain pipeline renders it the same, cheaper.
  const parse = html !== null && (props.content.includes("<") || hasImageSyntax(props.content))
  // Streamdown caches processors by plugin name + serialized options, not function identity.
  const plugins = useMemo(
    () =>
      [
        ...(parse ? htmlPlugins(html.parts, props.index, html.mediaScope, html.saved) : rehypePlugins),
        [sourcePositions, { offsets: JSON.parse(key) as SourceOffsets }]
      ] as Plugins,
    [key, parse, html, props.index]
  )
  const markdown = props.components
  const withHtml = useMemo(
    () => (parse ? (htmlComponents(markdown) as BlockProps["components"]) : markdown),
    [parse, markdown]
  )
  return (
    <Block
      {...props}
      rehypePlugins={plugins}
      {...(parse ? { remarkPlugins: htmlRemarkPlugins } : {})}
      {...(withHtml ? { components: withHtml } : {})}
    />
  )
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
  const settings = useContext(HtmlSettingsContext)
  const message = useContext(HtmlMessageContext)
  const chat = useContext(HtmlChatContext)
  const parts = useSyncExternalStore(subscribeHtmlParts, htmlPartsRevision, htmlPartsRevision)
  const saved = useSyncExternalStore(subscribeSavedMedia, savedMediaRevision, savedMediaRevision)
  // Disabling the registered schema (`html.inline`) shows HTML as text, as the switch does.
  const mediaScope = message?.media?.scope ?? null
  const html = useMemo(
    () => (settings.html && effectiveSchema() ? { parts, mediaScope, saved } : null),
    [settings.html, parts, mediaScope, saved]
  )
  // A message body's `<style>`s join the chat's stylesheet (ui/html/messageHtml.ts).
  const fontKey = message ? (chat?.styles.fontKey(message.key) ?? message.key) : undefined
  const bodyClass = chat?.styles.bodyClass
  const styles = useMemo(
    () =>
      html && fontKey !== undefined
        ? scopeStyles(extractStyles(text), mediaScope, undefined, fontKey, bodyClass)
        : null,
    [html, fontKey, text, mediaScope, bodyClass]
  )
  useEffect(() => {
    if (styles && message && chat) chat.styles.report(message.key, styles.css, styles.media)
  }, [styles, message, chat])
  const [blockedText, setBlockedText] = useState<string | null>(null)
  const reportBlocked = useCallback(() => setBlockedText(text), [text])
  const { fixed, renderedBlocks, sourceBlocks } = useMemo(() => {
    const indexed = fixMarkdownRuns(text)
    const normalized = indexed.text.replace(/\r\n|\r/g, "\n")
    const { blocks: parsed, starts, rendered } = stBlocks(normalized)
    // While a display transform catches up with a stream, its previous answer can
    // still be an unchanged prefix. Those characters have the same source offsets.
    if (sourceText.startsWith(text) && normalized === indexed.text) {
      const sourceBlocks = parsed.map((block, i) => packSourceRuns(indexed.runs, starts[i]!, starts[i]! + block.length))
      return { fixed: normalized, renderedBlocks: [...rendered], sourceBlocks }
    }
    const fixed = fixMarkdownMapped(text)
    const display = displayRanges(sourceText, text)
    const mapped = fixed.offsets.map((offset) => (offset === null ? null : (display[offset] ?? null)))
    const offsets: SourceChar[] = []
    // Streamdown's block parser normalizes line endings before reporting blocks.
    // Normalize explicitly so parser positions still address the stored CRLF range.
    fixed.text.replace(/\r\n|\r|[^\r]/g, (char, at: number) => {
      const first = mapped[at]
      const last = mapped[at + char.length - 1]
      offsets.push(first && last ? [first[0], last[1]] : null)
      return char === "\r\n" || char === "\r" ? "\n" : char
    })
    const sourceBlocks = parsed.map((block, i) =>
      packSourceOffsets(offsets.slice(starts[i]!, starts[i]! + block.length))
    )
    return { fixed: normalized, renderedBlocks: [...rendered], sourceBlocks }
  }, [text, sourceText])
  const blocks = useCallback(() => renderedBlocks, [renderedBlocks])
  const blocked = html !== null && mediaScope === null && (blockedText === text || styles?.blocked === true)
  return (
    <SourceBlocks.Provider value={sourceBlocks}>
      <BlockHtml value={html}>
        <MediaBlocked value={html ? reportBlocked : null}>
          <Streamdown
            // Contained (styles.css): a card's `position: fixed` stays inside its message (fix 1).
            className={`markdown${html ? " markdown-html" : ""}${html && fontKey !== undefined ? ` ${MESSAGE_SCOPE} ${messageFontClass(fontKey)}${bodyClass ? ` ${bodyClass}` : ""}` : ""}`}
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
          {blocked && <BlockedMediaNote />}
        </MediaBlocked>
      </BlockHtml>
    </SourceBlocks.Provider>
  )
}
