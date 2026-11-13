// The read tools over the chat's own history (spec/AGENTIC.md §4.5): search it, read a passage,
// open a summary, search the summaries. All causal: the path read ends at the message before
// the one being generated, in the generation's fork, with each message as that fork shows it.
// A join is read row by row, as the messages and summaries it brought (spec/THREADS.md §11).
import { Type } from "@earendil-works/pi-ai"
import type { EntityId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import { STRETCH_VIEW } from "@rp/shared/knowledge.ts"
import type { LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import { viewedJoin } from "../../assembler/mergeKnowledge.ts"
import type { MergeRow } from "../../assembler/types.ts"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"

/** One message as the tools show it: its number on the path (from 1), who wrote it, its text. */
interface PathMessage {
  readonly n: number
  readonly speaker: string
  readonly content: string
  /**
   * A row of the join at `n` (spec/THREADS.md §11): the joined thread's or chat's title and the
   * row's number there (from 1; null where not recorded), a summary's range.
   */
  readonly joined?: {
    readonly title: string
    readonly from: number | null
    readonly to: number | null
    readonly summary: boolean
  }
}

/** A joined summary (a join's frozen summary row) with the messages it condenses, as the viewer knew them. */
interface JoinedSummary {
  readonly at: number
  readonly title: string
  readonly from: number
  readonly to: number
  readonly content: string
  readonly messages: ReadonlyArray<PathMessage>
}

type JoinRead = Effect.Success<ReturnType<ToolContext["reader"]["JoinRows"]>>[number]

/**
 * Whose knowledge the tools read by (`ToolContext.viewers`): a separate context's character, or
 * read whole with a character speaking (`stretch`), its presence in a separate join's parallel
 * stretch only, and only where such a join is on the path read (as assembly's `withoutUnknown`).
 */
interface View {
  readonly identities: ReadonlyArray<string>
  readonly stretch: boolean
}

const WINDOW = 500

/** A value worked out once per rollout: the path and the summaries don't change while it runs. */
const cached = <A, E>(context: ToolContext, key: string, make: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() =>
    context.cache.has(key)
      ? Effect.succeed(context.cache.get(key) as A)
      : make.pipe(Effect.tap((value) => Effect.sync(() => context.cache.set(key, value))))
  )

/** The path as the view reads it: what it knew, and the numbers it missed. */
interface PathRead {
  readonly messages: ReadonlyArray<PathMessage>
  /** Numbers of messages on the path the viewer wasn't present for (hidden ones too); a join it knew only part of. */
  readonly missed: ReadonlySet<number>
  /** The view applied; null: everything read. */
  readonly view: View | null
  /** The joins' summaries it knew. */
  readonly joined: ReadonlyArray<JoinedSummary>
}

/** Versions asked about per `KnowersOf` read, to keep each query's parameters few. */
const KNOWERS_BATCH = 500

/** Slots asked about per `JoinRows` read. */
const JOINS_BATCH = 2000

const numberOf = (entry: PathEntry) => (entry.position ?? entry.depth) + 1

/**
 * Of `entries`, the numbers of those the view didn't know (`KnowersOf`, the rule assembly's
 * `knowledge` stage applies, spec/CHARACTER-CONTEXT.md §9.2 C5), and of those `away`: counted
 * not there in this fork (threads started earlier), a join whole. A join known in part is
 * missed, its rows read by `joinRows`. A stretch view counts only a separate join's parallel
 * stretch (`stretched`, `thread_stretch_slots`) and a separate join itself.
 */
const missedBy = (
  context: ToolContext,
  entries: ReadonlyArray<PathEntry>,
  view: View,
  joins: ReadonlyMap<string, JoinRead>
) =>
  Effect.gen(function* () {
    const missed = new Set<number>()
    const away = new Set<number>()
    const byVersion = new Map(entries.map((e) => [e.version.id as string, e]))
    const ids = [...byVersion.keys()]
    for (let at = 0; at < ids.length; at += KNOWERS_BATCH) {
      const known = yield* context.reader.KnowersOf({
        userId: context.userId,
        chatId: context.chatId,
        forkId: context.forkId,
        versionIds: ids.slice(at, at + KNOWERS_BATCH),
        viewers: context.viewers
      })
      for (const { versionId, knowers, away: gone, stretched } of known) {
        const entry = byVersion.get(versionId)!
        const join = joins.get(entry.slotId)
        if (view.stretch && !(join ? join.timelines === "separate" : stretched === true)) continue
        const n = numberOf(entry)
        if (
          gone !== undefined &&
          view.identities.some((id) => gone.includes(id)) &&
          !view.identities.includes(entry.version.speakerEntityId ?? "")
        ) {
          missed.add(n)
          away.add(n)
          continue
        }
        if (knowers !== null && !view.identities.some((id) => knowers.includes(id))) missed.add(n)
      }
    }
    return { missed, away }
  })

/** The joins among the path's messages (`JoinRows`), by slot. */
const joinsOn = (context: ToolContext, entries: ReadonlyArray<PathEntry>) =>
  Effect.gen(function* () {
    const joins = new Map<string, JoinRead>()
    const ids = entries.map((e) => e.slotId as string)
    for (let at = 0; at < ids.length; at += JOINS_BATCH)
      for (const join of yield* context.reader.JoinRows({
        userId: context.userId,
        chatId: context.chatId,
        slotIds: ids.slice(at, at + JOINS_BATCH)
      }))
        joins.set(join.slotId, join)
    return joins
  })

/**
 * A join's rows as messages, as the view reads it (`viewedJoin`, the projection assembly's
 * `knowledge` stage makes): the rows the viewer knew, or all of them, with the join's edits
 * that stay inside a row; none when it knew none. And its summaries, each with the messages it
 * condenses that the viewer knew.
 */
const joinRows = (
  n: number,
  content: string,
  join: JoinRead,
  knows: (knowers: ReadonlyArray<string>) => boolean
): { readonly messages: ReadonlyArray<PathMessage>; readonly summaries: ReadonlyArray<JoinedSummary> } => {
  const sent: Array<MergeRow> = join.rows.flatMap((row) =>
    row.included === "summarized"
      ? []
      : [
          {
            ordinal: row.ordinal,
            kind: row.kind,
            name: row.name,
            side: row.side,
            speaker: row.speaker,
            content: row.included === "verbatim" ? row.content : "",
            included: row.included,
            knowers: row.knowers
          }
        ]
  )
  const seen = viewedJoin(content, join.title, sent, knows)
  if (seen.rows.length === 0 && seen.partial) return { messages: [], summaries: [] }
  const at = new Map(join.rows.map((row) => [row.ordinal, row]))
  const number = (position: number | null | undefined) => (position == null ? null : position + 1)
  const messages = seen.rows.flatMap((row): Array<PathMessage> => {
    if (row.included !== "verbatim") return []
    const stored = at.get(row.ordinal)!
    return [
      {
        n,
        speaker: row.name,
        content: row.content,
        joined: {
          title: join.title,
          from: number(stored.from),
          to: number(stored.to),
          summary: row.kind === "summary"
        }
      }
    ]
  })
  const summaries = messages.flatMap((m): Array<JoinedSummary> => {
    if (!m.joined?.summary || m.joined.from === null || m.joined.to === null) return []
    const { from, to } = m.joined
    const condensed = join.rows.flatMap((row): Array<PathMessage> => {
      const position = number(row.from)
      return row.kind === "message" &&
        row.included === "summarized" &&
        position !== null &&
        position >= from &&
        position <= to &&
        knows(row.knowers)
        ? [
            {
              n,
              speaker: row.name,
              content: row.content,
              joined: { title: join.title, from: position, to: position, summary: false }
            }
          ]
        : []
    })
    return [{ at: n, title: join.title, from, to, content: m.content, messages: condensed }]
  })
  return { messages, summaries }
}

/**
 * The messages before the one being generated, oldest first; hidden ones left out, and, for a
 * separate context's viewer, those it wasn't present for (their numbers kept, so a passage
 * reads with a gap where they were).
 */
const pathMessages = (context: ToolContext) => Effect.map(pathRead(context), (read) => read.messages)

const pathRead = (context: ToolContext) =>
  cached(
    context,
    "path",
    Effect.gen(function* () {
      if (context.leafSlotId === null)
        return { messages: [], missed: new Set<number>(), view: null, joined: [] } as PathRead
      const entries: Array<PathEntry> = []
      let older: SlotId | null = null
      let first = true
      while (first || older !== null) {
        const window: { readonly entries: ReadonlyArray<PathEntry>; readonly older: SlotId | null } =
          yield* context.reader.ReadPath({
            userId: context.userId,
            chatId: context.chatId,
            forkId: context.forkId,
            leafSlotId: context.leafSlotId,
            range: first ? { _tag: "Bottom" } : { _tag: "Older", from: older! },
            limit: WINDOW
          })
        entries.unshift(...window.entries)
        older = window.older
        first = false
      }
      const name = yield* namer(
        context,
        entries.flatMap((e) => (e.version.speakerEntityId ? [e.version.speakerEntityId] : []))
      )
      const joins = yield* joinsOn(context, entries)
      const viewers = context.viewers
      const identities = viewers?.filter((id) => id !== STRETCH_VIEW) ?? []
      const stretch = viewers?.includes(STRETCH_VIEW) ?? false
      // A stretch view only where a separate join is on the path read.
      const view: View | null =
        viewers === null ||
        identities.length === 0 ||
        (stretch && ![...joins.values()].some((j) => j.timelines === "separate"))
          ? null
          : { identities, stretch }
      const { missed, away } =
        view === null
          ? { missed: new Set<number>(), away: new Set<number>() }
          : yield* missedBy(context, entries, view, joins)
      const joined: Array<JoinedSummary> = []
      const messages = entries.flatMap((entry): Array<PathMessage> => {
        const { version } = entry
        const n = numberOf(entry)
        if (
          entry.contextExcluded ||
          version.status === "generating" ||
          version.status === "failed" ||
          !version.content.trim()
        )
          return []
        const join = joins.get(entry.slotId)
        if (join === undefined) return missed.has(n) ? [] : [name({ ...version, n })]
        if (away.has(n)) return []
        const applies = view !== null && (!view.stretch || join.timelines === "separate")
        const read = joinRows(
          n,
          version.content,
          join,
          applies ? (knowers) => view.identities.some((id) => knowers.includes(id)) : () => true
        )
        joined.push(...read.summaries)
        return [...read.messages]
      })
      return { messages, missed, view, joined } satisfies PathRead
    })
  )

/**
 * Names the messages' speakers as the model knows them: a card's name, the persona the user
 * plays there for the user's own messages without one. A template message (a greeting) is
 * shown as the model read it, its names filled in [P: only these two].
 */
const namer = (context: ToolContext, speakerIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { playedByMe } = foldState(
      yield* context.reader.StateEventsAt({
        userId: context.userId,
        chatId: context.chatId,
        slotId: context.leafSlotId,
        forkId: context.forkId
      })
    )
    const persona = playedByMe.at(-1) ?? null
    const speakers = [...new Set([...speakerIds, ...(persona ? [persona] : [])])]
    const cards = speakers.length
      ? yield* context.reader.CastCards({ userId: context.userId, entityIds: speakers as Array<EntityId> })
      : []
    const names = new Map(cards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
    const user = (persona && names.get(persona)) ?? "User"
    return (message: {
      readonly n: number
      readonly speakerEntityId: string | null
      readonly writer: string
      readonly macroMode: string
      readonly content: string
    }): PathMessage => {
      const speaker = names.get(message.speakerEntityId ?? "") ?? (message.writer === "human" ? user : "Narrator")
      const content =
        message.macroMode === "template"
          ? message.content.replace(/\{\{char\}\}/gi, speaker).replace(/\{\{user\}\}/gi, user)
          : message.content
      return { n: message.n, speaker, content }
    }
  })

/**
 * The messages before the one being generated that full-text search finds for `words`, newest
 * first (reader `SearchChat`); null where the fork places inserted messages, so the path is read.
 */
const searched = (context: ToolContext, words: ReadonlyArray<string>, before: number | undefined) =>
  Effect.gen(function* () {
    if (context.leafSlotId === null) return [] as ReadonlyArray<PathMessage>
    const rows = yield* context.reader.SearchChat({
      userId: context.userId,
      chatId: context.chatId,
      forkId: context.forkId,
      leafSlotId: context.leafSlotId,
      tokens: words.flatMap((w) => w.match(/[\p{L}\p{N}]+/gu) ?? []),
      before: before === undefined ? null : before - 1,
      limit: 200,
      viewers: context.viewers
    })
    if (rows === null) return null
    const name = yield* namer(
      context,
      rows.flatMap((r) => (r.speakerEntityId ? [r.speakerEntityId] : []))
    )
    return rows.filter((r) => r.content.trim()).map((r) => name({ ...r, n: r.position + 1 }))
  })

/** The words of a query, for matching every one of them, case aside. */
const wordsOf = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)

const matches = (text: string, words: ReadonlyArray<string>) => {
  const lower = text.toLowerCase()
  return words.every((w) => lower.includes(w))
}

/** About `size` characters around the first word found, marked where it was cut. */
const excerpt = (text: string, words: ReadonlyArray<string>, size = 240) => {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= size) return flat
  const at = Math.max(
    0,
    ...words
      .map((w) => flat.toLowerCase().indexOf(w))
      .filter((i) => i >= 0)
      .slice(0, 1)
  )
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size))
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}${start + size < flat.length ? "…" : ""}`
}

/** Where a message is: its number, and a joined row's place in its thread or chat. */
const place = (m: PathMessage) => {
  if (!m.joined) return `Message ${m.n}`
  const { title, from, to, summary } = m.joined
  if (summary) return `Message ${m.n} (${title}, summary of #${from ?? "?"}–${to ?? "?"})`
  return `Message ${m.n} (${title}${from === null ? "" : ` #${from}`})`
}

