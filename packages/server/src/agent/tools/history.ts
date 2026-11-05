// The read tools over the chat's own history (spec/AGENTIC.md §4.5): search it, read a passage,
// open a summary, search the summaries. All causal: the path read ends at the message before
// the one being generated, in the generation's fork, with each message as that fork shows it.
import { Type } from "@earendil-works/pi-ai"
import type { EntityId, PathEntry, SlotId } from "@rp/shared/chat.ts"
import type { LcmSummary, Summary } from "@rp/shared/lcm.ts"
import { foldState } from "@rp/shared/state.ts"
import { Effect } from "effect"
import type { RolloutTool, ToolContext, ToolOutput } from "../tools.ts"

/** One message as the tools show it: its number on the path (from 1), who wrote it, its text. */
interface PathMessage {
  readonly n: number
  readonly speaker: string
  readonly content: string
}

const WINDOW = 500

/** A value worked out once per rollout: the path and the summaries don't change while it runs. */
const cached = <A, E>(context: ToolContext, key: string, make: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.suspend(() =>
    context.cache.has(key)
      ? Effect.succeed(context.cache.get(key) as A)
      : make.pipe(Effect.tap((value) => Effect.sync(() => context.cache.set(key, value))))
  )

/** The messages before the one being generated, oldest first; hidden ones left out. */
const pathMessages = (context: ToolContext) =>
  cached(
    context,
    "path",
    Effect.gen(function* () {
      if (context.leafSlotId === null) return [] as ReadonlyArray<PathMessage>
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
      // The user's messages without a speaker are the persona's they play there.
      const { playedByMe } = foldState(
        yield* context.reader.StateEventsAt({
          userId: context.userId,
          chatId: context.chatId,
          slotId: context.leafSlotId,
          forkId: context.forkId
        })
      )
      const persona = playedByMe.at(-1) ?? null
      const speakers = [
        ...new Set([
          ...entries.flatMap((e) => (e.version.speakerEntityId ? [e.version.speakerEntityId] : [])),
          ...(persona ? [persona] : [])
        ])
      ]
      const cards = speakers.length
        ? yield* context.reader.CastCards({ userId: context.userId, entityIds: speakers as Array<EntityId> })
        : []
      const names = new Map(cards.map((card) => [card.entityId as string, card.modelName ?? card.name]))
      const user = (persona && names.get(persona)) ?? "User"
      return entries.flatMap((entry): Array<PathMessage> => {
        const { version } = entry
        if (
          entry.contextExcluded ||
          version.status === "generating" ||
          version.status === "failed" ||
          !version.content.trim()
        )
          return []
        const speaker = names.get(version.speakerEntityId ?? "") ?? (version.writer === "human" ? user : "Narrator")
        // A template message (a greeting) as the model read it: its names filled in [P: only these two].
        const content =
          version.macroMode === "template"
            ? version.content.replace(/\{\{char\}\}/gi, speaker).replace(/\{\{user\}\}/gi, user)
            : version.content
        return [{ n: (entry.position ?? entry.depth) + 1, speaker, content }]
      })
    })
  )

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

const line = (m: PathMessage) => `Message ${m.n}, ${m.speaker}: ${m.content}`

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
    "Searches the story's earlier messages for words, newest first, and returns short excerpts with their message numbers. Use it to find when something happened or was said, then read_messages to read the passage. Don't use it for what's already in front of you.",
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
        const hits = (yield* pathMessages(context))
          .filter(
            (m) =>
              (before_message === undefined || m.n < before_message) &&
              (!who || m.speaker.toLowerCase() === who) &&
              matches(m.content, words)
          )
          .toReversed()
          .slice(0, Math.min(limit, 20))
        if (hits.length === 0) return { text: `No earlier messages match “${query}”.` }
        return { text: hits.map((m) => `Message ${m.n}, ${m.speaker}: ${excerpt(m.content, words)}`).join("\n") }
      })
    )
}

const readMessages: RolloutTool<{ readonly from: number; readonly count?: number }> = {
  id: "read_messages",
  label: "Read earlier messages",
  explanation: "Read earlier messages in full",
  effect: "read",
  description:
    "Reads earlier messages of the story verbatim, from a message number on. Use it after search_chat or expand_summary to read a passage in full.",
  parameters: Type.Object({
    from: Type.Integer({ minimum: 1, description: "The first message's number." }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many (5, at most 20)." }))
  }),
  summarize: ({ from, count = 5 }) => `Messages ${from}–${from + count - 1}`,
  execute: (context, { from, count = 5 }) =>
    safely(
      "read_messages",
      Effect.gen(function* () {
        const messages = yield* pathMessages(context)
        const last = messages.at(-1)?.n ?? 0
        const read = messages.filter((m) => m.n >= from).slice(0, Math.min(count, 20))
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
      const state = yield* context.reader.GetLcmState({
        userId: context.userId,
        chatId: context.chatId,
        forkId: context.forkId,
        leafSlotId: context.leafSlotId
      })
      if (!state.enabled) return []
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
          children
        })
        for (const id of children)
          queue.push(
            yield* context.reader.GetSummary({ userId: context.userId, forkId: context.forkId, summaryId: id })
          )
      }
      return nodes
    })
  )

interface SummaryNode {
  readonly id: string
  readonly level: number
  readonly from: number
  readonly to: number
  readonly content: string
  readonly children: ReadonlyArray<string>
}

const range = (text: string) => {
  const found = /(\d+)\D+(\d+)/.exec(text) ?? /(\d+)/.exec(text)
  if (!found) return null
  const from = Number(found[1])
  return { from, to: Number(found[2] ?? found[1]) }
}

const expandSummary: RolloutTool<{ readonly messages: string; readonly max_tokens?: number }> = {
  id: "expand_summary",
  label: "Opened a summary",
  explanation: "Open a summary for more detail",
  effect: "read",
  description:
    "Opens a summary in your context, named by the messages it covers (its from and to): a first-level summary gives its messages, a higher one the summaries it condenses. Use it when a summary leaves out a detail you need.",
  parameters: Type.Object({
    messages: Type.String({ description: "The range the summary covers, as “120–180”." }),
    max_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000, description: "At most this much (2000)." }))
  }),
  summarize: ({ messages }) => `Messages ${messages}`,
  execute: (context, { messages, max_tokens = 2000 }) =>
    safely(
      "expand_summary",
      Effect.gen(function* () {
        const wanted = range(messages)
        if (!wanted) return { text: "Name the summary by its messages, as “120–180”.", isError: true }
        const tree = yield* summaryTree(context)
        const node = tree.find((s) => s.from === wanted.from && s.to === wanted.to)
        if (!node)
          return {
            text: tree.length
              ? `No summary covers exactly messages ${wanted.from}–${wanted.to}. Summaries: ${tree
                  .filter((s) => tree.every((t) => !t.children.length || s.level <= t.level))
                  .map((s) => `${s.from}–${s.to}`)
                  .join(", ")}.`
              : "This chat has no summaries.",
            isError: true
          }
        const parts =
          node.level <= 1
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
    "Searches the summaries of earlier parts of the story for words, and returns which messages each match covers. Use it to find roughly when something happened, then expand_summary or read_messages.",
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
          text: hits
            .map((s) => `Messages ${s.from}–${s.to} (level ${s.level}): ${excerpt(s.content, words)}`)
            .join("\n")
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
