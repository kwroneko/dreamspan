import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { usePlaceExpansion, usePlaceParam } from "../../usePlaceParam.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { tokenizerText } from "../editor/tokenCounts.ts"
// The request inspector (DESIGN §7.4): the context one reply was generated from, as it was
// sent. First the model, the samplers, what was left out and what the provider reported; then
// each message with its role, where its text came from, its tokens and the cache breakpoints
// between them. Text is shown as text. The page's pane is the only scroller (owner,
// 2026-11-20: "No more scroll inside scroll"): the messages are measured virtual rows of that
// pane, so dense contexts stay bounded, and collapsed messages render only their previews.
import type { ChatId, ForkId, VersionId } from "@dreamspan/shared/chat.ts"
import { scriptLabel } from "./rewrites.tsx"
import { BUILTIN_PRESET_LABEL } from "@dreamspan/shared/generation.ts"
import type {
  ContextMessage,
  ContextSource,
  DraftRequest,
  RunContext,
  InspectorUsage,
  SourceActivation
} from "@dreamspan/shared/inspectorApi.ts"
import { totalInputTokens } from "@dreamspan/shared/usage.ts"
import { Link, Navigate, useParams, useSearch } from "@tanstack/react-router"
import { CARD_LOREBOOK_FOCUS } from "../editor/cardSections.ts"
import { entryParam } from "../editor/lorebookTable.ts"
import { endOfRequestText } from "@dreamspan/shared/endOfRequest.ts"
import { type Reuse, ReuseLine, reuseByMessage } from "../editor/promptLines.tsx"
import {
  createContext,
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useCallback,
  useState
} from "react"
import { Loading } from "../../ui/Spinner.tsx"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { AsyncView } from "../../actions.tsx"
import { Button } from "../../ui/Button.tsx"
import { AppClient } from "../../rpc.ts"
import { Alert, Badge, Card, CardHeader, Disclosure } from "../../ui/Surface.tsx"
import { ImageEstimate, ImagesInTags, SentImagesScope } from "./imageTokens.tsx"
import { requestStatusText } from "./requestWords.ts"
import { useTitle } from "../shell.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { runInspectorSections, runInspectorTranscript } from "./presentation.tsx"
import { RequestTools, requestTokenText, toolsForRequest, toolTokens } from "./agent/RequestTools.tsx"

/** How much of a collapsed message shows. */
const PREVIEW = 200

const inputText = (request: InspectorUsage) => {
  const total = totalInputTokens(request.counts)
  return `${count(total)}${request.estimatedInput == null ? "" : ` (~${count(request.estimatedInput)})`}`
}
const count = (n: number | null) => (n === null ? "unknown" : n.toLocaleString())

const activationText = (activation: SourceActivation): string => {
  if (activation.kind === "note") {
    const on = activation.activation === "explicit" ? "Activated by this chat" : "On in every chat"
    // Older snapshots kept ST's interval; notes go every turn since (DESIGN §4.1).
    const when =
      activation.condition !== undefined
        ? activation.condition
        : activation.interval === null || activation.interval === 1
          ? "every turn"
          : activation.interval === 0
            ? "never due"
            : `every ${activation.interval} user messages; counted ${activation.userMessages}`
    return `${on}; ${when}; ${activation.due ? "due this turn" : "skipped this turn"}.`
  }
  if (activation.status === "skipped") return `Skipped at step ${activation.step}: ${activation.reason}`
  const why =
    activation.why.kind === "sticky"
      ? "Kept active by sticky timing"
      : activation.why.kind === "constant"
        ? "constant entry"
        : activation.why.kind === "pinned"
          ? "pinned above the history until its start moves"
          : activation.why.kind === "decision"
            ? `the decision model judged it relevant (${Math.round(activation.why.probability * 100)}%)`
            : `keyword “${activation.why.primaryKey}”${activation.why.secondaryKeys.length ? `; ${activation.why.logic ?? "and_any"}: ${activation.why.secondaryKeys.map((key) => `“${key}”`).join(", ")}` : ""}`
  const notes =
    activation.why.kind === "keys" && activation.why.notes?.length
      ? `; found in the note${activation.why.notes.length > 1 ? "s" : ""} ${activation.why.notes.map((note) => `“${note}”`).join(", ")}`
      : ""
  return `Activated at step ${activation.step}: ${why}${notes}.`
}

const roleLabel = { system: "System", developer: "Developer", user: "User", assistant: "Assistant", model: "Model" }

/** Sources this turn left out, shown under "Not sent" rather than with the text they're beside. */
const unsent = (source: ContextSource) =>
  (source.activation?.kind === "note" && !source.activation.due) ||
  (source.activation?.kind === "lorebook" && source.activation.status === "skipped")

/**
 * The fork the inspector was opened from (`?fork=`), as links back into the chat carry it: the
 * fork being viewed, which needn't be the one the reply was generated in. Empty: the current one.
 */