const line = (m: PathMessage) =>
  m.joined?.summary ? `${place(m)}: ${m.content}` : `${place(m)}, ${m.speaker}: ${m.content}`

/** A tool's failure as text the model can act on; storage errors never reach the loop. */
export const safely = <E>(tool: string, run: Effect.Effect<ToolOutput, E>): Effect.Effect<ToolOutput> =>
  run.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`tool ${tool} failed`, cause).pipe(
        Effect.as({ text: `${tool} failed. Go on without it.`, isError: true })
      )
    )
  )

const tokensOf = (text: string) => Math.ceil(text.length / 4)

const searchChat: RolloutTool<{
  readonly query: string
  readonly speaker?: string
  readonly limit?: number
  readonly before_message?: number
}> = {
  id: "search_chat",
  label: "Searched the chat",
  explanation: "Search the chat's earlier messages",
  effect: "read",
  description:
    "Searches the story's earlier messages for words, newest first, and returns short excerpts with their message numbers. A message another thread or chat brought in when it was joined is named by its number there too, as “Message 55 (At the docks #47)”. Use it to find when something happened or was said, then read_messages to read the passage. Don't use it for what's already in front of you.",
  parameters: Type.Object({
    query: Type.String({ description: "Words that must all appear, case aside." }),
    speaker: Type.Optional(Type.String({ description: "Only messages by this character." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Most results (8)." })),
    before_message: Type.Optional(Type.Integer({ minimum: 1, description: "Only messages before this number." }))
  }),
  summarize: ({ query }) => query,
  execute: (context, { query, speaker, limit = 8, before_message }) =>
    safely(
      "search_chat",
      Effect.gen(function* () {
        const words = wordsOf(query)
        if (words.length === 0) return { text: "Give some words to search for.", isError: true }
        const who = speaker?.trim().toLowerCase()
        const found = (yield* searched(context, words, before_message)) ?? (yield* pathMessages(context)).toReversed()
        const hits = found
          .filter(
            (m) =>
              (before_message === undefined || m.n < before_message) &&
              (!who || m.speaker.toLowerCase() === who) &&
              matches(m.content, words)
          )
          .slice(0, Math.min(limit, 20))
        if (hits.length === 0) return { text: `No earlier messages match “${query}”.` }
        return {
          text: hits
            .map((m) =>
              m.joined?.summary
                ? `${place(m)}: ${excerpt(m.content, words)}`
                : `${place(m)}, ${m.speaker}: ${excerpt(m.content, words)}`
            )
            .join("\n")
        }
      })
    )
}

const readMessages: RolloutTool<{ readonly from: number; readonly count?: number; readonly joined_from?: number }> = {
  id: "read_messages",
  label: "Read earlier messages",
  explanation: "Read earlier messages in full",
  effect: "read",
  description:
    "Reads earlier messages of the story verbatim, from a message number on. Use it after search_chat or expand_summary to read a passage in full. A joined thread or chat is one message holding its messages: to start inside it, give its number in joined_from (47 for “Message 55 (At the docks #47)”).",
  parameters: Type.Object({
    from: Type.Integer({ minimum: 1, description: "The first message's number." }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many (5, at most 20)." })),
    joined_from: Type.Optional(
      Type.Integer({ minimum: 1, description: "In a join at message `from`: the number there to start at." })
    )
  }),
  summarize: ({ from, count = 5 }) => `Messages ${from}–${from + count - 1}`,
  execute: (context, { from, count = 5, joined_from }) =>
    safely(
      "read_messages",
      Effect.gen(function* () {
        const messages = yield* pathMessages(context)
        const last = messages.at(-1)?.n ?? 0
        const read = messages
          .filter(
            (m) =>
              m.n > from ||
              (m.n === from &&
                (joined_from === undefined || m.joined === undefined || (m.joined.to ?? Infinity) >= joined_from))
          )
          .slice(0, Math.min(count, 20))
        if (read.length === 0)
          return {
            text: last === 0 ? "There are no earlier messages." : `The earlier messages end at message ${last}.`,
            isError: true
          }
        return { text: read.map(line).join("\n\n") }
      })
    )
}

/** The summaries in use at the position, and those they condense, with their text. */
const summaryTree = (context: ToolContext) =>
  cached(
    context,
    "summaries",
    Effect.gen(function* () {
      if (context.leafSlotId === null) return [] as ReadonlyArray<SummaryNode>
      const read = yield* pathRead(context)
      // The joins' summaries the view knew, whether or not this chat summarizes.
      const joined = read.joined.map((s, i): SummaryNode => ({
        id: `joined:${s.at}:${i}`,
        level: 1,
        from: s.from,
        to: s.to,
        content: s.content,
        children: [],
        fresh: true,
        audience: undefined,
        joined: s
      }))
      const view = read.view
      const state = yield* context.reader.GetLcmState({
        userId: context.userId,
        chatId: context.chatId,
        forkId: context.forkId,
        leafSlotId: context.leafSlotId,
        // A separate context's character reads its own view's layer (unit C7); one read whole
        // its stretch view's where a separate join is on the path (TH7).
        ...(view === null ? {} : { viewer: view.identities[0]! as EntityId })
      })
      if (!state.enabled) return joined
      const nodes: Array<SummaryNode> = []
      const queue: Array<LcmSummary | Summary> = [...state.layer]
      // Bounded: the layer and what it condenses, as far as a few hundred summaries.
      while (queue.length > 0 && nodes.length < 300) {
        const summary = queue.shift()!
        const children = summary.children.map((c) => (typeof c === "string" ? c : c.summaryId))
        nodes.push({
          id: summary.id,
          level: summary.level,
          from: summary.from,
          to: summary.to,
          content: summary.content ?? "",
          children,
          fresh: summary.fresh,
          audience: summary.audience
        })
        for (const id of children)
          queue.push(
            yield* context.reader.GetSummary({ userId: context.userId, forkId: context.forkId, summaryId: id })
          )
      }
      if (view === null) return [...nodes, ...joined]
      // The view's layer (unit C7): its own summaries, written from what it knew, and shared ones
      // before where it diverged. Kept as a second guard: a shared summary opens only when it
      // is fresh and covers nothing the viewer missed; an own one only when it is this viewer's.
      const viewers = [...view.identities, ...(view.stretch ? [STRETCH_VIEW] : [])]
      const missed = [...read.missed]
      return [
        ...nodes.filter((s) =>
          s.audience === undefined
            ? s.fresh && !missed.some((n) => n >= s.from && n <= s.to)
            : s.audience.every((id) => viewers.includes(id))
        ),
        ...joined
      ]
    })
  )

interface SummaryNode {
  readonly id: string
  readonly level: number
  readonly from: number
  readonly to: number
  readonly content: string
  readonly children: ReadonlyArray<string>
  /** Its inputs are still what the path shows. */
  readonly fresh: boolean
  /** A separate context's own summary: its character's identities (unit C7). */
  readonly audience: ReadonlyArray<string> | undefined
  /** A join's summary: its range is in the joined thread or chat (spec/THREADS.md §11). */
  readonly joined?: JoinedSummary
}

/** A joined thread's or chat's name as the model may write it: case, quotes and spaces aside. */
const titleKey = (title: string) =>
  title
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** Where a summary is, as the summary tools name it. */
const summaryPlace = (s: SummaryNode) =>
  s.joined
    ? `Messages ${s.from}–${s.to} of “${s.joined.title}” (joined at message ${s.joined.at})`
    : `Messages ${s.from}–${s.to}`

const range = (text: string) => {
  const found = /(\d+)\D+(\d+)/.exec(text) ?? /(\d+)/.exec(text)
  if (!found) return null
  const from = Number(found[1])
  return { from, to: Number(found[2] ?? found[1]) }
}

const expandSummary: RolloutTool<{
  readonly messages: string
  readonly joined?: string
  readonly max_tokens?: number
}> = {
  id: "expand_summary",
  label: "Opened a summary",
  explanation: "Open a summary for more detail",
  effect: "read",
  description:
    "Opens a summary in your context, named by the messages it covers (its from and to): a first-level summary gives its messages, a higher one the summaries it condenses. A summary a joined thread or chat brought is named by its messages there, with its name in joined. Use it when a summary leaves out a detail you need.",
  parameters: Type.Object({
    messages: Type.String({ description: "The range the summary covers, as “120–180”." }),
    joined: Type.Optional(
      Type.String({ description: "For a joined thread's or chat's summary: its name, as “At the docks”." })
    ),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000, description: "At most this much (2000)." }))
  }),
  summarize: ({ messages, joined }) => (joined ? `Messages ${messages} of “${joined}”` : `Messages ${messages}`),
  execute: (context, { messages, joined, max_tokens = 2000 }) =>
    safely(
      "expand_summary",
      Effect.gen(function* () {
        const wanted = range(messages)
        if (!wanted) return { text: "Name the summary by its messages, as “120–180”.", isError: true }
        const tree = yield* summaryTree(context)
        const covers = (s: SummaryNode) => s.from === wanted.from && s.to === wanted.to
        const asked = joined === undefined ? null : titleKey(joined)
        const fromJoins = tree.filter(
          (s) => s.joined && covers(s) && (asked === null || titleKey(s.joined.title) === asked)
        )
        // Unnamed: this chat's own summary, else the one joined summary with that range.
        const node =
          asked === null
            ? (tree.find((s) => !s.joined && covers(s)) ?? (fromJoins.length === 1 ? fromJoins[0] : undefined))
            : fromJoins.at(-1)
        if (!node)
          return {
            text: tree.length
              ? `No summary covers exactly messages ${wanted.from}–${wanted.to}${joined ? ` of “${joined}”` : ""}. Summaries: ${tree
                  .filter((s) => s.joined || tree.every((t) => !t.children.length || s.level <= t.level))
                  .map((s) => (s.joined ? `${s.from}–${s.to} of “${s.joined.title}”` : `${s.from}–${s.to}`))
                  .join(", ")}.`
              : "This chat has no summaries.",
            isError: true
          }
        const parts = node.joined
          ? node.joined.messages.map(line)
          : node.level <= 1
            ? (yield* pathMessages(context)).filter((m) => m.n >= node.from && m.n <= node.to).map(line)
            : tree
                .filter((s) => node.children.includes(s.id))
                .toSorted((a, b) => node.children.indexOf(a.id) - node.children.indexOf(b.id))
                .map((s) => `<summary level="${s.level}" from="${s.from}" to="${s.to}">\n${s.content}\n</summary>`)
        const shown: Array<string> = []
        let used = 0
        for (const part of parts) {
          if (shown.length > 0 && used + tokensOf(part) > max_tokens) break
          shown.push(part)
          used += tokensOf(part)
        }
        const left = parts.length - shown.length
        return {
          text: `${shown.join("\n\n")}${left > 0 ? `\n\n[${left} more left out: ask for a higher max_tokens, or read_messages.]` : ""}`
        }
      })
    )
}

const searchSummaries: RolloutTool<{ readonly query: string; readonly limit?: number }> = {
  id: "search_summaries",
  label: "Searched the summaries",
  explanation: "Search the summaries",
  effect: "read",
  description:
    "Searches the summaries of earlier parts of the story for words, and returns which messages each match covers; a joined thread's or chat's summary is named by its messages there. Use it to find roughly when something happened, then expand_summary or read_messages.",
  parameters: Type.Object({
    query: Type.String({ description: "Words that must all appear, case aside." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Most results (5)." }))
  }),
  summarize: ({ query }) => query,
  execute: (context, { query, limit = 5 }) =>
    safely(
      "search_summaries",
      Effect.gen(function* () {
        const words = wordsOf(query)
        if (words.length === 0) return { text: "Give some words to search for.", isError: true }
        const tree = yield* summaryTree(context)
        if (tree.length === 0) return { text: "This chat has no summaries." }
        // The most detailed first: a first-level match names the shortest range.
        const hits = tree
          .filter((s) => matches(s.content, words))
          .toSorted((a, b) => a.level - b.level || b.from - a.from)
          .slice(0, Math.min(limit, 20))
        if (hits.length === 0) return { text: `No summaries match “${query}”.` }
        return {
          text: hits.map((s) => `${summaryPlace(s)} (level ${s.level}): ${excerpt(s.content, words)}`).join("\n")
        }
      })
    )
}

export const historyTools: ReadonlyArray<RolloutTool<never>> = [
  searchChat,
  readMessages,
  expandSummary,
  searchSummaries
] as unknown as ReadonlyArray<RolloutTool<never>>
