// Pure shell projections. Both worker reads and the shared materialization use these.
import { branchMatches } from "@dreamspan/shared/branchNaming.ts"
import type { CastCard, EntityId, ForkId } from "@dreamspan/shared/chat.ts"
import { CHAT_FILTERS, type ChatBrowse, type ChatFilterCounts } from "@dreamspan/shared/chatBrowse.ts"
import {
  SHELL_SECTION_LIMIT,
  ShellFork,
  type ShellCard,
  type ShellForksView,
  type ShellSection
} from "@dreamspan/shared/chatSetupApi.ts"
import type { SplitChatLink } from "@dreamspan/shared/splitChat.ts"
import type { ChatSummaries } from "./forkSummaries.ts"
import type { ShellSnapshotRead } from "./ops.ts"

export type Fork = {
  -readonly [K in keyof Omit<ShellFork, "cast" | "added">]: Omit<ShellFork, "cast" | "added">[K]
} & {
  cast: Array<CastCard>
  added: Array<CastCard>
}
export type Activity = ShellFork["activity"][number]

/** What every shell read is made of: the cards, each fork row newest first, and what it had to walk. */
export interface ShellState {
  readonly people: ReadonlyMap<string, CastCard>
  readonly links: ReadonlyMap<string, SplitChatLink>
  readonly parents: ReadonlyMap<string, string>
  readonly splitChatIds: ReadonlySet<string>
  readonly cards: ReadonlyArray<ShellCard>
  readonly personas: ReadonlyArray<ShellCard>
  readonly archived: ReadonlyArray<ShellCard>
  readonly forks: ReadonlyArray<Fork>
  readonly chatIndex: ReadonlyMap<string, Fork>
  readonly pinnedChats: ReadonlySet<string>
  readonly pinsCollapsed: boolean
  readonly fresh: ReadonlyArray<ChatSummaries>
}

export const trusted = { disableChecks: true } as const

/** A fork's row on the wire: its cast by id, which the read's `people` describe. */
export const wire = (f: Fork) =>
  new ShellFork({ ...f, cast: f.cast.map((c) => c.entityId), added: f.added.map((c) => c.entityId) }, trusted)

/** The cards a set of fork rows names, once. */
const peopleOf = (forks: ReadonlyArray<Fork>) => {
  const people = new Map<string, CastCard>()
  for (const f of forks) for (const c of [...f.cast, ...f.added]) people.set(c.entityId, c)
  return [...people.values()]
}

/** By `sort`; Recent and Name are the chat's (`chatRecentAt`, `chatName`) for rows that stand for their chat, else the fork's own. */
const sortBy = (forks: ReadonlyArray<Fork>, sort: ShellForksView["sort"], recent: "fork" | "chat" = "fork") =>
  [...forks].sort((a, b) =>
    sort === "name"
      ? recent === "chat"
        ? a.chatName.localeCompare(b.chatName)
        : a.name.localeCompare(b.name)
      : (sort === "created"
          ? b.createdAt - a.createdAt
          : sort === "added"
            ? (b.addedAt ?? b.createdAt) - (a.addedAt ?? a.createdAt)
            : recent === "chat"
              ? b.chatRecentAt - a.chatRecentAt
              : b.recentAt - a.recentAt) || a.name.localeCompare(b.name)
  )

/**
 * One row per chat, where a list stands for chats rather than forks: its current fork when
 * that's among `forks`, else its first there. In `forks`' order; each row says how many
 * branches its chat has (`branches`), so a chat's forks don't repeat its name down a list.
 */
export const perChat = (forks: ReadonlyArray<Fork>): ReadonlyArray<Fork> => {
  const withCurrent = new Set(forks.flatMap((f) => (f.current ? [f.chat.id] : [])))
  const seen = new Set<string>()
  return forks.filter((f) => {
    if (seen.has(f.chat.id) || (withCurrent.has(f.chat.id) && !f.current)) return false
    seen.add(f.chat.id)
    return true
  })
}