const ViewedFork = createContext<{ readonly fork?: ForkId }>({})

/** Where a source's link goes, landing on the item it is, and what its hover says. */
type SourceTarget =
  | { readonly to: "chat"; readonly chatId: ChatId; readonly search: Record<string, unknown>; readonly hint: string }
  | { readonly to: "library"; readonly ref: string; readonly search: Record<string, unknown>; readonly hint: string }

/**
 * A preset's text by its piece identifier: a prompt of its order by `?focus=` (its block opens,
 * scrolled to and flashed); an end-of-request text, a utility text or a prefill by its field
 * (`?at=`, the editor's landing).
 */
const presetTarget = (ref: string, identifier: string): SourceTarget => {
  const [group, rest] = identifier.split(/\.(.*)/s)
  const field =
    endOfRequestText(identifier) !== undefined
      ? ["prompts", `identifier=${identifier}`, "content"]
      : group === "utility" && rest
        ? ["utility_prompts", rest]
        : group === "prefill" && rest
          ? ["prefill", rest]
          : null
  return field
    ? { to: "library", ref, search: { at: field }, hint: "Opens this text in the preset editor." }
    : { to: "library", ref, search: { focus: identifier }, hint: "Opens this prompt in the preset editor." }
}

/** Whose page a source's link opens, at its item: every kind lands on the exact thing it names. */
const sourceTarget = (
  source: ContextSource,
  chatId: ChatId | null,
  viewed: { readonly fork?: ForkId }
): SourceTarget | null => {
  if (source.slotId)
    return chatId === null
      ? null
      : { to: "chat", chatId, search: { ...viewed, slot: source.slotId }, hint: "Opens this message in the chat." }
  if (source.kind === "summary" && source.summary)
    return chatId === null
      ? null
      : {
          to: "chat",
          chatId,
          search: { ...viewed, panel: "summaries", summary: source.summary.id },
          hint: "Opens this summary in the chat's Summaries tab."
        }
  if (!source.ref) return null
  const ref = source.ref
  // A note is the chat's or a card's, edited where the chat lists them.
  if (source.kind === "note")
    return chatId === null
      ? null
      : {
          to: "chat",
          chatId,
          search: { ...viewed, panel: "notes", note: ref },
          hint: "Opens this note in the chat's Notes tab."
        }
  // A plugin's kind keeps its plain library link, whatever item it carries.
  const item =
    source.kind === "preset" || source.kind === "lorebook" || source.kind === "card" ? source.item : undefined
  if (item?.kind === "prompt") return presetTarget(ref, item.identifier)
  if (item?.kind === "entry")
    // A card's own book opens on the card, the book alone (`focus`); a standalone one is its page.
    return item.embedded
      ? {
          to: "library",
          ref,
          search: { focus: CARD_LOREBOOK_FOCUS, [entryParam(ref, ["character_book"])]: String(item.uid) },
          hint: "Opens this entry in the card's lorebook."
        }
      : {
          to: "library",
          ref,
          search: { [entryParam(ref, [])]: String(item.uid) },
          hint: "Opens this entry in the lorebook editor."
        }
  if (item?.kind === "field")
    return { to: "library", ref, search: { at: [item.field] }, hint: "Opens this field in the card editor." }
  if (source.kind === "card") return { to: "library", ref, search: {}, hint: "Opens this card in the card editor." }
  // Older captures only named the book's ref; a standalone lorebook ignores the card's focus.
  const search = source.kind === "lorebook" && item === undefined ? { focus: CARD_LOREBOOK_FOCUS } : {}
  return { to: "library", ref, search, hint: "Opens this context source." }
}

/** A box whose text isn't its source's text verbatim: a transform changed it after assembly. */
const CHANGED = "(changed before sending)"
const CHANGED_HINT =
  "This text was changed after the prompt was assembled, for example by a regex script or prompt post-processing."

/** What the source is, where it's from: the inspector's own words, never prompt text. */
function SourceTitle({
  source,
  chatId,
  rewritten = false
}: {
  source: ContextSource
  chatId: ChatId | null
  rewritten?: boolean
}) {
  const viewed = useContext(ViewedFork)
  const label = (
    <>
      {source.label}
      {source.version !== undefined && `, swipe ${source.version}`}
    </>
  )
  const target = sourceTarget(source, chatId, viewed)
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="font-medium break-words text-text">
        {target === null ? (
          label
        ) : (
          <Tooltip label={target.hint}>
            {target.to === "chat" ? (
              <Link
                to="/chats/$chatId"
                params={{ chatId: target.chatId }}
                search={target.search}
                className="text-accent underline-offset-2 hover:underline"
              >
                {label}
              </Link>
            ) : (
              <Link
                to="/library/$refId"
                params={{ refId: target.ref }}
                search={target.search}
                className="text-accent underline-offset-2 hover:underline"
              >
                {label}
              </Link>
            )}
          </Tooltip>
        )}
        {rewritten && (
          <>
            {" "}
            <Tooltip label={CHANGED_HINT}>
              <span tabIndex={0} className="font-normal text-muted">
                {CHANGED}
              </span>
            </Tooltip>
          </>
        )}
      </span>
      {source.summary?.stale && <span className="text-warning">Stale when this reply was generated.</span>}
      {source.summary?.changed && <span className="text-warning">Summary stale or replaced since this reply.</span>}
      {source.activation && <span className="break-words text-muted">{activationText(source.activation)}</span>}
      <ScriptsNote source={source} />
    </span>
  )
}

