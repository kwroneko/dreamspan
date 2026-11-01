// The preset's prompt order as one document (DESIGN §6.2a). Each prompt is a bounded block: a
// header (handle, switch, name renamed in place, how it's sent, tokens, its options and actions)
// above its text in the code-editor box. Options fold away per prompt, or all at once.
import { writePresetOrder } from "./presetDraft.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { charDefinitions, newestMessage, perFieldMarkers, presetOrder } from "@rp/shared/presetOrder.ts"
import { CONDITION_LABELS, conditionOf, presetWarnings, TRIGGERS } from "@rp/shared/presetConditions.ts"
import { DIRECTION_PROMPT } from "@rp/shared/endOfRequest.ts"
import { type FieldPath, textField } from "@rp/shared/editing.ts"
import { Link } from "@tanstack/react-router"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { ResizeHandle, usePanelWidth } from "../../ui/ResizeHandle.tsx"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { IconButton, Tooltip } from "../../ui/Tooltip.tsx"
import { NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { SearchNavigation, scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { summaryBadge } from "./summaryBadge.ts"
import { type EditorStore, useText, useValue } from "./store.ts"
import { presetEditorWarnings } from "./presetSections.ts"
import { promptLabel } from "./promptLabel.ts"

/**
 * Where the document is shown: "document", the large editor (blocks open, the outline beside
 * them, a ＋ between blocks); "column", the side panel's Prompt preset tab (blocks closed to a
 * row with the first line of their text). Both are this one component and its blocks, editing
 * the same store, so the two can't drift.
 */
export type PromptLayout = "document" | "column"

const at = (id: string) => ["prompts", `identifier=${id}`]
const roles = ["system", "user", "assistant"].map((value) => ({ value, label: value }))
const positions = [
  { value: "relative", label: "In order" },
  { value: "absolute", label: "At a depth" }
]
/** When a prompt is sent (DESIGN §2.2). */
const conditions = (["always", "as_character", "as_user", "with_direction"] as const).map((value) => ({
  value,
  label: CONDITION_LABELS[value]
}))
const conditionBadges = {
  as_character: "as a character",
  as_user: "as {{user}}",
  with_direction: "with a direction"
} as const

const NEW_PROMPT_HINT = "An empty prompt of your own, placed here"
const DEFINITIONS_LABEL = "Card definitions block"
const DEFINITIONS_HINT =
  "Sends each character card's whole definition here, one labelled block per card, instead of the separate Char Description, Personality, Scenario and Persona markers"

/** A prompt's first line of text, for a closed row. */
const firstLine = (content: string) =>
  content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

/** Whether every prompt's options show, by default: this browser's choice. */
const OPTIONS_KEY = "rp.presetOptionsOpen"
const readOptionsOpen = () => {
  try {
    return localStorage.getItem(OPTIONS_KEY) === "1"
  } catch {
    return false
  }
}
const keepOptionsOpen = (open: boolean) => {
  try {
    localStorage.setItem(OPTIONS_KEY, open ? "1" : "0")
  } catch {
    /* In memory when storage is off. */
  }
}

function TokenCount({
  prompt,
  content,
  context
}: {
  prompt: PresetPrompt
  content: string
  context: PresetContext | null | undefined
}) {
  const filled = context?.blocks.find((b) => b.identifier === prompt.identifier)
  return (
    <span className="text-xs whitespace-nowrap text-muted tabular-nums">
      {prompt.marker
        ? filled
          ? `~${filled.tokens.toLocaleString()} tokens`
          : context === undefined
            ? "no chat open"
            : context === null
              ? "context unavailable"
              : "0 tokens"
        : `~${Math.ceil(content.length / 4).toLocaleString()} tokens`}
    </span>
  )
}

/** What a card's own prompt does to Main or Post-History Instructions in the open chat. */
function OverrideNote({
  store,
  entry,
  context,
  className
}: {
  store: EditorStore
  entry: PromptOrderEntry
  context: PresetContext | null | undefined
  className: string
}) {
  const forbids = useValue<boolean | undefined>(store, [...at(entry.identifier), "forbid_overrides"]) ?? false
  const override = context?.overrides?.find((o) => o.identifier === entry.identifier)
  if (entry.identifier !== "main" && entry.identifier !== "jailbreak") return null
  return (
    <p
      className={`text-xs text-muted ${className}`}
      data-override={override?.status ?? (forbids ? "forbidden" : "none")}
    >
      {override?.status === "replaced" ? (
        <>
          Replaced in this chat by{" "}
          <Link
            to="/cards/$entityId"
            params={{ entityId: override.card }}
            className="text-accent underline-offset-4 hover:underline"
          >
            {override.name}
          </Link>
          's {entry.identifier === "main" ? "system prompt" : "post-history instructions"}
        </>
      ) : override?.status === "forbidden" ? (
        <>
          <Link
            to="/cards/$entityId"
            params={{ entityId: override.card }}
            className="text-accent underline-offset-4 hover:underline"
          >
            {override.name}
          </Link>{" "}
          has {entry.identifier === "main" ? "a system prompt" : "post-history instructions"}; this prompt forbids it
        </>
      ) : forbids ? (
        "A card can't replace it"
      ) : (
        "A card's own prompt can replace it"
      )}
    </p>
  )
}

/** What fills a marker in the open chat. */
function MarkerNote({
  entry,
  context,
  byDefinitions
}: {
  entry: PromptOrderEntry
  context: PresetContext | null | undefined
  byDefinitions: boolean
}) {
  const filled = context?.blocks.find((b) => b.identifier === entry.identifier)
  return (
    <span className="text-xs text-muted">
      {byDefinitions
        ? "Filled by Definitions"
        : filled?.labels.length
          ? `Definitions: ${filled.labels.join(", ")}`
          : entry.identifier === "chatHistory"
            ? "Earlier messages in the current context"
            : entry.identifier === "newestMessage"
              ? "The latest message, placed here"
              : "Filled from the current chat"}
    </span>
  )
}

/**
 * A prompt's options, compact and grouped: how it's sent (role, position, depth), when it's sent
 * (condition, generation types), and whether a card may replace it. The name is renamed in the
 * header.
 */
function PromptOptions({ store, path, prompt }: { store: EditorStore; path: FieldPath; prompt: PresetPrompt }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="w-32">
          <SelectField store={store} path={[...path, "role"]} label="Role" items={roles} />
        </div>
        <div className="w-36">
          <SelectField store={store} path={[...path, "injection_position"]} label="Position" items={positions} />
        </div>
        {prompt.injection_position === "absolute" && (
          <>
            <div className="w-24">
              <NumberField
                store={store}
                path={[...path, "injection_depth"]}
                label="Depth"
                integer
                min={0}
                max={10000}
              />
            </div>
            <div className="w-28">
              <NumberField store={store} path={[...path, "injection_order"]} label="Order at depth" />
            </div>
          </>
        )}
        <div className="w-64 max-w-full">
          <SelectField
            store={store}
            path={[...path, "condition"]}
            label="Condition"
            items={conditions}
            fallback="always"
          />
        </div>
      </div>
      {/* ST's generation types (ST's Triggers), beside the condition (DESIGN §2.2). */}
      <TriggersField store={store} path={[...path, "injection_trigger"]} label="Generation types" items={TRIGGERS} />
      <Tooltip label="A character card's own system prompt or post-history instructions won't take this prompt's place">
        <span className="self-start">
          <SwitchField store={store} path={[...path, "forbid_overrides"]} label="A card can't replace it" />
        </span>
      </Tooltip>
    </div>
  )
}

/** Main and ST's system prompts keep their place; markers have no text to lose. */
const deletable = (entry: PromptOrderEntry, prompt: PresetPrompt) =>
  entry.identifier !== "main" && !prompt.system_prompt && !prompt.marker

/** How a prompt is sent: role, position, and any condition or generation types. */
function SendBadges({ prompt }: { prompt: PresetPrompt }) {
  const condition = conditionOf(prompt)
  return (
    <>
      <Badge>{prompt.role}</Badge>
      <Badge>{prompt.injection_position === "absolute" ? `depth ${prompt.injection_depth}` : "in order"}</Badge>
      {condition !== "always" && <Badge tone="accent">{conditionBadges[condition]}</Badge>}
      {prompt.injection_trigger.length > 0 && (
        <Badge tone="accent">
          {TRIGGERS.filter((t) => prompt.injection_trigger.includes(t.value))
            .map((t) => t.label.toLowerCase())
            .join(", ") || "never"}
        </Badge>
      )}
    </>
  )
}

/** A block's menu: the large editor at this prompt, inserting beside it, deleting it. */
interface RowActions {
  readonly openLarge: (() => void) | undefined
  readonly insertAbove: () => void
  readonly insertBelow: () => void
  /** Offered while the order has no Definitions marker (DESIGN §5.0). */
  readonly definitionsBelow: (() => void) | undefined
}

function Block({
  store,
  entry,
  handle,
  collapsed,
  toggle,
  remove,
  context,
  definitions,
  layout,
  optionsOpen,
  toggleOptions,
  actions
}: {
  store: EditorStore
  entry: PromptOrderEntry
  handle: ReactNode
  collapsed: boolean
  toggle: () => void
  remove: () => void
  context: PresetContext | null | undefined
  /** The order sends the Definitions marker, which leaves the per-field markers empty. */
  definitions: boolean
  layout: PromptLayout
  optionsOpen: boolean
  toggleOptions: () => void
  actions: RowActions
}) {
  const path = at(entry.identifier)
  const namePath = [...path, "name"]
  const prompt = useValue<PresetPrompt | undefined>(store, path) ?? newestMessage
  const byDefinitions = definitions && perFieldMarkers.includes(entry.identifier)
  const typed = useText(store, namePath)
  const content = useText(store, [...path, "content"])
  const label = prompt.marker ? { text: typed || prompt.name, derived: false } : promptLabel(typed, content)
  const name = label.text
  const nameMatch = useSearchMatch(namePath)
  const marker = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!prompt.marker || !nameMatch) return
    const frame = requestAnimationFrame(() => {
      const target = marker.current
      if (!target) return
      target.focus({ preventScroll: true })
      scrollToSearchField(target)
    })
    return () => cancelAnimationFrame(frame)
  }, [nameMatch, prompt.marker])
  const column = layout === "column"
  const open = !prompt.marker && !collapsed
  const first = firstLine(content)

  const sendSwitch = entry.identifier !== "newestMessage" && (
    <Switch
      checked={entry.enabled}
      onCheckedChange={(enabled) =>
        writePresetOrder(
          store,
          presetOrder(store.value(["prompts"]) as PresetPrompt[], store.value(["order"]) as PromptOrderEntry[]).map(
            (e) => (e.identifier === entry.identifier ? { ...e, enabled } : e)
          )
        )
      }
    >
      <span className="sr-only">Send {name}</span>
    </Switch>
  )
  const markedName =
    nameMatch && prompt.marker ? (
      <>
        {name.slice(0, nameMatch.at)}
        <mark className="bg-warning/30 text-text">{name.slice(nameMatch.at, nameMatch.at + nameMatch.length)}</mark>
        {name.slice(nameMatch.at + nameMatch.length)}
      </>
    ) : (
      name
    )
  const summary = !prompt.marker && /\{\{summary\}\}/i.test(content) && context?.summary && (
    <Badge>{summaryBadge(context.summary)}</Badge>
  )

  const title = prompt.marker ? (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-1">
      <span className="text-sm text-muted [overflow-wrap:anywhere]">{markedName}</span>
      {!entry.enabled && <Badge>off</Badge>}
      <MarkerNote entry={entry} context={context} byDefinitions={byDefinitions} />
    </span>
  ) : (
    <Tooltip label={collapsed ? "Show the prompt's text" : "Hide the prompt's text"}>
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
        onClick={toggle}
        className="flex min-w-0 shrink items-start gap-1 rounded-md px-1 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Icon
          name="right"
          size={14}
          className={`mt-0.5 text-muted transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-90"}`}
        />
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span
            className={`text-sm break-words ${label.derived ? "text-muted italic" : "font-medium"} ${entry.enabled ? "" : "opacity-60"}`}
          >
            {name}
          </span>
          {column && collapsed && !label.derived && first !== "" && (
            <span className="line-clamp-1 text-xs text-muted [overflow-wrap:anywhere]">{first}</span>
          )}
        </span>
      </button>
    </Tooltip>
  )
  // A closed row in the column keeps its width for the name and first line: renaming and the
  // options are in the header once it's open.
  const full = !column || open
  const named = prompt.marker ? (
    title
  ) : full ? (
    <InlineRename
      value={typed}
      label={name}
      allowEmpty
      className="min-w-0 flex-1 basis-40"
      onRename={(next) => {
        store.setText(namePath, next)
        void store.save(textField(namePath))
      }}
    >
      {title}
    </InlineRename>
  ) : (
    <span className="flex min-w-0 flex-1">{title}</span>
  )

  const menu = (
    <Menu
      label={`Actions for ${name}`}
      trigger={
        <Button variant="ghost" className="size-8 shrink-0 px-0!" aria-label={`Actions for ${name}`}>
          <Icon name="more" />
        </Button>
      }
    >
      {actions.openLarge && (
        <MenuItem
          icon="expand"
          onClick={actions.openLarge}
          description="The preset editor over the chat, at this prompt"
        >
          Open in the large editor
        </MenuItem>
      )}
      <MenuItem icon="plus" onClick={actions.insertAbove} description="A new empty prompt just above this one">
        Insert a prompt above
      </MenuItem>
      <MenuItem icon="plus" onClick={actions.insertBelow} description="A new empty prompt just below this one">
        Insert a prompt below
      </MenuItem>
      {actions.definitionsBelow && (
        <MenuItem icon="insert" onClick={actions.definitionsBelow} description={DEFINITIONS_HINT}>
          Insert a {DEFINITIONS_LABEL.toLowerCase()} below
        </MenuItem>
      )}
      {deletable(entry, prompt) && (
        <>
          <MenuSeparator />
          <MenuItem
            icon="trash"
            tone="danger"
            onClick={remove}
            description="Takes it out of the preset; Revert brings it back until you save"
          >
            Delete the prompt
          </MenuItem>
        </>
      )}
    </Menu>
  )

  const optionsToggle = !prompt.marker && full && (
    <IconButton
      label={`Options of ${name}`}
      hint={optionsOpen ? "Hide the prompt's options" : "Show the prompt's options: role, position, condition…"}
      icon="sliders"
      aria-expanded={optionsOpen}
      className={optionsOpen ? "bg-surface-raised text-text" : ""}
      onClick={toggleOptions}
    />
  )

  return (
    <section
      ref={marker}
      tabIndex={-1}
      id={column ? undefined : `prompt-${entry.identifier}`}
      data-prompt={entry.identifier}
      className={`scroll-mt-[var(--preset-toolbar-height,1rem)] rounded-lg border ${
        prompt.marker ? "border-dashed border-border bg-transparent" : "border-border bg-surface shadow-xs"
      } ${column ? "bg-canvas" : ""}`}
    >
      <header className={`flex min-w-0 items-start gap-0.5 px-1 py-0.5 ${column ? "" : "@lg:items-center"}`}>
        {handle}
        <span className="flex h-8 w-10 shrink-0 items-center justify-center">{sendSwitch}</span>
        <span
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 ${column ? "" : "@lg:flex-nowrap"}`}
        >
          {named}
          {!column && !prompt.marker && (
            <span className="flex flex-wrap items-center gap-1 @lg:ml-auto">
              <SendBadges prompt={prompt} />
              <TokenCount prompt={prompt} content={content} context={context} />
            </span>
          )}
          {summary}
        </span>
        {/* A prompt's count goes with its chips, so a narrow header leaves the name (and its
            rename field) the width; a marker's, and a closed row's in the column, stay at the end. */}
        {(prompt.marker || (column && !open)) && (
          <span className="flex h-8 shrink-0 items-center pl-1">
            <TokenCount prompt={prompt} content={content} context={context} />
          </span>
        )}
        {optionsToggle}
        {menu}
      </header>
      {column && open && !prompt.marker && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1 pl-12">
          <SendBadges prompt={prompt} />
          <TokenCount prompt={prompt} content={content} context={context} />
        </div>
      )}
      {open && optionsOpen && (
        <div className="border-t border-border bg-surface-raised/50 px-3 py-3">
          <PromptOptions store={store} path={path} prompt={prompt} />
        </div>
      )}
      {full && <OverrideNote store={store} entry={entry} context={context} className="px-3 pb-1" />}
      {open && (
        <div className={`border-t border-border px-2 pt-2 pb-2 ${entry.enabled ? "" : "opacity-70"}`}>
          <TextField
            store={store}
            path={[...path, "content"]}
            label={`Prompt: ${name}`}
            labelHidden
            rows={Math.min(8, Math.max(2, content.split("\n").length))}
          />
        </div>
      )}
    </section>
  )
}

/** Which blocks are open: all or none, except some. */
interface Opened {
  readonly all: boolean
  readonly except: ReadonlySet<string>
}
const isOpen = (opened: Opened, id: string) => opened.all !== opened.except.has(id)
const withOpen = (opened: Opened, id: string, open: boolean): Opened => {
  if (isOpen(opened, id) === open) return opened
  const except = new Set(opened.except)
  if (except.has(id)) except.delete(id)
  else except.add(id)
  return { all: opened.all, except }
}

/** The large editor's outline of names, beside the document: resizable, its width kept per browser. */
function Outline({ children }: { children: ReactNode }) {
  const userId = useSession().user.id
  const { ref, width, min, max, change, reset } = usePanelWidth(userId, "presetOutline", 240, 140, 560, 480)
  return (
    <nav
      ref={ref}
      aria-label="Prompt outline"
      style={{ width }}
      className="relative hidden min-w-0 shrink-0 @3xl:block"
    >
      <div className="sticky top-[var(--preset-toolbar-height,1rem)] max-h-[70dvh] overflow-y-auto pr-2">
        {children}
      </div>
      <ResizeHandle
        label="Resize the outline"
        width={width}
        min={min}
        max={max}
        direction={1}
        onChange={change}
        onReset={reset}
      />
    </nav>
  )
}

export function PromptDocument({
  store,
  context,
  focus,
  goTo,
  layout = "document",
  onOpenLarge
}: {
  store: EditorStore
  context?: PresetContext | null | undefined
  focus?: string | undefined
  /** A prompt to open and scroll to, asked for again by a new object (a warning's link). */
  goTo?: { readonly identifier: string } | null | undefined
  layout?: PromptLayout
  /** The column's way to the large editor, at a prompt. */
  onOpenLarge?: ((identifier: string) => void) | undefined
}) {
  const column = layout === "column"
  const searchMatch = useContext(SearchNavigation)
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const order = presetOrder(prompts, savedOrder)
  // The document opens every block; the column opens none, so its editors mount only when asked for.
  const [opened, setOpened] = useState<Opened>(() => ({ all: !column, except: new Set() }))
  // Options fold away by default; "Show all options" is this browser's choice.
  const [options, setOptions] = useState<Opened>(() => ({ all: readOptionsOpen(), except: new Set() }))
  const reveal = (identifier: string) => setOpened((current) => withOpen(current, identifier, true))
  useEffect(() => {
    const [list, identity, part] = searchMatch?.path ?? []
    if (list === "prompts" && typeof identity === "string" && identity.startsWith("identifier=")) {
      const identifier = identity.slice("identifier=".length)
      const frame = requestAnimationFrame(() => {
        reveal(identifier)
        // A match in a field other than the text or name is in the options.
        if (typeof part === "string" && part !== "content" && part !== "name")
          setOptions((current) => withOpen(current, identifier, true))
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [searchMatch])
  const root = useRef<HTMLDivElement>(null)
  const names = new Map(
    [...prompts, newestMessage].map((p) => [p.identifier, p.marker ? p.name : promptLabel(p.name, p.content).text])
  )
  if (!names.has(charDefinitions.identifier)) names.set(charDefinitions.identifier, charDefinitions.name)
  const jump = (identifier: string) => {
    reveal(identifier)
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(identifier)}"]`)
      if (!target) return
      const scroll = root.current?.closest<HTMLElement>("[data-preset-scroll]")
      if (scroll) {
        const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
        scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - margin
      } else target.scrollIntoView({ block: column ? "nearest" : "start" })
    })
  }
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() => jump(focus))
    return () => cancelAnimationFrame(frame)
  }, [focus])
  useEffect(() => {
    if (!goTo) return
    // A warning's link is about the prompt's condition and generation types: its options open too.
    const frame = requestAnimationFrame(() => {
      setOptions((current) => withOpen(current, goTo.identifier, true))
      jump(goTo.identifier)
    })
    return () => cancelAnimationFrame(frame)
  }, [goTo])
  const setOrder = (next: ReadonlyArray<PromptOrderEntry>) => writePresetOrder(store, next)
  const move = (from: number, to: number) => {
    const next = [...order]
    next.splice(to, 0, ...next.splice(from, 1))
    setOrder(next)
  }
  const add = (index: number) => {
    const identifier = uuidv7()
    store.setValue(at(identifier), {
      ...newestMessage,
      identifier,
      name: "New prompt",
      role: "system",
      marker: false,
      system_prompt: false,
      // A card can't replace a prompt made here unless the user allows it (DESIGN §5.0).
      forbid_overrides: true
    })
    const next = [...order]
    next.splice(index, 0, { identifier, enabled: true })
    setOrder(next)
    jump(identifier)
  }
  const hasDefinitions = order.some((e) => e.identifier === charDefinitions.identifier)
  const definitionsOn = order.some((e) => e.identifier === charDefinitions.identifier && e.enabled)
  const addDefinitions = (index: number) => {
    if (!prompts.some((p) => p.identifier === charDefinitions.identifier))
      store.setValue(at(charDefinitions.identifier), charDefinitions)
    const next = [...order]
    next.splice(index, 0, { identifier: charDefinitions.identifier, enabled: true })
    setOrder(next)
    jump(charDefinitions.identifier)
  }
  const insert = (index: number, label: string, className?: string, content: ReactNode = "＋") =>
    hasDefinitions ? (
      <Tooltip label={NEW_PROMPT_HINT}>
        <Button variant="ghost" className={className} aria-label={label} onClick={() => add(index)}>
          {content}
        </Button>
      </Tooltip>
    ) : (
      <Menu
        label={label}
        align="center"
        trigger={
          <Button variant="ghost" className={className} aria-label={label}>
            {content}
          </Button>
        }
      >
        <MenuItem icon="plus" onClick={() => add(index)} description={NEW_PROMPT_HINT}>
          New prompt
        </MenuItem>
        <MenuItem icon="insert" onClick={() => addDefinitions(index)} description={DEFINITIONS_HINT}>
          {DEFINITIONS_LABEL}
        </MenuItem>
      </Menu>
    )
  const slot = (label: string, predicate: (p: PresetContext["notes"][number]["placement"]) => boolean) => {
    const notes = context
      ? context.notes
          .filter((n) => predicate(n.placement))
          .map(
            (n) =>
              n.title +
              (n.placement.mode === "depth" ? ` (depth ${n.placement.depth})` : "") +
              (n.due === false ? " (not due this turn)" : "")
          )
          .join(", ")
      : ""
    // The column names only the places that hold a note.
    if (column && notes === "") return null
    return (
      <div className="my-1 border-l-2 border-border px-2 py-0.5 text-xs text-muted">
        <strong>{label}</strong>:{" "}
        {context === undefined ? "no chat open" : context === null ? "context unavailable" : notes || "no active notes"}
      </div>
    )
  }
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const afterHistory = order[history + 1]?.identifier === "newestMessage" ? history + 2 : history + 1
  const divider = (text: string) => (
    <p className="my-1 border-y border-border py-0.5 text-xs font-medium text-accent">{text}</p>
  )
  const tailStarts = (
    <>
      {divider("Tail starts")}
      {slot("Start of tail notes", (p) => p.mode === "section" && p.section === "tail_start")}
    </>
  )
  const cacheEnds = (identifier: string) =>
    context?.cacheAfter
      .filter((b) => b.identifier === identifier)
      .map((b) => (
        <p key={b.reason} className="my-1 border-y border-accent py-0.5 text-xs text-accent">
          Cached part ends · {b.reason}
        </p>
      ))
  const newestAfterTail = order.findIndex((e) => e.identifier === "newestMessage") > history + 1
  const anyOpen = order.some((e) => isOpen(opened, e.identifier))
  const small = column ? "h-7 px-2" : ""
  const variant = column ? "ghost" : "secondary"
  const controls = (
    <div className={`flex flex-wrap items-center gap-1 ${column ? "justify-end" : "sm:gap-2"}`}>
      <Tooltip label="Show every prompt's text">
        <Button variant={variant} className={small} onClick={() => setOpened({ all: true, except: new Set() })}>
          Expand all
        </Button>
      </Tooltip>
      <Tooltip label="Fold every prompt to its header: an outline of the preset">
        <Button
          variant={variant}
          className={small}
          disabled={column && !anyOpen}
          onClick={() => setOpened({ all: false, except: new Set() })}
        >
          Collapse all
        </Button>
      </Tooltip>
      <Tooltip
        label={
          options.all
            ? "Fold every prompt's options away again (remembered in this browser)"
            : "Open every prompt's options at once (remembered in this browser)"
        }
      >
        <Button
          variant={variant}
          className={small}
          aria-pressed={options.all}
          onClick={() => {
            keepOptionsOpen(!options.all)
            setOptions({ all: !options.all, except: new Set() })
          }}
        >
          <Icon name="sliders" />
          {options.all ? "Hide all options" : "Show all options"}
        </Button>
      </Tooltip>
    </div>
  )
  const list = (
    <div className="@container min-w-0 flex-1">
      {slot("Start of context notes", (p) => p.mode === "section" && p.section === "context_start")}
      {cacheEnds("context_start")}
      {!column && <div className="flex justify-center">{insert(0, "Insert prompt at start", "h-6 w-full")}</div>}
      <SortableList
        items={order}
        itemKey={(e) => e.identifier}
        itemLabel={(e) => names.get(e.identifier) ?? e.identifier}
        label={column ? "Preset blocks" : "Prompt order"}
        onMove={move}
      >
        {(entry, handle) => {
          const index = order.indexOf(entry)
          return (
            <>
              {entry.identifier === "charDescription" &&
                slot("With definitions", (p) => p.mode === "section" && p.section === "card")}
              {entry.identifier === "chatHistory" && (
                <>
                  {divider("History starts")}
                  {slot("At depth N", (p) => p.mode === "depth")}
                  {slot("Top of the author's note", (p) => p.mode === "section" && p.section === "author_note_top")}
                  {slot(
                    "Bottom of the author's note",
                    (p) => p.mode === "section" && p.section === "author_note_bottom"
                  )}
                </>
              )}
              {history >= 0 && index === afterHistory && tailStarts}
              {entry.identifier === "newestMessage" &&
                newestAfterTail &&
                slot("End of tail notes", (p) => p.mode === "section" && p.section === "tail_end")}
              {entry.identifier === "main" &&
                slot("Before main prompt", (p) => p.mode === "section" && p.section === "before_main_prompt")}
              <div className={column ? "py-0.5" : ""}>
                <Block
                  store={store}
                  entry={entry}
                  handle={handle}
                  context={context}
                  definitions={definitionsOn}
                  layout={layout}
                  collapsed={!isOpen(opened, entry.identifier)}
                  toggle={() => setOpened(withOpen(opened, entry.identifier, !isOpen(opened, entry.identifier)))}
                  optionsOpen={isOpen(options, entry.identifier)}
                  toggleOptions={() =>
                    setOptions(withOpen(options, entry.identifier, !isOpen(options, entry.identifier)))
                  }
                  actions={{
                    openLarge: onOpenLarge && (() => onOpenLarge(entry.identifier)),
                    insertAbove: () => add(index),
                    insertBelow: () => add(index + 1),
                    definitionsBelow: hasDefinitions ? undefined : () => addDefinitions(index + 1)
                  }}
                  remove={() => {
                    if (entry.identifier === "main") return
                    // The prompt goes first: the order would otherwise list it again, off, at the end.
                    void store.removeItem(at(entry.identifier))
                    setOrder(order.filter((e) => e.identifier !== entry.identifier))
                  }}
                />
              </div>
              {entry.identifier === "main" &&
                slot("After main prompt", (p) => p.mode === "section" && p.section === "after_main_prompt")}
              {entry.identifier === "newestMessage" &&
                slot(
                  "After newest message / depth 0",
                  (p) => p.mode === "tail" || (p.mode === "depth" && p.depth === 0)
                )}
              {cacheEnds(entry.identifier)}
              {!column && (
                <div className="flex justify-center">
                  {insert(index + 1, `Insert prompt after ${names.get(entry.identifier)}`, "h-6 w-full text-muted")}
                </div>
              )}
            </>
          )
        }}
      </SortableList>
      {history >= 0 && afterHistory >= order.length && tailStarts}
      {!newestAfterTail && slot("End of tail notes", (p) => p.mode === "section" && p.section === "tail_end")}
      {column && (
        <div className="pt-2">
          {insert(
            order.length,
            "Add a prompt at the end",
            "w-full border border-dashed border-border",
            <>
              <Icon name="plus" />
              Add a prompt
            </>
          )}
        </div>
      )}
    </div>
  )
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-3">
      {controls}
      {column ? (
        list
      ) : (
        <div className="@container flex min-w-0 gap-4">
          <Outline>
            <SortableList
              items={order}
              itemKey={(e) => e.identifier}
              itemLabel={(e) => names.get(e.identifier) ?? e.identifier}
              label="Outline order"
              namesAsHandles
              onSelect={(e) => jump(e.identifier)}
              onMove={move}
            >
              {(_e, handle) => handle}
            </SortableList>
          </Outline>
          {list}
        </div>
      )}
    </div>
  )
}

