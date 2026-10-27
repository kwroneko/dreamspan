import { writePresetOrder } from "./presetDraft.ts"
import type { PresetPrompt, PromptOrderEntry } from "@rp/shared/docs/preset.ts"
import type { PresetContext } from "@rp/shared/inspectorApi.ts"
import { newestMessage, presetOrder } from "@rp/shared/presetOrder.ts"
import {
  CONDITION_LABELS,
  conditionFromTriggers,
  conditionOf,
  directionPrompt,
  readsDirection
} from "@rp/shared/presetConditions.ts"
import { uuidv7 } from "@rp/shared/id.ts"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button } from "../../ui/Button.tsx"
import { Switch } from "../../ui/Choice.tsx"
import { SortableList } from "../../ui/SortableList.tsx"
import { Badge } from "../../ui/Surface.tsx"
import { NumberField, SelectField, SwitchField, TextField } from "./controls.tsx"
import { type EditorStore, useText, useValue } from "./store.ts"

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
  context
}: {
  store: EditorStore
  entry: PromptOrderEntry
  handle: ReactNode
  collapsed: boolean
  toggle: () => void
  remove: () => void
  context: PresetContext | null | undefined
}) {
  const path = at(entry.identifier)
  const prompt = useValue<PresetPrompt | undefined>(store, path) ?? newestMessage
  const name = useText(store, [...path, "name"]) || prompt.name
  const content = useText(store, [...path, "content"])
  const condition = conditionOf(prompt)
  const filled = context?.blocks.find((b) => b.identifier === entry.identifier)
  return (
    <section
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
        <span className="min-w-0 flex-1 basis-40 text-sm font-medium break-words">{name}</span>
        {!prompt.marker && (
          <>
            <Badge>{prompt.role}</Badge>
            <Badge>{prompt.injection_position === "absolute" ? `depth ${prompt.injection_depth}` : "in order"}</Badge>
            {condition !== "always" && <Badge tone="accent">{conditionBadges[condition]}</Badge>}
            {prompt.added_on_import && <Badge>added on import</Badge>}
          </>
        )}
        {prompt.marker && !entry.enabled && <Badge>off</Badge>}
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
      {prompt.marker && (
        <p className="pl-10 text-xs text-muted">
          {filled?.labels.length
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
            fallback={conditionFromTriggers(prompt.injection_trigger)}
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
            {/* Added on import, it would come back on the next read: it's turned off instead. */}
            {!prompt.system_prompt && !prompt.added_on_import && (
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
  focus
}: {
  store: EditorStore
  context?: PresetContext | null | undefined
  focus?: string | undefined
}) {
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const order = presetOrder(prompts, savedOrder)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const root = useRef<HTMLDivElement>(null)
  const names = new Map([...prompts, newestMessage].map((p) => [p.identifier, p.name]))
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
      forbid_overrides: false
    })
    const next = [...order]
    next.splice(index, 0, { identifier, enabled: true })
    setOrder(next)
    jump(identifier)
  }
  const slot = (label: string, predicate: (p: PresetContext["notes"][number]["placement"]) => boolean) => (
    <div className="border-l-2 border-border px-2 py-1 text-xs text-muted">
      <strong>{label}</strong>:{" "}
      {context === undefined
        ? "no chat open"
        : context === null
          ? "context unavailable"
          : context.notes
              .filter((n) => predicate(n.placement))
              .map((n) => n.title + (n.due === false ? " (not due this turn)" : ""))
              .join(", ") || "no active notes"}
    </div>
  )
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const afterHistory = order[history + 1]?.identifier === "newestMessage" ? history + 2 : history + 1
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
          <Button variant="ghost" aria-label="Insert prompt at start" onClick={() => add(0)}>
            ＋
          </Button>
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
                    {context?.notes
                      .filter((n) => n.placement.mode === "depth")
                      .map((n, i) => (
                        <p key={i} className="text-xs text-muted">
                          {n.title}: depth {n.placement.mode === "depth" ? n.placement.depth : 0}
                        </p>
                      ))}
                  </>
                )}
                {order.indexOf(entry) === afterHistory && (
                  <>
                    <p className="border-y border-border py-1 text-xs font-medium text-accent">Tail starts</p>
                    {slot("Start of tail notes", (p) => p.mode === "section" && p.section === "tail_start")}
                  </>
                )}
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
                  <Button
                    variant="ghost"
                    className="w-full rounded-none"
                    aria-label={`Insert prompt after ${names.get(entry.identifier)}`}
                    onClick={() => add(order.indexOf(entry) + 1)}
                  >
                    ＋
                  </Button>
                </div>
              </>
            )}
          </SortableList>
          {!newestAfterTail && slot("End of tail notes", (p) => p.mode === "section" && p.section === "tail_end")}
        </div>
      </div>
    </div>
  )
}