/** Forks by card `entity`'s latest turn in them, then newest. */
const byTurn = (forks: ReadonlyArray<Fork>, entity: string) => {
  const at = (f: Fork) => f.activity.find((a) => a.entityId === entity)?.at ?? -1
  return [...forks].sort((a, b) => at(b) - at(a) || b.chatRecentAt - a.chatRecentAt || b.recentAt - a.recentAt)
}

/** How card `entity` is in fork `f`: alone with the user, with others, or gone. */
const categoryOf = (f: Fork, entity: string) =>
  f.activity.find((a) => a.entityId === entity)?.category ?? (f.departed.some((id) => id === entity) ? "was" : "with")

/**
 * Chat metrics come from the current path; chat pins are independent of branch pins. A workshop
 * is listed under "All" and "Workshops" only, so the other choices read as story chats.
 */
const inChatFilter = (f: Fork, filter: ChatBrowse["filter"], pinned: ReadonlySet<string>) =>
  filter === "all"
    ? true
    : filter === "workshops"
      ? f.chat.kind === "workshop"
      : f.chat.kind !== "workshop" &&
        (filter === "pinned"
          ? pinned.has(f.chat.id)
          : filter === "groups"
            ? f.cast.length >= 2
            : filter === "solo"
              ? f.cast.length === 1
              : f.branches > 1)

/**
 * The chats a message search looks through, as the Chats tab lists them: those `filter` shows,
 * of card `entity`'s chats when given, by name (A to Z, as its Name sort).
 * Keep the displayed rows' fork ids alongside the stored chat ids they share.
 */
export const searchedChats = (state: ShellState, filter: ChatBrowse["filter"], entity: EntityId | null) => {
  const rows = perChat(state.forks.filter((f) => entity === null || f.joined.includes(entity)))
    .map((f) => state.chatIndex.get(f.chat.id)!)
    .filter((f) => inChatFilter(f, filter, state.pinnedChats))
    .sort((a, b) => a.chatName.localeCompare(b.chatName) || a.chat.id.localeCompare(b.chat.id))
  const rank = new Map(rows.map((f, i) => [f.chat.id, i]))
  const ids = new Map<string, number>()
  const forks: Array<ForkId> = []
  for (const f of state.forks) {
    const at = rank.get(f.chat.id)
    if (at === undefined) continue
    const id = f.sourceChatId ?? f.chat.id
    ids.set(id, Math.min(at, ids.get(id) ?? at))
    forks.push(f.forkId as ForkId)
  }
  return {
    chats: [...ids].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([id]) => id),
    forks
  }
}

const browseChats = (rows: ReadonlyArray<Fork>, browse: ChatBrowse, state: ShellState) => {
  const metric = (f: Fork) => {
    const current = state.chatIndex.get(f.chat.id)!
    switch (browse.sort) {
      case "recent":
        return current.chatRecentAt
      case "started":
        return current.chat.createdAt ?? current.createdAt
      case "messages":
        return current.messages
      case "branches":
        return current.branches
      case "name":
        return current.chatName
    }
  }
  return rows
    .filter((f) => inChatFilter(state.chatIndex.get(f.chat.id)!, browse.filter, state.pinnedChats))
    .sort((a, b) => {
      const x = metric(a),
        y = metric(b)
      const order = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(y) - Number(x)
      return (
        (browse.reversed ? -order : order) || a.chat.id.localeCompare(b.chat.id) || a.forkId.localeCompare(b.forkId)
      )
    })
}

