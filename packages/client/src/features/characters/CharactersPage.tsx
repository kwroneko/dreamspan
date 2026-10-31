import { useState, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { AsyncView } from "../../actions.tsx"
import { Input } from "../../ui/Field.tsx"
import { Segmented } from "../../ui/Segmented.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useTitle } from "../shell.tsx"
import { homeIntro } from "./homeSlots.ts"
import { sortCards } from "./cardRecency.ts"
import { CharacterTile, shellAtom, type ShellLibrary } from "./shellData.tsx"
import { GroupTile, PinnedChats, SortSwitch, sortForks, type ShellSort } from "./ShellBrowser.tsx"

type Filter = "all" | "used" | "unused" | "groups"
function Home({ data }: { data: ShellLibrary }) {
  const [filter, setFilter] = useState<Filter>("all")
  const [sort, setSort] = useState<ShellSort>("recent")
  const [search, setSearch] = useState("")
  // With nothing imported, what the intro offers (first-run steps) stands in for the empty grid.
  const intro = useSyncExternalStore(homeIntro.subscribe, homeIntro.snapshot).entries.length > 0
  const needle = search.trim().toLowerCase()
  const cards = sortCards(
    data.cards.filter(
      (c) =>
        (filter !== "used" || c.card.chats > 0) &&
        (filter !== "unused" || c.card.chats === 0) &&
        [c.card.label, c.card.name, c.card.subtitle].some((n) => n.toLowerCase().includes(needle))
    ),
    data.lastChatAt,
    sort
  )
  const groups = sortForks(
    data.forks.filter(
      (f) =>
        f.cast.length > 1 &&
        (f.current || f.pinned || f.named) &&
        [f.name, ...f.cast.flatMap((c) => [c.name, c.label])].some((n) => n.toLowerCase().includes(needle))
    ),
    sort
  )
  return (
    <div className="flex flex-col gap-5">
      <SlotOutlet slot={homeIntro} props={{ data }} />
      <PinnedChats data={data} home />
      <div>
        <Segmented
          wrap
          label="Show"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "used", label: "With chats" },
            { value: "unused", label: "Never used" },
            { value: "groups", label: "Groups" }
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input
          type="search"
          aria-label="Search characters and groups"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          className="sm:max-w-xs"
        />
        <SortSwitch value={sort} onChange={setSort} />
      </div>
      {filter === "groups" ? (
        <div aria-label="Groups" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {groups.map((f) => (
            <GroupTile key={`${f.chat.id}/${f.forkId}`} fork={f} />
          ))}
          {!groups.length && <p className="text-muted">No chats with several characters yet.</p>}
        </div>
      ) : (
        <div aria-label="Characters" className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
          {cards.map((c) => (
            <CharacterTile key={c.card.entityId} card={c} />
          ))}
          {!cards.length && !(intro && data.cards.length === 0) && (
            <EmptyState title="No characters here">
              <Link to="/import/st" className="text-accent">
                Import from SillyTavern
              </Link>
            </EmptyState>
          )}
        </div>
      )}
    </div>
  )
}
export function CharactersPage() {
  useTitle("Characters")
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Characters</h1>
      <AsyncView atom={shellAtom} loading="Loading characters…">
        {(data) => <Home data={data} />}
      </AsyncView>
    </div>
  )
}