/** The prompt regex scripts that changed the source's text in this request, in the order they ran. */
function ScriptsNote({ source }: { source: ContextSource }) {
  if (!source.scripts || source.scripts.length === 0) return null
  return <span className="break-words text-muted">Changed by regex: {source.scripts.map(scriptLabel).join(", ")}</span>
}

/** Prompt text exactly as sent: monospace, so it never reads as the inspector's own labels. */
function PromptText({ text }: { text: string }) {
  return (
    <ImagesInTags text={text}>
      {(piece) => (
        <p className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-text">{piece}</p>
      )}
    </ImagesInTags>
  )
}

/** A titled box: what its text is and where it came from, above the text or the parts it holds. */
function Box({
  sources,
  chatId,
  children,
  group = false,
  rewritten = false
}: {
  sources: ReadonlyArray<ContextSource>
  chatId: ChatId | null
  children: ReactNode
  group?: boolean
  /** Its text is where the sources' text was, changed after assembly. */
  rewritten?: boolean
}) {
  return (
    <section
      aria-label={
        sources.map((source) => (rewritten ? `${source.label} ${CHANGED}` : source.label)).join(", ") ||
        "No recorded source"
      }
      className="overflow-hidden rounded-md border border-border"
    >
      <header className="flex flex-col gap-1 border-b border-border bg-surface-raised px-2.5 py-1.5 font-sans text-xs">
        {sources.length === 0 ? (
          <span className="text-muted">No recorded source</span>
        ) : (
          sources.map((source) => <SourceTitle key={source.id} source={source} chatId={chatId} rewritten={rewritten} />)
        )}
      </header>
      <div className={group ? "flex flex-col gap-1.5 bg-surface p-2" : "bg-canvas px-2.5 py-2"}>{children}</div>
    </section>
  )
}

/**
 * Text that frames a block's parts (its wrappers, the joins between them) or joins the turn's
 * blocks: verbatim, quieter than the parts, with the inspector's note of whose it is beside it.
 * Line breaks at its edges are left to the layout; "Show as one text" has every character.
 */
function Frame({ text, owner, quiet }: { text: string; owner: string | null; quiet: boolean }) {
  const shown = text.replace(/^\n+|\n+$/g, "")
  if (shown.trim() === "") return null
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-2.5">
      <ImagesInTags text={shown}>
        {(piece) => (
          <p
            className={`font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap ${quiet ? "text-muted" : "text-text"}`}
          >
            {piece}
          </p>
        )}
      </ImagesInTags>
      {owner && <span className="font-sans text-[11px] text-muted italic">{owner}</span>}
    </div>
  )
}

type Span = { start: number; end: number; source: number }
type Node = Span & {
  frame: boolean
  rewritten: boolean
  also: ReadonlyArray<number>
  children: Array<Node> | null
}

/** The recorded parts nested in their groups by offsets: a group holds what lies inside it. */
const treeOf = (message: ContextMessage): Array<Node> => {
  const items: Array<Node> = [
    ...(message.groups ?? []).map((g) => ({
      ...g,
      frame: false,
      rewritten: g.rewritten === true,
      also: [],
      children: []
    })),
    ...(message.parts ?? []).map((p) => ({
      ...p,
      frame: p.frame === true,
      rewritten: p.rewritten === true,
      also: p.also ?? [],
      children: null
    }))
  ].toSorted((a, b) => a.start - b.start || b.end - a.end || (a.children ? 0 : 1) - (b.children ? 0 : 1))
  const roots: Array<Node> = []
  const open: Array<Node> = []
  for (const item of items) {
    while (open.length > 0 && item.end > open.at(-1)!.end) open.pop()
    ;(open.at(-1)?.children ?? roots).push(item)
    if (item.children) open.push(item)
  }
  return roots
}

/**
 * A turn's text cut at its recorded parts: each block in its titled box holding its parts, each
 * part in its own, and the text around them as framing. Text outside every box is the
 * assembler's joins.
 */