/**
 * What would go wrong when sending with this preset (DESIGN §2.2): the direction text doesn't
 * read `{{direction}}`, so a direction you give would be lost; a switched-on prompt whose
 * condition and generation types never meet is never sent. Each links to its text.
 */
export const registerPresetWarnings = () =>
  presetEditorWarnings.register({ id: "preset.warnings", order: 100, component: PresetWarnings })

export function PresetWarnings({ store, onGoTo }: { store: EditorStore; onGoTo: (identifier: string) => void }) {
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const direction = useText(store, ["prompts", `identifier=${DIRECTION_PROMPT}`, "content"])
  const { directionLost, neverSent } = presetWarnings(
    new Map(prompts.map((p) => [p.identifier, p.identifier === DIRECTION_PROMPT ? { ...p, content: direction } : p])),
    presetOrder(prompts, savedOrder)
  )
  if (!directionLost && neverSent.length === 0) return null
  const jump = () =>
    document
      .querySelector<HTMLElement>(`[data-end-of-request="${DIRECTION_PROMPT}"]`)
      ?.scrollIntoView({ block: "start" })
  const link = "text-accent underline-offset-4 hover:underline"
  return (
    <div className="flex flex-col gap-2" aria-label="Preset warnings" role="group">
      {directionLost && (
        <div role="alert" className="rounded-md border border-warning/40 px-3 py-2 text-sm">
          The end-of-request text for a direction doesn&apos;t contain {"{{direction}}"}: a direction you give
          won&apos;t be sent.{" "}
          <button type="button" className={link} onClick={jump}>
            Go to the text
          </button>
        </div>
      )}
      {neverSent.map((prompt) => (
        <div key={prompt.identifier} role="alert" className="rounded-md border border-warning/40 px-3 py-2 text-sm">
          “{prompt.name || prompt.identifier}” is never sent: it&apos;s sent{" "}
          {CONDITION_LABELS[conditionOf(prompt)].toLowerCase()}, but only for{" "}
          {TRIGGERS.filter((t) => prompt.injection_trigger.includes(t.value))
            .map((t) => t.label)
            .join(", ")}
          , and the two never meet. Exported to SillyTavern, it&apos;s switched off.{" "}
          <button type="button" className={link} onClick={() => onGoTo(prompt.identifier)}>
            Go to the prompt
          </button>
        </div>
      ))}
    </div>
  )
}
