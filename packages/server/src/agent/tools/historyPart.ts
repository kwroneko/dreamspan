// Editable history policy. The host owns causal projection, snapshots and permissions.
import {
  Effect,
  Type,
  type StoryToolV1,
  type StoryMessageV1 as PathMessage,
  type PrivateStoryV1 as PrivateHistory,
  type StorySummaryV1 as SummaryNode
} from "../../../../plugin-api/src/server.ts"
type Address = number | string
const JOINED_READ_REFUSAL = "History tools are unavailable for this separate thread view."
const PRIVATE_EMPTY = "No earlier messages match."
const safely = <E>(_tool: string, run: Effect.Effect<{ readonly text: string; readonly isError?: boolean }, E>) => run
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
  if (m.address) return `Message ${m.address} (view #${m.n})`
  if (!m.joined) return `Message ${m.n}`
  const { title, from, to, summary } = m.joined
  if (summary) return `Message ${m.n} (${title}, summary of #${from ?? "?"}–${to ?? "?"})`
  return `Message ${m.n} (${title}${from === null ? "" : ` #${from}`})`
}

export const line = (m: PathMessage) =>
  m.joined?.summary ? `${place(m)}: ${m.content}` : `${place(m)}, ${m.speaker}: ${m.content}`

/** A tool's failure as text the model can act on; storage errors never reach the loop. */
const privateIndex = (read: PrivateHistory, address: Address) =>
  typeof address === "string"
    ? read.messages.findIndex((m) => m.address === address)
    : read.messages.findIndex((m) => m.n === address)

const addressParameter = (description: string) =>
  Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^v[a-f0-9]{24}$" })], { description })

const tokensOf = (text: string) => Math.ceil(text.length / 4)