/** Each of `view`'s sections over `forks` (newest first), unlimited. */
const sectionRows = (state: ShellState, view: ShellForksView, id: ShellSection): ReadonlyArray<Fork> => {
  const forks = state.forks
  const needle = view.search.trim().toLowerCase()
  const chats = view.chats === undefined ? null : new Set<string>(view.chats)
  // One chat's branches share its name and cast: there a search looks through each branch's
  // own name and its last message, as the branch menu's filter does. A fork not read yet
  // (`pending`) has no cast: its own name and its chat's, when known.
  const matches = (f: Fork) =>
    needle === "" ||
    (view.chat !== null
      ? branchMatches(needle, [f.named ? f.name : "", f.original ? "Original" : "", f.preview])
      : (f.pending === true
          ? [f.named ? f.name : "", f.chatName]
          : [f.name, f.chatName, ...f.cast.flatMap((c) => [c.label, c.name])]
        ).some((n) => n !== "" && n.toLowerCase().includes(needle)))
  const scoped = forks.filter(
    (f) =>
      (view.entity === null || f.joined.includes(view.entity)) &&
      (view.chat === null || f.chat.id === view.chat) &&
      (chats === null || chats.has(f.chat.id)) &&
      matches(f)
  )
  // A chat's branches by their last message, newest first (owner, 2026-11-01).
  const byLast = (list: ReadonlyArray<Fork>) =>
    [...list].sort((a, b) => (b.endAt ?? b.createdAt) - (a.endAt ?? a.createdAt) || b.createdAt - a.createdAt)
  const peer = (f: Fork) => f.pinned || f.named
  // A fork of a shown set of threads is listed as a thread, never as a branch (DESIGN §3.3).
  const thread = (f: Fork) => f.threads !== undefined
  switch (id) {
    case "pinned":
      return sortBy(
        perChat(scoped)
          .filter(
            (f) =>
              state.pinnedChats.has(f.chat.id) &&
              (!view.browse || inChatFilter(state.chatIndex.get(f.chat.id)!, view.browse.filter, state.pinnedChats))
          )
          .map((f) => state.chatIndex.get(f.chat.id)!),
        view.sort,
        "chat"
      )
    case "chats":
      return view.browse ? browseChats(perChat(scoped), view.browse, state) : perChat(scoped)
    case "just":
    case "with":
    case "was":
      if (view.entity === null) return []
      {
        const rows = perChat(
          byTurn(
            scoped.filter((f) => categoryOf(f, view.entity!) === id),
            view.entity
          )
        )
        return view.browse ? browseChats(rows, view.browse, state) : rows
      }
    case "current":
      return scoped.filter((f) => f.current)
    case "threads":
      return byLast(scoped.filter(thread))
    case "pinnedBranches":
      return byLast(scoped.filter((f) => f.pinned && !thread(f)))
    case "peers":
      return byLast(scoped.filter((f) => f.named && !f.pinned && !thread(f)))
    case "other":
      return byLast(scoped.filter((f) => !peer(f) && !thread(f)))
    case "groups": {
      // The home grid's direction toggle turns the order round (oldest first, Z to A).
      const sorted = sortBy(
        perChat(scoped).filter((f) => f.cast.length > 1),
        view.sort,
        "chat"
      )
      return view.reversed === true ? sorted.reverse() : sorted
    }
    case "card":
      return perChat(view.entity === null ? scoped : byTurn(scoped, view.entity))
    case "all":
      return scoped
  }
}

export type ThreadLabels = ReadonlyMap<string, { readonly name: string | null; readonly cast: ReadonlyArray<EntityId> }>

export const libraryView = (state: ShellState) => ({
  cards: state.cards,
  forks: state.forks.map(wire),
  people: peopleOf(state.forks),
  pinsCollapsed: state.pinsCollapsed,
  fresh: state.fresh
})
export const cardsView = (state: ShellState) => ({
  cards: state.cards,
  personas: state.personas,
  archived: state.archived,
  pinsCollapsed: state.pinsCollapsed,
  fresh: state.fresh
})
export const sectionsOf = (state: ShellState, view: ShellForksView) =>
  view.sections.map(({ id, limit, offset = 0, through }) => {
    const rows = sectionRows(state, view, id)
    const target = through === undefined ? -1 : rows.findIndex((row) => row.chat.id === through)
    const pastWindow = target >= offset + SHELL_SECTION_LIMIT
    const end = pastWindow ? offset + limit : Math.max(offset + limit, target + 1)
    const page = rows.slice(offset, end)
    // A distant target can still be revealed without transferring thousands of intervening rows.
    if (pastWindow && page.length > 0) page[page.length - 1] = rows[target]!
    return { id, rows: page, total: rows.length }
  })

