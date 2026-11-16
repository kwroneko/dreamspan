// What a message says about itself beside its text (msgmeta, owner 2026-11-01, after ST's
// message header and the column under its portrait): in the header, when it was written
// (time first, the date when it isn't today) and the model that wrote it, with its lab's
// mark; under the portrait, its number, the generation time and the tokens (versionMetrics.tsx).
// Each is a registered detail (spec/PLUGINS.md §8) with a place, a name and a description, so a
// plugin adds, replaces or disables one, and the Interface settings list a switch for every
// detail registered, defaulting to shown (ST's Chat Timestamps, Model Icons, Message IDs,
// Message Timer and Message Token Count). The choices are the account's (`messageDetails`).
import type { PathEntry } from "@rp/shared/chat.ts"
import { type ComponentProps, type ComponentType, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { makeRegistry } from "../../registry.ts"
import { Switch } from "../../ui/Choice.tsx"
import { Fieldset } from "../../ui/Field.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { useViewPrefs } from "../../ui/viewPrefs.ts"
import { GenericModelMark, markFor, providerLabel, useModelMarks } from "./modelMarks.tsx"
import { positionOf } from "./position.ts"
import type { ChatSession } from "./session.ts"

export interface MessageDetailProps {
  readonly entry: PathEntry
  readonly session: ChatSession
  readonly generating: boolean
  /** On the replies' side (as the cast places it), not the user's. */
  readonly reply: boolean
}

export interface MessageDetail {
  readonly id: string
  /** In the header after the name, or in the column under the portrait. */
  readonly place: "header" | "portrait"
  readonly order: number
  /** Its switch in the Interface settings, and what it shows. */
  readonly label: string
  readonly description: string
  /** Renders nothing where the message has no such detail. */
  readonly component: ComponentType<MessageDetailProps>
}

export const messageDetails = { id: "message.details", ...makeRegistry<MessageDetail>() }

/** The details shown, by place and in order: those the user hid left out. */
export function useMessageDetails() {
  const { entries } = useSyncExternalStore(messageDetails.subscribe, messageDetails.snapshot, messageDetails.snapshot)
  const hidden = useViewPrefs().prefs.messageDetails
  const shown = [...entries].filter((detail) => hidden[detail.id] !== false).sort((a, b) => a.order - b.order)
  return {
    header: shown.filter((detail) => detail.place === "header"),
    portrait: shown.filter((detail) => detail.place === "portrait")
  }
}

export function MessageDetails({ details, ...props }: MessageDetailProps & { details: ReadonlyArray<MessageDetail> }) {
  return details.map((detail) => <detail.component key={detail.id} {...props} />)
}

/** A switch per registered detail, on unless the user turned it off. */
export function MessageDetailSettings() {
  const viewer = useViewPrefs()
  const { entries } = useSyncExternalStore(messageDetails.subscribe, messageDetails.snapshot, messageDetails.snapshot)
  const choices = viewer.prefs.messageDetails
  const sorted = [...entries].sort((a, b) => (a.place === b.place ? a.order - b.order : a.place === "header" ? -1 : 1))
  if (sorted.length === 0) return null
  return (
    <Fieldset legend="Message details">
      {sorted.map((detail) => {
        const on = choices[detail.id] !== false
        return (
          <Switch
            key={detail.id}
            checked={on}
            disabled={!viewer.ready}
            onCheckedChange={(next) =>
              void viewer.change(
                { messageDetails: { ...choices, [detail.id]: next } },
                { messageDetails: { [detail.id]: next } }
              )
            }
            about={detail.description}
          >
            {detail.label}
          </Switch>
        )
      })}
    </Fieldset>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })
const yearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" })

/**
 * "14:32" today, "Mar 4, 14:32" this year, "Mar 4, 2025, 14:32" before: the time first, in
 * the browser's locale and its 12- or 24-hour clock (accounts have no setting for either).
 */
export const formatMessageTime = (at: number, now = Date.now()) => {
  const date = new Date(at)
  const today = new Date(now)
  const time = timeFormat.format(date)
  if (date.toDateString() === today.toDateString()) return time
  return `${(date.getFullYear() === today.getFullYear() ? dayFormat : yearFormat).format(date)}, ${time}`
}
export const formatFullTime = (at: number) => fullFormat.format(at)

function WrittenAt({ entry }: MessageDetailProps) {
  const at = entry.version.createdAt
  return (
    <Tooltip label={`Written ${formatFullTime(at)}`}>
      <time
        tabIndex={0}
        dateTime={new Date(at).toISOString()}
        className="shrink-0 text-xs whitespace-nowrap text-muted tabular-nums outline-none"
      >
        {formatMessageTime(at)}
      </time>
    </Tooltip>
  )
}

/** Where the model was used through, when that isn't the lab itself: "through OpenRouter". */
const through = (provider: string, lab: string | undefined) => {
  const name = provider === "" ? "" : providerLabel(provider)
  return name === "" || name === lab ? "" : ` through ${name}`
}

function ModelIcon({ entry }: MessageDetailProps) {
  const { version } = entry
  const marks = useModelMarks()
  if (version.writer !== "model" || !version.modelRef) return null
  const mark = markFor(marks, version.modelRef)
  const Drawing = mark?.component ?? GenericModelMark
  const model = version.modelRef.model
  const label = `${mark ? `${mark.label}'s model` : "Model"}${model ? ` ${model}` : ""}${through(version.modelRef.provider, mark?.label)}`
  return (
    <Tooltip label={label}>
      <span
        tabIndex={0}
        role="img"
        aria-label={mark ? `${mark.label} model` : "Model"}
        data-model-mark={mark?.id ?? "generic"}
        className="flex shrink-0 items-center text-muted outline-none"
      >
        <Drawing size={14} />
      </span>
    </Tooltip>
  )
}

/**
 * A header item that never moves the wrapping header (a phone's, a narrow column's) onto
 * another line: no width of its own, it grows into what its line leaves, up to its content.
 */
const headerGives =
  "max-sm:shrink max-sm:basis-0 max-sm:grow max-sm:max-w-max @max-[30rem]/chat:shrink @max-[30rem]/chat:basis-0 @max-[30rem]/chat:grow @max-[30rem]/chat:max-w-max"

/**
 * Uses the header's available width: show "connection · model" in full or hide the
 * connection entirely, then cut the model only if it alone is too wide. The invisible
 * full label keeps the intrinsic size stable as the observer switches the connection;
 * switching the connection does not move the header or cause a sizing loop while streaming.
 */
function ModelLabel({ model, ...props }: { model: string } & ComponentProps<"span">) {
  const at = model.indexOf(" · ")
  const measure = useRef<HTMLSpanElement>(null)
  const connection = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const full = measure.current!
    const label = full.parentElement!
    const update = () => {
      if (connection.current)
        connection.current.hidden = full.getBoundingClientRect().width > label.getBoundingClientRect().width
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(label)
    observer.observe(full)
    return () => observer.disconnect()
  }, [model])
  return (
    <span
      {...props}
      tabIndex={0}
      data-model-label=""
      // Where the header wraps (a phone, a narrow column), it never starts a line of its own: it
      // takes what its line leaves, up to its full width, and the model truncates instead.
      className={`relative grid min-w-0 overflow-hidden text-xs whitespace-nowrap text-muted outline-none ${headerGives}`}
    >
      <span ref={measure} aria-hidden="true" className="invisible w-max">
        {model}
      </span>
      <span className="absolute inset-0 flex min-w-0">
        {at > 0 && (
          <span ref={connection} hidden className="shrink-0">
            {model.slice(0, at)} ·&nbsp;
          </span>
        )}
        <span className="max-w-full shrink-0 truncate">{at > 0 ? model.slice(at + 3) : model}</span>
      </span>
    </span>
  )
}

