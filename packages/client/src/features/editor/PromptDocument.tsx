import { useSearchHighlights } from "./searchHighlights.ts"
import { SearchReplaceButton } from "../../ui/SearchReplace.tsx"
import { createPortal } from "react-dom"
import { SearchDialog } from "./SearchDialog.tsx"
import { usePresetWorkspace } from "./PresetWorkspace.tsx"
import { NOTE_FOCUS } from "./workspaceViews.ts"
import { presetScopes } from "./searchScopes.ts"
import {
  PlaceholderSource,
  PromptKindTag,
  promptKind,
  SummariesPlaceholder,
  VolatileBadge,
  volatileMacros
} from "./promptKinds.tsx"
import { usePlaceExpansion, usePlaceNotice, usePlaceParam } from "../../usePlaceParam.ts"
// The preset's prompt order as one document (DESIGN §6.2a). Each prompt is a bounded block: a
// header (handle, switch, name renamed in place, how it's sent, tokens, its options and actions)
// above its text in the code-editor box. Options fold away per prompt, or all at once.
import type { RefId } from "@rp/shared/library.ts"
import { addPresetPrompt, writePresetOrder } from "./presetDraft.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { charDefinitions, newestMessage, ownTurnNotes, perFieldMarkers, presetOrder } from "@rp/shared/presetOrder.ts"
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
  BlockToggle
} from "../../ui/Block.tsx"
import { Menu, MenuItem, MenuSeparator } from "../../ui/Menu.tsx"
import { ResizeHandle, useInnerPanelWidth } from "../../ui/ResizeHandle.tsx"
import { revealAdded, revealIfHidden } from "../../ui/reveal.ts"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { SearchNavigation, scrollToSearchField, useSearchMatch, type SearchMatch } from "./searchNavigation.ts"
import { summaryBadge } from "./summaryBadge.ts"
import { PRESET_LOREBOOKS_FOCUS, PresetLorebooks } from "./PresetLorebooks.tsx"
import { AfterChatLine, AT_START, BEFORE_CHAT, placeReuseLines, CacheBreakpointLine } from "./promptLines.tsx"
import { type EditorStore, useText, useValue } from "./store.ts"
import { presetEditorWarnings } from "./presetSections.ts"
import { promptLabel } from "./promptLabel.ts"
import { tokensText, useTokenCounts } from "./tokenCounts.ts"

/**
 * Where the document is shown: "document", the large editor (blocks open, the outline beside
 * them); "column", the side panel's Prompt preset tab (blocks closed to a
 * row with the first line of their text). Both are this one component and its blocks, editing
 * the same store, so the two can't drift.
 */
export type PromptLayout = "document" | "column"