export const searchChat: StoryToolV1<{
  readonly query: string
  readonly speaker?: string
  readonly limit?: number
  readonly before_message?: Address
}> = {
  source: import.meta.url,
  id: "search_chat",
  label: "Searched the chat",
  explanation: "Search the chat's earlier messages",
  effect: "read",
  description:
    "Searches the story's earlier messages for words, newest first, and returns short excerpts with their message addresses. In a private joined view, copy the v… address exactly into read_messages or before_message; it names only a row you know. Other views use message numbers. A message another thread or chat brought in when it was joined is named by its number there too, as “Message 55 (At the docks #47)”. Use it to find when something happened or was said, then read_messages to read the passage. Don't use it for what's already in front of you.",
  parameters: Type.Object({
    query: Type.String({ description: "Words that must all appear, case aside." }),
    speaker: Type.Optional(Type.String({ description: "Only messages by this character." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Most results (8)." })),
    before_message: Type.Optional(addressParameter("Only messages before this address."))
  }),
  summarize: ({ query }) => query,
  execute: (context, { query, speaker, limit = 8, before_message }) =>
    safely(
      "search_chat",
      Effect.gen(function* () {
        const words = wordsOf(query)
        if (words.length === 0) return { text: "Give some words to search for.", isError: true }
        const who = speaker?.trim().toLowerCase()
        const indexed = yield* context.search(words, typeof before_message === "number" ? before_message : undefined)
        const privateRead = indexed === null ? yield* context.privateHistory : null
        if (privateRead !== null) {
          if (privateRead.refused) return { text: JOINED_READ_REFUSAL, isError: true }
          const before =
            before_message === undefined ? privateRead.messages.length : privateIndex(privateRead, before_message)
          if (before < 0) return { text: PRIVATE_EMPTY }
          const hits = privateRead.messages
            .slice(0, before)
            .toReversed()
            .filter((m) => (!who || m.speaker.toLowerCase() === who) && matches(m.content, words))
            .slice(0, Math.min(limit, 20))
          return {
            text: hits.length
              ? hits.map((m) => `${place(m)}, ${m.speaker}: ${excerpt(m.content, words)}`).join("\n")
              : PRIVATE_EMPTY
          }
        }
        if (typeof before_message === "string") return { text: PRIVATE_EMPTY }
        // The indexed reader returns null for every chat containing a merge. Keep ordinary
        // no-merge searches indexed; a joined view must pass the same guard before any output.
        const path = indexed === null ? yield* context.messages : []
        const ordinary =
          indexed === null && context.filtered && !path.some((m) => m.joined !== undefined)
            ? yield* context.search(words, before_message, true)
            : null
        const found = indexed ?? ordinary ?? path.toReversed()
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

export const readMessages: StoryToolV1<{
  readonly from: Address
  readonly count?: number
  readonly joined_from?: Address
}> = {
  source: import.meta.url,
  id: "read_messages",
  label: "Read earlier messages",
  explanation: "Read earlier messages in full",
  effect: "read",
  description:
    "Reads earlier messages of the story verbatim, from an address on. In a private joined view copy the exact v… address returned by search_chat; numbers there refer only to your view, and from: 1 starts at your first known row. Rows there have no joined_from offset; unavailable and stale addresses have the same answer. Use it after search_chat or expand_summary to read a passage in full. A joined thread or chat is one message holding its messages: to start inside it, give its number in joined_from (47 for “Message 55 (At the docks #47)”).",
  parameters: Type.Object({
    from: addressParameter("The first message address, or 1 for the start."),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many (5, at most 20)." })),
    joined_from: Type.Optional(
      addressParameter("In a whole-thread numbered join at `from`: the source number there to start at.")
    )
  }),
  summarize: ({ from, count = 5 }) =>
    typeof from === "number" ? `Messages ${from}–${from + count - 1}` : `From ${from}`,
  execute: (context, { from, count = 5, joined_from }) =>
    safely(
      "read_messages",
      Effect.gen(function* () {
        const privateRead = yield* context.privateHistory
        if (privateRead !== null) {
          if (privateRead.refused) return { text: JOINED_READ_REFUSAL, isError: true }
          const at = privateIndex(privateRead, from)
          if (at < 0 || joined_from !== undefined) return { text: PRIVATE_EMPTY }
          const rows = privateRead.messages.slice(at, at + Math.min(count, 20))
          return { text: rows.length ? rows.map(line).join("\n\n") : PRIVATE_EMPTY }
        }
        if (typeof from === "string" || typeof joined_from === "string") return { text: PRIVATE_EMPTY }
        const messages = yield* context.messages
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

export const expandSummary: StoryToolV1<{
  readonly messages: string
  readonly joined?: string
  readonly max_tokens?: number
}> = {
  source: import.meta.url,
  id: "expand_summary",
  label: "Opened a summary",
  explanation: "Open a summary for more detail",
  effect: "read",
  description:
    "Opens a summary in your context, named by the messages it covers (its from and to): a first-level summary gives its messages, a higher one the summaries it condenses. A summary a joined thread or chat brought is named by its messages there, with its name in joined. This tool is unavailable in a private joined view; use search_chat and read_messages instead. Use it when a summary leaves out a detail you need.",
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
        if ((yield* context.privateHistory) !== null) return { text: JOINED_READ_REFUSAL, isError: true }
        const wanted = range(messages)
        if (!wanted) return { text: "Name the summary by its messages, as “120–180”.", isError: true }
        const tree = yield* context.summaries
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
            ? (yield* context.messages).filter((m) => m.n >= node.from && m.n <= node.to).map(line)
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

export const searchSummaries: StoryToolV1<{ readonly query: string; readonly limit?: number }> = {
  source: import.meta.url,
  id: "search_summaries",
  label: "Searched the summaries",
  explanation: "Search the summaries",
  effect: "read",
  description:
    "Searches the summaries of earlier parts of the story for words, and returns which messages each match covers; a joined thread's or chat's summary is named by its messages there. This tool is unavailable in a private joined view; use search_chat and read_messages instead. Use it to find roughly when something happened, then expand_summary or read_messages.",
  parameters: Type.Object({
    query: Type.String({ description: "Words that must all appear, case aside." }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Most results (5)." }))
  }),
  summarize: ({ query }) => query,
  execute: (context, { query, limit = 5 }) =>
    safely(
      "search_summaries",
      Effect.gen(function* () {
        if ((yield* context.privateHistory) !== null) return { text: JOINED_READ_REFUSAL, isError: true }
        const words = wordsOf(query)
        if (words.length === 0) return { text: "Give some words to search for.", isError: true }
        const tree = yield* context.summaries
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
