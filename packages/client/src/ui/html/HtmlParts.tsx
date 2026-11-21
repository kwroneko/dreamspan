import { useQueuedMediaProps } from "./useQueuedMedia.ts"
import { HtmlMessageContext } from "./messageHtml.ts"
import { Button } from "../Button.tsx"
// The React side of message HTML (spec/HTML-MESSAGES.md §3.2): parsed elements render as
// themselves, not as Streamdown's Markdown components; form controls stay the user's to change
// (CSS-only games toggle checkboxes); a document block goes to the registered frame renderer;
// and blocked media becomes one note under the message.
import { createContext, createElement, useContext, useEffect, type ComponentType, type ReactNode } from "react"
import { defaultComponents } from "streamdown"
import { Icon } from "../Icon.tsx"
import { effectiveDocumentRenderer, effectiveSchema } from "./parts.ts"
import { FRAME_ELEMENT, MEDIA_MARKER } from "./rehypeHtml.ts"

interface HastNode {
  readonly tagName?: string
  readonly type?: string
  readonly value?: string
  readonly properties?: Record<string, unknown>
  readonly children?: ReadonlyArray<HastNode>
  readonly data?: { readonly html?: boolean }
  readonly position?: { readonly start?: { readonly offset?: number } }
}
type Props = Record<string, unknown> & { node?: HastNode; children?: ReactNode }

const parsed = (node: HastNode | undefined) => node?.data?.html === true
const textOf = (node: HastNode): string =>
  node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("")

/** An element from the message's HTML, as written: no Markdown component's wrappers or controls. */
function Plain({ node, ...props }: Props) {
  return createElement(node!.tagName!, props)
}

/** Each Markdown component, or the plain element when the HTML wrote it (a card's own `<table>`). */
function htmlAware(markdown: ComponentType<Props> | string): ComponentType<Props> {
  return function HtmlAware(props: Props) {
    const queued = useQueuedMediaProps(props, props.node?.tagName ?? "")
    const { node: _node, ...dom } = queued
    return parsed(props.node) ? (
      <Plain {...queued} />
    ) : (
      createElement(markdown, typeof markdown === "string" ? dom : queued)
    )
  }
}

/** Input types whose value is text the user types (a password isn't kept). */
const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "number"])

/**
 * A text field the user types into: kept as typed by the chat's TextField (messageHtml.ts), keyed
 * by the version and the field's place in the HTML; without one, uncontrolled as written.
 */
function TextField({
  node,
  tag,
  props,
  initial
}: {
  node: HastNode | undefined
  tag: "input" | "textarea"
  props: Record<string, unknown>
  initial: string
}) {
  const message = useContext(HtmlMessageContext)
  const at = node?.position?.start?.offset
  if (message?.TextField && message.versionId !== undefined && typeof at === "number")
    return <message.TextField fieldKey={`${message.versionId}:${at}`} tag={tag} props={props} initial={initial} />
  return tag === "textarea" ? (
    <textarea {...props} defaultValue={initial} />
  ) : (
    <input {...props} defaultValue={initial} />
  )
}

/** Uncontrolled, so a click toggles a checkbox or radio, and typing changes a field. */
function Input({ node, checked, value, ...raw }: Props) {
  const props = useQueuedMediaProps(raw, "input")
  if (!parsed(node)) return <input {...props} checked={checked as boolean} value={value as string} />
  const type = String(props.type ?? "").toLowerCase()
  if (type === "checkbox" || type === "radio")
    return <input {...props} value={value as string} defaultChecked={checked as boolean} />
  if (TEXT_TYPES.has(type)) return <TextField node={node} tag="input" props={props} initial={String(value ?? "")} />
  return <input {...props} defaultValue={value as string} />
}
function Textarea({ node, children: _children, value, ...raw }: Props) {
  const props = useQueuedMediaProps(raw, "textarea")
  const initial = (value as string | undefined) ?? (node ? textOf(node) : "")
  return <TextField node={node} tag="textarea" props={props} initial={initial} />
}
function Select({ node, value, ...raw }: Props) {
  const props = useQueuedMediaProps(raw, "select")
  const options = (function* walk(at: HastNode | undefined): Generator<HastNode> {
    for (const child of at?.children ?? []) {
      if (child.tagName === "option") yield child
      else yield* walk(child)
    }
  })(node)
  const selected = [...options]
    .filter((option) => option.properties?.selected)
    .map((option) => String(option.properties?.value ?? textOf(option)))
  const initial = (value as string | undefined) ?? (props.multiple ? selected : selected[0])
  return <select {...props} defaultValue={initial} />
}
function Option({ node: _node, selected: _selected, ...raw }: Props) {
  const props = useQueuedMediaProps(raw, "option")
  return <option {...props} />
}

