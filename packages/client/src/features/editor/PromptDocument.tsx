import { writePresetOrder } from "./presetDraft.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { charDefinitions, newestMessage, perFieldMarkers, presetOrder } from "@rp/shared/presetOrder.ts"
import { CONDITION_LABELS, conditionOf, presetWarnings, TRIGGERS } from "@rp/shared/presetConditions.ts"
import { DIRECTION_PROMPT } from "@rp/shared/endOfRequest.ts"
import { Link } from "@tanstack/react-router"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { Menu, MenuItem } from "../../ui/Menu.tsx"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { NumberField, SelectField, SwitchField, TextField, TriggersField } from "./controls.tsx"
import { SearchNavigation, scrollToSearchField, useSearchMatch } from "./searchNavigation.ts"
import { summaryBadge } from "./summaryBadge.ts"
import { type EditorStore, useText, useValue } from "./store.ts"
import { presetEditorWarnings } from "./presetSections.ts"

const at = (id: string) => ["prompts", `identifier=${id}`]
const roles = ["system", "user", "assistant"].map((value) => ({ value, label: value }))
const positions = [
  { value: "relative", label: "In order" },
  { value: "absolute", label: "Depth" }
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

function Block({
  store,
  entry,
  handle,
  collapsed,
  toggle,
  remove,
  context,
  definitions
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
}) {
  const path = at(entry.identifier)
  const prompt = useValue<PresetPrompt | undefined>(store, path) ?? newestMessage
  const forbids = useValue<boolean | undefined>(store, [...path, "forbid_overrides"]) ?? false
  const override = context?.overrides?.find((o) => o.identifier === entry.identifier)
  const byDefinitions = definitions && perFieldMarkers.includes(entry.identifier)
  const name = useText(store, [...path, "name"]) || prompt.name
  const content = useText(store, [...path, "content"])
  const nameMatch = useSearchMatch([...path, "name"])
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
  const condition = conditionOf(prompt)
  const filled = context?.blocks.find((b) => b.identifier === entry.identifier)
  return (
    <section
      ref={marker}
      tabIndex={-1}
      id={`prompt-${entry.identifier}`}
      data-prompt={entry.identifier}
      className="scroll-mt-[var(--preset-toolbar-height,1rem)] border-t border-border py-2"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-2">
        {handle}
        {entry.identifier !== "newestMessage" && (
          <Switch
            checked={entry.enabled}
            onCheckedChange={(enabled) =>
              writePresetOrder(
                store,
                presetOrder(
                  store.value(["prompts"]) as PresetPrompt[],
                  store.value(["order"]) as PromptOrderEntry[]
                ).map((e) => (e.identifier === entry.identifier ? { ...e, enabled } : e))
              )
            }
          >
            <span className="sr-only">Send {name}</span>
          </Switch>
        )}
        <span className="min-w-0 flex-1 basis-40 text-sm font-medium break-words">
          {prompt.marker && nameMatch ? (
            <>
              {name.slice(0, nameMatch.at)}
              <mark className="bg-warning/30 text-text">
                {name.slice(nameMatch.at, nameMatch.at + nameMatch.length)}
              </mark>
              {name.slice(nameMatch.at + nameMatch.length)}
            </>
          ) : (
            name
          )}
        </span>
        {!prompt.marker && (
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
        )}
        {prompt.marker && !entry.enabled && <Badge>off</Badge>}
        {!prompt.marker && /\{\{summary\}\}/i.test(content) && context?.summary && (
          <Badge>{summaryBadge(context.summary)}</Badge>
        )}
        <span className="text-xs text-muted">
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
        {!prompt.marker && (
          <Button
            variant="ghost"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${name}`}
            aria-expanded={!collapsed}
            onClick={toggle}
          >
            {collapsed ? "Expand" : "Collapse"}
          </Button>
        )}
      </header>
      {(entry.identifier === "main" || entry.identifier === "jailbreak") && (
        <p className="pl-10 text-xs text-muted" data-override={override?.status ?? (forbids ? "forbidden" : "none")}>
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
              has {entry.identifier === "main" ? "a system prompt" : "post-history instructions"}; this prompt forbids
              it
            </>
          ) : forbids ? (
            "A card can't replace it"
          ) : (
            "A card's own prompt can replace it"
          )}
        </p>
      )}
      {prompt.marker && (
        <p className="pl-10 text-xs text-muted">
          {byDefinitions
            ? "Filled by Definitions"
            : filled?.labels.length
              ? `Definitions: ${filled.labels.join(", ")}`
              : entry.identifier === "chatHistory"
                ? "Earlier messages in the current context"
                : entry.identifier === "newestMessage"
                  ? "The latest message, placed here"
                  : "Filled from the current chat"}
        </p>
      )}
      {!prompt.marker && !collapsed && (
        <div className={`mt-2 flex flex-col gap-3 ${entry.enabled ? "" : "opacity-70"}`}>
          <div className="grid gap-2 sm:grid-cols-3">
            <TextField store={store} path={[...path, "name"]} label="Name" />
            <SelectField store={store} path={[...path, "role"]} label="Role" items={roles} />
            <SelectField store={store} path={[...path, "injection_position"]} label="Position" items={positions} />
          </div>
          <SelectField
            store={store}
            path={[...path, "condition"]}
            label="Condition"
            items={conditions}
            fallback="always"
          />
          {/* ST's generation types (ST's Triggers), beside the condition (DESIGN §2.2). */}
          <TriggersField
            store={store}
            path={[...path, "injection_trigger"]}
            label="Generation types"
            items={TRIGGERS}
          />
          {prompt.injection_position === "absolute" && (
            <div className="grid grid-cols-2 gap-2">
              <NumberField
                store={store}
                path={[...path, "injection_depth"]}
                label="Depth"
                integer
                min={0}
                max={10000}
              />
              <NumberField store={store} path={[...path, "injection_order"]} label="Order at depth" />
            </div>
          )}
          <TextField
            store={store}
            path={[...path, "content"]}
            label={`Prompt: ${name}`}
            rows={Math.min(8, Math.max(2, content.split("\n").length))}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SwitchField store={store} path={[...path, "forbid_overrides"]} label="A card can't replace it" />
            {entry.identifier !== "main" && !prompt.system_prompt && (
              <Button variant="ghost" onClick={remove}>
                Delete the prompt
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export function PromptDocument({
  store,
  context,
  focus,
  goTo
}: {
  store: EditorStore
  context?: PresetContext | null | undefined
  focus?: string | undefined
  /** A prompt to open and scroll to, asked for again by a new object (a warning's link). */
  goTo?: { readonly identifier: string } | null | undefined
}) {
  const searchMatch = useContext(SearchNavigation)
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const order = presetOrder(prompts, savedOrder)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const [list, identity] = searchMatch?.path ?? []
    if (list === "prompts" && typeof identity === "string" && identity.startsWith("identifier=")) {
      const identifier = identity.slice("identifier=".length)
      const frame = requestAnimationFrame(() =>
        setCollapsed((current) => new Set([...current].filter((id) => id !== identifier)))
      )
      return () => cancelAnimationFrame(frame)
    }
  }, [searchMatch])
  const root = useRef<HTMLDivElement>(null)
  const names = new Map([...prompts, newestMessage].map((p) => [p.identifier, p.name]))
  if (!names.has(charDefinitions.identifier)) names.set(charDefinitions.identifier, charDefinitions.name)
  const jump = (identifier: string) => {
    setCollapsed((current) => new Set([...current].filter((id) => id !== identifier)))
    requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(identifier)}"]`)
      if (!target) return
      const scroll = root.current?.closest<HTMLElement>("[data-preset-scroll]")
      if (scroll) {
        const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
        scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - margin
      } else target.scrollIntoView({ block: "start" })
    })
  }
  useEffect(() => {
    if (!focus) return
    const frame = requestAnimationFrame(() => jump(focus))
    return () => cancelAnimationFrame(frame)
  }, [focus])
  useEffect(() => {
    if (!goTo) return
    const frame = requestAnimationFrame(() => jump(goTo.identifier))
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
  const insert = (index: number, label: string, className?: string) =>
    hasDefinitions ? (
      <Button variant="ghost" className={className} aria-label={label} onClick={() => add(index)}>
        ＋
      </Button>
    ) : (
      <Menu
        label={label}
        align="center"
        trigger={
          <Button variant="ghost" className={className} aria-label={label}>
            ＋
          </Button>
        }
      >
        <MenuItem onClick={() => add(index)}>New prompt</MenuItem>
        <MenuItem onClick={() => addDefinitions(index)}>Definitions marker (every card whole)</MenuItem>
      </Menu>
    )
  const slot = (label: string, predicate: (p: PresetContext["notes"][number]["placement"]) => boolean) => (
    <div className="border-l-2 border-border px-2 py-1 text-xs text-muted">
      <strong>{label}</strong>:{" "}
      {context === undefined
        ? "no chat open"
        : context === null
          ? "context unavailable"
          : context.notes
              .filter((n) => predicate(n.placement))
              .map(
                (n) =>
                  n.title +
                  (n.placement.mode === "depth" ? ` (depth ${n.placement.depth})` : "") +
                  (n.due === false ? " (not due this turn)" : "")
              )
              .join(", ") || "no active notes"}
    </div>
  )
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const afterHistory = order[history + 1]?.identifier === "newestMessage" ? history + 2 : history + 1
  const tailStarts = (
    <>
      <p className="border-y border-border py-1 text-xs font-medium text-accent">Tail starts</p>
      {slot("Start of tail notes", (p) => p.mode === "section" && p.section === "tail_start")}
    </>
  )
  const newestAfterTail = order.findIndex((e) => e.identifier === "newestMessage") > history + 1
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setCollapsed(new Set(order.map((e) => e.identifier)))}>Collapse all</Button>
        <Button onClick={() => setCollapsed(new Set())}>Expand all</Button>
      </div>
      <div className="grid min-w-0 gap-4 xl:grid-cols-[9rem_minmax(0,1fr)]">
        <nav aria-label="Prompt outline" className="hidden min-w-0 xl:block">
          <div className="sticky top-[var(--preset-toolbar-height,1rem)] max-h-[60dvh] overflow-y-auto">
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
          </div>
        </nav>
        <div className="min-w-0">
          {slot("Start of context notes", (p) => p.mode === "section" && p.section === "context_start")}
          {context?.cacheAfter
            .filter((b) => b.identifier === "context_start")
            .map((b) => (
              <p key={b.reason} className="border-y border-accent py-1 text-xs text-accent">
                Cached part ends · {b.reason}
              </p>
            ))}
          {insert(0, "Insert prompt at start")}
          <SortableList
            items={order}
            itemKey={(e) => e.identifier}
            itemLabel={(e) => names.get(e.identifier) ?? e.identifier}
            label="Prompt order"
            onMove={move}
          >
            {(entry, handle) => (
              <>
                {entry.identifier === "charDescription" &&
                  slot("With definitions", (p) => p.mode === "section" && p.section === "card")}
                {entry.identifier === "chatHistory" && (
                  <>
                    <p className="border-y border-border py-1 text-xs font-medium text-accent">History starts</p>
                    {slot("At depth N", (p) => p.mode === "depth")}
                  </>
                )}
                {history >= 0 && order.indexOf(entry) === afterHistory && tailStarts}
                {entry.identifier === "newestMessage" &&
                  newestAfterTail &&
                  slot("End of tail notes", (p) => p.mode === "section" && p.section === "tail_end")}
                {entry.identifier === "main" &&
                  slot("Before main prompt", (p) => p.mode === "section" && p.section === "before_main_prompt")}
                <Block
                  store={store}
                  entry={entry}
                  handle={handle}
                  context={context}
                  definitions={definitionsOn}
                  collapsed={collapsed.has(entry.identifier)}
                  toggle={() =>
                    setCollapsed(
                      new Set(
                        collapsed.has(entry.identifier)
                          ? [...collapsed].filter((id) => id !== entry.identifier)
                          : [...collapsed, entry.identifier]
                      )
                    )
                  }
                  remove={() => {
                    if (entry.identifier === "main") return
                    setOrder(order.filter((e) => e.identifier !== entry.identifier))
                    void store.removeItem(at(entry.identifier))
                  }}
                />
                {entry.identifier === "main" &&
                  slot("After main prompt", (p) => p.mode === "section" && p.section === "after_main_prompt")}
                {entry.identifier === "newestMessage" &&
                  slot(
                    "After newest message / depth 0",
                    (p) => p.mode === "tail" || (p.mode === "depth" && p.depth === 0)
                  )}
                {context?.cacheAfter
                  .filter((b) => b.identifier === entry.identifier)
                  .map((b) => (
                    <p key={b.reason} className="border-y border-accent py-1 text-xs text-accent">
                      Cached part ends · {b.reason}
                    </p>
                  ))}
                <div className="flex justify-center">
                  {insert(
                    order.indexOf(entry) + 1,
                    `Insert prompt after ${names.get(entry.identifier)}`,
                    "w-full rounded-none"
                  )}
                </div>
              </>
            )}
          </SortableList>
          {history >= 0 && afterHistory >= order.length && tailStarts}
          {!newestAfterTail && slot("End of tail notes", (p) => p.mode === "section" && p.section === "tail_end")}
        </div>
      </div>
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
