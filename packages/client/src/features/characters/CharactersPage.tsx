// The home screen (DESIGN §2.1): the user's characters as a grid, as in ST, with their groups
// of chats among them as ST shows its groups. One click goes into a conversation: the latest
// chat with that character or group, or a character's greeting when there's none yet
// (nothing is saved until the first message). A character's tile also starts a new chat or
// opens the card's page; a group's lists its chats. Personas aren't characters here.
import type { CardUsage, ChatGroup } from "@rp/shared/chatSetupApi.ts"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { allOf, AsyncView } from "../../actions.tsx"
import { Avatar } from "../../ui/Avatar.tsx"
import { Button, buttonClass } from "../../ui/Button.tsx"
import { Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { useTitle } from "../shell.tsx"
import {
  groupsAtom,
  matches,
  openTarget,
  shortUsageLine,
  type Sort,
  sortTiles,
  type Tile,
  usageAtom,
  usageLine
} from "./data.ts"
import { GroupFaces } from "./GroupFaces.tsx"

const homeAtom = allOf({ cards: usageAtom, groups: groupsAtom })

const SORT_KEY = "rp.characters.sort"

const savedSort = (): Sort => {
  try {
    return localStorage.getItem(SORT_KEY) === "name" ? "name" : "recent"
  } catch {
    return "recent"
  }
}

const saveSort = (sort: Sort) => {
  try {
    localStorage.setItem(SORT_KEY, sort)
  } catch {
    // Not remembered, then.
  }
}

type Filter = "all" | "groups" | "unused"

// Buttons over the picture: on a mouse, they show on hover or focus; on a touch screen,
// where nothing hovers, always.
const tileAction =
  "pointer-events-auto inline-flex h-7 items-center whitespace-nowrap rounded-md border border-border bg-surface/95 px-2 text-xs font-medium text-text shadow-sm outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-focus"

/** A group's tile: its members' faces, its name, its use and who's in it. */
function GroupTile({ group }: { group: ChatGroup }) {
  const members = group.members.map((member) => member.name).join(", ")
  return (
    <li className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors focus-within:border-focus hover:border-focus/60">
      <Link
        to="/chats/$chatId"
        params={{ chatId: group.latestChatId }}
        aria-label={`${group.name}, a group with ${members}: continue the latest chat`}
        className="flex min-w-0 flex-col outline-none"
      >
        <span className="block aspect-[4/5] w-full overflow-hidden bg-surface-raised">
          <GroupFaces members={group.members} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
          <span className="text-sm font-medium [overflow-wrap:anywhere]" title={group.name}>
            {group.name}
          </span>
          <span className="text-xs text-muted [overflow-wrap:anywhere]" title={`Group: ${members}`}>
            {members}
          </span>
          <span className="truncate text-xs text-muted" title={usageLine(group)}>
            {shortUsageLine(group)}
          </span>
        </span>
      </Link>
      <span className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[4/5] items-start justify-start p-2">
        <span className="rounded-md bg-surface/95 px-1.5 py-0.5 text-xs font-medium text-text shadow-sm">
          Group · {group.members.length}
        </span>
      </span>
      {/* Two actions: on a narrow tile the second goes under the first rather than squeezing both. */}
      <span className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[4/5] flex-wrap content-end items-end justify-between gap-1.5 p-2 transition-opacity pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 motion-reduce:transition-none">
        <Link
          to="/groups/$chatId/new"
          params={{ chatId: group.latestChatId }}
          aria-label={`New chat with ${group.name}`}
          className={tileAction}
        >
          New chat
        </Link>
        <Link
          to="/groups/$chatId"
          params={{ chatId: group.latestChatId }}
          aria-label={`All chats of ${group.name}`}
          className={tileAction}
        >
          {group.chats === 1 ? "Group page" : `All ${group.chats.toLocaleString()} chats`}
        </Link>
      </span>
    </li>
  )
}

function CardTile({ card }: { card: CardUsage }) {
  const used = card.chats > 0
  return (
    <li className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface transition-colors focus-within:border-focus hover:border-focus/60">
      <Link
        {...openTarget(card)}
        aria-label={`${card.label}${card.subtitle ? ` (${card.subtitle})` : ""}: ${used ? "continue the latest chat" : "start a chat"}`}
        className="flex min-w-0 flex-col outline-none"
      >
        <span className="block aspect-[4/5] w-full overflow-hidden bg-surface-raised">
          <Avatar
            id={card.entityId}
            name={card.name}
            mediaId={card.avatarMediaId}
            size="fill"
            shape="square"
            className="object-[50%_20%] transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none"
          />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
          <span className="truncate text-sm font-medium" title={card.label}>
            {card.label}
          </span>
          {card.subtitle && (
            <span className="truncate text-xs text-muted" title={card.subtitle}>
              {card.subtitle}
            </span>
          )}
          <span className={`truncate text-xs ${used ? "text-muted" : "text-accent"}`} title={usageLine(card)}>
            {shortUsageLine(card)}
          </span>
        </span>
      </Link>
      <span className="pointer-events-none absolute inset-x-0 top-0 flex aspect-[4/5] items-end justify-between gap-1.5 p-2 transition-opacity pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 motion-reduce:transition-none">
        <Link
          to="/cards/$entityId/chat"
          params={{ entityId: card.entityId }}
          aria-label={`New chat with ${card.label}`}
          className={tileAction}
        >
          New chat
        </Link>
        <Link
          to="/cards/$entityId"
          params={{ entityId: card.entityId }}
          aria-label={`Inspect ${card.label}`}
          className={tileAction}
        >
          Inspect
        </Link>
      </span>
    </li>
  )
}

function NoCharacters() {
  return (
    <EmptyState title="No characters yet">
      <p>Bring in your SillyTavern folder or card files, or write a card from scratch.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link to="/import/st" className={buttonClass("primary")}>
          Import from SillyTavern
        </Link>
        <Link to="/import" className={buttonClass()}>
          Import card files
        </Link>
        <Link to="/library" className={buttonClass("ghost")}>
          Library
        </Link>
      </div>
    </EmptyState>
  )
}

const keyOf = (tile: Tile) => (tile.kind === "card" ? tile.card.entityId : `group:${tile.group.latestChatId}`)

function Grid({ cards, groups }: { cards: ReadonlyArray<CardUsage>; groups: ReadonlyArray<ChatGroup> }) {
  const [search, setSearch] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [sort, setSortState] = useState<Sort>(savedSort)
  const setSort = (next: Sort) => {
    setSortState(next)
    saveSort(next)
  }
  const tiles: ReadonlyArray<Tile> = [
    ...groups.map((group) => ({ kind: "group", group }) as const),
    ...cards.map((card) => ({ kind: "card", card }) as const)
  ]
  const unused = cards.filter((card) => card.chats === 0).length
  const needle = search.trim()
  const shown = sortTiles(
    tiles.filter(
      (tile) =>
        (filter === "all" ||
          (filter === "groups" ? tile.kind === "group" : tile.kind === "card" && tile.card.chats === 0)) &&
        matches(tile, needle)
    ),
    sort
  )
  if (cards.length === 0 && groups.length === 0) return <NoCharacters />
  const among = filter === "unused" ? " among those never used" : filter === "groups" ? " among the groups" : ""
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Input
          type="search"
          aria-label="Search characters and groups"
          placeholder="Search by name"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 sm:ml-auto sm:justify-end">
          <Segmented
            label="Show"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: `All ${tiles.length.toLocaleString()}` },
              ...(groups.length > 0
                ? [{ value: "groups" as const, label: `Groups ${groups.length.toLocaleString()}` }]
                : []),
              { value: "unused", label: `Never used ${unused.toLocaleString()}` }
            ]}
          />
          <Segmented
            label="Sort by"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" }
            ]}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={
            needle
              ? `Nothing matches “${needle}”${among}.`
              : filter === "groups"
                ? "No groups yet."
                : "Every character has been used."
          }
        >
          <Button
            variant="ghost"
            onClick={() => {
              setSearch("")
              setFilter("all")
            }}
          >
            Show everything
          </Button>
        </EmptyState>
      ) : (
        <ul
          aria-label="Characters and groups"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
        >
          {shown.map((tile) =>
            tile.kind === "card" ? (
              <CardTile key={keyOf(tile)} card={tile.card} />
            ) : (
              <GroupTile key={keyOf(tile)} group={tile.group} />
            )
          )}
        </ul>
      )}
    </div>
  )
}

export function CharactersPage() {
  useTitle("Characters")
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Characters</h1>
      <AsyncView atom={homeAtom} loading="Loading characters…">
        {({ cards, groups }) => <Grid cards={cards} groups={groups} />}
      </AsyncView>
    </div>
  )
}