/**
 * What would go wrong when sending with this preset (DESIGN §2.2): its prompts after the
 * history ending on an assistant prompt without a prefill (the app then adds a user turn), and
 * no prompt carrying a direction (the default direction prompt is then added). Each links to
 * the prompt it's about, or adds the missing one.
 */
export function PresetWarnings({ store }: { store: EditorStore }) {
  const prompts = useValue<ReadonlyArray<PresetPrompt>>(store, ["prompts"]) ?? []
  const savedOrder = useValue<ReadonlyArray<PromptOrderEntry>>(store, ["order"]) ?? []
  const prefill = useValue<string>(store, ["prefill", "assistant"]) ?? ""
  const order = presetOrder(prompts, savedOrder)
  const byId = new Map(prompts.map((p) => [p.identifier, p]))
  const history = order.findIndex((e) => e.identifier === "chatHistory")
  const sent = order.flatMap((e) => {
    const prompt = byId.get(e.identifier)
    return e.enabled && prompt && !prompt.marker && prompt.content.trim() !== "" ? [{ e, prompt }] : []
  })
  const last = sent
    .filter(({ e, prompt }) => order.indexOf(e) > history && prompt.injection_position === "relative")
    .findLast(({ prompt }) => prompt.role !== "system")
  const endsOnAssistant = history >= 0 && last?.prompt.role === "assistant" && prefill.trim() === ""
  const direction = sent.some(({ prompt }) => readsDirection(prompt.content))
  const jump = (identifier: string) =>
    document.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(identifier)}"]`)?.scrollIntoView({ block: "start" })
  const addDirection = () => {
    const { added_on_import: _added, ...prompt } = directionPrompt
    const identifier = byId.has(prompt.identifier) ? uuidv7() : prompt.identifier
    store.setValue(at(identifier), { ...prompt, identifier })
    writePresetOrder(store, [...order, { identifier, enabled: true }])
  }
  if (!endsOnAssistant && direction) return null
  return (
    <div className="flex flex-col gap-2" aria-label="Preset warnings" role="group">
      {endsOnAssistant && (
        <div role="alert" className="rounded-md border border-warning/40 px-3 py-2 text-sm">
          The prompts after the chat history end on an assistant prompt, “{last.prompt.name || last.prompt.identifier}”,
          and the preset doesn't prefill: a user turn asking for the next message will be added after it.{" "}
          <button
            type="button"
            className="text-accent underline-offset-4 hover:underline"
            onClick={() => jump(last.prompt.identifier)}
          >
            Go to the prompt
          </button>
        </div>
      )}
      {!direction && (
        <div role="alert" className="rounded-md border border-warning/40 px-3 py-2 text-sm">
          No prompt that&apos;s on sends the direction ({"{{direction}}"}): a direction you give will be sent with the
          default direction prompt at the end.{" "}
          {byId.get("direction") ? (
            <button
              type="button"
              className="text-accent underline-offset-4 hover:underline"
              onClick={() => jump("direction")}
            >
              Go to the direction prompt
            </button>
          ) : (
            <button type="button" className="text-accent underline-offset-4 hover:underline" onClick={addDirection}>
              Add the direction prompt
            </button>
          )}
        </div>
      )}
    </div>
  )
}