function Parts({ message, chatId }: { message: ContextMessage; chatId: ChatId | null }) {
  const sent = message.sources.filter((source) => !unsent(source))
  if (!message.parts?.length)
    return (
      <Box sources={sent} chatId={chatId}>
        {<PromptText text={message.content} />}
      </Box>
    )
  const sourceOf = (node: Span) => message.sources[node.source]
  const render = (nodes: ReadonlyArray<Node>, from: number, to: number, owner: ContextSource | null): ReactNode => {
    const out: Array<ReactNode> = []
    // The block's own text between its parts: an assembler's framing is quiet, a prompt's is its text.
    const quiet = owner === null || owner.kind === "assembler"
    let at = from
    const gap = (end: number) => {
      if (end > at)
        out.push(
          <Frame
            key={`gap-${at}`}
            text={message.content.slice(at, end)}
            owner={owner ? null : "Added by the assembler"}
            quiet={quiet}
          />
        )
    }
    for (const node of nodes) {
      gap(node.start)
      const source = sourceOf(node)
      const text = message.content.slice(node.start, node.end)
      out.push(
        node.children ? (
          <Box
            key={`group-${node.start}-${node.end}`}
            sources={source ? [source] : []}
            chatId={chatId}
            group
            rewritten={node.rewritten}
          >
            {render(node.children, node.start, node.end, source ?? null)}
          </Box>
        ) : node.frame ? (
          <Frame key={`frame-${node.start}`} text={text} owner={source?.label ?? null} quiet />
        ) : (
          <Box
            key={`part-${node.start}`}
            sources={[node.source, ...node.also].flatMap((i) => message.sources[i] ?? [])}
            chatId={chatId}
            rewritten={node.rewritten}
          >
            <PromptText text={text} />
          </Box>
        )
      )
      at = node.end
    }
    gap(to)
    return out
  }
  // Sources with no box of their own, such as a join that's only whitespace.
  const boxed = new Set(
    [
      ...(message.groups ?? []).map((g) => g.source),
      ...message.parts.flatMap((p) => [p.source, ...(p.also ?? [])])
    ].map((i) => message.sources[i]?.id)
  )
  const around = sent.filter((source) => !boxed.has(source.id))
  return (
    <>
      {around.length > 0 && (
        <p className="font-sans text-xs break-words text-muted">
          Also from: {around.map((source) => source.label).join("; ")}
        </p>
      )}
      {render(treeOf(message), 0, message.content.length, null)}
    </>
  )
}

/** Whether a turn's text is cut into more than one box, so seeing it whole is worth a toggle. */
const cut = (message: ContextMessage) => {
  const parts = message.parts ?? []
  if (parts.length > 1 || message.groups?.length) return true
  const [only] = parts
  return only !== undefined && message.content.slice(0, only.start) + message.content.slice(only.end) !== ""
}

function Message({
  message,
  index,
  chatId,
  open,
  setOpen,
  reuse
}: {
  message: ContextMessage
  index: number
  chatId: ChatId | null
  open: boolean
  setOpen: (open: boolean) => void
  /** The reuse line after it, and whether it's the only one. */
  reuse: { kind: Reuse; alone: boolean } | undefined
}) {
  const [rawMode, changeRaw] = usePlaceParam(`requestText:${index}`, "parts", ["parts", "raw"])
  const raw = rawMode === "raw"
  const setRaw = (next: boolean) => changeRaw(next ? "raw" : "parts", true)
  const preview = message.content.length > PREVIEW ? `${message.content.slice(0, PREVIEW)}…` : message.content
  const sources = message.sources.filter((source) => !unsent(source))
  return (
    <div className="flex flex-col gap-2">
      <details
        open={open}
        className="overflow-hidden rounded-lg border-2 border-border bg-surface"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <Tooltip label="Shows the messages in this context turn.">
          <summary className="flex cursor-pointer flex-col gap-1.5 px-3 py-2 font-sans">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="text-muted tabular-nums">#{index + 1}</span>
              <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs font-semibold tracking-wide uppercase">
                {roleLabel[message.role]}
              </span>
              {message.name && <span className="text-muted">({message.name})</span>}
              {message.prefill && (
                <Badge>
                  {message.prefill.protocol === "deepseek_prefix"
                    ? "DeepSeek prefix: true"
                    : "Forced tool schema prefill"}
                </Badge>
              )}
              <span className="text-muted tabular-nums">~{counted(message.tokens, "token")}</span>
            </span>
            {message.images && (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {message.images.map((image, i) => (
                  <ImageEstimate key={i} image={image} index={i} />
                ))}
              </span>
            )}
            {!open && (
              <>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {sources.map((source) => (
                    <span key={source.id} className="flex flex-col gap-0.5">
                      <span className="break-words text-muted">
                        {source.label}
                        {source.version !== undefined && `, swipe ${source.version}`}
                      </span>
                      {source.activation && (
                        <span className="break-words text-muted">{activationText(source.activation)}</span>
                      )}
                      <ScriptsNote source={source} />
                    </span>
                  ))}
                </span>
                <span className="line-clamp-2 font-mono text-[13px] break-words text-muted">{preview}</span>
              </>
            )}
          </summary>
        </Tooltip>
        {message.prefill?.schema && (
          <pre className="overflow-x-auto border-t border-border px-3 py-2 text-xs" aria-label="Prefill schema">
            {message.prefill.schema}
          </pre>
        )}
        {open && (
          <div className="flex flex-col gap-2 border-t border-border px-3 py-2.5">
            <SentImagesScope message={message} raw={raw}>
              {raw ? (
                <div className="rounded-md border border-border bg-canvas px-2.5 py-2">
                  <PromptText text={message.content} />
                </div>
              ) : (
                <Parts message={message} chatId={chatId} />
              )}
            </SentImagesScope>
            {cut(message) && (
              <Button
                variant="ghost"
                className="h-7 self-start px-2 text-xs"
                hint={
                  raw
                    ? "Splits the message into the parts it was built from, each with its source."
                    : "The message's whole text, exactly as it was sent."
                }
                onClick={() => setRaw(!raw)}
              >
                {raw ? "Show by source" : "Show as one text"}
              </Button>
            )}
          </div>
        )}
      </details>
      {reuse && <ReuseLine kind={reuse.kind} alone={reuse.alone} />}
    </div>
  )
}