export const forksView = (state: ShellState, view: ShellForksView, availableLabels: ThreadLabels) => {
  const sections = sectionsOf(state, view)
  // The request's section order determines label/person order, even when the shared
  // materialization computed labels for other sections too.
  const labels = new Map(
    sections.flatMap((section) =>
      section.rows.flatMap((f) => {
        const label = availableLabels.get(f.forkId)
        return f.threads !== undefined && label ? [[f.forkId, label] as const] : []
      })
    )
  )
  const labelled = (f: Fork) => {
    const thread = labels.get(f.forkId)
    return thread ? new ShellFork({ ...wire(f), thread }, trusted) : wire(f)
  }
  const threadPeople = new Set([...labels.values()].flatMap((thread) => thread.cast))
  const chatIds = view.chats === undefined ? null : new Set<string>(view.chats)
  const scoped = perChat(
    state.forks.filter(
      (f) =>
        (view.entity === null || f.joined.includes(view.entity)) &&
        (view.chat === null || f.chat.id === view.chat) &&
        (chatIds === null || chatIds.has(f.chat.id))
    )
  )
  const filterCounts = { all: 0, pinned: 0, groups: 0, solo: 0, branches: 0, workshops: 0 } satisfies ChatFilterCounts
  for (const row of scoped)
    for (const filter of CHAT_FILTERS)
      if (inChatFilter(state.chatIndex.get(row.chat.id)!, filter, state.pinnedChats)) filterCounts[filter]++
  // While the first pass hasn't read every fork: how far it is in what the view lists, its
  // chat's forks for a chat's branches, else its chats (by the rows that stand for them). A
  // character's scope counts its chats' rows, since a fork not read yet has no cast to match.
  const listed =
    view.chat !== null
      ? state.forks.filter((f) => f.chat.id === view.chat)
      : perChat(state.forks.filter((f) => chatIds === null || chatIds.has(f.chat.id)))
  const pendingChats = new Set(state.forks.filter((f) => f.pending === true).map((f) => f.chat.id))
  const waiting = listed.reduce(
    (n, f) => n + (view.chat !== null ? Number(f.pending === true) : Number(pendingChats.has(f.chat.id))),
    0
  )
  return {
    filterCounts,
    ...(waiting > 0 ? { loading: { ready: listed.length - waiting, total: listed.length } } : {}),
    sections: sections.map((section) => ({ ...section, rows: section.rows.map(labelled) })),
    people: [
      ...new Map(
        [
          ...peopleOf(sections.flatMap((section) => section.rows)),
          ...[...threadPeople].flatMap((id) => state.people.get(id) ?? [])
        ].map((card) => [card.entityId, card])
      ).values()
    ],
    fresh: state.fresh
  }
}

/** Restore only display metadata. Navigation's ancestry remains worker-local. */
export const snapshotState = (snapshot: typeof ShellSnapshotRead.Type) => {
  const people = new Map<string, CastCard>(snapshot.people.map((c) => [c.entityId, c]))
  const forks: Array<Fork> = snapshot.forks.map((f) => ({
    ...f,
    cast: f.cast.flatMap((id) => people.get(id) ?? []),
    added: f.added.flatMap((id) => people.get(id) ?? [])
  }))
  const state: ShellState = {
    ...snapshot,
    people,
    forks,
    chatIndex: new Map(perChat(forks).map((f) => [f.chat.id, f])),
    pinnedChats: new Set(snapshot.pinnedChats),
    links: new Map(),
    parents: new Map(),
    splitChatIds: new Set()
  }
  const labels: ThreadLabels = new Map(snapshot.labels.map((entry) => [entry.forkId, entry.thread]))
  return { state, labels }
}