function ModelName({ entry }: MessageDetailProps) {
  const { version } = entry
  if (version.writer !== "model" || version.model === null) return null
  const imported = version.origin === "imported" || version.recorded !== undefined
  return (
    <Tooltip
      label={imported ? `Generated with ${version.model}, as recorded at import` : `Generated with ${version.model}`}
    >
      <ModelLabel model={version.model} />
    </Tooltip>
  )
}

function MessageNumber({ entry }: MessageDetailProps) {
  const n = positionOf(entry) + 1
  return (
    <Tooltip label={`Message ${n}: its place on this path, counted from the first message`}>
      <span tabIndex={0} className="outline-none">
        #{n}
      </span>
    </Tooltip>
  )
}

export const registerMessageDetails = () => [
  messageDetails.register({
    id: "message.time",
    place: "header",
    order: 10,
    label: "Date and time",
    description: "When it was written: the time, with the date when it wasn't today.",
    component: WrittenAt
  }),
  messageDetails.register({
    id: "message.model-icon",
    place: "header",
    order: 20,
    label: "Model icon",
    description: "The mark of the lab whose model wrote a reply, before the model's name.",
    component: ModelIcon
  }),
  messageDetails.register({
    id: "message.model",
    place: "header",
    order: 21,
    label: "Model name",
    description: "The model that wrote a reply, and the connection or API it was used through.",
    component: ModelName
  }),
  messageDetails.register({
    id: "message.number",
    place: "portrait",
    order: 10,
    label: "Message number",
    description: "Its place in the chat, from #1 at the first message.",
    component: MessageNumber
  })
]