/** What this turn left out by its condition, or skipped: the inspector's list, no prompt text. */
function NotSent({ run }: { run: Pick<RunContext, "notSent" | "messages"> & { chatId: ChatId | null } }) {
  const listed =
    run.notSent ??
    run.messages
      .flatMap((message) => message.sources)
      .filter(unsent)
      .filter((source, i, all) => all.findIndex((s) => s.id === source.id) === i)
  if (listed.length === 0) return null
  return (
    <section aria-label="Not sent" className="flex flex-col gap-2">
      <h2 className="text-base font-semibold">Not sent this turn</h2>
      <ul className="flex flex-col gap-2">
        {listed.map((source) => (
          <li
            key={source.id}
            className="flex items-start gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-xs"
          >
            <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-semibold tracking-wide text-muted uppercase">
              Not sent
            </span>
            <SourceTitle source={source} chatId={run.chatId} />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** "1 message", "2,416 tokens". */
const counted = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
/** A request's times from the ledger: how long it took, its first token and its speed. */
const timings = (request: InspectorUsage) => {
  const { startedAt, firstTokenAt, endedAt } = request
  const output = request.counts.output
  return {
    time: endedAt !== null ? seconds(endedAt - startedAt) : request.status === "running" ? "running" : "unknown",
    firstToken: firstTokenAt !== null ? seconds(firstTokenAt - startedAt) : "unknown",
    speed:
      output !== null && firstTokenAt !== null && endedAt !== null && endedAt > firstTokenAt
        ? `${(output / ((endedAt - firstTokenAt) / 1000)).toFixed(1)}/s`
        : "unknown"
  }
}

/**
 * Each attempt's usage, by its own width, not the window's (a workbench frame can be narrow on
 * a wide screen): a table where its nine columns fit (about 680 px with a retried attempt),
 * else label and value pairs, four to a row where they fit and two on the narrowest frames.
 */
function Usage({ requests }: { requests: ReadonlyArray<InspectorUsage> }) {
  if (requests.length === 0) return <p className="text-sm text-muted">No request was sent.</p>
  return (
    <div className="@container">
      <div className="flex flex-col gap-3 @min-[44rem]:hidden" aria-label="Usage by attempt">
        {requests.map((request, i) => (
          <dl
            key={request.id}
            className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border py-2 text-sm tabular-nums @min-[28rem]:grid-cols-4"
          >
            {[
              [
                "Attempt",
                `${i + 1}: ${requestStatusText(request.status)}${request.usageSource === "estimated" ? " (estimated)" : ""}`
              ],
              ["Input", inputText(request)],
              ["Cache read", count(request.counts.cacheRead)],
              ["Cache write", count(request.counts.cacheWrite)],
              ["Output", count(request.counts.output)],
              ["Cost", request.cost ? `${request.cost.amount.toFixed(4)} ${request.cost.currency}` : "unknown"],
              ["Time", timings(request).time],
              ["First token", timings(request).firstToken],
              ["Tokens/s", timings(request).speed]
            ].map(([label, value]) => (
              <div key={label} className={label === "Attempt" ? "col-span-full" : ""}>
                <dt className="text-muted">{label}</dt>
                <dd className="whitespace-nowrap">{value}</dd>
              </div>
            ))}
          </dl>
        ))}
      </div>
      <table className="w-full text-left text-sm tabular-nums hidden @min-[44rem]:table [&_td]:whitespace-nowrap">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Attempt</th>
            <th className="py-1 pr-3 font-medium">
              <Tooltip label="Total input, including cached tokens. The local estimate before sending is in parentheses.">
                <span>Input</span>
              </Tooltip>
            </th>
            <th className="py-1 pr-3 font-medium">Cache read</th>
            <th className="py-1 pr-3 font-medium">Cache write</th>
            <th className="py-1 pr-3 font-medium">Output</th>
            <th className="py-1 pr-3 font-medium">Cost</th>
            <th className="py-1 pr-3 font-medium">Time</th>
            <th className="py-1 pr-3 font-medium">First token</th>
            <th className="py-1 font-medium">Tokens/s</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request, i) => (
            <tr key={request.id} className="border-t border-border">
              <td className="py-1 pr-3">
                {i + 1}: {requestStatusText(request.status)}
                {request.usageSource === "estimated" && " (estimated)"}
              </td>
              <td className="py-1 pr-3">{inputText(request)}</td>
              <td className="py-1 pr-3">{count(request.counts.cacheRead)}</td>
              <td className="py-1 pr-3">{count(request.counts.cacheWrite)}</td>
              <td className="py-1 pr-3">{count(request.counts.output)}</td>
              <td className="py-1 pr-3">
                {request.cost ? `${request.cost.amount.toFixed(4)} ${request.cost.currency}` : "unknown"}
              </td>
              <td className="py-1 pr-3">{timings(request).time}</td>
              <td className="py-1 pr-3">{timings(request).firstToken}</td>
              <td className="py-1">{timings(request).speed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A context this small opens with every turn's text showing. */
const OPEN_ALL = { messages: 60, characters: 120_000 }

/** The nearest ancestor that scrolls: the page's pane, a workbench frame's, or a dialog's body. */
const scrollPaneOf = (element: HTMLElement): HTMLElement => {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === "auto" || overflowY === "scroll") return parent
  }
  return document.documentElement
}

/**
 * The pane the list scrolls with, and where the list starts in it: the rows are virtual rows of
 * the pane itself, never of a scroller of their own inside it.
 */
function useScrollPane() {
  const [list, setList] = useState<{ element: HTMLElement; pane: HTMLElement } | null>(null)
  const [margin, setMargin] = useState(0)
  const ref = useCallback((element: HTMLElement | null) => {
    setList(element ? { element, pane: scrollPaneOf(element) } : null)
  }, [])
  useLayoutEffect(() => {
    if (!list) return
    const { element, pane } = list
    // What's above the list (the request's facts, a section that loads) moves where it starts.
    // The observer reports each element once on observing it, before the first paint.
    const observer = new ResizeObserver(() =>
      setMargin(element.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop)
    )
    observer.observe(element)
    for (const child of pane.children) observer.observe(child)
    return () => observer.disconnect()
  }, [list])
  return { ref, pane: list?.pane ?? null, margin }
}

function Messages({ run }: { run: Pick<RunContext, "messages"> & { chatId: ChatId | null } }) {
  "use no memo"
  const { ref: listRef, pane, margin } = useScrollPane()
  const all = () => new Set(run.messages.keys())
  const defaultAll =
    run.messages.length <= OPEN_ALL.messages &&
    run.messages.reduce((sum, m) => sum + m.content.length, 0) <= OPEN_ALL.characters
  const [opened, setOpened] = usePlaceExpansion("turns", defaultAll)
  const expanded: ReadonlySet<number> = new Set(
    [...run.messages.keys()].filter((i) => opened.all !== opened.except.has(String(i)))
  )
  const setExpanded = (change: ReadonlySet<number> | ((previous: ReadonlySet<number>) => ReadonlySet<number>)) => {
    const next = typeof change === "function" ? change(expanded) : change
    if (next.size === expanded.size && [...next].every((i) => expanded.has(i))) return
    const allOpen = next.size === run.messages.length
    const allClosed = next.size === 0
    setOpened(
      allOpen || allClosed
        ? { all: allOpen, except: new Set() }
        : {
            all: opened.all,
            except: new Set([...run.messages.keys()].filter((i) => opened.all !== next.has(i)).map(String))
          }
    )
  }
  const [focused, setFocused] = useState<number | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- mutable instance; memoization is disabled above
  const virtualizer = useVirtualizer({
    count: run.messages.length,
    getScrollElement: () => pane,
    estimateSize: () => 120,
    overscan: 4,
    scrollMargin: margin,
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range)
      return focused === null || visible.includes(focused) ? visible : [...visible, focused].sort((a, b) => a - b)
    },
    gap: 12
  })
  const everyOpen = expanded.size === run.messages.length
  const reuse = reuseByMessage(run.messages.map((m) => m.breakpoint ?? undefined))
  const reuseAlone = ![...reuse.values()].includes("every")
  return (
    <>
      <Button
        hint={everyOpen ? "Click to collapse every context turn." : "Click to expand every context turn."}
        className="self-start"
        onClick={() => setExpanded(everyOpen ? new Set() : all())}
      >
        {everyOpen ? "Collapse every turn" : "Expand every turn"}
      </Button>
      <div ref={listRef} role="list" className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            role="listitem"
            aria-posinset={item.index + 1}
            aria-setsize={run.messages.length}
            onFocusCapture={() => setFocused(item.index)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
            }}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${item.start - margin}px)` }}
          >
            <Message
              message={run.messages[item.index]!}
              index={item.index}
              chatId={run.chatId}
              reuse={reuse.has(item.index) ? { kind: reuse.get(item.index)!, alone: reuseAlone } : undefined}
              open={expanded.has(item.index)}
              setOpen={(open) =>
                setExpanded((previous) => {
                  if (previous.has(item.index) === open) return previous
                  const next = new Set(previous)
                  if (open) next.add(item.index)
                  else next.delete(item.index)
                  return next
                })
              }
            />
          </div>
        ))}
      </div>
    </>
  )
}

function Inspector({ run }: { run: RunContext }) {
  const tools = toolsForRequest(run.toolDeclarations) ?? []
  const messages = run.messageTokens ?? run.messages.reduce((sum, m) => sum + m.tokens, 0)
  const several = Object.keys(run.toolDeclarations?.attempts ?? {}).length > 1
  const breakpointsSent = run.model?.breakpoints === "explicit"
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={several ? "Latest request" : "Request"}
          about="The latest captured request. The estimated input includes cached messages and the tool definitions available to the model."
          description={
            <>
              {run.capture === "captured" && (
                <span className="block tabular-nums text-text">{requestTokenText(messages, toolTokens(tools))}</span>
              )}
              Built {new Date(run.builtAt).toLocaleString()}. {run.tokenizer && tokenizerText(run.tokenizer)}
            </>
          }
        />
        {run.continuity && (
          <p className="text-sm text-muted">
            {run.continuity.parentVersionId ? (
              <Link
                to="/chats/$chatId/context/$versionId"
                params={{ chatId: run.chatId, versionId: run.continuity.parentVersionId }}
                className="underline underline-offset-2"
                title="Open the previous turn’s run"
              >
                Carried on from the previous turn’s run
              </Link>
            ) : (
              run.continuity.reason
            )}
            {run.continuity.elided
              ? ` Older tool results were left out to make room (${counted(run.continuity.elided, "result")}); the assistant can read them again.`
              : ""}
          </p>
        )}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [&_dd]:break-words">
          <dt className="text-muted">Model</dt>
          <dd>{run.model ? `${run.model.model} on ${run.model.connection} (${run.model.kind})` : "none"}</dd>
          <dt className="text-muted">Preset</dt>
          <dd>
            {run.preset.label ?? BUILTIN_PRESET_LABEL} ({run.preset.scope})
          </dd>
          {run.speakerPick && (
            <>
              <dt className="text-muted">Speaker</dt>
              <dd>
                The decision model picked {run.speakerPick.name} ({Math.round(run.speakerPick.confidence * 100)}%)
              </dd>
            </>
          )}
          {run.decisionsOff?.map((point) => (
            <Fragment key={point.id}>
              <dt className="text-muted">{point.label}</dt>
              <dd data-decision-off={point.id}>
                Off in this chat, so the decision model wasn't asked. {point.instead}
              </dd>
            </Fragment>
          ))}
          <dt className="text-muted">Generation</dt>
          <dd>
            {run.type}, {run.mode === "st" ? "the earlier fixed layout" : "the preset's layout"}; {run.status}
          </dd>
          <dt className="text-muted">Breakpoints</dt>
          <dd>
            {breakpointsSent
              ? "sent to the provider"
              : "marked here, not sent: the model's breakpoints aren't explicit"}
          </dd>
          <dt className="text-muted">Samplers</dt>
          <dd className="break-words">
            {Object.entries(run.samplers)
              .map(([name, value]) => `${name} ${value}`)
              .join(", ")}
          </dd>
        </dl>
      </Card>
      {run.issues.length > 0 && (
        <Alert tone="warning" title="Notes on this context">
          <ul className="list-disc pl-5">
            {run.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <SlotOutlet slot={runInspectorSections} props={{ run }} />
      <NotSent run={run} />
      {tools.length > 0 ? (
        <section aria-label="Usage" className="rounded-md border border-border bg-surface px-2.5 py-1.5">
          <Disclosure
            title={<h2 className="font-semibold text-text">Usage</h2>}
            hint="Show or hide the provider’s usage for each attempt, including timing and cost."
            className="[&>div]:pl-0"
            lazy
          >
            <Usage requests={run.requests} />
          </Disclosure>
        </section>
      ) : (
        <Card>
          <CardHeader
            title="Usage"
            about="The provider’s usage for each attempt. First token is the time from sending to the first text or reasoning."
          />
          <Usage requests={run.requests} />
        </Card>
      )}
      <RequestTools key={run.versionId} tools={tools} />
      <section aria-label="Messages" className="flex flex-col gap-2">
        <Tooltip label="The message blocks of this request in provider order.">
          <h2 className="w-fit text-base font-semibold">Messages</h2>
        </Tooltip>
        {run.capture === "unavailable" ? (
          <p className="text-sm text-muted">Not sent, or the exact request wasn't kept.</p>
        ) : (
          <Messages key={run.versionId} run={run} />
        )}
      </section>
      <SlotOutlet slot={runInspectorTranscript} props={{ run }} />
    </div>
  )
}

/**
 * A preview of the first or next request, built without sending it. Only a saved chat has
 * destinations for links to messages, summaries and notes.
 */
export function DraftRequestView({
  request,
  chatId = null,
  forkId = null
}: {
  request: DraftRequest
  chatId?: ChatId | null
  forkId?: ForkId | null
}) {
  const tokens = request.messages.reduce((sum, m) => sum + m.tokens, 0)
  const run = { ...request, chatId }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Request"
          about="A preview of the assembled messages, with a local token estimate."
          description={`Built now: ${counted(request.messages.length, "message")}, about ${counted(tokens, "token")}. ${request.tokenizer ? tokenizerText(request.tokenizer) : ""}`}
        />
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm [&_dd]:break-words">
          <dt className="text-muted">Model</dt>
          <dd>
            {request.model ? `${request.model.model} on ${request.model.connection} (${request.model.kind})` : "none"}
          </dd>
          <dt className="text-muted">Preset</dt>
          <dd>
            {request.preset.label ?? BUILTIN_PRESET_LABEL} ({request.preset.scope})
          </dd>
          <dt className="text-muted">Generation</dt>
          <dd>
            {request.type}, {request.mode === "st" ? "the earlier fixed layout" : "the preset's layout"}
          </dd>
          <dt className="text-muted">Samplers</dt>
          <dd className="break-words">
            {Object.entries(request.samplers)
              .map(([name, value]) => `${name} ${value}`)
              .join(", ")}
          </dd>
        </dl>
      </Card>
      {request.issues.length > 0 && (
        <Alert tone="warning" title="Notes on this context">
          <ul className="list-disc pl-5">
            {request.issues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <ViewedFork.Provider value={forkId === null ? {} : { fork: forkId }}>
        <NotSent run={run} />
        <section aria-label="Messages" className="flex flex-col gap-2">
          <Tooltip label="The message blocks of this request in provider order.">
            <h2 className="w-fit text-base font-semibold">Messages</h2>
          </Tooltip>
          <Messages run={run} />
        </section>
      </ViewedFork.Provider>
    </div>
  )
}

/** /chats/$chatId/context/$versionId */
const SubagentRunView = lazy(() =>
  import("./agent/SubagentRunView.tsx").then((module) => ({ default: module.SubagentRunView }))
)

export function ContextPage() {
  const { chatId, versionId } = useParams({ strict: false }) as { chatId: ChatId; versionId: VersionId }
  const search = useSearch({ strict: false }) as { fork?: unknown; subagent?: unknown }
  // A subagent's own run, opened from its row's Inspect (spec/SUBAGENTS.md §7).
  if (typeof search.subagent === "string" && search.subagent !== "")
    return (
      <Suspense fallback={<Loading label="Loading the subagent…" />}>
        <SubagentRunView chatId={chatId} versionId={versionId} rolloutId={search.subagent} usage={Usage} />
      </Suspense>
    )
  return <ReplyContext chatId={chatId} versionId={versionId} search={search} />
}

function ReplyContext({
  chatId,
  versionId,
  search
}: {
  chatId: ChatId
  versionId: VersionId
  search: { fork?: unknown }
}) {
  const viewed = useMemo(
    () => (typeof search.fork === "string" && search.fork !== "" ? { fork: search.fork as ForkId } : {}),
    [search.fork]
  )
  useTitle("Request")
  const atom = useMemo(() => AppClient.query("GetRunContext", { versionId }), [versionId])
  return (
    <div data-request-inspector className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <CenterHeaderContent>
          <h1 className="text-lg font-semibold">The request a reply was generated from</h1>
        </CenterHeaderContent>
      </header>
      <AsyncView atom={atom} loading="Loading the context…">
        {(run) =>
          run.chatId !== chatId ? (
            <Navigate to="/chats/$chatId/context/$versionId" params={{ chatId: run.chatId, versionId }} replace />
          ) : (
            <ViewedFork.Provider value={viewed}>
              <Tooltip label="Returns to the reply.">
                <Link
                  to="/chats/$chatId"
                  params={{ chatId: run.chatId }}
                  search={{ ...viewed, slot: run.slotId }}
                  className="text-sm text-muted hover:text-text"
                >
                  ← Back to the reply
                </Link>
              </Tooltip>
              <Inspector run={run} />
            </ViewedFork.Provider>
          )
        }
      </AsyncView>
    </div>
  )
}
