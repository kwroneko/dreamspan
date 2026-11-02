// The preset's prompt order as one document (DESIGN §6.2a). Each prompt is a bounded block: a
// header (handle, switch, name renamed in place, how it's sent, tokens, its options and actions)
// above its text in the code-editor box. Options fold away per prompt, or all at once.
import type { RefId } from "@rp/shared/library.ts"
import { addPresetPrompt, writePresetOrder } from "./presetDraft.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { charDefinitions, newestMessage, perFieldMarkers, presetOrder } from "@rp/shared/presetOrder.ts"
import { CONDITION_LABELS, conditionOf, presetWarnings, TRIGGERS } from "@rp/shared/presetConditions.ts"
import { DIRECTION_PROMPT } from "@rp/shared/endOfRequest.ts"
import { type FieldPath, textField } from "@rp/shared/editing.ts"
import { Link } from "@tanstack/react-router"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useSession } from "../../session.ts"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { InlineRename } from "../../ui/InlineRename.tsx"
import {
  Block,
  BlockBody,
  BlockHeader,
  BlockMenuButton,
  BlockOptions,
  BlockOptionsToggle,
  BlockToggle,
  ExpandCollapseAll
} from "../../ui/Block.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { ResizeHandle, useInnerPanelWidth } from "../../ui/ResizeHandle.tsx"
import { revealIfHidden } from "../../ui/reveal.ts"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { SearchNavigation, scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { summaryBadge } from "./summaryBadge.ts"
import { PRESET_LOREBOOKS_FOCUS, PresetLorebooks } from "./PresetLorebooks.tsx"
import { AfterChatLine, AT_START, BEFORE_CHAT, ChatStartsLine, placeReuseLines, ReuseLine } from "./promptLines.tsx"
import { type EditorStore, useText, useValue } from "./store.ts"
import { presetEditorWarnings } from "./presetSections.ts"
import { promptLabel } from "./promptLabel.ts"
import { tokenizerText, tokensText, useTokenCounts } from "./tokenCounts.ts"

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
  with_direction: "with guidance"
} as const

const NEW_PROMPT_HINT =
  "Adds an empty prompt of your own at the end of the list, open for typing; drag it where you want it"
const DEFINITIONS_LABEL = "Card definitions block"
const DEFINITIONS_BUTTON = "Definitions block"
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
  // A prompt's own text: the chat model's tokenizer. A marker's: what the open chat fills it
  // with, as the context budget counts it (ARCHITECTURE §15 "Token counts").
  const texts = useMemo(() => [prompt.marker ? "" : content], [prompt.marker, content])
  const own = useTokenCounts(texts)
  const label = prompt.marker
    ? "What the open chat puts here, as its context budget estimates it: four characters a token, three more a message."
    : tokenizerText(own.tokenizer)
  return (
    <Tooltip label={label}>
      <span
        tabIndex={0}
        data-prompt-tokens
        className="rounded text-xs whitespace-nowrap text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {prompt.marker
          ? filled
            ? `~${filled.tokens.toLocaleString()} tokens`
            : context === undefined
              ? "no chat open"
              : context === null
                ? "context unavailable"
                : "0 tokens"
          : tokensText(own.counts[0] ?? null, own.tokenizer, own.pending)}
      </span>
    </Tooltip>
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