/** Media from another site was left out somewhere in the message (the marker element). */
export const MediaBlocked = createContext<(() => void) | null>(null)
function MediaMarker() {
  const report = useContext(MediaBlocked)
  useEffect(() => report?.(), [report])
  return null
}

/** The note under a message whose media was left out. */
export function BlockedMediaNote() {
  const media = useContext(HtmlMessageContext)?.media
  return (
    <div role="note" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted select-none">
      <Icon name="image" className="size-3.5 shrink-0" />
      <span>Images from other sites are blocked.</span>
      {media?.actions.map((action) => (
        <Button
          key={action.label}

          variant="ghost"
          hint={action.about}
          disabled={media.pending}
          onClick={() => void action.allow()}
        >
          {action.label}
        </Button>
      ))}
      {media?.error && (
        <span role="alert" className="text-danger">
          {media.error}
        </span>
      )}
    </div>
  )
}

/**
 * A video: the browser picks among its `<source>`s once, when it loads, so a source that changes
 * later (a saved file whose lookup answered after a placeholder) mounts a new player.
 */
function Video(props: Props) {
  const queued = useQueuedMediaProps(props, "video")
  const { node: _node, ...dom } = queued
  const sources = [
    String(props.src ?? ""),
    ...(props.node?.children ?? []).map((child) =>
      child.type === "element" && child.tagName === "source" ? String(child.properties?.src ?? "") : ""
    )
  ].join(" ")
  return createElement("video", { ...dom, key: sources })
}

/** A document block, through the registered frame renderer (parts.ts, `html.frame`). */
function DocumentBlock(props: Props) {
  const renderer = effectiveDocumentRenderer()
  if (!renderer) return null
  const Component = renderer.component
  return (
    <Component
      source={String(props.source ?? "")}
      index={Number(props.block ?? 0) * 1000 + Number(props.index ?? 0)}
      {...(typeof props["data-source-map"] === "string" ? { sourceMap: props["data-source-map"] } : {})}
    />
  )
}

/**
 * The block's components (Streamdown's, with the app's overrides), each aware of parsed HTML.
 * Links keep the app's component either way: its new-tab rule applies to parsed links too.
 */
export function htmlComponents(markdown: object | undefined): Record<string, ComponentType<Props>> {
  const all: Record<string, ComponentType<Props> | string> = {
    ...(defaultComponents as unknown as Record<string, ComponentType<Props>>),
    ...(markdown as Record<string, ComponentType<Props>> | undefined)
  }
  for (const tag of effectiveSchema()?.schema("").tagNames ?? []) all[tag] ??= tag
  return {
    ...Object.fromEntries(
      Object.entries(all).map(([tag, component]) => [
        tag,
        tag === "a"
          ? function QueuedLink(props: Props) {
              return createElement(component, useQueuedMediaProps(props, "a"))
            }
          : htmlAware(component)
      ])
    ),
    input: Input,
    textarea: Textarea,
    select: Select,
    option: Option,
    video: Video,
    [FRAME_ELEMENT]: DocumentBlock,
    [MEDIA_MARKER]: MediaMarker
  }
}