const at = (id: string) => ["prompts", `identifier=${id}`]
const roles = ["system", "user", "assistant"].map((value) => ({ value, label: value }))
const positions = [
  { value: "relative", label: "In place" },
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

const NEW_PROMPT_HINT = "Adds a new prompt at the end of the list."
const DEFINITIONS_LABEL = "Card definitions block"
const DEFINITIONS_BUTTON = "Add definitions block"
const DEFINITIONS_HINT = "Adds a definitions block: it places every cast card's definitions there."

/** A prompt's first line of text, for a closed row. */
const firstLine = (content: string) =>
  content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? ""

/** Whether every prompt's options show, by default: this browser's choice. */
const OPTIONS_KEY = "rp.presetOptionsOpen:"
const readOptionsOpen = (userId: string) => {
  try {
    return localStorage.getItem(OPTIONS_KEY + userId) === "1"
  } catch {
    return false
  }
}
const keepOptionsOpen = (userId: string, open: boolean) => {
  try {
    localStorage.setItem(OPTIONS_KEY + userId, open ? "1" : "0")
  } catch {
    /* In memory when storage is off. */
  }
}

function TokenCount({
  prompt,
  content,
  context,
  replaced
}: {
  prompt: PresetPrompt
  content: string
  context: PresetContext | null | undefined
  replaced: boolean
}) {
  const filled = context?.blocks.find((b) => b.identifier === prompt.identifier)
  // Markers and replaced prompts count what's actually sent in the open chat; other
  // prompts count their own text with the chat model's tokenizer.
  const fromChat = prompt.marker || replaced
  const texts = useMemo(() => [fromChat ? "" : content], [fromChat, content])
  const own = useTokenCounts(texts)
  return (
    <Tooltip label="Estimated tokens this prompt sends.">
      <span
        tabIndex={0}
        data-prompt-tokens
        className="shrink-0 rounded text-xs whitespace-nowrap text-muted tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {fromChat
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
  entry,
  context,
  className
}: {
  entry: PromptOrderEntry
  context: PresetContext | null | undefined
  className: string
}) {
  const override = context?.overrides?.find((o) => o.identifier === entry.identifier)
  if (
    (entry.identifier !== "main" && entry.identifier !== "jailbreak") ||
    !override ||
    override.status === "disabled" ||
    override.status === "missing"
  )
    return null
  return (
    <p className={`text-xs text-muted ${className}`} data-override={override.status}>
      {override?.status === "replaced" ? (
        <>
          Replaced in this chat by{" "}
          <Tooltip label="Opens the card supplying this override.">
            <Link
              to="/cards/$entityId"
              params={{ entityId: override.card }}
              className="text-accent underline-offset-4 hover:underline"
            >
              {override.name}
            </Link>
          </Tooltip>
          's {entry.identifier === "main" ? "system prompt" : "post-history instructions"}
        </>
      ) : override?.status === "forbidden" ? (
        <>
          <Tooltip label="Opens the card supplying this override.">
            <Link
              to="/cards/$entityId"
              params={{ entityId: override.card }}
              className="text-accent underline-offset-4 hover:underline"
            >
              {override.name}
            </Link>
          </Tooltip>{" "}
          has {entry.identifier === "main" ? "a system prompt" : "post-history instructions"}; this prompt forbids it
        </>
      ) : null}
    </p>
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
      <SwitchField
        store={store}
        path={[...path, "forbid_overrides"]}
        label="A card can't replace it"
        about="Keep this prompt even when a character card supplies its own system prompt or post-history instructions."
      />
    </div>
  )
}

/** Main and ST's system prompts keep their place; markers have no text to lose. */
const deletable = (entry: PromptOrderEntry, prompt: PresetPrompt) =>
  entry.identifier === "ownTurnNotes" || (entry.identifier !== "main" && !prompt.system_prompt && !prompt.marker)

/** How a prompt is sent: role, position, and any condition or generation types. */
function SendBadges({ prompt }: { prompt: PresetPrompt }) {
  const condition = conditionOf(prompt)
  return (
    <>
      {condition !== "always" && (
        <Tooltip label={`Sent ${CONDITION_LABELS[condition].toLowerCase()}.`}>
          <span tabIndex={0}>
            <Badge tone="accent">{conditionBadges[condition]}</Badge>
          </span>
        </Tooltip>
      )}
      {prompt.injection_trigger.length > 0 && (
        <Tooltip label="Sent only for these generation types.">
          <span tabIndex={0}>
            <Badge tone="accent">
              {TRIGGERS.filter((t) => prompt.injection_trigger.includes(t.value))
                .map((t) => t.label.toLowerCase())
                .join(", ") || "never"}
            </Badge>
          </span>
        </Tooltip>
      )}
      <Tooltip
        label={
          prompt.injection_position === "absolute"
            ? `Inserted ${prompt.injection_depth} messages from the end of the chat.`
            : "Sent at this prompt's place in the list."
        }
      >
        <span tabIndex={0}>
          <Badge>{prompt.injection_position === "absolute" ? `depth ${prompt.injection_depth}` : "in place"}</Badge>
        </span>
      </Tooltip>
      <Tooltip label={`Sent as ${prompt.role === "assistant" ? "an" : "a"} ${prompt.role} message.`}>
        <span tabIndex={0} data-prompt-role>
          <Badge>{prompt.role}</Badge>
        </span>
      </Tooltip>
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
  readonly ownTurnBelow: (() => void) | undefined
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
  autoFocus = false,
  aboveBreakpoint = false
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
  aboveBreakpoint?: boolean
}) {
  const path = at(entry.identifier)
  const namePath = [...path, "name"]
  const prompt = useValue<PresetPrompt | undefined>(store, path) ?? newestMessage
  const byDefinitions = definitions && perFieldMarkers.includes(entry.identifier)
  const typed = useText(store, namePath)
  const content = useText(store, [...path, "content"])
  const label = prompt.marker ? { text: typed || prompt.name, derived: false } : promptLabel(typed, content)
  const name = label.text
  const nameHighlights = useSearchHighlights(store, namePath)
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
  const kind = promptKind(prompt)
  const landmark = entry.identifier === "chatHistory"

  const sendSwitch = entry.identifier !== "newestMessage" && (
    <Tooltip label={entry.enabled ? `Stops sending ${name}.` : `Sends ${name}.`}>
      <span className="inline-flex">
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
      </span>
    </Tooltip>
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
  // A note replaces it in the open chat (DESIGN §4.2): said on the row, closed too.
  const noted = context?.replacements?.find(
    (r) =>
      r.target.kind === "preset_prompt" &&
      r.target.identifier === entry.identifier &&
      (r.status === "replaced" || r.status === "own_position" || r.status === "not_due")
  )
  const replacedBadge = !prompt.marker && noted && (
    <Tooltip label={`The note “${noted.title}” replaces this prompt in this chat.`}>
      <span tabIndex={0} data-prompt-replaced>
        <Badge tone="accent">replaced in this chat</Badge>
      </span>
    </Tooltip>
  )
  const summary = !prompt.marker && /\{\{summary\}\}/i.test(content) && context?.summary && (
    <Tooltip label="Shows what the summary note macro sends.">
      <span tabIndex={0}>
        <Badge>{summaryBadge(context.summary)}</Badge>
      </span>
    </Tooltip>
  )

  const title = prompt.marker ? (
    <span className="flex min-w-0 flex-1 flex-col gap-1 px-1 py-1">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name={kind && "icon" in kind ? kind.icon! : "insert"} />
        <span
          className={
            landmark ? "min-w-0 flex-1 truncate text-base font-semibold" : "min-w-0 flex-1 truncate text-sm font-medium"
          }
        >
          {landmark && !nameMatch ? "Chat history" : markedName}
        </span>
        {!entry.enabled && (
          <Tooltip label="This block is switched off.">
            <span>
              <Badge>off</Badge>
            </span>
          </Tooltip>
        )}
        {!landmark && <PromptKindTag prompt={prompt} />}
      </span>
    </span>
  ) : (
    <BlockToggle
      open={!collapsed}
      onToggle={toggle}
      label={name}
      name={<span className="block truncate">{name}</span>}
      hint={collapsed ? "Click to show the prompt’s text" : "Click to hide the prompt’s text"}
      derived={label.derived}
      dim={!entry.enabled}
      detail={
        column &&
        collapsed &&
        !label.derived &&
        first !== "" && (
          <span data-prompt-inline-preview className="block max-w-full truncate text-xs text-muted">
            {first}
          </span>
        )
      }
    />
  )
  const full = !column || open
  const named = prompt.marker ? (
    title
  ) : full ? (
    <InlineRename
      value={typed}
      label={name}
      // Search and replace's Go to a match in the name: its field opens with the match selected.
      goTo={nameMatch}
      highlights={nameHighlights}
      allowEmpty
      className="min-w-14 max-w-md"
      onRename={(next) => {
        store.setText(namePath, next)
        void store.save(textField(namePath))
      }}
    >
      {title}
    </InlineRename>
  ) : (
    <span className="flex min-w-7 flex-1">{title}</span>
  )

  const menu = (
    <Menu
      label={`Actions for ${name}`}
      hint="More actions for this prompt."
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
      {actions.ownTurnBelow && (
        <MenuItem
          icon="note"
          onClick={actions.ownTurnBelow}
          description="Adds the speaker’s own-turn notes here. Drag the marker to move them."
        >
          Insert Own-turn notes below
        </MenuItem>
      )}
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
            description="Takes this prompt out of the preset when you save."
          >
            Delete the prompt
          </MenuItem>
        </>
      )}
    </Menu>
  )

  const optionsToggle = !prompt.marker && (
    <BlockOptionsToggle
      open={optionsOpen}
      onToggle={toggleOptions}
      label={`Options of ${name}`}
      hint={
        optionsOpen
          ? "Click to hide the prompt's options"
          : "Click to show the prompt's options: role, position, condition…"
      }
    />
  )

  return (
    <Block
      ref={marker}
      tabIndex={-1}
      id={column ? undefined : `prompt-${entry.identifier}`}
      data-prompt={entry.identifier}
      dashed={false}
      data-prompt-type={landmark ? "history" : prompt.marker ? "placeholder" : kind ? "builtin" : "custom"}
      className={`scroll-mt-[var(--preset-toolbar-height,1rem)] ${landmark ? "prompt-history" : prompt.marker ? "prompt-placeholder" : column ? "bg-canvas" : ""}`}
    >
      <BlockHeader className={`prompt-row-header ${column ? "flex-nowrap" : "prompt-document-header flex-wrap"}`}>
        {handle}
        <span className="flex h-8 w-10 shrink-0 items-center justify-center">{sendSwitch}</span>
        <div data-prompt-heading className={column ? "min-w-7 flex-1" : "min-w-0 flex-1"}>
          <div data-prompt-title-row className="flex min-w-0 items-center gap-1">
            {named}
            {!column && !prompt.marker && <PromptKindTag prompt={prompt} />}
            {!column && optionsToggle}
            {!column && menu}
          </div>
          {column && collapsed && !prompt.marker && !label.derived && first !== "" && (
            <div data-prompt-column-preview className="hidden px-1 text-xs text-muted">
              {first}
            </div>
          )}
          {prompt.marker && (
            <div data-prompt-description className="px-1 pb-1">
              <PlaceholderSource
                identifier={prompt.identifier}
                heading={kind?.label ?? prompt.name}
                byDefinitions={byDefinitions}
              />
            </div>
          )}
          {!column && !prompt.marker && !label.derived && first !== "" && (
            <div data-prompt-preview className="mt-0.5 truncate px-1 text-xs text-muted">
              {first}
            </div>
          )}
        </div>
        {!column && (
          <div
            data-prompt-info
            className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 self-start min-h-8"
          >
            {aboveBreakpoint && <VolatileBadge names={volatileMacros(content)} />}
            {replacedBadge}
            {summary}
            {!prompt.marker && <SendBadges prompt={prompt} />}
            <TokenCount prompt={prompt} content={content} context={context} replaced={Boolean(noted)} />
          </div>
        )}
        {column && (
          // One cluster on the title's line: kind, tokens, options and ⋯, centred together with
          // even gaps. A marker has no options button; its slot stays empty so the tokens and ⋯
          // line up with the other rows' (owner, 2026-11-03: "both alignment and spacing are off").
          <span data-prompt-end className="ml-auto flex h-8 min-w-0 items-center gap-2 self-start">
            {!prompt.marker && <PromptKindTag prompt={prompt} />}
            {(prompt.marker || !open) && (
              <TokenCount prompt={prompt} content={content} context={context} replaced={Boolean(noted)} />
            )}
            <span className="flex shrink-0 items-center gap-1">
              {optionsToggle || <span aria-hidden className="size-8 shrink-0" />}
              {menu}
            </span>
          </span>
        )}
      </BlockHeader>
      {column &&
        !prompt.marker &&
        (open || summary || replacedBadge || (aboveBreakpoint && volatileMacros(content).length > 0)) && (
          <div data-prompt-info className="flex flex-wrap items-center gap-2 px-3 pb-2">
            {aboveBreakpoint && <VolatileBadge names={volatileMacros(content)} />}
            {replacedBadge}
            {summary}
            {open && (
              <>
                <SendBadges prompt={prompt} />
                <TokenCount prompt={prompt} content={content} context={context} replaced={Boolean(noted)} />
              </>
            )}
          </div>
        )}
      {open && optionsOpen && (
        <BlockOptions>
          <PromptOptions store={store} path={path} prompt={prompt} />
        </BlockOptions>
      )}
      {full && <OverrideNote entry={entry} context={context} className="px-3 pb-2" />}
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
  toolbarTarget,
  toolbarEnd,
  onSearchReveal
}: {
  store: EditorStore
  /** Portal target for the list's toolbar, below the editor's title row. */
  toolbarTarget?: HTMLElement | null | undefined
  toolbarEnd?: ReactNode
  onSearchReveal?: ((match: SearchMatch) => void) | undefined
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
  const userId = useSession().user.id
  const [searching, setSearching] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const searchId = column ? "preset-tab-search" : "preset-search"
  const [searchTarget, setSearchTarget] = useState<SearchMatch | null>(null)
  const inheritedMatch = useContext(SearchNavigation)
  const searchMatch = searchTarget ?? inheritedMatch
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const order = presetOrder(prompts, savedOrder)
  // The document opens every block; the column opens none, so its editors mount only when asked for.
  const scope = `prompts:${layout}:${store.refId}`
  const [promptFocus, setPromptFocus] = usePlaceParam(`${scope}:focus`, "")
  const focusedPrompt = promptFocus || focus
  const focusedHere = useRef<string | undefined>(undefined)
  const [opened, changeOpened] = usePlaceExpansion(scope, !column)
  const setOpened = (next: Opened | ((current: Opened) => Opened)) =>
    changeOpened(typeof next === "function" ? next(opened) : next)
  usePlaceNotice(
    focusedPrompt && focusedPrompt !== PRESET_LOREBOOKS_FOCUS && !prompts.some((p) => p.identifier === focusedPrompt)
      ? "This prompt is no longer in the preset."
      : null
  )
  // Auto-expansion is remembered per account in this browser.
  const [autoOptions, setAutoOptions] = useState(() => readOptionsOpen(userId))
  const [options, setOptions] = useState<Opened>(() => ({ all: readOptionsOpen(userId), except: new Set() }))
  // The prompt just added, whose text takes the focus as its editor mounts.
  const [added, setAdded] = useState<string | null>(null)
  const reveal = (identifier: string) => {
    setOpened((current) => withOpen(current, identifier, true))
    if (autoOptions) setOptions((current) => withOpen(current, identifier, true))
  }
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
    // A new search target reveals once; folding a prompt must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatch])
  const root = useRef<HTMLDivElement>(null)
  const names = new Map(
    [...prompts, newestMessage].map((p) => [p.identifier, p.marker ? p.name : promptLabel(p.name, p.content).text])
  )
  if (!names.has(charDefinitions.identifier)) names.set(charDefinitions.identifier, charDefinitions.name)
  /** Opens and scrolls to a prompt; a new block also flashes after the toolbar has measured. */
  const jump = (identifier: string, added = false) => {
    reveal(identifier)
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(
        identifier === PRESET_LOREBOOKS_FOCUS ? "[data-preset-lorebooks]" : `[data-prompt="${CSS.escape(identifier)}"]`
      )
      if (!target) return
      if (added) {
        // Let the sticky toolbar measure the newly shown unsaved bar first.
        requestAnimationFrame(() => {
          if (!target.isConnected) return
          // Keep the header at the top while the new text editor finishes opening.
          revealIfHidden(target)
          revealAdded(target)
        })
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
    if (!focusedPrompt || focusedHere.current === focusedPrompt) return
    const frame = requestAnimationFrame(() => jump(focusedPrompt))
    return () => cancelAnimationFrame(frame)
    // Only a new target scrolls; editing that prompt must not keep scrolling it back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedPrompt])
  useEffect(() => {
    if (!goTo) return
    // A warning's link is about the prompt's condition and generation types: its options open too.
    const frame = requestAnimationFrame(() => {
      setOptions((current) => withOpen(current, goTo.identifier, true))
      jump(goTo.identifier)
    })
    return () => cancelAnimationFrame(frame)
    // Only a new warning navigation scrolls; expansion changes must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const hasOwnTurn = order.some((e) => e.identifier === ownTurnNotes.identifier)
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
  const definitionsPlace = order[definitionsAt()]?.identifier
  const definitionsHint = hasDefinitions
    ? "The preset already has its definitions block; drag the block to move it."
    : `Adds a definitions block ${definitionsPlace && perFieldMarkers.includes(definitionsPlace) ? "before the first definition marker" : definitionsPlace === "chatHistory" ? "just above the chat history" : "at the end of the list"}: it places every cast card's definitions there.`
  const addButtons = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        className="preset-add-prompt h-8! px-2!"
        aria-label="Add prompt"
        hint={NEW_PROMPT_HINT}
        onClick={() => add(order.length)}
      >
        <Icon name="plus" />
        <span>Add prompt</span>
      </Button>
      <Tooltip label={definitionsHint}>
        <span tabIndex={hasDefinitions ? 0 : undefined}>
          <Button
            className="preset-add-definitions h-8! px-2!"
            aria-label={DEFINITIONS_BUTTON}
            disabled={hasDefinitions}
            onClick={() => addDefinitions(definitionsAt())}
          >
            <Icon name="insert" />
            <span>{DEFINITIONS_BUTTON}</span>
          </Button>
        </span>
      </Tooltip>
    </div>
  )
  const workspace = usePresetWorkspace()
  const slot = (label: string, predicate: (p: PresetContext["notes"][number]["placement"]) => boolean) => {
    const notes = context?.notes.filter((n) => predicate(n.placement)) ?? []
    // Only the places that hold a note show (owner, 2026-11-02: quiet when empty), in both layouts.
    if (notes.length === 0) return null
    // A row like the prompts' (dashed: it stands for what fills it), its icon in their handle's column.
    return (
      <Block
        data-note-slot={label}
        data-prompt-type="placeholder"
        className="prompt-placeholder my-1 flex min-h-10 items-center gap-2 px-3 py-2 text-sm"
      >
        <span className="flex size-8 shrink-0 items-center justify-center text-muted" aria-hidden="true">
          <Icon name="note" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1 break-words">
          <Tooltip label="Active notes at this placement.">
            <span tabIndex={0} className="prompt-kind-tag rounded px-1.5 py-0.5 font-medium">
              {label}
            </span>
          </Tooltip>
          <PlaceholderSource
            identifier="notes"
            heading={label}
            source={notes.map((note, index) => (
              <span key={note.ref}>
                {index > 0 && ", "}
                <Tooltip label={`Opens ${note.title} in the large editor.`}>
                  <Link
                    to="/library/$refId"
                    params={{ refId: note.ref }}
                    search={{ focus: NOTE_FOCUS }}
                    className="underline underline-offset-2"
                    onClick={(event) => {
                      if (
                        !workspace ||
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return
                      event.preventDefault()
                      workspace.open(note.ref, NOTE_FOCUS)
                    }}
                  >
                    {note.title}
                  </Link>
                </Tooltip>
                {note.placement.mode === "depth" && ` (depth ${note.placement.depth})`}
                {note.due === false && " (not due this turn)"}
              </span>
            ))}
            about="Each request inserts the active notes at this placement; this text isn't from the preset and can't be edited here. Edit the notes in the chat's Notes tab or the card's Notes tab. Their placement and conditions decide where and when they are sent."
          />
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
  const reuseLine = (place: string) =>
    reuse.get(place)?.map((kind, i) => <CacheBreakpointLine key={`${place}:${i}`} kind={kind} />)
  const breakpointPositions = [...reuse.keys()].map((id) =>
    id === AT_START
      ? -1
      : id === BEFORE_CHAT || id === "summaries"
        ? history - 0.5
        : order.findIndex((e) => e.identifier === id)
  )
  const firstBreakpoint = breakpointPositions.length ? Math.min(...breakpointPositions) : -1
  const newestAfterTail = order.findIndex((e) => e.identifier === "newestMessage") > history + 1
  const anyOpen = order.some((e) => isOpen(opened, e.identifier))
  const controls = (
    <div data-preset-layout={layout} className="preset-toolbar @container flex min-w-0 flex-col gap-2">
      <div data-preset-edit-row className="preset-edit-row flex items-center gap-2">
        {addButtons}
        <SearchReplaceButton
          ref={searchButton}
          controls={searchId}
          open={searching}
          className="preset-search"
          onClick={() => setSearching(!searching)}
        />
        {toolbarEnd && <div className="preset-toolbar-end flex shrink-0 items-center gap-1">{toolbarEnd}</div>}
      </div>
      {searching && (
        <SearchDialog
          store={store}
          inline
          idPrefix={searchId}
          scopes={presetScopes}
          onClose={() => {
            setSearching(false)
            searchButton.current?.focus()
          }}
          onReveal={(match) => {
            setSearchTarget(match)
            onSearchReveal?.(match)
          }}
        />
      )}
      <div data-preset-view-row className="flex items-center gap-3">
        <Button
          variant="ghost"
          className="h-8! shrink-0 px-2!"
          hint={anyOpen ? "Click to fold every prompt." : "Click to show every prompt’s text."}
          onClick={() => {
            setOpened({ all: !anyOpen, except: new Set() })
            if (!anyOpen && autoOptions) setOptions({ all: true, except: new Set() })
          }}
        >
          {anyOpen ? "Collapse all" : "Expand all"}
        </Button>
        <Tooltip label="Opening a prompt also opens its options.">
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              className="accent-accent"
              checked={autoOptions}
              onChange={(event) => {
                const next = event.target.checked
                keepOptionsOpen(userId, next)
                setAutoOptions(next)
                setOptions({ all: next, except: new Set() })
              }}
            />
            Auto-expand options
          </label>
        </Tooltip>
      </div>
    </div>
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
              {entry.identifier === "ownTurnNotes" && (
                <>
                  {slot("Own-turn notes", (p) => p.mode === "section" && p.section === "own_turn")}
                  {index < history && (
                    <p role="status" className="px-3 py-1 text-sm text-warning">
                      Above the history, own-turn notes rewrite the cached part whenever the speaker changes.
                    </p>
                  )}
                </>
              )}
              {entry.identifier === "charDescription" &&
                slot("Notes with the definitions", (p) => p.mode === "section" && p.section === "card")}
              {entry.identifier === "chatHistory" && (
                <>
                  {reuseLine(BEFORE_CHAT)}
                  <SummariesPlaceholder />
                  {reuseLine("summaries")}
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
                  aboveBreakpoint={entry.enabled && index <= firstBreakpoint}
                  collapsed={!isOpen(opened, entry.identifier)}
                  toggle={() => {
                    if (!isOpen(opened, entry.identifier)) reveal(entry.identifier)
                    else setOpened(withOpen(opened, entry.identifier, false))
                  }}
                  optionsOpen={isOpen(options, entry.identifier)}
                  toggleOptions={() => {
                    if (!isOpen(opened, entry.identifier)) {
                      reveal(entry.identifier)
                      setOptions(withOpen(options, entry.identifier, true))
                    } else setOptions(withOpen(options, entry.identifier, !isOpen(options, entry.identifier)))
                  }}
                  actions={{
                    openLarge: onOpenLarge && (() => onOpenLarge(entry.identifier)),
                    insertAbove: () => add(index),
                    insertBelow: () => add(index + 1),
                    definitionsBelow: hasDefinitions ? undefined : () => addDefinitions(index + 1),
                    ownTurnBelow: hasOwnTurn ? undefined : () => addAt(index + 1, ownTurnNotes)
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
              {entry.identifier === "chatHistory" &&
                slot("Notes in the chat history", (p) => p.mode === "depth" && p.depth > 0)}
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
    <SearchNavigation value={searchMatch}>
      <div
        ref={root}
        className="flex min-w-0 flex-col gap-3"
        // The user moved on before the new prompt's editor mounted (renaming it, say): its text
        // doesn't take the focus back. A menu handing focus back to its trigger isn't moving on.
        onFocusCapture={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[data-prompt]")?.dataset.prompt
          const target = event.target as HTMLElement
          if (
            id &&
            id !== promptFocus &&
            (target.matches("input, textarea, [contenteditable=true]") || target.shadowRoot !== null)
          ) {
            focusedHere.current = id
            setPromptFocus(id, true)
          }
          if (added === null || !(event.target instanceof HTMLElement)) return
          if (event.target.hasAttribute("aria-haspopup")) return
          const own = `[data-prompt="${CSS.escape(added)}"]`
          if (event.target.closest(`${own} [contenteditable], ${own} textarea`)) return
          setAdded(null)
        }}
      >
        {toolbarTarget ? createPortal(controls, toolbarTarget) : controls}
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
    </SearchNavigation>
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
          <Tooltip label="Scrolls to this prompt’s text.">
            <button type="button" className={link} onClick={jump}>
              Go to the text
            </button>
          </Tooltip>
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
          <Tooltip label="Scrolls to this prompt’s header.">
            <button type="button" className={link} onClick={() => onGoTo(prompt.identifier)}>
              Go to the prompt
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  )
}
