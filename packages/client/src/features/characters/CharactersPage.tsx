import { useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { AsyncView } from "../../actions.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useTitle } from "../shell.tsx"
import { homeIntro } from "./homeSlots.ts"
import { browseCards, mixesPersonas } from "./cardBrowse.tsx"
import { useHomeBrowse } from "./useHomeBrowse.ts"
import { CardGridControls } from "./CardGridControls.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { browsable, CharacterGrid, shellAtom, type ShellLibrary } from "./shellData.tsx"
import { PinnedChats } from "./ShellBrowser.tsx"

const COLUMNS = "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"

function Home({ data }: { data: ShellLibrary }) {
  const [browse, setBrowse] = useHomeBrowse()
  const { search } = browse
  // With nothing imported, what the intro offers (first-run steps) stands in for the empty grid.
  const intro = useSyncExternalStore(homeIntro.subscribe, homeIntro.snapshot).entries.length > 0
  // Then the filters and search, having nothing to work on, stay out of the way too.
  if (intro && data.cards.length === 0)
    return (
      <div className="flex flex-col gap-5">
        <SlotOutlet slot={homeIntro} props={{ data }} />
        <PinnedChats
          pinsCollapsed={data.pinsCollapsed}
          home
          sortBy={browse.pinsSort}
          onSortChange={(pinsSort) => setBrowse({ pinsSort })}
        />
      </div>
    )
  const needle = search.trim().toLowerCase()
  const cards = browseCards(browsable(data), browse, search)
  return (
    <div className="flex flex-col gap-5">
      <SlotOutlet slot={homeIntro} props={{ data }} />
      <PinnedChats
        pinsCollapsed={data.pinsCollapsed}
        home
        sortBy={browse.pinsSort}
        onSortChange={(pinsSort) => setBrowse({ pinsSort })}
      />
      <CardGridControls
        data={data}
        browse={browse}
        onChange={setBrowse}
        search={search}
        onSearch={(search) => setBrowse({ search })}
        searchLabel="Search characters and groups"
      />
      {browse.filter === "groups" ? (
        <GroupGrid needle={needle} sort={browse.sort} reversed={browse.reversed} className={COLUMNS} />
      ) : (
        <CharacterGrid cards={cards} sort={browse.sort} markPersonas={mixesPersonas(browse)} className={COLUMNS}>
          {!cards.length && (
            <EmptyState
              title={
                needle
                  ? "No characters here"
                  : browse.filter === "favourites"
                    ? "No favourites yet"
                    : browse.filter === "personas"
                      ? "No personas yet"
                      : "No characters here"
              }
            >
              {browse.filter === "favourites" && !needle ? (
                <p>Star a character to keep it here.</p>
              ) : browse.filter === "personas" && !needle ? (
                <p>Cards you play as are kept here. In the library, a card’s menu adds it.</p>
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
