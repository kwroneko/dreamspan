import { archivedCardActions, cardSearchExtras } from "./homeSlots.ts"
import { Tooltip } from "../../ui/Tooltip.tsx"
import { CenterHeaderContent } from "../../ui/CenterHeader.tsx"
import { useSyncExternalStore } from "react"
import { Link } from "@tanstack/react-router"
import { AsyncView } from "../../actions.tsx"
import { EmptyState } from "../../ui/Surface.tsx"
import { SlotOutlet } from "../../slots.tsx"
import { useTitle } from "../shell.tsx"
import { homeIntro } from "./homeSlots.ts"
import { browseCards, mixesPersonas, useGroupedFamilies } from "./cardBrowse.tsx"
import { useHomeBrowse } from "./useHomeBrowse.ts"
import type { HomeBrowse } from "./homeSearch.ts"
import { SourceResults, useSourceBrowse } from "../cardSources/browse.tsx"
import { SourceChips, SourceFiltersPanel } from "../cardSources/filters.tsx"
import { CardGridControls } from "./CardGridControls.tsx"
import { GroupGrid } from "./GroupGrid.tsx"
import { browsable, CharacterGrid, shellAtom, type ShellLibrary } from "./shellData.tsx"
import { PinnedChats } from "./ShellBrowser.tsx"
import { NewCardButton } from "../editor/NewCard.tsx"

// By Home's own width, not the window's: in a split frame the tiles keep their size rather than
// shrinking to five columns of a narrow frame, where the corner toggles would cover the tile.
const COLUMNS = "grid grid-cols-2 gap-3 @xl:grid-cols-3 @3xl:grid-cols-4 @4xl:grid-cols-5"

function Home({ data }: { data: ShellLibrary }) {
  const [browse, setBrowse] = useHomeBrowse()
  const { search } = browse
  // A card source shown in place of the user's cards; nothing is asked of it otherwise (§5.1).
  const sources = useSourceBrowse(browse.source, browse.remote, (remote, options) => setBrowse({ remote }, options))
  const source = sources.info
  // With nothing imported, what the intro offers (first-run steps) stands in for the empty grid.
  const intro = useSyncExternalStore(homeIntro.subscribe, homeIntro.snapshot).entries.length > 0
  // The source choices also work with an empty library (spec/CARD-SOURCES D1).
  if (
    intro &&
    sources.options.length === 0 &&
    data.cards.length === 0 &&
    data.personas.length === 0 &&
    data.archived.length === 0 &&
    browse.filter !== "personas" &&
    source === null
  )
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
    <div className="@container flex flex-col gap-5">
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
        sources={sources}
        onSource={(id) => setBrowse({ source: id })}
        filtersId="home-source-filters"
      />
      {source !== null ? (
        // The source's cards only: never mixed with the user's (spec/CARD-SOURCES.md §3.2).
        <>
          <SourceFiltersPanel browse={sources} id="home-source-filters" />
          <SourceChips browse={sources} />
          <SourceResults browse={sources} className={COLUMNS} />
        </>
      ) : (
        <LocalCards data={data} browse={browse} search={search} needle={needle} cards={cards} />
      )}
    </div>
  )
}

function LocalCards({
  data,
  browse,
  search,
  needle,
  cards
}: {
  data: ShellLibrary
  browse: HomeBrowse
  search: string
  needle: string
  cards: ReturnType<typeof browseCards>
}) {
  const [, setBrowse] = useHomeBrowse()
  const grouped = useGroupedFamilies(browse, search)
  return (
    <>
      {browse.filter === "personas" && (
        <div>
          <NewCardButton persona />
        </div>
      )}
      {browse.filter === "archived" && <SlotOutlet slot={archivedCardActions} props={{}} />}
      {browse.filter === "groups" ? (
        <GroupGrid needle={needle} sort={browse.sort} reversed={browse.reversed} className={COLUMNS} />
      ) : (
        <CharacterGrid
          cards={cards}
          sort={browse.sort}
          markPersonas={mixesPersonas(browse)}
          families={grouped ? { expanded: browse.family, onToggle: (family) => setBrowse({ family }) } : undefined}
          className={COLUMNS}
        >
          {!cards.length && (
            <EmptyState
              title={
                needle
                  ? "No characters here"
                  : browse.filter === "favourites"
                    ? "No favourites yet"
                    : browse.filter === "archived"
                      ? "No archived cards"
                      : browse.filter === "personas"
                        ? "No personas yet"
                        : "No characters here"
              }
            >
              {browse.filter === "archived" ? (
                <p>Archived cards stay here until you unarchive them.</p>
              ) : browse.filter === "favourites" && !needle ? (
                <p>Star a character to keep it here.</p>
              ) : browse.filter === "personas" && !needle ? (
                <p>Cards you play as are kept here. In the library, a card’s menu adds it.</p>
              ) : (
                <Tooltip label="Opens the SillyTavern importer.">
                  <Link to="/import/st" className="text-accent">
                    Import from SillyTavern
                  </Link>
                </Tooltip>
              )}
            </EmptyState>
          )}
        </CharacterGrid>
      )}
      <SlotOutlet slot={cardSearchExtras} props={{ data, browse, search, className: COLUMNS }} />
    </>
  )
}

export function CharactersPage() {
  useTitle("Characters")
  return (
    <div className="flex flex-col gap-4">
      <CenterHeaderContent>
        <h1 className="text-xl font-semibold">Characters</h1>
      </CenterHeaderContent>
      <AsyncView atom={shellAtom} loading="Loading characters…">
        {(data) => <Home data={data} />}
      </AsyncView>
    </div>
  )
}