function PromptBlock({
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
  actions,
  autoFocus = false
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
  /** Just added: its text is focused as it mounts, ready to type. */
  autoFocus?: boolean
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
      labelHidden
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
    <span className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-1 ${column ? "flex-1" : ""}`}>
      <span className="text-sm text-muted [overflow-wrap:anywhere]">{markedName}</span>
      {!entry.enabled && <Badge>off</Badge>}
      <MarkerNote entry={entry} context={context} byDefinitions={byDefinitions} />
    </span>
  ) : (
    <BlockToggle
      open={!collapsed}
      onToggle={toggle}
      label={name}
      name={name}
      hint={collapsed ? "Show the prompt's text" : "Hide the prompt's text"}
      derived={label.derived}
      dim={!entry.enabled}
      detail={
        column &&
        collapsed &&
        !label.derived &&
        first !== "" && <span className="line-clamp-1 text-xs text-muted [overflow-wrap:anywhere]">{first}</span>
      }
    />
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
      className={column ? "min-w-0 flex-1 basis-40" : "min-w-0 max-w-md"}
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
      hint="More: open it in the large editor, insert a prompt beside it, delete it"
      trigger={<BlockMenuButton label={`Actions for ${name}`} />}
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
            description="Takes it out of the preset when you save the new order; until then Revert brings it back"
          >
            Delete the prompt
          </MenuItem>
        </>
      )}
    </Menu>
  )

  const optionsToggle = !prompt.marker && full && (
    <BlockOptionsToggle
      open={optionsOpen}
      onToggle={toggleOptions}
      label={`Options of ${name}`}
      hint={optionsOpen ? "Hide the prompt's options" : "Show the prompt's options: role, position, condition…"}
    />
  )

  return (
    <Block
      ref={marker}
      tabIndex={-1}
      id={column ? undefined : `prompt-${entry.identifier}`}
      data-prompt={entry.identifier}
      dashed={prompt.marker}
      className={`scroll-mt-[var(--preset-toolbar-height,1rem)] ${column ? "bg-canvas" : ""}`}
    >
      <BlockHeader className={column ? "" : "@lg:items-center"}>
        {handle}
        <span className="flex h-8 w-10 shrink-0 items-center justify-center">{sendSwitch}</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {named}
          {/* Wide (owner, 2026-11-02): the chips, count and actions follow the name instead of
              sitting at the far end of a wide row, and a closed prompt's first line fills the rest. */}
          {!column && (
            <span className="flex shrink-0 flex-wrap items-center gap-1">
              {!prompt.marker && <SendBadges prompt={prompt} />}
              <TokenCount prompt={prompt} content={content} context={context} />
              {summary}
              {optionsToggle}
              {menu}
            </span>
          )}
          {!column && collapsed && !prompt.marker && !label.derived && first !== "" && (
            <span className="min-w-0 flex-1 basis-48 truncate text-sm text-muted">{first}</span>
          )}
          {column && summary}
        </span>
        {/* In the column a prompt's count goes with its chips, so a narrow header leaves the name
            (and its rename field) the width; a marker's, and a closed row's, stay at the end. */}
        {column && (prompt.marker || !open) && (
          <span className="flex h-8 shrink-0 items-center pl-1">
            <TokenCount prompt={prompt} content={content} context={context} />
          </span>
        )}
        {column && optionsToggle}
        {column && menu}
      </BlockHeader>
      {column && open && !prompt.marker && (
        <div className="flex flex-wrap items-center gap-1 px-2 pb-1 pl-12">
          <SendBadges prompt={prompt} />
          <TokenCount prompt={prompt} content={content} context={context} />
        </div>
      )}
      {open && optionsOpen && (
        <BlockOptions>
          <PromptOptions store={store} path={path} prompt={prompt} />
        </BlockOptions>
      )}
      {full && <OverrideNote store={store} entry={entry} context={context} className="px-3 pb-1" />}
      {open && (
        <BlockBody dim={!entry.enabled}>
          <TextField
            store={store}
            path={[...path, "content"]}
            label={`Prompt: ${name}`}
            labelHidden
            autoFocus={autoFocus}
            rows={Math.min(8, Math.max(2, content.split("\n").length))}
          />
        </BlockBody>
      )}
    </Block>
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
  const { ref, width, min, max, change, reset } = useInnerPanelWidth(userId, "presetOutline", 240, 140, 560, 480)
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
  onOpenLarge,
  onOpenLorebook,
  saveControls
}: {
  store: EditorStore
  /** The save cluster, at the start of the list's own toolbar row (DESIGN §10.1). */
  saveControls?: ReactNode
  context?: PresetContext | null | undefined
  focus?: string | undefined
  /** A prompt to open and scroll to, asked for again by a new object (a warning's link). */
  goTo?: { readonly identifier: string } | null | undefined
  layout?: PromptLayout
  /** The column's way to the large editor, at a prompt. */
  onOpenLarge?: ((identifier: string) => void) | undefined
  /** Opens a lorebook the preset sends (over the chat); without it, its page. */
  onOpenLorebook?: ((ref: RefId) => void) | undefined
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
  // The prompt just added, whose text takes the focus as its editor mounts.
  const [added, setAdded] = useState<string | null>(null)
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
  /** Opens a prompt and scrolls to it; `added`: one just made, scrolled to only if its header is hidden. */
  const jump = (identifier: string, added = false) => {
    reveal(identifier)
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(
        identifier === PRESET_LOREBOOKS_FOCUS ? "[data-preset-lorebooks]" : `[data-prompt="${CSS.escape(identifier)}"]`
      )
      if (!target) return
      if (added) {
        revealIfHidden(target.firstElementChild instanceof HTMLElement ? target.firstElementChild : target)
        return
      }
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
  // A prompt added waits behind the unsaved bar with its place (owner, 2026-11-02); its text can
  // be typed at once, and it's sent once saved.
  const addAt = (index: number, prompt: PresetPrompt) => {
    const next = [...order]
    next.splice(index, 0, { identifier: prompt.identifier, enabled: true })
    addPresetPrompt(store, prompt, next)
    setAdded(prompt.identifier)
    jump(prompt.identifier, true)
  }
  const add = (index: number) => {
    const identifier = uuidv7()
    addAt(index, {
      ...newestMessage,
      identifier,
      name: "New prompt",
      role: "system",
      marker: false,
      system_prompt: false,
      // A card can't replace a prompt made here unless the user allows it (DESIGN §5.0).
      forbid_overrides: true
    })
  }
  const hasDefinitions = order.some((e) => e.identifier === charDefinitions.identifier)
  const definitionsOn = order.some((e) => e.identifier === charDefinitions.identifier && e.enabled)
  const addDefinitions = (index: number) =>
    addAt(index, prompts.find((p) => p.identifier === charDefinitions.identifier) ?? charDefinitions)
  // Adding is two buttons in the toolbar, once (owner, 2026-11-02): a new prompt goes at the end
  // of the list, the definitions block where the separate definition markers start (or just
  // above the chat); either opens there, ready to type, and is dragged wherever it's wanted.
  const definitionsAt = () => {
    const field = order.findIndex((e) => perFieldMarkers.includes(e.identifier))
    if (field >= 0) return field
    const chat = order.findIndex((e) => e.identifier === "chatHistory")
    return chat >= 0 ? chat : order.length
  }
  const addButtons = (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        variant={column ? "ghost" : "secondary"}
        className={column ? "h-7 px-2" : ""}
        hint={NEW_PROMPT_HINT}
        onClick={() => add(order.length)}
      >
        <Icon name="plus" />
        New prompt
      </Button>
      {hasDefinitions ? (
        // Disabled, it still explains itself on hover and focus.
        <Tooltip label="The preset already has its definitions block; drag it to move it">
          <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <Button variant={column ? "ghost" : "secondary"} className={column ? "h-7 px-2" : ""} disabled>
              <Icon name="insert" />
              {DEFINITIONS_BUTTON}
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Button
          variant={column ? "ghost" : "secondary"}
          className={column ? "h-7 px-2" : ""}
          hint={DEFINITIONS_HINT}
          onClick={() => addDefinitions(definitionsAt())}
        >
          <Icon name="insert" />
          {DEFINITIONS_BUTTON}
        </Button>
      )}
    </div>
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
    // Only the places that hold a note show (owner, 2026-11-02: quiet when empty), in both layouts.
    if (notes === "") return null
    // A row like the prompts' (dashed: it stands for what fills it), its icon in their handle's column.
    return (
      <Block dashed data-note-slot={label} className="my-1 flex min-h-10 items-center gap-2 py-1 ps-1 pe-2 text-sm">
        <span className="flex size-8 shrink-0 items-center justify-center text-muted" aria-hidden="true">
          <Icon name="note" />
        </span>
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium">{label}</span>
          <span className="text-muted">: {notes}</span>
        </span>
      </Block>
    )
  }
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const afterHistory = order[history + 1]?.identifier === "newestMessage" ? history + 2 : history + 1
  const tailStarts = (
    <>
      <AfterChatLine />
      {slot("Notes after the chat", (p) => p.mode === "section" && p.section === "tail_start")}
    </>
  )
  const reuse = placeReuseLines(
    context?.cacheAfter ?? [],
    order.map((e) => e.identifier)
  )
  const reuseAlone = ![...reuse.values()].includes("every")
  const reuseLine = (place: string) => {
    const kind = reuse.get(place)
    return kind && <ReuseLine kind={kind} alone={reuseAlone} />
  }
  const newestAfterTail = order.findIndex((e) => e.identifier === "newestMessage") > history + 1
  const anyOpen = order.some((e) => isOpen(opened, e.identifier))
  const small = column ? "h-7 px-2" : ""
  const variant = column ? "ghost" : "secondary"
  const controls = (
    // One toolbar row: the save cluster, New prompt and the definitions block, then expand and options.
    <ExpandCollapseAll
      compact={column}
      start={
        <div className="flex flex-wrap items-center gap-1">
          {saveControls}
          {addButtons}
        </div>
      }
      anyOpen={anyOpen}
      allOpen={false}
      expandHint="Show every prompt's text"
      collapseHint="Fold every prompt to its header: an outline of the preset"
      onExpand={() => setOpened({ all: true, except: new Set() })}
      onCollapse={() => setOpened({ all: false, except: new Set() })}
    >
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
    </ExpandCollapseAll>
  )
  const list = (
    <div className="@container min-w-0 flex-1">
      {slot("Notes at the very start", (p) => p.mode === "section" && p.section === "context_start")}
      {reuseLine(AT_START)}
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
                slot("Notes with the definitions", (p) => p.mode === "section" && p.section === "card")}
              {entry.identifier === "chatHistory" && (
                <>
                  {reuseLine(BEFORE_CHAT)}
                  <ChatStartsLine />
                  {slot("Notes inside the chat", (p) => p.mode === "depth")}
                </>
              )}
              {history >= 0 && index === afterHistory && tailStarts}
              {entry.identifier === "newestMessage" &&
                newestAfterTail &&
                slot("Notes at the very end", (p) => p.mode === "section" && p.section === "tail_end")}
              {entry.identifier === "main" &&
                slot("Notes before the main prompt", (p) => p.mode === "section" && p.section === "before_main_prompt")}
              <div className={column ? "py-0.5" : "py-1"}>
                <PromptBlock
                  store={store}
                  entry={entry}
                  handle={handle}
                  context={context}
                  definitions={definitionsOn}
                  autoFocus={added === entry.identifier}
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
                    // Held behind the unsaved bar with moves (owner, 2026-11-01): sent until Save.
                    store.deletePrompt(entry.identifier)
                  }}
                />
              </div>
              {entry.identifier === "main" &&
                slot("Notes after the main prompt", (p) => p.mode === "section" && p.section === "after_main_prompt")}
              {entry.identifier === "newestMessage" &&
                slot(
                  "Notes after the newest message",
                  (p) => p.mode === "tail" || (p.mode === "depth" && p.depth === 0)
                )}
              {reuseLine(entry.identifier)}
            </>
          )
        }}
      </SortableList>
      {history >= 0 && afterHistory >= order.length && tailStarts}
      {!newestAfterTail && slot("Notes at the very end", (p) => p.mode === "section" && p.section === "tail_end")}
      <PresetLorebooks store={store} column={column} onOpen={onOpenLorebook} />
    </div>
  )
  return (
    <div
      ref={root}
      className="flex min-w-0 flex-col gap-3"
      // The user moved on before the new prompt's editor mounted (renaming it, say): its text
      // doesn't take the focus back. A menu handing focus back to its trigger isn't moving on.
      onFocusCapture={(event) => {
        if (added === null || !(event.target instanceof HTMLElement)) return
        if (event.target.hasAttribute("aria-haspopup")) return
        const own = `[data-prompt="${CSS.escape(added)}"]`
        if (event.target.closest(`${own} [contenteditable], ${own} textarea`)) return
        setAdded(null)
      }}
    >
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
          , and the two never meet. In an export, it&apos;s switched off.{" "}
          <button type="button" className={link} onClick={() => onGoTo(prompt.identifier)}>
            Go to the prompt
          </button>
        </div>
      ))}
    </div>
  )
}
