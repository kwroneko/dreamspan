import { useState, useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { AsyncView } from "../../actions.tsx"
import { Input } from "../../ui/Field.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useTitle } from "../shell.tsx"
import { homeIntro } from "./homeSlots.ts"
import { browseCards, CardFilterControl, CardSortControl, useCardBrowse } from "./cardBrowse.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { CharacterGrid, shellAtom, useGroupCount, type ShellLibrary } from "./shellData.tsx"
import { PinnedChats } from "./ShellBrowser.tsx"

const COLUMNS = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"

function Home({ data }: { data: ShellLibrary }) {
  const [browse, setBrowse] = useCardBrowse("home")
  const [search, setSearch] = useState("")
  const groups = useGroupCount()
  // With nothing imported, what the intro offers (first-run steps) stands in for the empty grid.
  const intro = useSyncExternalStore(homeIntro.subscribe, homeIntro.snapshot).entries.length > 0
  // Then the filters and search, having nothing to work on, stay out of the way too.
  if (intro && data.cards.length === 0)
    return (
      <div className="flex flex-col gap-5">
        <SlotOutlet slot={homeIntro} props={{ data }} />
        <PinnedChats pinsCollapsed={data.pinsCollapsed} home />
      </div>
    )
  const needle = search.trim().toLowerCase()
  const cards = browseCards(data.cards, browse, search)
  return (
    <div className="flex flex-col gap-5">
      <SlotOutlet slot={homeIntro} props={{ data }} />
      <PinnedChats pinsCollapsed={data.pinsCollapsed} home />
      <div>
        <CardFilterControl
          value={browse.filter}
          onChange={(filter) => setBrowse({ filter })}
          cards={data.cards}
          groups={groups}
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
        <CardSortControl sort={browse.sort} reversed={browse.reversed} onChange={setBrowse} />
      </div>
      {browse.filter === "groups" ? (
        <GroupGrid needle={needle} sort={browse.sort} reversed={browse.reversed} className={COLUMNS} />
      ) : (
        <CharacterGrid cards={cards} sort={browse.sort} className={COLUMNS}>
          {!cards.length && (
            <EmptyState title={browse.filter === "favourites" && !needle ? "No favourites yet" : "No characters here"}>
              {browse.filter === "favourites" && !needle ? (
                <p>Star a character to keep it here.</p>
              ) : (
                <Link to="/import/st" className="text-accent">
                  Import from SillyTavern
                </Link>
              )}
            </EmptyState>
          )}
        </CharacterGrid>
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
